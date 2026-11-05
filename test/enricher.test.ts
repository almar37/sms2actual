import { describe, expect, it, vi } from 'vitest';
import { OpenCodeGoEnricher } from '../src/enricher.js';

const input = {
  merchant: 'SAMPLE BOOKS',
  location: { latitude: 24.7136, longitude: 46.6753 },
  occurredAt: '2026-08-22T10:05:00+03:00',
  categories: [{ id: 'cat-shopping', name: 'Shopping' }],
};

function completion(content: unknown, status = 200) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

describe('OpenCode Go enricher', () => {
  it('requests JSON without the unsupported JSON-mode parameter and accepts an eligible category', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      completion({
        payee: 'Sample Books',
        categoryId: 'cat-shopping',
        confidence: 0.96,
        reason: 'Known retailer',
      }),
    );
    const result = await new OpenCodeGoEnricher(
      'secret-key',
      'deepseek-v4.1-flash',
      request,
    ).enrich(input);

    expect(result).toMatchObject({
      status: 'success',
      suggestion: { payee: 'Sample Books', categoryId: 'cat-shopping' },
    });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer secret-key',
      'user-agent': 'actual-sms/1.0.0',
      'x-opencode-session': expect.any(String),
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: 'deepseek-v4.1-flash',
    });
    expect(body).not.toHaveProperty('response_format');
    expect(body.messages[0].content).toContain('Return only JSON');
  });

  it('keeps a stable routing session per client without using credentials or merchant data', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () =>
      completion({
        payee: 'Sample Books',
        categoryId: 'cat-shopping',
        confidence: 0.96,
        reason: 'Known retailer',
      }),
    );
    const client = new OpenCodeGoEnricher('secret-key', 'deepseek-v4.1-flash', request);
    await client.enrich(input);
    await client.enrich({ ...input, merchant: 'OTHER BOOKS' });
    await new OpenCodeGoEnricher('secret-key', 'deepseek-v4.1-flash', request).enrich(input);

    const sessions = request.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get('x-opencode-session'),
    );
    expect(sessions[0]).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(sessions[1]).toBe(sessions[0]);
    expect(sessions[2]).not.toBe(sessions[0]);
  });

  it.each([
    ['malformed JSON', new Response('{', { status: 200 })],
    [
      'invalid schema',
      completion({
        payee: 'Example Store',
        categoryId: 'cat-shopping',
        confidence: 2,
        reason: 'x',
      }),
    ],
    [
      'unknown category',
      completion({ payee: 'Example Store', categoryId: 'unknown', confidence: 0.9, reason: 'x' }),
    ],
    ['rate limit', completion({}, 429)],
    ['exhausted Go limit', completion({}, 402)],
    ['provider failure', completion({}, 500)],
  ])('records a failed result for %s', async (_name, response) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    const result = await new OpenCodeGoEnricher('key', 'deepseek-v4.1-flash', request).enrich(
      input,
    );
    expect(result.status).not.toBe('success');
  });

  it('times out without throwing', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    });
    await expect(
      new OpenCodeGoEnricher('key', 'deepseek-v4.1-flash', request, 5).enrich(input),
    ).resolves.toMatchObject({ status: 'timeout' });
  });

  it('sends only the approved enrichment fields', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      completion({
        payee: 'Example Store',
        categoryId: 'cat-shopping',
        confidence: 0.9,
        reason: 'x',
      }),
    );
    await new OpenCodeGoEnricher('key', 'deepseek-v4.1-flash', request).enrich(input);
    const body = JSON.parse(String(request.mock.calls[0]![1]?.body));
    const outbound = JSON.parse(body.messages[1].content);

    expect(Object.keys(outbound).sort()).toEqual([
      'categories',
      'location',
      'merchant',
      'occurredAt',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/raw|sms|balance|alias|account|personal/i);
  });
});

const live = process.env.LIVE_OPENCODE_GO_TEST === '1' && process.env.OPENCODE_GO_API_KEY;
describe.skipIf(!live)('OpenCode Go live smoke test', () => {
  it('returns a valid suggestion', async () => {
    const result = await new OpenCodeGoEnricher(
      process.env.OPENCODE_GO_API_KEY!,
      process.env.OPENCODE_GO_MODEL ?? 'deepseek-v4.1-flash',
    ).enrich(input);
    expect(result.status).toBe('success');
  }, 30_000);
});
