export type GatewayAuthMode = 'dev-static' | 'jwt';

export interface GatewayIdentitySession {
  accessToken: string;
  expiresAtEpochMs: number;
  principalId: string;
  deviceId: string;
}

export interface GatewayIdentityAdapter {
  getSession(): Promise<GatewayIdentitySession | null>;
  refreshSession(session: GatewayIdentitySession): Promise<GatewayIdentitySession | null>;
  clearSession?(): Promise<void>;
}

export interface GatewaySessionProviderOptions {
  mode: GatewayAuthMode;
  devToken?: string;
  identityAdapter?: GatewayIdentityAdapter;
  isPackaged: boolean;
  isProduction: boolean;
  now?: () => number;
}

export interface GatewaySessionAvailability {
  available: boolean;
  reason?: string;
}

let registeredIdentityAdapter: GatewayIdentityAdapter | undefined;
let identityAdapterRegistrationLocked = false;

export function registerGatewayIdentityAdapter(adapter: GatewayIdentityAdapter): void {
  if (identityAdapterRegistrationLocked || registeredIdentityAdapter) {
    throw new Error('Gateway identity adapter registration is already closed');
  }
  registeredIdentityAdapter = adapter;
}

export function resolveGatewayIdentityAdapter(): GatewayIdentityAdapter | undefined {
  identityAdapterRegistrationLocked = true;
  return registeredIdentityAdapter;
}

const REFRESH_WINDOW_MS = 60_000;
const MAX_ACCESS_TOKEN_LENGTH = 16_384;

export class GatewaySessionProvider {
  private readonly now: () => number;

  constructor(private readonly options: GatewaySessionProviderOptions) {
    this.now = options.now ?? Date.now;
  }

  getAvailability(): GatewaySessionAvailability {
    if (this.options.mode === 'dev-static') {
      if (this.options.isPackaged || this.options.isProduction) {
        return {
          available: false,
          reason: 'Local gateway authentication is disabled in production builds.',
        };
      }
      if (
        !this.options.devToken ||
        this.options.devToken.length < 32 ||
        this.options.devToken.length > MAX_ACCESS_TOKEN_LENGTH ||
        /\s/.test(this.options.devToken)
      ) {
        return { available: false, reason: 'Local gateway authentication is not configured.' };
      }
      return { available: true };
    }

    if (!this.options.identityAdapter) {
      return {
        available: false,
        reason: 'A signed-in Obelus session is required for live research.',
      };
    }
    return { available: true };
  }

  async getAuthorizationHeader(): Promise<string> {
    const availability = this.getAvailability();
    if (!availability.available) {
      throw new Error(availability.reason ?? 'Gateway authentication is unavailable');
    }

    if (this.options.mode === 'dev-static') {
      return `Bearer ${this.options.devToken}`;
    }

    const adapter = this.options.identityAdapter;
    if (!adapter) throw new Error('Gateway authentication is unavailable');
    let session: GatewayIdentitySession | null;
    try {
      session = await adapter.getSession();
    } catch {
      throw new Error('The Obelus session could not be verified');
    }
    if (!session) throw new Error('A signed-in Obelus session is required for live research');

    if (session.expiresAtEpochMs <= this.now() + REFRESH_WINDOW_MS) {
      try {
        session = await adapter.refreshSession(session);
      } catch {
        session = null;
      }
    }
    if (!session || !this.isValidSession(session)) {
      await adapter.clearSession?.().catch(() => undefined);
      throw new Error('The Obelus session has expired; sign in again to continue live research');
    }
    return `Bearer ${session.accessToken}`;
  }

  private isValidSession(session: GatewayIdentitySession): boolean {
    return (
      session.accessToken.length > 0 &&
      session.accessToken.length <= MAX_ACCESS_TOKEN_LENGTH &&
      !/\s/.test(session.accessToken) &&
      session.principalId.length > 0 &&
      session.principalId.length <= 256 &&
      session.deviceId.length > 0 &&
      session.deviceId.length <= 256 &&
      Number.isSafeInteger(session.expiresAtEpochMs) &&
      session.expiresAtEpochMs > this.now()
    );
  }
}
