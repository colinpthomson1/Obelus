import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type KeyObject,
  type webcrypto,
} from 'node:crypto';
import type {
  GatewayIdentityAdapter,
  GatewayIdentitySession,
  GatewaySessionAvailability,
} from './GatewaySessionProvider';
import type { GatewayAuthenticationStatus } from '../ipcTypes';

export const AUTH0_GATEWAY_CALLBACK_URL = 'obelus://auth/callback';
export const AUTH0_GATEWAY_LOGOUT_CALLBACK_URL = 'obelus://auth/logout';
export const AUTH0_GATEWAY_DEVICE_PARAMETER = 'obelus_device_id';
export const AUTH0_GATEWAY_DEVICE_CLAIM = 'https://obelus.ai/claims/device_id';
export const AUTH0_GATEWAY_EMAIL_CLAIM = 'https://obelus.ai/claims/email';

const AUTHORIZATION_PATH = '/authorize';
const TOKEN_PATH = '/oauth/token';
const LOGOUT_PATH = '/v2/logout';
const AUTHORIZATION_SCOPE = 'openid profile email';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;
const JWKS_REQUEST_TIMEOUT_MS = 10_000;
const JWKS_CACHE_MS = 5 * 60 * 1_000;
const MAX_CALLBACK_LENGTH = 8_192;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_TOKEN_RESPONSE_LENGTH = 64 * 1_024;
const CLOCK_SKEW_SECONDS = 60;
const MAX_GATEWAY_TOKEN_LIFETIME_SECONDS = 10 * 60;
const MAX_IDENTITY_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._~-]{8,256}$/;
const OAUTH_VALUE_PATTERN = /^[\x21-\x7e]{1,512}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface Auth0GatewayIdentityConfig {
  issuer: string;
  clientId: string;
  audience: string;
  redirectUri: typeof AUTH0_GATEWAY_CALLBACK_URL;
  logoutRedirectUri: typeof AUTH0_GATEWAY_LOGOUT_CALLBACK_URL;
}

export interface Auth0GatewayIdentityEnvironment {
  OBELUS_AUTH0_ISSUER?: string;
  OBELUS_AUTH0_CLIENT_ID?: string;
  OBELUS_AUTH0_AUDIENCE?: string;
}

export interface Auth0GatewayIdentityDependencies {
  getInstallationDeviceId(): Promise<string>;
  openExternal(url: string): Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  randomBytesImpl?: (size: number) => Uint8Array;
}

export interface InteractiveGatewayIdentityAdapter extends GatewayIdentityAdapter {
  getAuthenticationStatus(): GatewayAuthenticationStatus;
  signIn(): Promise<GatewayAuthenticationStatus>;
  signOut(): Promise<GatewayAuthenticationStatus>;
  handleProtocolUrl(url: string): Promise<boolean>;
}

interface OAuthTransaction {
  state: string;
  nonce: string;
  verifier: string;
  deviceId: string;
  startedAtEpochMs: number;
  resolve(session: GatewayIdentitySession): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface OAuthSignInAttempt {
  cancelled: Error | null;
}

interface JwtPayload {
  [claim: string]: unknown;
}

interface JwtHeader {
  alg: 'RS256';
  kid: string;
  typ?: 'JWT' | 'at+jwt';
}

interface ParsedJwt {
  header: JwtHeader;
  payload: JwtPayload;
  signingInput: string;
  signature: Buffer;
}

interface TokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  refresh_token?: unknown;
}

export function parseAuth0GatewayIdentityConfig(
  environment: Auth0GatewayIdentityEnvironment
): Auth0GatewayIdentityConfig | null {
  const values = {
    issuer: environment.OBELUS_AUTH0_ISSUER?.trim() ?? '',
    clientId: environment.OBELUS_AUTH0_CLIENT_ID?.trim() ?? '',
    audience: environment.OBELUS_AUTH0_AUDIENCE?.trim() ?? '',
  };
  const configuredCount = Object.values(values).filter(Boolean).length;
  if (configuredCount === 0) return null;
  if (configuredCount !== Object.keys(values).length) {
    throw new Error('Obelus Auth0 configuration is incomplete');
  }

  const issuer = normalizeIssuer(values.issuer);
  if (!CLIENT_ID_PATTERN.test(values.clientId)) {
    throw new Error('Obelus Auth0 client ID is invalid');
  }
  if (!OAUTH_VALUE_PATTERN.test(values.audience) || /[\s&=]/.test(values.audience)) {
    throw new Error('Obelus Auth0 audience is invalid');
  }

  return {
    issuer,
    clientId: values.clientId,
    audience: values.audience,
    redirectUri: AUTH0_GATEWAY_CALLBACK_URL,
    logoutRedirectUri: AUTH0_GATEWAY_LOGOUT_CALLBACK_URL,
  };
}

export function isAuth0GatewayProtocolUrl(value: string): boolean {
  if (!value || value.length > MAX_CALLBACK_LENGTH) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'obelus:' &&
      parsed.hostname === 'auth' &&
      parsed.port === '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      (parsed.pathname === '/callback' || parsed.pathname === '/logout')
    );
  } catch {
    return false;
  }
}

export class Auth0GatewayIdentityAdapter implements InteractiveGatewayIdentityAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly randomBytesImpl: (size: number) => Uint8Array;
  private session: GatewayIdentitySession | null = null;
  private signInAttempt: OAuthSignInAttempt | null = null;
  private transaction: OAuthTransaction | null = null;
  private jwksCache: { expiresAtEpochMs: number; keys: Map<string, KeyObject> } | null = null;

  constructor(
    private readonly config: Auth0GatewayIdentityConfig,
    private readonly dependencies: Auth0GatewayIdentityDependencies
  ) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.randomBytesImpl = dependencies.randomBytesImpl ?? randomBytes;
  }

  getAvailability(): GatewaySessionAvailability {
    const session = this.currentSession();
    return session
      ? { available: true }
      : {
          available: false,
          reason: 'Sign in to Obelus to use hosted live research.',
        };
  }

  getAuthenticationStatus(): GatewayAuthenticationStatus {
    const session = this.currentSession();
    return session
      ? {
          configured: true,
          authenticated: true,
          expiresAtEpochMs: session.expiresAtEpochMs,
        }
      : {
          configured: true,
          authenticated: false,
          reason: 'Sign in to use hosted live research.',
        };
  }

  async getSession(): Promise<GatewayIdentitySession | null> {
    return cloneSession(this.currentSession());
  }

  async refreshSession(session: GatewayIdentitySession): Promise<GatewayIdentitySession | null> {
    const current = this.currentSession();
    if (!current || current.accessToken !== session.accessToken) return null;

    // Auth0 Essentials cannot safely carry this installation's client-asserted device
    // partition through refresh-token rotation. Keep the valid token until expiry and
    // require a fresh interactive PKCE authorization after that point.
    return cloneSession(current);
  }

  async clearSession(): Promise<void> {
    this.session = null;
  }

  async signIn(): Promise<GatewayAuthenticationStatus> {
    if (this.signInAttempt) throw new Error('Obelus sign-in is already in progress');

    const attempt: OAuthSignInAttempt = { cancelled: null };
    this.signInAttempt = attempt;
    try {
      const deviceId = await this.dependencies.getInstallationDeviceId();
      if (attempt.cancelled || this.signInAttempt !== attempt) {
        throw attempt.cancelled ?? new Error('Obelus sign-in was cancelled');
      }
      assertDeviceId(deviceId);
      const state = this.randomValue(32);
      const nonce = this.randomValue(32);
      const verifier = this.randomValue(64);
      const challenge = base64Url(createHash('sha256').update(verifier).digest());

      let resolveTransaction!: (session: GatewayIdentitySession) => void;
      let rejectTransaction!: (error: Error) => void;
      const completion = new Promise<GatewayIdentitySession>((resolve, reject) => {
        resolveTransaction = resolve;
        rejectTransaction = reject;
      });
      void completion.catch(() => undefined);
      let transaction!: OAuthTransaction;
      const timeout = setTimeout(() => {
        this.failTransaction(new Error('Obelus sign-in timed out'), transaction);
      }, LOGIN_TIMEOUT_MS);
      timeout.unref?.();
      transaction = {
        state,
        nonce,
        verifier,
        deviceId,
        startedAtEpochMs: this.now(),
        resolve: resolveTransaction,
        reject: rejectTransaction,
        timeout,
      };
      this.transaction = transaction;

      const authorizationUrl = new URL(AUTHORIZATION_PATH, this.config.issuer);
      authorizationUrl.searchParams.set('response_type', 'code');
      authorizationUrl.searchParams.set('client_id', this.config.clientId);
      authorizationUrl.searchParams.set('redirect_uri', this.config.redirectUri);
      authorizationUrl.searchParams.set('scope', AUTHORIZATION_SCOPE);
      authorizationUrl.searchParams.set('audience', this.config.audience);
      authorizationUrl.searchParams.set('state', state);
      authorizationUrl.searchParams.set('nonce', nonce);
      authorizationUrl.searchParams.set('code_challenge', challenge);
      authorizationUrl.searchParams.set('code_challenge_method', 'S256');
      authorizationUrl.searchParams.set(AUTH0_GATEWAY_DEVICE_PARAMETER, deviceId);

      try {
        await this.dependencies.openExternal(authorizationUrl.toString());
      } catch {
        this.failTransaction(new Error('Obelus could not open the sign-in page'), transaction);
      }
      await completion;
      return this.getAuthenticationStatus();
    } finally {
      if (this.signInAttempt === attempt) this.signInAttempt = null;
    }
  }

  async signOut(): Promise<GatewayAuthenticationStatus> {
    const cancellation = new Error('Obelus sign-in was cancelled');
    if (this.signInAttempt) {
      this.signInAttempt.cancelled = cancellation;
      this.signInAttempt = null;
    }
    this.cancelTransaction(cancellation);
    this.session = null;

    const logoutUrl = new URL(LOGOUT_PATH, this.config.issuer);
    logoutUrl.searchParams.set('client_id', this.config.clientId);
    logoutUrl.searchParams.set('returnTo', this.config.logoutRedirectUri);
    await this.dependencies.openExternal(logoutUrl.toString());
    return this.getAuthenticationStatus();
  }

  async handleProtocolUrl(value: string): Promise<boolean> {
    if (!isAuth0GatewayProtocolUrl(value)) return false;
    const callback = new URL(value);
    if (callback.pathname === '/logout') {
      if (callback.search || callback.hash) {
        throw new Error('The Obelus logout callback is invalid');
      }
      this.session = null;
      return true;
    }
    if (callback.hash || hasDuplicateParameters(callback.searchParams)) {
      this.failTransaction(new Error('The Obelus sign-in callback is invalid'));
      throw new Error('The Obelus sign-in callback is invalid');
    }

    const transaction = this.transaction;
    if (!transaction) throw new Error('No Obelus sign-in is in progress');
    if (this.now() - transaction.startedAtEpochMs > LOGIN_TIMEOUT_MS) {
      const error = new Error('Obelus sign-in timed out');
      this.failTransaction(error);
      throw error;
    }

    const state = singleParameter(callback.searchParams, 'state');
    if (!state || !constantTimeEqual(state, transaction.state)) {
      const error = new Error('The Obelus sign-in state did not match');
      this.failTransaction(error);
      throw error;
    }
    const returnedIssuer = singleParameter(callback.searchParams, 'iss');
    let issuerMatches = true;
    if (returnedIssuer) {
      try {
        issuerMatches = normalizeIssuer(returnedIssuer) === this.config.issuer;
      } catch {
        issuerMatches = false;
      }
    }
    if (!issuerMatches) {
      const error = new Error('The Obelus sign-in issuer did not match');
      this.failTransaction(error);
      throw error;
    }
    const oauthError = singleParameter(callback.searchParams, 'error');
    if (oauthError) {
      const error = new Error(
        oauthError === 'access_denied'
          ? 'Obelus sign-in was cancelled'
          : 'The identity provider rejected Obelus sign-in'
      );
      this.failTransaction(error);
      throw error;
    }
    const code = singleParameter(callback.searchParams, 'code');
    if (!code || code.length > 2_048 || !OAUTH_VALUE_PATTERN.test(code)) {
      const error = new Error('The Obelus sign-in callback did not contain a valid code');
      this.failTransaction(error);
      throw error;
    }

    try {
      const response = await this.exchangeCode(code, transaction.verifier);
      const session = await this.validateTokens(response, transaction);
      if (this.transaction !== transaction) throw new Error('Obelus sign-in was cancelled');
      this.session = session;
      this.completeTransaction(session, transaction);
      return true;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('Obelus could not complete sign-in');
      this.failTransaction(error, transaction);
      throw error;
    }
  }

  private currentSession(): GatewayIdentitySession | null {
    if (this.session && this.session.expiresAtEpochMs <= this.now()) this.session = null;
    return this.session;
  }

  private randomValue(size: number): string {
    const value = base64Url(this.randomBytesImpl(size));
    if (!BASE64URL_PATTERN.test(value)) throw new Error('Secure randomness is unavailable');
    return value;
  }

  private async exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: this.config.redirectUri,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(TOKEN_PATH, this.config.issuer), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      throw new Error('The identity provider could not be reached');
    } finally {
      clearTimeout(timeout);
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('application/json')) {
      throw new Error('The identity provider returned an invalid response');
    }
    const text = await response.text();
    if (text.length === 0 || text.length > MAX_TOKEN_RESPONSE_LENGTH) {
      throw new Error('The identity provider returned an invalid response');
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('The identity provider returned an invalid response');
    }
    if (!response.ok) throw new Error('The identity provider rejected the token exchange');
    return parseTokenResponse(value);
  }

  private async validateTokens(
    response: TokenResponse,
    transaction: OAuthTransaction
  ): Promise<GatewayIdentitySession> {
    const access = await this.verifyJwt(response.access_token);
    const identity = await this.verifyJwt(response.id_token);
    const nowSeconds = Math.floor(this.now() / 1_000);

    validateJwtTimeAndIssuer(
      access,
      this.config.issuer,
      nowSeconds,
      MAX_GATEWAY_TOKEN_LIFETIME_SECONDS
    );
    validateAudience(access.aud, this.config.audience);
    if (access.azp !== this.config.clientId) {
      throw new Error('The gateway token was issued to another client');
    }
    const subject = boundedClaim(access.sub, 'subject', 256);
    const deviceId = boundedClaim(access[AUTH0_GATEWAY_DEVICE_CLAIM], 'device identity', 128);
    const email = boundedClaim(access[AUTH0_GATEWAY_EMAIL_CLAIM], 'email identity', 320);
    if (!DEVICE_ID_PATTERN.test(deviceId) || deviceId !== transaction.deviceId) {
      throw new Error('The gateway token did not match this Obelus installation');
    }
    if (!isEmailClaim(email)) throw new Error('The gateway token email claim is invalid');

    validateJwtTimeAndIssuer(
      identity,
      this.config.issuer,
      nowSeconds,
      MAX_IDENTITY_TOKEN_LIFETIME_SECONDS
    );
    validateAudience(identity.aud, this.config.clientId);
    if (identity.azp !== undefined && identity.azp !== this.config.clientId) {
      throw new Error('The identity token was issued to another client');
    }
    if (!constantTimeEqual(boundedClaim(identity.nonce, 'nonce', 256), transaction.nonce)) {
      throw new Error('The Obelus sign-in nonce did not match');
    }
    if (boundedClaim(identity.sub, 'subject', 256) !== subject) {
      throw new Error('The Obelus identity tokens did not agree');
    }

    const tokenExpiryMs = numberClaim(access.exp, 'expiration') * 1_000;
    const responseExpiryMs = this.now() + response.expires_in * 1_000;
    if (Math.abs(tokenExpiryMs - responseExpiryMs) > 90 * 1_000) {
      throw new Error('The identity provider returned an inconsistent expiration');
    }
    return {
      accessToken: response.access_token,
      expiresAtEpochMs: tokenExpiryMs,
      principalId: subject,
      deviceId,
    };
  }

  private async verifyJwt(token: string): Promise<JwtPayload> {
    const parsed = parseJwt(token);
    let key = (await this.getJwks(false)).get(parsed.header.kid);
    if (!key) key = (await this.getJwks(true)).get(parsed.header.kid);
    if (!key) throw new Error('The identity provider token signing key is unknown');
    if (!verify('RSA-SHA256', Buffer.from(parsed.signingInput), key, parsed.signature)) {
      throw new Error('The identity provider token signature is invalid');
    }
    return parsed.payload;
  }

  private async getJwks(forceRefresh: boolean): Promise<Map<string, KeyObject>> {
    if (!forceRefresh && this.jwksCache && this.jwksCache.expiresAtEpochMs > this.now()) {
      return this.jwksCache.keys;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JWKS_REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(new URL('/.well-known/jwks.json', this.config.issuer), {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      throw new Error('The identity provider signing keys could not be reached');
    } finally {
      clearTimeout(timeout);
    }
    if (
      !response.ok ||
      !(response.headers.get('content-type') ?? '').startsWith('application/json')
    ) {
      throw new Error('The identity provider returned invalid signing keys');
    }
    const text = await response.text();
    if (text.length === 0 || text.length > MAX_TOKEN_RESPONSE_LENGTH) {
      throw new Error('The identity provider returned invalid signing keys');
    }
    const keys = parseJwks(text);
    this.jwksCache = { expiresAtEpochMs: this.now() + JWKS_CACHE_MS, keys };
    return keys;
  }

  private completeTransaction(
    session: GatewayIdentitySession,
    expectedTransaction: OAuthTransaction
  ): void {
    const transaction = this.transaction;
    if (transaction !== expectedTransaction) return;
    this.transaction = null;
    clearTimeout(transaction.timeout);
    transaction.resolve(cloneSession(session)!);
  }

  private failTransaction(error: Error, expectedTransaction?: OAuthTransaction): void {
    if (expectedTransaction && this.transaction !== expectedTransaction) return;
    this.session = null;
    this.cancelTransaction(error);
  }

  private cancelTransaction(error: Error): void {
    const transaction = this.transaction;
    this.transaction = null;
    if (!transaction) return;
    clearTimeout(transaction.timeout);
    transaction.reject(error);
  }
}

function normalizeIssuer(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Obelus Auth0 issuer is invalid');
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Obelus Auth0 issuer must be an HTTPS origin');
  }
  return `${parsed.origin}/`;
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The identity provider returned an invalid response');
  }
  const record = value as Record<string, unknown>;
  const accessToken = tokenValue(record.access_token, 'access token');
  const idToken = tokenValue(record.id_token, 'identity token');
  if (typeof record.token_type !== 'string' || record.token_type.toLowerCase() !== 'bearer') {
    throw new Error('The identity provider returned an unsupported token type');
  }
  if (
    !Number.isSafeInteger(record.expires_in) ||
    (record.expires_in as number) < 60 ||
    (record.expires_in as number) > MAX_GATEWAY_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error('The identity provider returned an invalid expiration');
  }
  if (record.refresh_token !== undefined) {
    throw new Error('The identity provider returned a disallowed refresh token');
  }
  if (record.scope !== undefined) {
    if (typeof record.scope !== 'string') {
      throw new Error('The identity provider returned an invalid scope');
    }
    const scopes = new Set(record.scope.split(/\s+/).filter(Boolean));
    if (scopes.has('offline_access')) {
      throw new Error('The identity provider returned a disallowed offline scope');
    }
  }
  return {
    access_token: accessToken,
    id_token: idToken,
    token_type: record.token_type,
    expires_in: record.expires_in as number,
    ...(record.scope === undefined ? {} : { scope: record.scope }),
  };
}

function tokenValue(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value.length > MAX_TOKEN_LENGTH ||
    /\s/.test(value)
  ) {
    throw new Error(`The identity provider returned an invalid ${label}`);
  }
  return value;
}

function parseJwt(token: string): ParsedJwt {
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((segment) => !BASE64URL_PATTERN.test(segment))) {
    throw new Error('The identity provider returned a malformed token');
  }
  const rawHeader = decodeJwtPart(segments[0]);
  const payload = decodeJwtPart(segments[1]);
  if (
    rawHeader.alg !== 'RS256' ||
    typeof rawHeader.kid !== 'string' ||
    rawHeader.kid.length < 1 ||
    rawHeader.kid.length > 256 ||
    !OAUTH_VALUE_PATTERN.test(rawHeader.kid) ||
    (rawHeader.typ !== undefined && rawHeader.typ !== 'JWT' && rawHeader.typ !== 'at+jwt')
  ) {
    throw new Error('The identity provider returned an unsupported token');
  }
  const signature = Buffer.from(segments[2], 'base64url');
  if (signature.length < 256 || signature.length > 1_024) {
    throw new Error('The identity provider returned a malformed token');
  }
  return {
    header: rawHeader as unknown as JwtHeader,
    payload,
    signingInput: `${segments[0]}.${segments[1]}`,
    signature,
  };
}

function decodeJwtPart(value: string): JwtPayload {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as JwtPayload;
  } catch {
    throw new Error('The identity provider returned a malformed token');
  }
}

function parseJwks(text: string): Map<string, KeyObject> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The identity provider returned invalid signing keys');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The identity provider returned invalid signing keys');
  }
  const rawKeys = (value as Record<string, unknown>).keys;
  if (!Array.isArray(rawKeys) || rawKeys.length === 0 || rawKeys.length > 20) {
    throw new Error('The identity provider returned invalid signing keys');
  }
  const keys = new Map<string, KeyObject>();
  for (const candidate of rawKeys) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const key = candidate as Record<string, unknown>;
    if (
      key.kty !== 'RSA' ||
      (key.use !== undefined && key.use !== 'sig') ||
      (key.alg !== undefined && key.alg !== 'RS256') ||
      typeof key.kid !== 'string' ||
      key.kid.length < 1 ||
      key.kid.length > 256 ||
      !OAUTH_VALUE_PATTERN.test(key.kid) ||
      typeof key.n !== 'string' ||
      key.n.length < 342 ||
      key.n.length > 1_024 ||
      !BASE64URL_PATTERN.test(key.n) ||
      typeof key.e !== 'string' ||
      key.e.length < 2 ||
      key.e.length > 16 ||
      !BASE64URL_PATTERN.test(key.e) ||
      (key.key_ops !== undefined &&
        (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify')))
    ) {
      continue;
    }
    if (keys.has(key.kid)) throw new Error('The identity provider returned duplicate signing keys');
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({
        key: candidate as unknown as webcrypto.JsonWebKey,
        format: 'jwk',
      });
    } catch {
      continue;
    }
    if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048) continue;
    keys.set(key.kid, publicKey);
  }
  if (keys.size === 0) throw new Error('The identity provider returned no usable signing keys');
  return keys;
}

function validateJwtTimeAndIssuer(
  payload: JwtPayload,
  issuer: string,
  nowSeconds: number,
  maxLifetimeSeconds: number
): void {
  if (payload.iss !== issuer) throw new Error('The identity provider issuer did not match');
  const issuedAt = numberClaim(payload.iat, 'issued-at time');
  const expiresAt = numberClaim(payload.exp, 'expiration');
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS || expiresAt <= nowSeconds) {
    throw new Error('The identity provider returned an expired token');
  }
  if (
    (payload.nbf !== undefined && numberClaim(payload.nbf, 'not-before time') > nowSeconds) ||
    expiresAt - issuedAt > maxLifetimeSeconds
  ) {
    throw new Error('The identity provider returned an overlong token');
  }
}

function validateAudience(value: unknown, expected: string): void {
  const audiences = typeof value === 'string' ? [value] : value;
  if (
    !Array.isArray(audiences) ||
    audiences.length === 0 ||
    audiences.some((audience) => typeof audience !== 'string') ||
    !audiences.includes(expected)
  ) {
    throw new Error('The identity provider audience did not match');
  }
}

function boundedClaim(value: unknown, label: string, maxLength: number): string {
  const containsControlCharacter =
    typeof value === 'string' &&
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    containsControlCharacter
  ) {
    throw new Error(`The identity provider returned an invalid ${label}`);
  }
  return value;
}

function numberClaim(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`The identity provider returned an invalid ${label}`);
  }
  return value as number;
}

function isEmailClaim(value: string): boolean {
  const at = value.indexOf('@');
  return at > 0 && at === value.lastIndexOf('@') && at < value.length - 1 && !/\s/.test(value);
}

function singleParameter(parameters: URLSearchParams, name: string): string | null {
  const values = parameters.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function hasDuplicateParameters(parameters: URLSearchParams): boolean {
  const seen = new Set<string>();
  for (const name of parameters.keys()) {
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

function assertDeviceId(value: string): void {
  if (!DEVICE_ID_PATTERN.test(value)) {
    throw new Error('The Obelus installation identity is invalid');
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function cloneSession(session: GatewayIdentitySession | null): GatewayIdentitySession | null {
  return session ? { ...session } : null;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}
