import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { username } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders } from 'better-auth/node';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { EventStore } from './db.js';

const usernamePattern = /^[\p{L}\p{N}_.-]+$/u;

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
    plugins: [
      username({
        displayUsername: false,
        minUsernameLength: 1,
        maxUsernameLength: 64,
        usernameValidator: (value) => usernamePattern.test(value),
      }),
    ],
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    advanced: { useSecureCookies: publicUrl.startsWith('https:') },
    rateLimit: { enabled: true, window: 60, max: 20, storage: 'database' },
  } satisfies BetterAuthOptions;
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  store.db.transaction(() => {
    const legacy = store.db
      .prepare("SELECT id,name FROM user WHERE username IS NULL OR username=''")
      .all() as { id: string; name: string }[];
    for (const user of legacy) {
      const base =
        user.name
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_.-]+/gu, '_')
          .slice(0, 56) || 'admin';
      let candidate = base,
        suffix = 1;
      while (store.db.prepare('SELECT id FROM user WHERE username=?').get(candidate))
        candidate = `${base}_${suffix++}`;
      store.db.prepare('UPDATE user SET username=? WHERE id=?').run(candidate, user.id);
    }
  })();
  return betterAuth(options);
}
export type ConsoleAuth = Awaited<ReturnType<typeof createConsoleAuth>>;
export function registerConsoleAuth(
  app: FastifyInstance,
  auth: ConsoleAuth,
  store: EventStore,
  apiKey: string,
  publicUrl: string,
) {
  let bootstrapping = false;
  const hasOwner = () => Boolean(store.db.prepare('SELECT id FROM user LIMIT 1').get());
  app.get('/api/console/setup', async () => ({ needsSetup: !hasOwner() }));
  app.post(
    '/api/console/setup',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (hasOwner() || bootstrapping)
        return reply.code(409).send({ error: 'Owner already configured' });
      const body = z
        .object({
          username: z.string().trim().min(1).max(64).regex(usernamePattern),
          password: z.string().min(8).max(200),
          apiKey: z.string(),
        })
        .strict()
        .safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({
          error:
            'Use a username with letters, numbers, dots, underscores, or hyphens and a password of at least 8 characters',
        });
      if (!secureEqual(body.data.apiKey, apiKey))
        return reply.code(401).send({ error: 'Invalid API key' });
      bootstrapping = true;
      try {
        await auth.api.signUpEmail({
          body: {
            // Better Auth requires an internal email identifier; no email is collected or used for sign-in.
            email: `${createHash('sha256').update(body.data.username.toLowerCase()).digest('hex')}@users.sms2actual.invalid`,
            username: body.data.username,
            name: body.data.username,
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
    'sign-in/username',
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
      const authHeaders = fromNodeHeaders(req.headers);
      for (const name of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'])
        authHeaders.delete(name);
      authHeaders.set('x-forwarded-for', req.ip);
      const response = await auth.handler(
        new Request(new URL(req.url, publicUrl), {
          method: req.method,
          headers: authHeaders,
          ...(req.body ? { body: JSON.stringify(req.body) } : {}),
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
