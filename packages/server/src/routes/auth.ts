import '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../services/container.js';
import { SESSION_COOKIE, parseBody } from './helpers.js';

export function registerAuthRoutes(app: FastifyInstance, services: Services): void {
  const { auth, settings, config } = services;

  app.get('/api/auth/status', async (request) => {
    const user = auth.resolveSession(request.cookies[SESSION_COOKIE]);
    return {
      needsSetup: auth.needsSetup(),
      authRequired: settings.get().security.requireLogin && !config.disableAuth,
      authDisabled: config.disableAuth,
      user,
      version: config.version,
      siteName: settings.get().general.siteName,
    };
  });

  app.post('/api/auth/setup', async (request, reply) => {
    if (!auth.needsSetup()) {
      return reply.code(409).send({ error: 'already_configured', message: 'An account already exists' });
    }
    const body = parseBody(
      z.object({ username: z.string().min(1).max(64), password: z.string().min(8).max(200) }),
      request,
      reply,
    );
    if (!body) return reply;

    auth.createUser(body.username, body.password);
    const session = auth.login(body.username, body.password, settings.get().security.sessionDays);
    if (!session) return reply.code(500).send({ error: 'setup_failed', message: 'Could not sign in' });
    setSessionCookie(reply, session.token, settings.get().security.sessionDays);
    return { user: session.user };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const body = parseBody(
      z.object({ username: z.string().min(1), password: z.string().min(1) }),
      request,
      reply,
    );
    if (!body) return reply;

    const session = auth.login(body.username, body.password, settings.get().security.sessionDays);
    if (!session) {
      return reply.code(401).send({ error: 'invalid_credentials', message: 'Incorrect username or password' });
    }
    setSessionCookie(reply, session.token, settings.get().security.sessionDays);
    return { user: session.user };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    auth.logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', async (request, reply) => {
    const user = auth.resolveSession(request.cookies[SESSION_COOKIE]);
    if (!user) return reply.code(401).send({ error: 'unauthorized', message: 'Sign in first' });
    const body = parseBody(
      z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) }),
      request,
      reply,
    );
    if (!body) return reply;
    try {
      auth.changePassword(user.id, body.currentPassword, body.newPassword);
    } catch (error) {
      return reply
        .code(400)
        .send({ error: 'password_change_failed', message: error instanceof Error ? error.message : 'Failed' });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}

function setSessionCookie(reply: import('fastify').FastifyReply, token: string, days: number): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: days * 86_400,
  });
}
