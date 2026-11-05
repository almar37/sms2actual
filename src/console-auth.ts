import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders } from 'better-auth/node';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { EventStore } from './db.js';

const ownerEmail = 'owner@users.sms2actual.invalid';

export function secureEqual(left: unknown, right: string) {
  return (
    typeof left === 'string' &&
    timingSafeEqual(
      createHash('sha256').update(left).digest(),
      createHash('sha256').update(right).digest(),
    )
  );
}
export async function createConsoleAuth(
  store: EventStore,
  publicUrl: string,
  secret: string,
  trustedOrigins: string[] = [],
) {
  const options = {
    appName: 'sms2actual',
    baseURL: publicUrl,
    basePath: '/api/auth',
    secret,
    database: store.db,
    trustedOrigins: [new URL(publicUrl).origin, ...trustedOrigins],
    emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 200 },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    advanced: { useSecureCookies: publicUrl.startsWith('https:') },
    rateLimit: { enabled: true, window: 60, max: 20, storage: 'database' },
  } satisfies BetterAuthOptions;
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  return betterAuth(options);
}
export type ConsoleAuth = Awaited<ReturnType<typeof createConsoleAuth>>;
export function registerConsoleAuth(
  app: FastifyInstance,
  auth: ConsoleAuth,
  store: EventStore,
  apiKey: string,
  publicUrl: string,
  requireSetupKey = true,
) {
  let bootstrapping = false;
  const hasOwner = () => Boolean(store.db.prepare('SELECT id FROM user LIMIT 1').get());
  app.get('/api/console/setup', async () => ({
    needsSetup: !hasOwner(),
    ...(requireSetupKey ? {} : { requiresApiKey: false }),
  }));
  app.post(
    '/api/console/setup',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (hasOwner() || bootstrapping)
        return reply.code(409).send({ error: 'Owner already configured' });
      const body = z
        .object({
          password: z.string().min(8).max(200),
          apiKey: requireSetupKey ? z.string() : z.string().optional(),
        })
        .strict()
        .safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({
          error: 'Use a password of at least 8 characters',
        });
      if (requireSetupKey && !secureEqual(body.data.apiKey, apiKey))
        return reply.code(401).send({ error: 'Invalid API key' });
      bootstrapping = true;
      try {
        await auth.api.signUpEmail({
          body: {
            // Better Auth's internal identifier is never collected from the owner.
            email: ownerEmail,
            name: 'Owner',
            password: body.data.password,
          },
        });
        return { ok: true };
      } finally {
        bootstrapping = false;
      }
    },
  );
  const allowed = new Set([
    'sign-in/password',
    'sign-out',
    'get-session',
    'list-sessions',
    'revoke-session',
    'revoke-other-sessions',
    'change-password',
  ]);
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(req, reply) {
      const path = req.url.split('?')[0]!.replace('/api/auth/', '');
      if (!allowed.has(path)) return reply.code(404).send({ error: 'not_found' });
      let authPath = req.url;
      let body = req.body;
      if (path === 'sign-in/password') {
        if (req.method !== 'POST') return reply.code(405).header('allow', 'POST').send();
        const parsed = z
          .object({ password: z.string().min(1).max(200) })
          .strict()
          .safeParse(body);
        if (!parsed.success)
          return reply.code(400).send({ error: 'Enter your workspace password' });
        // Look up the original identifier so existing owners keep their password,
        // account ID, and sessions without a database rewrite.
        const owner = store.db
          .prepare('SELECT email FROM user ORDER BY createdAt,id LIMIT 1')
          .get() as { email: string } | undefined;
        authPath = '/api/auth/sign-in/email';
        body = { email: owner?.email ?? ownerEmail, password: parsed.data.password };
      }
      const authHeaders = fromNodeHeaders(req.headers);
      for (const name of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'])
        authHeaders.delete(name);
      authHeaders.set('x-forwarded-for', req.ip);
      const response = await auth.handler(
        new Request(new URL(authPath, publicUrl), {
          method: req.method,
          headers: authHeaders,
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.code(response.status).send(await response.text());
    },
  });
}
