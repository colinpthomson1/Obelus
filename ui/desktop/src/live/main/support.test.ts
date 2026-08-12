import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateLiveSupport, getLiveSupportStatus, resolveMicrophonePermission } from './support';

const electronMocks = vi.hoisted(() => ({
  askForMediaAccess: vi.fn(),
  getMediaAccessStatus: vi.fn(),
}));

vi.mock('electron', () => ({
  systemPreferences: {
    askForMediaAccess: electronMocks.askForMediaAccess,
    getMediaAccessStatus: electronMocks.getMediaAccessStatus,
  },
}));

describe('evaluateLiveSupport', () => {
  beforeEach(() => {
    electronMocks.askForMediaAccess.mockReset();
    electronMocks.getMediaAccessStatus.mockReset();
  });

  it('enables full call capture on supported macOS while requiring a health check', () => {
    const status = evaluateLiveSupport({
      platform: 'darwin',
      systemVersion: '14.4.1',
      microphonePermission: 'granted',
      gatewayAvailable: true,
    });
    expect(status.fullCallCaptureSupported).toBe(true);
    expect(status.systemAudioRequiresHealthCheck).toBe(true);
    expect(status.systemAudioPermission).toBe('unknown');
    expect(status.localFactCheckMode).toBe('hosted');
    expect(status.directFactCheckFallbackEnabled).toBe(false);
  });

  it('reports explicit direct fallback separately from the preferred hosted mode', () => {
    const status = evaluateLiveSupport({
      platform: 'darwin',
      systemVersion: '14.4.1',
      microphonePermission: 'granted',
      gatewayAvailable: true,
      localFactCheckMode: 'hosted',
      directFactCheckFallbackEnabled: true,
    });

    expect(status.localFactCheckMode).toBe('hosted');
    expect(status.directFactCheckFallbackEnabled).toBe(true);
  });

  it('recognizes the decorated macOS version returned by newer Electron builds', () => {
    const status = evaluateLiveSupport({
      platform: 'darwin',
      systemVersion: 'macOS Version 26.4 (Build 25E246)',
      microphonePermission: 'granted',
      gatewayAvailable: true,
    });
    expect(status.macosVersion).toBe('26.4.0');
    expect(status.fullCallCaptureSupported).toBe(true);
    expect(status.systemAudioRequiresHealthCheck).toBe(true);
  });

  it('fails open to microphone-only when the macOS version cannot be read', () => {
    const status = evaluateLiveSupport({
      platform: 'darwin',
      systemVersion: 'unknown',
      microphonePermission: 'granted',
      gatewayAvailable: true,
    });
    expect(status.macosVersion).toBeNull();
    expect(status.microphoneOnlySupported).toBe(true);
    expect(status.fullCallCaptureSupported).toBe(false);
    expect(status.callUnavailableReason).toContain('Microphone-only');
  });

  it('supports system audio on macOS 13 through the ScreenCaptureKit path', () => {
    const status = evaluateLiveSupport({
      platform: 'darwin',
      systemVersion: '13.6.9',
      microphonePermission: 'granted',
      gatewayAvailable: false,
      gatewayUnavailableReason: 'not configured',
    });
    expect(status.microphoneOnlySupported).toBe(true);
    expect(status.fullCallCaptureSupported).toBe(true);
    expect(status.systemAudioRequiresHealthCheck).toBe(true);
    expect(status.callUnavailableReason).toBeUndefined();
    expect(status.gatewayAvailable).toBe(false);
  });

  it('keeps microphone-only mode usable below the system-audio floor', () => {
    const status = evaluateLiveSupport({
      platform: 'darwin',
      systemVersion: '12.7.6',
      microphonePermission: 'granted',
      gatewayAvailable: true,
    });
    expect(status.microphoneOnlySupported).toBe(true);
    expect(status.fullCallCaptureSupported).toBe(false);
    expect(status.callUnavailableReason).toContain('macOS 13');
  });

  it('does not substitute Screen Recording status for CoreAudio Tap authorization', async () => {
    electronMocks.getMediaAccessStatus.mockImplementation((mediaType: string) =>
      mediaType === 'microphone' ? 'granted' : 'denied'
    );
    const gateway = {
      checkHealth: vi.fn().mockResolvedValue({ available: true }),
    } as unknown as Parameters<typeof getLiveSupportStatus>[0];

    const status = await getLiveSupportStatus(gateway);

    expect(electronMocks.getMediaAccessStatus).toHaveBeenCalledTimes(1);
    expect(electronMocks.getMediaAccessStatus).toHaveBeenCalledWith('microphone');
    expect(status.systemAudioPermission).toBe('unknown');
    if (process.platform === 'darwin' && status.macosVersion !== null) {
      expect(status.fullCallCaptureSupported).toBe(true);
      expect(status.callUnavailableReason).toBeUndefined();
    }
  });

  it('reports on-device fact-check support separately from the hosted gateway', async () => {
    electronMocks.getMediaAccessStatus.mockReturnValue('granted');
    const gateway = {
      checkHealth: vi.fn().mockResolvedValue({ available: false, reason: 'not configured' }),
    } as unknown as Parameters<typeof getLiveSupportStatus>[0];
    const localFactCheck = {
      factCheckMode: 'local_wikimedia' as const,
      checkSupport: vi.fn().mockResolvedValue({
        available: true,
        mode: 'local_wikimedia' as const,
        model: 'qwen3.5:9b-q4_K_M' as const,
        evidenceScope:
          'Local evidence is limited to English Wikipedia and Wikidata, which are secondary reference sources. It does not search the wider web or primary-source databases.' as const,
      }),
    };

    const status = await getLiveSupportStatus(gateway, undefined, localFactCheck);

    expect(status.gatewayAvailable).toBe(false);
    expect(status.localFactCheckMode).toBe('local_wikimedia');
    expect(status.localFactCheckAvailable).toBe(true);
    expect(status.localFactCheckModel).toBe('qwen3.5:9b-q4_K_M');
    expect(status.localFactCheckEvidenceScope).toContain('English Wikipedia and Wikidata');
  });

  it('keeps local Wikimedia routing configured when Ollama health is unavailable', async () => {
    electronMocks.getMediaAccessStatus.mockReturnValue('granted');
    const gateway = {
      checkHealth: vi.fn().mockResolvedValue({ available: false, reason: 'not configured' }),
    } as unknown as Parameters<typeof getLiveSupportStatus>[0];
    const localFactCheck = {
      factCheckMode: 'local_wikimedia' as const,
      checkSupport: vi.fn().mockResolvedValue({
        available: false,
        mode: 'local_wikimedia' as const,
        model: 'qwen3.5:9b-q4_K_M' as const,
        evidenceScope:
          'Local evidence is limited to English Wikipedia and Wikidata, which are secondary reference sources. It does not search the wider web or primary-source databases.' as const,
        reason: 'Local fact-checking needs Ollama running on this Mac.',
      }),
    };

    const status = await getLiveSupportStatus(gateway, undefined, localFactCheck);

    expect(status.localFactCheckMode).toBe('local_wikimedia');
    expect(status.localFactCheckAvailable).toBe(false);
    expect(status.localFactCheckUnavailableReason).toContain('needs Ollama');
  });

  it('preserves local routing disclosure when its health probe rejects', async () => {
    electronMocks.getMediaAccessStatus.mockReturnValue('granted');
    const gateway = {
      checkHealth: vi.fn().mockResolvedValue({ available: false, reason: 'not configured' }),
    } as unknown as Parameters<typeof getLiveSupportStatus>[0];
    const localFactCheck = {
      factCheckMode: 'local_wikimedia' as const,
      checkSupport: vi.fn().mockRejectedValue(new Error('probe failed')),
    };

    const status = await getLiveSupportStatus(gateway, undefined, localFactCheck);

    expect(status.localFactCheckMode).toBe('local_wikimedia');
    expect(status.localFactCheckAvailable).toBe(false);
    expect(status.localFactCheckUnavailableReason).toBe('Fact-checking could not be reached.');
  });

  it('requests native microphone consent before the first packaged capture attempt', async () => {
    electronMocks.getMediaAccessStatus
      .mockReturnValueOnce('not-determined')
      .mockReturnValueOnce('granted');
    electronMocks.askForMediaAccess.mockResolvedValue(true);

    await expect(resolveMicrophonePermission('darwin')).resolves.toBe('granted');

    expect(electronMocks.askForMediaAccess).toHaveBeenCalledOnce();
    expect(electronMocks.askForMediaAccess).toHaveBeenCalledWith('microphone');
    expect(electronMocks.getMediaAccessStatus).toHaveBeenCalledTimes(2);
  });

  it('uses the native consent result if macOS has not refreshed its status yet', async () => {
    electronMocks.getMediaAccessStatus.mockReturnValue('not-determined');
    electronMocks.askForMediaAccess.mockResolvedValue(false);

    await expect(resolveMicrophonePermission('darwin')).resolves.toBe('denied');
  });

  it('uses the native consent result when the refreshed status is unknown', async () => {
    electronMocks.getMediaAccessStatus
      .mockReturnValueOnce('not-determined')
      .mockReturnValueOnce('unknown');
    electronMocks.askForMediaAccess.mockResolvedValue(true);

    await expect(resolveMicrophonePermission('darwin')).resolves.toBe('granted');
  });

  it('coalesces concurrent native microphone consent requests', async () => {
    let resolveConsent: ((granted: boolean) => void) | undefined;
    electronMocks.getMediaAccessStatus
      .mockReturnValueOnce('not-determined')
      .mockReturnValueOnce('not-determined')
      .mockReturnValue('granted');
    electronMocks.askForMediaAccess.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveConsent = resolve;
      })
    );

    const firstRequest = resolveMicrophonePermission('darwin');
    const secondRequest = resolveMicrophonePermission('darwin');
    expect(electronMocks.askForMediaAccess).toHaveBeenCalledOnce();

    resolveConsent?.(true);
    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([
      'granted',
      'granted',
    ]);
  });

  it('does not request native microphone consent outside macOS', async () => {
    electronMocks.getMediaAccessStatus.mockReturnValue('not-determined');

    await expect(resolveMicrophonePermission('linux')).resolves.toBe('not-determined');

    expect(electronMocks.askForMediaAccess).not.toHaveBeenCalled();
  });

  it('does not request native consent when microphone access is already decided', async () => {
    electronMocks.getMediaAccessStatus.mockReturnValue('restricted');

    await expect(resolveMicrophonePermission('darwin')).resolves.toBe('restricted');

    expect(electronMocks.askForMediaAccess).not.toHaveBeenCalled();
  });

  it('re-reads microphone status if the native request fails', async () => {
    electronMocks.getMediaAccessStatus
      .mockReturnValueOnce('not-determined')
      .mockReturnValueOnce('denied');
    electronMocks.askForMediaAccess.mockRejectedValue(new Error('unavailable'));

    await expect(resolveMicrophonePermission('darwin')).resolves.toBe('denied');
  });

  it('still blocks call capture when microphone access is denied', () => {
    const status = evaluateLiveSupport({
      platform: 'darwin',
      systemVersion: '15.0',
      microphonePermission: 'denied',
      gatewayAvailable: true,
    });
    expect(status.fullCallCaptureSupported).toBe(false);
    expect(status.callUnavailableReason).toContain('Microphone access is blocked');
  });
});
