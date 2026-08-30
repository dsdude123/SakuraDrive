import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AGENT_PROTOCOL_VERSION,
  agentJobBatchSchema,
  agentJobClaimSchema,
  agentJobFinishSchema,
  agentReportSchema,
} from '@sakuradrive/shared';
import { nowIso } from '../db/index.js';
import type { Services } from '../services/container.js';
import { applyAgentHashes } from '../services/hash-ingest.js';
import { parseBody } from './helpers.js';

export function registerAgentRoutes(app: FastifyInstance, services: Services): void {
  const { agents, agentJobs, auth, bitrot, catalog, db, settings, logger } = services;

  /** Bearer token, or null. The agent is a scheduled task: no cookie, no password. */
  const authenticate = (request: { headers: Record<string, unknown> }): string | null => {
    const header = String(request.headers.authorization ?? '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    return auth.verifyAgentToken(token) ? token : null;
  };

  /**
   * The Windows agent posts here. Authenticated with a bearer token created in the UI
   * rather than the session cookie, because the agent is a scheduled task with no
   * browser and no password.
   */
  app.post('/api/agent/report', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const agentToken = auth.verifyAgentToken(token);
    if (!agentToken) {
      return reply
        .code(401)
        .send({ error: 'unauthorized', message: 'A valid agent token is required' });
    }

    const parsed = agentReportSchema.safeParse(request.body);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues.slice(0, 5) }, 'rejected an agent report');
      return reply.code(400).send({
        error: 'invalid_report',
        message: 'The report does not match the agent protocol',
        details: parsed.error.flatten(),
      });
    }

    const report = parsed.data;
    const warnings: string[] = [];
    if (report.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      warnings.push(
        `Agent speaks protocol ${report.protocolVersion}; this server expects ${AGENT_PROTOCOL_VERSION}. Update the agent script.`,
      );
    }

    const result = agents.ingest(report);
    return {
      accepted: true,
      agentId: String(result.agentId),
      serverTime: nowIso(),
      alertsRaised: result.alertsRaised,
      warnings: [...warnings, ...result.warnings],
    };
  });

  /* ------------------------------------------------------------- agent jobs */

  /**
   * The agent asks for work.
   *
   * Roots whose source is `agent` are read on the Windows side, because a pool member
   * with no drive letter is invisible to this container: WSL2 only surfaces lettered
   * drives, and drvfs will not follow a folder mount point into another volume. Rather
   * than constraining the host's disk layout, the reading moves to the side of the
   * boundary that can already see everything.
   */
  app.post('/api/agent/jobs/claim', async (request, reply) => {
    if (!authenticate(request)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'A valid agent token is required' });
    }
    const body = parseBody(agentJobClaimSchema, request, reply);
    if (!body) return reply;

    const job = agentJobs.claim(body.hostname);
    if (!job) return reply.code(204).send();

    const root = settings.get().catalog.roots.find((candidate) => candidate.id === job.rootId);
    if (!root) {
      // The root was removed while the job sat in the queue. Say so rather than handing
      // out work against a path nobody configured any more.
      agentJobs.cancel(job.id, 'The catalog root no longer exists.');
      return reply.code(204).send();
    }
    return { job: agentJobs.toWireJob(job, root) };
  });

  /**
   * A batch of results, and the answer to "should I keep going?".
   *
   * The reply is where the I/O window crosses the process boundary: the agent knows
   * nothing about schedules, it just gets told to stop and posts a cursor so the next
   * window resumes rather than restarts.
   */
  app.post<{ Params: { id: string } }>('/api/agent/jobs/:id/batch', async (request, reply) => {
    if (!authenticate(request)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'A valid agent token is required' });
    }
    const body = parseBody(agentJobBatchSchema, request, reply);
    if (!body) return reply;

    const job = agentJobs.byId(Number(request.params.id));
    if (!job) return reply.code(404).send({ error: 'not_found', message: 'Unknown job' });
    if (job.state !== 'claimed') {
      // Reclaimed, cancelled or already finished. Tell the agent to stop rather than
      // accepting rows into a catalog run that has moved on without it.
      return { accepted: 0, continue: false };
    }

    const root = settings.get().catalog.roots.find((candidate) => candidate.id === job.rootId);
    if (!root) {
      agentJobs.cancel(job.id, 'The catalog root no longer exists.');
      return { accepted: 0, continue: false };
    }

    let accepted = 0;
    if (job.type === 'catalog.scan' && body.entries.length > 0 && job.catalogRunId !== null) {
      accepted = catalog.recordAgentFiles(job.catalogRunId, root, body.entries);
    } else if (job.type === 'catalog.hash' && body.hashes.length > 0) {
      // Bit rot is decided here, not on the agent: the agent reads bytes, it does not
      // hold opinions about what they mean.
      const outcome = applyAgentHashes(
        { db, catalog, bitrot, settings },
        body.hashes,
        (job.payload.hashAlgorithm as string | undefined) ?? 'sha256',
      );
      accepted = outcome.recorded;
      if (outcome.findings > 0) bitrot.syncAlert();
    }

    for (const error of body.errors) {
      logger.warn({ job: job.id, root: root.name, ...error }, 'the agent could not read a directory');
    }

    return {
      accepted,
      continue: agentJobs.heartbeat(job.id, {
        cursor: body.cursor,
        dirsDone: body.dirsDone,
        dirsRemaining: body.dirsRemaining,
      }),
    };
  });

  /** The agent is done with a job, one way or another. */
  app.post<{ Params: { id: string } }>('/api/agent/jobs/:id/finish', async (request, reply) => {
    if (!authenticate(request)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'A valid agent token is required' });
    }
    const body = parseBody(agentJobFinishSchema, request, reply);
    if (!body) return reply;

    const job = agentJobs.byId(Number(request.params.id));
    if (!job) return reply.code(404).send({ error: 'not_found', message: 'Unknown job' });

    agentJobs.finish(job.id, body);
    return { ok: true };
  });

  app.get('/api/agents/jobs', async () => ({ jobs: agentJobs.list() }));

  app.get('/api/agents', async () => ({ agents: agents.listAgents() }));

  app.get('/api/agents/tokens', async () => ({ tokens: auth.listAgentTokens() }));

  app.post('/api/agents/tokens', async (request, reply) => {
    const body = parseBody(z.object({ name: z.string().min(1).max(64) }), request, reply);
    if (!body) return reply;
    // The plaintext token is returned exactly once; only its hash is stored.
    return { token: auth.createAgentToken(body.name) };
  });

  app.delete<{ Params: { id: string } }>('/api/agents/tokens/:id', async (request) => {
    auth.revokeAgentToken(Number(request.params.id));
    return { ok: true };
  });
}
