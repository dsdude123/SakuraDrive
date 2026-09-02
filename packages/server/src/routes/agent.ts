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

/** The one file an operator downloads by hand; it fetches the rest. */
const BOOTSTRAP_FILE = 'Bootstrap-SakuraDriveAgent.ps1';

export function registerAgentRoutes(app: FastifyInstance, services: Services): void {
  const { agentDist, agents, agentJobs, auth, bitrot, catalog, db, settings, logger } = services;

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

  /* ----------------------------------------------------- agent distribution */

  /**
   * What the agent should be running.
   *
   * The agent has needed a fix on the host several times now, and every one of those
   * meant copying files onto a Windows box by hand. The image carries the agent source,
   * so the server can simply say what the current set of files is and let the agent
   * fetch what it does not already have.
   *
   * Behind the agent token like everything else under /api/agent: an installation
   * script with a server URL baked into it is not something to hand to anyone who can
   * reach the port.
   */
  app.get('/api/agent/dist', async (request, reply) => {
    if (!authenticate(request)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'A valid agent token is required' });
    }
    const manifest = agentDist.manifest();
    if (!manifest) {
      return reply.code(503).send({
        error: 'unavailable',
        message: 'This server was built without the agent source, so it cannot distribute updates.',
      });
    }
    return manifest;
  });

  /**
   * One file from the distribution.
   *
   * The name is matched against the manifest rather than joined onto a directory, so
   * `../` is not a special case to handle -- it is simply not a file in the manifest.
   * Served as bytes so what the agent hashes is exactly what is on disk here.
   */
  app.get<{ Querystring: { path?: string } }>('/api/agent/dist/file', async (request, reply) => {
    if (!authenticate(request)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'A valid agent token is required' });
    }
    const found = agentDist.read(request.query.path ?? '');
    if (!found) {
      return reply.code(404).send({
        error: 'not_found',
        message: 'That file is not part of the agent distribution',
      });
    }
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(found.buffer.byteLength))
      .header('x-sakuradrive-sha256', found.file.sha256)
      .send(found.buffer);
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
      accepted = await catalog.recordAgentFilesYielding(job.catalogRunId, root, body.entries);
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

  /**
   * What the agent is doing, is about to do, and just did.
   *
   * A scan of a 95 TB pool runs for days on the far side of a process boundary, so
   * "is anything actually happening?" has to be answerable without reading a log on the
   * Windows box. Rate and elapsed are computed here because they are what turns a pile
   * of counters into that answer.
   */
  app.get('/api/agents/jobs', async () => {
    const roots = settings.get().catalog.roots;
    const now = Date.now();

    const shape = (job: ReturnType<typeof agentJobs.list>[number]) => {
      const stats = job.stats as {
        filesSeen?: number;
        bytesSeen?: number;
        dirsDone?: number;
        dirsRemaining?: number;
      };
      // What this root held before the scan started. Zero on a first scan, and the
      // interface then shows movement rather than a percentage: a walk discovers
      // directories as it goes, so there is no total to be a fraction of yet.
      const expectedFiles = Number((job.payload as { expectedFiles?: number }).expectedFiles ?? 0);
      const startedAt = job.claimedAt ?? job.createdAt;
      const elapsedMs = (job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(startedAt);
      const filesSeen = stats.filesSeen ?? stats.dirsDone ?? 0;
      return {
        id: job.id,
        type: job.type,
        rootId: job.rootId,
        rootName: roots.find((root) => root.id === job.rootId)?.name ?? job.rootId,
        hostPath: roots.find((root) => root.id === job.rootId)?.hostPath ?? '',
        state: job.state,
        claimedBy: job.claimedBy,
        error: job.error,
        cancelRequested: job.cancelRequested,
        createdAt: job.createdAt,
        claimedAt: job.claimedAt,
        heartbeatAt: job.heartbeatAt,
        finishedAt: job.finishedAt,
        elapsedMs: Math.max(0, elapsedMs),
        // Seconds since the agent last said anything. The number that distinguishes
        // "working through a big directory" from "the host went away".
        silentForMs: job.heartbeatAt ? Math.max(0, now - Date.parse(job.heartbeatAt)) : null,
        // How long a queued job has been waiting for an agent to take it.
        queuedForMs: job.state === 'queued' ? Math.max(0, now - Date.parse(job.createdAt)) : null,
        filesSeen,
        bytesSeen: stats.bytesSeen ?? 0,
        dirsDone: stats.dirsDone ?? 0,
        dirsRemaining: stats.dirsRemaining ?? 0,
        expectedFiles,
        filesPerSecond: elapsedMs > 1000 ? (filesSeen / elapsedMs) * 1000 : null,
      };
    };

    const jobs = agentJobs.list(100).map(shape);
    return {
      active: jobs.filter((job) => job.state === 'claimed'),
      queued: jobs.filter((job) => job.state === 'queued'),
      recent: jobs.filter((job) => job.state !== 'claimed' && job.state !== 'queued').slice(0, 25),
      claimTimeoutSeconds: settings.get().catalog.agentClaimTimeoutSeconds,
    };
  });

  /**
   * Abandon a job by hand.
   *
   * A claimed job is asked to stop at its next batch, which is the same cooperative
   * path the I/O window uses -- so it stops with a cursor rather than being killed
   * mid-tree. A queued one is simply dropped.
   */
  app.post<{ Params: { id: string } }>('/api/agents/jobs/:id/cancel', async (request, reply) => {
    const job = agentJobs.byId(Number(request.params.id));
    if (!job) return reply.code(404).send({ error: 'not_found', message: 'Unknown job' });
    if (job.state === 'claimed') {
      agentJobs.requestCancel(job.id);
      return { ok: true, stopping: true };
    }
    agentJobs.cancel(job.id, 'Cancelled from the interface');
    return { ok: true, stopping: false };
  });

  app.get('/api/agents', async () => ({ agents: agents.listAgents() }));

  /**
   * The distribution as the interface needs it: the version, and enough to render the
   * one command an operator has to paste into an elevated prompt on the host.
   */
  app.get('/api/agents/dist', async () => {
    const manifest = agentDist.manifest();
    if (!manifest) {
      return {
        available: false,
        reason: 'This server was built without the agent source, so it cannot install or update agents.',
      };
    }
    return {
      available: true,
      version: manifest.version,
      agentVersion: manifest.agentVersion,
      protocolVersion: manifest.protocolVersion,
      bootstrapFile: BOOTSTRAP_FILE,
      files: manifest.files.map((file) => ({ path: file.path, bytes: file.bytes })),
      totalBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    };
  });

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
