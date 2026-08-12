import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTH0_GATEWAY_CALLBACK_URL,
  AUTH0_GATEWAY_DEVICE_CLAIM,
  AUTH0_GATEWAY_DEVICE_PARAMETER,
  AUTH0_GATEWAY_EMAIL_CLAIM,
  AUTH0_GATEWAY_LOGOUT_CALLBACK_URL,
  Auth0GatewayIdentityAdapter,
  isAuth0GatewayProtocolUrl,
  parseAuth0GatewayIdentityConfig,
  type Auth0GatewayIdentityConfig,
} from './Auth0GatewayIdentityAdapter';

const NOW_MS = Date.UTC(2026, 7, 12, 12, 0, 0);
const ISSUER = 'https://obelus-staging.us.auth0.com/';
const CLIENT_ID = 'EUgCgX7CUfuaPMQ4ofLLSPOPutlVAedn';
const AUDIENCE = 'urn:obelus:staging:gateway';
const DEVICE_ID = 'jNf3hTY6wP2A8vR0qL9sX5cM7dK1uB4eG6iZ8oQ2aFs';
const KEY_ID = 'obelus-staging-rs256';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
const publicJwk = publicKey.export({ format: 'jwk' });

const config: Auth0GatewayIdentityConfig = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  audience: AUDIENCE,
  redirectUri: AUTH0_GATEWAY_CALLBACK_URL,
  logoutRedirectUri: AUTH0_GATEWAY_LOGOUT_CALLBACK_URL,
};

function jwt(payload: Record<string, unknown>, patch = ''): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KEY_ID })).toString(
    'base64url'
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${header}.${body}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${patch || signature}`;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function harness(
  tokenPatch: Record<string, unknown> = {},
  accessPatch: Record<string, unknown> = {},
  identityPatch: Record<string, unknown> = {},
  now: () => number = () => NOW_MS,
  getInstallationDeviceId: () => Promise<string> = async () => DEVICE_ID
) {
  const opened: string[] = [];
  let authorizationUrl: URL | null = null;
  const requestBodies: URLSearchParams[] = [];
  const fetchImpl = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      if (url.pathname === '/oauth/token') {
        const body = new URLSearchParams(String(init?.body));
        requestBodies.push(body);
        const nonce = authorizationUrl?.searchParams.get('nonce');
        const now = Math.floor(NOW_MS / 1_000);
        return jsonResponse({
          access_token: jwt({
            iss: ISSUER,
            aud: AUDIENCE,
            azp: CLIENT_ID,
            sub: 'auth0|obelus-user',
            iat: now,
            exp: now + 600,
            [AUTH0_GATEWAY_DEVICE_CLAIM]: DEVICE_ID,
            [AUTH0_GATEWAY_EMAIL_CLAIM]: 'verified@example.com',
            ...accessPatch,
          }),
          id_token: jwt({
            iss: ISSUER,
            aud: CLIENT_ID,
            azp: CLIENT_ID,
            sub: 'auth0|obelus-user',
            nonce,
            iat: now,
            exp: now + 600,
            ...identityPatch,
          }),
          token_type: 'Bearer',
          expires_in: 600,
          scope: 'openid profile email',
          ...tokenPatch,
        });
      }
      if (url.pathname === '/.well-known/jwks.json') {
        return jsonResponse({
          keys: [{ ...publicJwk, kid: KEY_ID, use: 'sig', alg: 'RS256', key_ops: ['verify'] }],
        });
      }
      throw new Error(`Unexpected identity request: ${url.pathname}`);
    }
  );
  const adapter = new Auth0GatewayIdentityAdapter(config, {
    getInstallationDeviceId,
    openExternal: async (url) => {
      opened.push(url);
      if (new URL(url).pathname === '/authorize') authorizationUrl = new URL(url);
    },
    fetchImpl: fetchImpl as typeof fetch,
    now,
  });
  return {
    adapter,
    opened,
    fetchImpl,
    requestBodies,
    getAuthorizationUrl: () => authorizationUrl,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function beginSignIn(testHarness: ReturnType<typeof harness>) {
  const completion = testHarness.adapter.signIn();
  await vi.waitFor(() => expect(testHarness.opened).toHaveLength(1));
  const authorizationUrl = testHarness.getAuthorizationUrl();
  if (!authorizationUrl) throw new Error('Authorization URL was not opened');
  return { completion, authorizationUrl };
}

describe('Auth0GatewayIdentityAdapter', () => {
  it('reserves sign-in before installation identity loading completes', async () => {
    const installation = deferred<string>();
    const testHarness = harness(
      {},
      {},
      {},
      () => NOW_MS,
      () => installation.promise
    );
    const firstSignIn = testHarness.adapter.signIn();

    await expect(testHarness.adapter.signIn()).rejects.toThrow('already in progress');
    expect(testHarness.opened).toHaveLength(0);

    installation.resolve(DEVICE_ID);
    await vi.waitFor(() => expect(testHarness.opened).toHaveLength(1));
    const authorizationUrl = testHarness.getAuthorizationUrl();
    if (!authorizationUrl) throw new Error('Authorization URL was not opened');
    await testHarness.adapter.handleProtocolUrl(
      `${AUTH0_GATEWAY_CALLBACK_URL}?code=authorization-code&state=${authorizationUrl.searchParams.get('state')}`
    );

    await expect(firstSignIn).resolves.toMatchObject({ authenticated: true });
    expect(testHarness.opened.filter((url) => new URL(url).pathname === '/authorize')).toHaveLength(
      1
    );
  });

  it('cancels sign-in cleanly while installation identity is still loading', async () => {
    const installation = deferred<string>();
    const testHarness = harness(
      {},
      {},
      {},
      () => NOW_MS,
      () => installation.promise
    );
    const signInFailure = testHarness.adapter.signIn().catch((error: unknown) => error);

    await expect(testHarness.adapter.signOut()).resolves.toMatchObject({ authenticated: false });
    installation.resolve(DEVICE_ID);

    await expect(signInFailure).resolves.toMatchObject({ message: 'Obelus sign-in was cancelled' });
    expect(testHarness.opened.map((url) => new URL(url).pathname)).toEqual(['/v2/logout']);
  });

  it('builds a public-client Authorization Code + S256 PKCE request', async () => {
    const testHarness = harness();
    const { completion, authorizationUrl } = await beginSignIn(testHarness);

    expect(authorizationUrl.origin).toBe('https://obelus-staging.us.auth0.com');
    expect(authorizationUrl.pathname).toBe('/authorize');
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(AUTH0_GATEWAY_CALLBACK_URL);
    expect(authorizationUrl.searchParams.get('audience')).toBe(AUDIENCE);
    expect(authorizationUrl.searchParams.get('scope')).toBe('openid profile email');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get(AUTH0_GATEWAY_DEVICE_PARAMETER)).toBe(DEVICE_ID);
    expect(authorizationUrl.searchParams.has('client_secret')).toBe(false);
    expect(authorizationUrl.searchParams.get('scope')).not.toContain('offline_access');

    const state = authorizationUrl.searchParams.get('state');
    await testHarness.adapter.handleProtocolUrl(
      `${AUTH0_GATEWAY_CALLBACK_URL}?code=authorization-code&state=${state}`
    );
    await expect(completion).resolves.toMatchObject({ authenticated: true });

    const exchange = testHarness.requestBodies[0];
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('client_id')).toBe(CLIENT_ID);
    expect(exchange.get('client_secret')).toBeNull();
    expect(exchange.get('redirect_uri')).toBe(AUTH0_GATEWAY_CALLBACK_URL);
    const verifier = exchange.get('code_verifier');
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{80,100}$/);
    expect(authorizationUrl.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(verifier!).digest('base64url')
    );
    await expect(testHarness.adapter.getSession()).resolves.toMatchObject({
      principalId: 'auth0|obelus-user',
      deviceId: DEVICE_ID,
      expiresAtEpochMs: NOW_MS + 600_000,
    });
  });

  it('rejects a callback with the wrong state and consumes the transaction', async () => {
    const testHarness = harness();
    const { completion } = await beginSignIn(testHarness);
    const signInFailure = completion.catch((error: unknown) => error);

    await expect(
      testHarness.adapter.handleProtocolUrl(
        `${AUTH0_GATEWAY_CALLBACK_URL}?code=authorization-code&state=wrong-state`
      )
    ).rejects.toThrow('state did not match');
    await expect(signInFailure).resolves.toBeInstanceOf(Error);
    await expect(
      testHarness.adapter.handleProtocolUrl(
        `${AUTH0_GATEWAY_CALLBACK_URL}?code=authorization-code&state=wrong-state`
      )
    ).rejects.toThrow('No Obelus sign-in');
    expect(testHarness.fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a malformed authorization-response issuer and consumes the transaction', async () => {
    const testHarness = harness();
    const { completion, authorizationUrl } = await beginSignIn(testHarness);
    const signInFailure = completion.catch((error: unknown) => error);
    const state = authorizationUrl.searchParams.get('state');

    await expect(
      testHarness.adapter.handleProtocolUrl(
        `${AUTH0_GATEWAY_CALLBACK_URL}?code=authorization-code&state=${state}&iss=not-a-url`
      )
    ).rejects.toThrow('issuer did not match');
    await expect(signInFailure).resolves.toMatchObject({
      message: expect.stringContaining('issuer'),
    });
    await expect(
      testHarness.adapter.handleProtocolUrl(
        `${AUTH0_GATEWAY_CALLBACK_URL}?code=authorization-code&state=${state}`
      )
    ).rejects.toThrow('No Obelus sign-in');
    expect(testHarness.fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a nonce mismatch, device mismatch, refresh token, and invalid signature', async () => {
    for (const testHarness of [
      harness({}, {}, { nonce: 'wrong-nonce' }),
      harness({}, { [AUTH0_GATEWAY_DEVICE_CLAIM]: 'different-installation-id' }),
      harness({ refresh_token: 'must-not-be-issued' }),
    ]) {
      const { completion, authorizationUrl } = await beginSignIn(testHarness);
      const signInFailure = completion.catch((error: unknown) => error);
      await expect(
        testHarness.adapter.handleProtocolUrl(
          `${AUTH0_GATEWAY_CALLBACK_URL}?code=authorization-code&state=${authorizationUrl.searchParams.get('state')}`
        )
      ).rejects.toThrow();
      await expect(signInFailure).resolves.toBeInstanceOf(Error);
      await expect(testHarness.adapter.getSession()).resolves.toBeNull();
    }

    const invalidSignature = harness();
    invalidSignature.fetchImpl.mockImplementationOnce(async () => {
      const now = Math.floor(NOW_MS / 1_000);
      const signature = Buffer.alloc(256, 7).toString('base64url');
      return jsonResponse({
        access_token: jwt(
          {
            iss: ISSUER,
            aud: AUDIENCE,
            azp: CLIENT_ID,
            sub: 'auth0|obelus-user',
            iat: now,
            exp: now + 600,
            [AUTH0_GATEWAY_DEVICE_CLAIM]: DEVICE_ID,
            [AUTH0_GATEWAY_EMAIL_CLAIM]: 'verified@example.com',
          },
          signature
        ),
        id_token: jwt({}),
        token_type: 'Bearer',
        expires_in: 600,
      });
    });
    const { completion, authorizationUrl } = await beginSignIn(invalidSignature);
    const signInFailure = completion.catch((error: unknown) => error);
    await expect(
      invalidSignature.adapter.handleProtocolUrl(
        `${AUTH0_GATEWAY_CALLBACK_URL}?code=authorization-code&state=${authorizationUrl.searchParams.get('state')}`
      )
    ).rejects.toThrow('signature is invalid');
    await expect(signInFailure).resolves.toBeInstanceOf(Error);
  });

  it('rejects a gateway access token whose lifetime exceeds the staging 600-second contract', async () => {
    const nowSeconds = Math.floor(NOW_MS / 1_000);
    const testHarness = harness({}, { exp: nowSeconds + 601 });
    const { completion, authorizationUrl } = await beginSignIn(testHarness);
    const signInFailure = completion.catch((error: unknown) => error);

    await expect(
      testHarness.adapter.handleProtocolUrl(
        `${AUTH0_GATEWAY_CALLBACK_URL}?code=authorization-code&state=${authorizationUrl.searchParams.get('state')}`
      )
    ).rejects.toThrow('overlong token');
    await expect(signInFailure).resolves.toBeInstanceOf(Error);
    await expect(testHarness.adapter.getSession()).resolves.toBeNull();
  });

  it('keeps valid access tokens only in memory and requires interactive login after expiry', async () => {
    let now = NOW_MS;
    const testHarness = harness({}, {}, {}, () => now);
    const { completion, authorizationUrl } = await beginSignIn(testHarness);
    await testHarness.adapter.handleProtocolUrl(
      `${AUTH0_GATEWAY_CALLBACK_URL}?code=authorization-code&state=${authorizationUrl.searchParams.get('state')}`
    );
    await completion;
    const valid = await testHarness.adapter.getSession();
    expect(valid).toMatchObject({ accessToken: expect.any(String) });
    await expect(testHarness.adapter.refreshSession(valid!)).resolves.toEqual(valid);
    const fetchCallCount = testHarness.fetchImpl.mock.calls.length;

    now += 600_001;
    await expect(testHarness.adapter.getSession()).resolves.toBeNull();
    await expect(testHarness.adapter.refreshSession(valid!)).resolves.toBeNull();
    expect(testHarness.fetchImpl).toHaveBeenCalledTimes(fetchCallCount);
  });

  it('clears the in-memory session before opening the exact logout URL', async () => {
    const testHarness = harness();
    const { completion, authorizationUrl } = await beginSignIn(testHarness);
    await testHarness.adapter.handleProtocolUrl(
      `${AUTH0_GATEWAY_CALLBACK_URL}?code=authorization-code&state=${authorizationUrl.searchParams.get('state')}`
    );
    await completion;

    await expect(testHarness.adapter.signOut()).resolves.toMatchObject({ authenticated: false });
    await expect(testHarness.adapter.getSession()).resolves.toBeNull();
    const logoutUrl = new URL(testHarness.opened[1]);
    expect(logoutUrl.origin).toBe('https://obelus-staging.us.auth0.com');
    expect(logoutUrl.pathname).toBe('/v2/logout');
    expect(logoutUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(logoutUrl.searchParams.get('returnTo')).toBe(AUTH0_GATEWAY_LOGOUT_CALLBACK_URL);
  });
});

describe('Auth0 gateway configuration and callback boundary', () => {
  it('normalizes a complete configuration and rejects partial or insecure values', () => {
    expect(
      parseAuth0GatewayIdentityConfig({
        OBELUS_AUTH0_ISSUER: 'https://obelus-staging.us.auth0.com',
        OBELUS_AUTH0_CLIENT_ID: CLIENT_ID,
        OBELUS_AUTH0_AUDIENCE: AUDIENCE,
      })
    ).toEqual(config);
    expect(parseAuth0GatewayIdentityConfig({})).toBeNull();
    expect(() => parseAuth0GatewayIdentityConfig({ OBELUS_AUTH0_ISSUER: ISSUER })).toThrow(
      'incomplete'
    );
    expect(() =>
      parseAuth0GatewayIdentityConfig({
        OBELUS_AUTH0_ISSUER: 'http://obelus-staging.us.auth0.com/',
        OBELUS_AUTH0_CLIENT_ID: CLIENT_ID,
        OBELUS_AUTH0_AUDIENCE: AUDIENCE,
      })
    ).toThrow('HTTPS');
  });

  it('accepts only the exact Obelus auth callback and logout routes', () => {
    expect(isAuth0GatewayProtocolUrl(AUTH0_GATEWAY_CALLBACK_URL)).toBe(true);
    expect(isAuth0GatewayProtocolUrl(AUTH0_GATEWAY_LOGOUT_CALLBACK_URL)).toBe(true);
    expect(isAuth0GatewayProtocolUrl('obelus://auth/callback/extra')).toBe(false);
    expect(isAuth0GatewayProtocolUrl('obelus://other/callback')).toBe(false);
    expect(isAuth0GatewayProtocolUrl('https://auth/callback')).toBe(false);
    expect(isAuth0GatewayProtocolUrl('goose://auth/callback')).toBe(false);
  });
});
