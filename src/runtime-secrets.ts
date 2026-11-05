import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const schema = z.object({ apiKey: z.string().min(32), authSecret: z.string().min(32) });

/** Keep generated credentials stable across container recreations and upgrades. */
export async function loadRuntimeSecrets(
  path: string,
  overrides: { API_KEY?: string; AUTH_SECRET?: string },
) {
  let saved;
  try {
    saved = schema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const generated = {
      apiKey: randomBytes(32).toString('base64url'),
      authSecret: randomBytes(48).toString('base64url'),
    };
    try {
      await writeFile(path, JSON.stringify(generated), { mode: 0o600, flag: 'wx' });
      saved = generated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      saved = schema.parse(JSON.parse(await readFile(path, 'utf8')));
    }
  }
  return {
    apiKey: overrides.API_KEY ?? saved.apiKey,
    authSecret:
      overrides.AUTH_SECRET ??
      (overrides.API_KEY
        ? createHash('sha256').update(`sms2actual:${overrides.API_KEY}`).digest('hex')
        : saved.authSecret),
  };
}
