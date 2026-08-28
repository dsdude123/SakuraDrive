import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENT_PROTOCOL_VERSION, agentReportSchema } from '@sakuradrive/shared';
import { nowIso } from '../db/index.js';
import type { Services } from '../services/container.js';
import { parseBody } from './helpers.js';

export function registerAgentRoutes(app: FastifyInstance, services: Services): void {
  const { agents, auth, logger } = services;

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
