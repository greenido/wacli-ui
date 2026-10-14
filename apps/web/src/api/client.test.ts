import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiClientError } from './client.ts';

/**
 * Every component test mocks `api`, so this is the only place the unwrapping
 * runs. It decides whether the operator reads the server's reason for a failed
 * send or a bare status line.
 */
function respondWith(status: number, body: unknown, statusText = ''): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      typeof body === 'string'
        ? new Response(body, { status, statusText })
        : Response.json(body, { status, statusText })
    )
  );
}

async function failureOf(call: Promise<unknown>): Promise<ApiClientError> {
  return call.then(
    () => {
      throw new Error('expected the request to fail');
    },
    (err: unknown) => err as ApiClientError
  );
}

describe('api request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hands back the data, not the envelope', async () => {
    respondWith(200, { success: true, data: { readOnly: true }, error: null });

    await expect(api.getHealth()).resolves.toEqual({ readOnly: true });
  });

  it('carries the server’s reason, status and lock details on a refusal', async () => {
    respondWith(503, {
      success: false,
      data: null,
      error: 'The wacli store is locked by another process',
      code: 'STORE_LOCKED',
      lockHolderPid: 4242,
    });

    const err = await failureOf(api.getHealth());

    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.message).toBe('The wacli store is locked by another process');
    expect(err.status).toBe(503);
    expect(err.code).toBe('STORE_LOCKED');
    expect(err.lockHolderPid).toBe(4242);
  });

  it('falls back to the status line when the error body is not JSON', async () => {
    respondWith(502, '<html>Bad Gateway</html>', 'Bad Gateway');

    const err = await failureOf(api.getHealth());

    expect(err.message).toBe('HTTP Error 502: Bad Gateway');
    expect(err.status).toBe(502);
  });

  it('treats an unsuccessful answer as a failure even with a 200', async () => {
    respondWith(200, { success: false, data: null, error: 'wacli did not answer' });

    const err = await failureOf(api.getHealth());

    expect(err.message).toBe('wacli did not answer');
  });
});
