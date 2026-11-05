import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadRuntimeSecrets } from '../src/runtime-secrets.js';
import { loadEnv } from '../src/config.js';

describe('first-run runtime configuration', () => {
  it('starts with no environment settings', () => {
    expect(loadEnv({})).toMatchObject({ PUBLIC_URL: 'http://localhost:3000', PORT: 3000 });
    expect(loadEnv({}).API_KEY).toBeUndefined();
    expect(loadEnv({}).CONFIG_PATH).toBeUndefined();
  });
  it('persists private generated secrets and retains legacy secret derivation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sms2actual-secrets-'));
    const path = join(dir, 'runtime-secrets.json');
    try {
      const first = await loadRuntimeSecrets(path, {});
      expect(first.apiKey.length).toBeGreaterThanOrEqual(32);
      expect(await loadRuntimeSecrets(path, {})).toEqual(first);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await loadRuntimeSecrets(path, { API_KEY: 'legacy-api-key' })).toEqual({
        apiKey: 'legacy-api-key',
        authSecret: createHash('sha256').update('sms2actual:legacy-api-key').digest('hex'),
      });
      const raw = await readFile(path, 'utf8');
      expect(raw).not.toContain('legacy-api-key');
      expect((await loadRuntimeSecrets(path, { AUTH_SECRET: 'explicit-secret' })).authSecret).toBe(
        'explicit-secret',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
