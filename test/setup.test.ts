import { describe, expect, it, vi } from 'vitest';
import {
  chooseCreditCardPaymentFundingAccount,
  encodeEnvValue,
  parseChoice,
  parseChoices,
  renderEnv,
  verifyActualServer,
} from '../src/setup.js';
import { resolveCreditCardPaymentFundingAccount } from '../src/config.js';

const choices = [{ name: 'One' }, { name: 'Two' }, { name: 'Three' }];

describe('setup helpers', () => {
  it('offers existing Actual accounts as a repayment funding default', async () => {
    const accounts = [
      { id: 'checking-id', name: 'Checking' },
      { id: 'card-id', name: 'Credit Card' },
    ];
    const choose = vi.fn(async (_label: string, choices: { name: string }[]) =>
      parseChoice('2', choices),
    );
    const name = await chooseCreditCardPaymentFundingAccount(accounts, choose);
    expect(name).toBe('Checking');
    expect(resolveCreditCardPaymentFundingAccount(accounts, name)).toEqual(accounts[0]);
    expect(choose.mock.calls[0]?.[0]).toContain('when the SMS omits it');
    expect(choose.mock.calls[0]?.[1].slice(1)).toEqual(accounts);
  });

  it('allows setup without an assumed repayment funding account', async () => {
    const name = await chooseCreditCardPaymentFundingAccount(
      [{ name: 'Checking' }],
      async (_label, choices) => parseChoice('1', choices),
    );
    expect(name).toBeUndefined();
    expect(
      resolveCreditCardPaymentFundingAccount([{ id: 'checking-id', name: 'Checking' }], name),
    ).toBeUndefined();
  });

  it('rejects missing or ambiguous funding account names during startup resolution', () => {
    const account = { id: 'checking-id', name: 'Checking' };
    expect(() => resolveCreditCardPaymentFundingAccount([account], 'checking')).toThrow(
      'resolve exactly once',
    );
    expect(() =>
      resolveCreditCardPaymentFundingAccount([account, { ...account, id: 'other-id' }], 'Checking'),
    ).toThrow('resolve exactly once');
  });
  it('quotes dotenv values when necessary', () => {
    expect(encodeEnvValue('simple-value')).toBe('simple-value');
    expect(encodeEnvValue('space and "quote"')).toBe('"space and \\"quote\\""');
    expect(renderEnv({ SECRET: 'line\nbreak' })).toBe('SECRET="line\\nbreak"\n');
  });

  it('parses single and multiple numbered choices', () => {
    expect(parseChoice('2', choices).name).toBe('Two');
    expect(parseChoices('3, 1, 3', choices).map((choice) => choice.name)).toEqual(['Three', 'One']);
    expect(() => parseChoice('0', choices)).toThrow('1 to 3');
    expect(() => parseChoices('1,4', choices)).toThrow('1 to 3');
  });

  it('preflights the Actual sync endpoint and exposes HTTP errors', async () => {
    const ok = async () =>
      new Response(JSON.stringify({ build: { version: '26.9.0' } }), {
        headers: { 'content-type': 'application/json' },
      });
    await expect(verifyActualServer('http://actual.test:5006/', ok)).resolves.toBe('26.9.0');
    await expect(
      verifyActualServer('https://actual.test', async () => new Response('', { status: 404 })),
    ).rejects.toThrow('HTTP 404');
  });
});
