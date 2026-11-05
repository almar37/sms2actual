import Fastify from 'fastify';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { username } from 'better-auth/plugins';
import { afterEach, expect, it } from 'vitest';
import { createConsoleAuth, registerConsoleAuth } from '../src/console-auth.js';
import { EventStore } from '../src/db.js';

const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const origin = 'http://localhost:3000';
const secret = 'test-auth-secret-with-more-than-32-characters';

it('preserves an existing username owner, password hash, and browser session after upgrading to password-only access', async () => {
  const store = new EventStore(':memory:');
  stores.push(store);
  const options = {
    appName: 'sms2actual',
    baseURL: origin,
    basePath: '/api/auth',
    secret,
    database: store.db,
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    plugins: [username({ displayUsername: false })],
  } satisfies BetterAuthOptions;
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  const legacy = betterAuth(options);
  const owner = await legacy.api.signUpEmail({
    body: {
      name: 'Existing Owner',
      username: 'existing_owner',
      email: 'legacy-identifier@users.sms2actual.invalid',
      password: 'existing-password',
    },
  });
  const login = await legacy.api.signInUsername({
    body: { username: 'existing_owner', password: 'existing-password' },
    asResponse: true,
  });
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  expect(cookie).toContain('session_token');
  const before = store.db.prepare('SELECT id,userId,password FROM account').all();
  const previousUser = store.db.prepare('SELECT * FROM user').all();

  const auth = await createConsoleAuth(store, origin, secret);
  const app = Fastify();
  registerConsoleAuth(app, auth, store, 'legacy-bootstrap-key', origin);
  try {
    expect(store.db.prepare('SELECT id,userId,password FROM account').all()).toEqual(before);
    expect(store.db.prepare('SELECT * FROM user').all()).toEqual(previousUser);
    expect((await app.inject('/api/console/setup')).json()).toEqual({ needsSetup: false });
    const existingSession = await app.inject({ url: '/api/auth/get-session', headers: { cookie } });
    expect(existingSession.json().user.id).toBe(owner.user.id);
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/password',
      headers: { origin },
      payload: { password: 'wrong-password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.cookies).toEqual([]);
    const passwordLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/password',
      headers: { origin },
      payload: { password: 'existing-password' },
    });
    expect(passwordLogin.statusCode, passwordLogin.body).toBe(200);
    expect(passwordLogin.json().user.id).toBe(owner.user.id);
    expect(passwordLogin.cookies.some((cookie) => cookie.name.endsWith('session_token'))).toBe(
      true,
    );
    expect(
      (await app.inject({ url: '/api/auth/get-session', headers: { cookie } })).json().user.id,
    ).toBe(owner.user.id);
  } finally {
    await app.close();
  }
});
