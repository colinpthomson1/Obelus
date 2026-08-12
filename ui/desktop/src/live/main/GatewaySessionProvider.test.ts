import { describe, expect, it, vi } from 'vitest';
import { GatewaySessionProvider } from './GatewaySessionProvider';

describe('GatewaySessionProvider', () => {
  it('refuses a static credential in packaged or production builds', async () => {
    const provider = new GatewaySessionProvider({
      mode: 'dev-static',
      devToken: 'do-not-expose',
      isPackaged: true,
      isProduction: false,
    });
    expect(provider.getAvailability().available).toBe(false);
    await expect(provider.getAuthorizationHeader()).rejects.toThrow('disabled');
  });

  it('fails closed when jwt mode has no identity adapter', async () => {
    const provider = new GatewaySessionProvider({
      mode: 'jwt',
      isPackaged: true,
      isProduction: true,
    });
    await expect(provider.getAuthorizationHeader()).rejects.toThrow('signed-in');
  });

  it('refreshes an expiring identity session before returning authorization', async () => {
    const adapter = {
      getSession: vi.fn(async () => ({
        accessToken: 'old',
        expiresAtEpochMs: 10_001,
        principalId: 'principal',
        deviceId: 'device',
      })),
      refreshSession: vi.fn(async () => ({
        accessToken: 'new',
        expiresAtEpochMs: 100_000,
        principalId: 'principal',
        deviceId: 'device',
      })),
    };
    const provider = new GatewaySessionProvider({
      mode: 'jwt',
      identityAdapter: adapter,
      isPackaged: true,
      isProduction: true,
      now: () => 10_000,
    });
    await expect(provider.getAuthorizationHeader()).resolves.toBe('Bearer new');
    expect(adapter.refreshSession).toHaveBeenCalledTimes(1);
  });
});
