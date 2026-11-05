import { banks } from './fixtures/banks.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { loadConfigFile } from '../src/config.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('public release configuration', () => {
  it('keeps personal configuration local and ships a valid synthetic example', async () => {
    expect(read('.gitignore')).toContain('config/accounts.yaml');
    const config = await loadConfigFile(
      new URL('../config/accounts.example.yaml', import.meta.url).pathname,
      banks,
    );
    expect(config.accounts).toHaveLength(6);
    expect(config.bankFeesCategory).toBe('Bank Fees');
  });

  it('keeps the base Compose file independent of private DNS and proxy topology', () => {
    const compose = YAML.parse(read('compose.example.yaml')) as {
      services: { 'actual-sms': { extra_hosts?: unknown; networks?: unknown } };
      networks?: unknown;
    };
    expect(compose.services['actual-sms'].extra_hosts).toBeUndefined();
    expect(compose.services['actual-sms'].networks).toBeUndefined();
    expect(compose.networks).toBeUndefined();
    expect(read('compose.host-override.example.yaml')).toContain('${ACTUAL_HOSTNAME:');
    expect(read('compose.proxy.example.yaml')).toContain('${PROXY_NETWORK:-caddy}');
  });

  it('does not require a deployment-specific host mapping during setup', () => {
    expect(read('.env.example')).not.toMatch(/^ACTUAL_HOST_IP=/m);
    const setupScript = read('scripts/setup-docker.sh');
    expect(setupScript).toContain('ACTUAL_SMS_ACTUAL_HOST:-}');
    expect(setupScript).not.toContain('ACTUAL_SMS_ACTUAL_HOST:-actual.');
  });

  it('boots the default Compose project without local config files or private networks', () => {
    const compose = YAML.parse(read('compose.yaml'));
    const service = compose.services['actual-sms'];
    expect(service.build).toBe('.');
    expect(service.env_file).toBeUndefined();
    expect(service.volumes).toEqual(['sms-data:/data', 'actual-cache:/actual-cache']);
    expect(service.networks).toBeUndefined();
    expect(service.extra_hosts).toBeUndefined();
    expect(read('Dockerfile')).toContain('COPY config/banks.yaml config/parsing.yaml ./config/');
  });
});
