import type { DesktopCapturerSource, Session, WebContents, WebFrameMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  configureObelusSession,
  createTrustedRendererUrlPredicate,
  isRecoverableDisplayMediaError,
  OBELUS_SESSION_PARTITION,
  shouldRewriteOriginForRequest,
} from './sessionSecurity';

describe('live session security', () => {
  it('uses the same persistent partition as BrowserWindow', () => {
    expect(OBELUS_SESSION_PARTITION).toBe('persist:obelus');
  });

  it('trusts only the configured renderer origin in development', () => {
    const trusted = createTrustedRendererUrlPredicate(new URL('http://localhost:5173/'));
    expect(trusted('http://localhost:5173/#/live')).toBe(true);
    expect(trusted('http://localhost:5174/#/live')).toBe(false);
    expect(trusted('https://streaming.assemblyai.com/')).toBe(false);
  });

  it('trusts only renderer files beside the packaged entry point', () => {
    const trusted = createTrustedRendererUrlPredicate(
      new URL('file:///Applications/Obelus.app/Contents/Resources/renderer/index.html')
    );
    expect(
      trusted('file:///Applications/Obelus.app/Contents/Resources/renderer/index.html#/live')
    ).toBe(true);
    expect(trusted('file:///tmp/index.html')).toBe(false);
  });

  it('never rewrites AssemblyAI or gateway origins', () => {
    expect(
      shouldRewriteOriginForRequest(
        'wss://streaming.assemblyai.com/v3/ws',
        'wss://streaming.assemblyai.com',
        'http://127.0.0.1:8787'
      )
    ).toBe(false);
    expect(
      shouldRewriteOriginForRequest(
        'http://127.0.0.1:8787/v1/claims/detect',
        undefined,
        'http://127.0.0.1:8787'
      )
    ).toBe(false);
    expect(shouldRewriteOriginForRequest('http://127.0.0.1:3000/acp', undefined, undefined)).toBe(
      true
    );
  });

  it('registers exact permission, display-media, CSP, and origin handlers on the target session', async () => {
    type PermissionRequestHandler = NonNullable<
      Parameters<Session['setPermissionRequestHandler']>[0]
    >;
    type PermissionCheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
    type DisplayHandler = Parameters<Session['setDisplayMediaRequestHandler']>[0];
    let permissionRequestHandler: PermissionRequestHandler | undefined;
    let permissionCheckHandler: PermissionCheckHandler | undefined;
    let displayHandler: DisplayHandler | undefined;
    let headersHandler: Parameters<Session['webRequest']['onHeadersReceived']>[0] | undefined;
    let beforeSendHandler: Parameters<Session['webRequest']['onBeforeSendHeaders']>[0] | undefined;
    const targetSession = {
      setPermissionRequestHandler: vi.fn((handler) => {
        permissionRequestHandler = handler;
      }),
      setPermissionCheckHandler: vi.fn((handler) => {
        permissionCheckHandler = handler;
      }),
      setDisplayMediaRequestHandler: vi.fn((handler) => {
        displayHandler = handler;
      }),
      webRequest: {
        onHeadersReceived: vi.fn((handler) => {
          headersHandler = handler;
        }),
        onBeforeSendHeaders: vi.fn((handler) => {
          beforeSendHandler = handler;
        }),
      },
    } as unknown as Session;
    const webContents = { getURL: () => 'http://localhost:5173/#/live' } as WebContents;
    const frame = {
      parent: null,
      url: 'http://localhost:5173/#/live',
    } as WebFrameMain;
    configureObelusSession(targetSession, {
      appEntryUrl: new URL('http://localhost:5173/'),
      isKnownWebContents: (candidate) => candidate === webContents,
      isKnownFrame: (candidate) => candidate === frame,
      getCsp: () => "default-src 'self'; object-src 'none';",
      getExternalBackendUrl: () => 'http://127.0.0.1:3000',
      gatewayBaseUrl: 'http://127.0.0.1:8787',
      getDisplaySources: async () => [
        { id: 'screen:1:0', name: 'Screen 1' } as unknown as DesktopCapturerSource,
      ],
    });

    const permissionResult = vi.fn();
    permissionRequestHandler?.(webContents, 'media', permissionResult, {
      requestingUrl: 'http://localhost:5173/#/live',
      isMainFrame: true,
      mediaTypes: ['audio'],
    } as never);
    expect(permissionResult).toHaveBeenCalledWith(true);
    const legacyLoopbackPermissionResult = vi.fn();
    permissionRequestHandler?.(webContents, 'media', legacyLoopbackPermissionResult, {
      requestingUrl: 'http://localhost:5173/#/live',
      isMainFrame: true,
      mediaTypes: [],
    } as never);
    expect(legacyLoopbackPermissionResult).toHaveBeenCalledWith(true);
    const videoPermissionResult = vi.fn();
    permissionRequestHandler?.(webContents, 'media', videoPermissionResult, {
      requestingUrl: 'http://localhost:5173/#/live',
      isMainFrame: true,
      mediaTypes: ['video'],
    } as never);
    expect(videoPermissionResult).toHaveBeenCalledWith(false);
    const subframePermissionResult = vi.fn();
    permissionRequestHandler?.(webContents, 'media', subframePermissionResult, {
      requestingUrl: 'http://localhost:5173/#/live',
      isMainFrame: false,
      mediaTypes: [],
    } as never);
    expect(subframePermissionResult).toHaveBeenCalledWith(false);
    expect(
      permissionCheckHandler?.(webContents, 'media', 'http://localhost:5173', {
        mediaType: 'audio',
        isMainFrame: true,
      } as never)
    ).toBe(true);

    const displayCapturePermission = 'display-capture' as Parameters<PermissionCheckHandler>[1];
    expect(
      permissionCheckHandler?.(webContents, displayCapturePermission, 'http://localhost:5173', {
        isMainFrame: true,
      } as never)
    ).toBe(true);
    const displayPermissionResult = vi.fn();
    permissionRequestHandler?.(webContents, 'display-capture', displayPermissionResult, {
      requestingUrl: 'http://localhost:5173/#/live',
      isMainFrame: true,
    } as never);
    expect(displayPermissionResult).toHaveBeenCalledWith(true);

    const displayResult = vi.fn();
    await displayHandler?.(
      {
        frame,
        securityOrigin: 'http://localhost:5173',
        userGesture: true,
        audioRequested: true,
        videoRequested: true,
      },
      displayResult
    );
    expect(displayResult).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: 'loopback',
        video: expect.objectContaining({ id: 'screen:1:0' }),
      })
    );
    expect(
      permissionCheckHandler?.(webContents, displayCapturePermission, 'http://localhost:5173', {
        isMainFrame: false,
      } as never)
    ).toBe(false);

    const headersResult = vi.fn();
    headersHandler?.(
      {
        url: 'http://localhost:5173/index.html',
        responseHeaders: { Server: ['vite'] },
      } as never,
      headersResult
    );
    expect(headersResult).toHaveBeenCalledWith(
      expect.objectContaining({
        responseHeaders: expect.objectContaining({
          'Content-Security-Policy': ["default-src 'self'; object-src 'none';"],
        }),
      })
    );

    const gatewayHeadersResult = vi.fn();
    beforeSendHandler?.(
      {
        url: 'http://127.0.0.1:8787/v1/stt/session',
        webContents,
        frame,
        requestHeaders: { Origin: 'http://localhost:5173' },
      } as never,
      gatewayHeadersResult
    );
    expect(gatewayHeadersResult).toHaveBeenCalledWith(
      expect.objectContaining({ requestHeaders: { Origin: 'http://localhost:5173' } })
    );

    const backendHeadersResult = vi.fn();
    beforeSendHandler?.(
      {
        url: 'http://127.0.0.1:3000/acp',
        webContents,
        frame,
        requestHeaders: { Origin: 'file://' },
      } as never,
      backendHeadersResult
    );
    expect(backendHeadersResult).toHaveBeenCalledWith(
      expect.objectContaining({ requestHeaders: { Origin: 'http://localhost:5173' } })
    );

    const untrustedHeadersResult = vi.fn();
    beforeSendHandler?.(
      {
        url: 'http://127.0.0.1:3000/acp',
        webContents: { getURL: () => 'https://hostile.example/' } as WebContents,
        frame: {
          parent: null,
          url: 'https://hostile.example/',
        } as WebFrameMain,
        requestHeaders: { Origin: 'https://hostile.example' },
      } as never,
      untrustedHeadersResult
    );
    expect(untrustedHeadersResult).toHaveBeenCalledWith(
      expect.objectContaining({ requestHeaders: { Origin: 'https://hostile.example' } })
    );
  });

  it('recognizes the opaque file origin only for a known packaged renderer', async () => {
    type PermissionCheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
    type DisplayHandler = Parameters<Session['setDisplayMediaRequestHandler']>[0];
    let permissionCheckHandler: PermissionCheckHandler | undefined;
    let displayHandler: DisplayHandler | undefined;
    const targetSession = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn((handler) => {
        permissionCheckHandler = handler;
      }),
      setDisplayMediaRequestHandler: vi.fn((handler) => {
        displayHandler = handler;
      }),
      webRequest: {
        onHeadersReceived: vi.fn(),
        onBeforeSendHeaders: vi.fn(),
      },
    } as unknown as Session;
    const rendererUrl =
      'file:///Applications/Obelus.app/Contents/Resources/renderer/index.html#/live';
    const webContents = { getURL: () => rendererUrl } as WebContents;
    const frame = { parent: null, url: rendererUrl } as WebFrameMain;
    const getDisplaySources = vi.fn(async () => [
      { id: 'screen:1:0', name: 'Screen 1' } as unknown as DesktopCapturerSource,
    ]);
    configureObelusSession(targetSession, {
      appEntryUrl: new URL(
        'file:///Applications/Obelus.app/Contents/Resources/renderer/index.html'
      ),
      isKnownWebContents: (candidate) => candidate === webContents,
      isKnownFrame: (candidate) => candidate === frame,
      getCsp: () => "default-src 'self'",
      getExternalBackendUrl: () => undefined,
      getDisplaySources,
    });

    for (const packagedOrigin of ['file://', 'file:///']) {
      expect(
        permissionCheckHandler?.(webContents, 'media', packagedOrigin, {
          mediaType: 'audio',
          isMainFrame: true,
        } as never)
      ).toBe(true);
    }
    expect(
      permissionCheckHandler?.(webContents, 'media', 'file:///tmp/hostile.html', {
        mediaType: 'audio',
        isMainFrame: true,
      } as never)
    ).toBe(false);
    expect(
      permissionCheckHandler?.(
        { getURL: () => 'file:///tmp/hostile.html' } as WebContents,
        'media',
        'file://',
        { mediaType: 'audio', isMainFrame: true } as never
      )
    ).toBe(false);

    for (const packagedOrigin of ['file://', 'file:///', 'null']) {
      const displayResult = vi.fn();
      await displayHandler?.(
        {
          frame,
          securityOrigin: packagedOrigin,
          userGesture: true,
          audioRequested: true,
          videoRequested: true,
        },
        displayResult
      );
      expect(displayResult).toHaveBeenCalledWith(
        expect.objectContaining({
          audio: 'loopback',
          video: expect.objectContaining({ id: 'screen:1:0' }),
        })
      );
    }

    const sourceLookupsBeforeRejections = getDisplaySources.mock.calls.length;
    for (const [securityOrigin, requestFrame] of [
      ['file:///tmp/hostile.html', frame],
      ['null', { parent: null, url: 'file:///tmp/hostile.html' } as WebFrameMain],
    ] as const) {
      const displayResult = vi.fn();
      await displayHandler?.(
        {
          frame: requestFrame,
          securityOrigin,
          userGesture: true,
          audioRequested: true,
          videoRequested: true,
        },
        displayResult
      );
      expect(displayResult).toHaveBeenCalledWith({});
    }
    expect(getDisplaySources).toHaveBeenCalledTimes(sourceLookupsBeforeRejections);
  });

  it('contains display callback failures without retrying or rejecting the handler', async () => {
    type DisplayHandler = Parameters<Session['setDisplayMediaRequestHandler']>[0];
    let displayHandler: DisplayHandler | undefined;
    const targetSession = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn((handler) => {
        displayHandler = handler;
      }),
      webRequest: {
        onHeadersReceived: vi.fn(),
        onBeforeSendHeaders: vi.fn(),
      },
    } as unknown as Session;
    const rendererUrl = 'http://localhost:5173/#/live';
    const frame = { parent: null, url: rendererUrl } as WebFrameMain;
    const getDisplaySources = vi.fn(async () => [
      { id: 'screen:1:0', name: 'Screen 1' } as unknown as DesktopCapturerSource,
    ]);
    configureObelusSession(targetSession, {
      appEntryUrl: new URL('http://localhost:5173/'),
      isKnownWebContents: () => true,
      isKnownFrame: (candidate) => candidate === frame,
      getCsp: () => "default-src 'self'",
      getExternalBackendUrl: () => undefined,
      getDisplaySources,
    });

    const deniedCallback = vi.fn(() => {
      throw new Error('Electron rejected the denial response');
    });
    expect(
      displayHandler?.(
        {
          frame,
          securityOrigin: 'http://localhost:5173',
          userGesture: false,
          audioRequested: true,
          videoRequested: true,
        },
        deniedCallback
      )
    ).toBeUndefined();
    expect(deniedCallback).toHaveBeenCalledOnce();
    expect(deniedCallback).toHaveBeenCalledWith({});
    expect(getDisplaySources).not.toHaveBeenCalled();

    const acceptedCallback = vi.fn(() => {
      throw new Error('Electron rejected the selected source');
    });
    expect(
      displayHandler?.(
        {
          frame,
          securityOrigin: 'http://localhost:5173',
          userGesture: true,
          audioRequested: true,
          videoRequested: true,
        },
        acceptedCallback
      )
    ).toBeUndefined();
    await Promise.resolve();
    expect(acceptedCallback).toHaveBeenCalledOnce();
    expect(acceptedCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: 'loopback',
        video: expect.objectContaining({ id: 'screen:1:0' }),
      })
    );
    expect(getDisplaySources).toHaveBeenCalledOnce();
  });

  it('contains a rejected source lookup and classifies it as recoverable', async () => {
    type DisplayHandler = Parameters<Session['setDisplayMediaRequestHandler']>[0];
    let displayHandler: DisplayHandler | undefined;
    const targetSession = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn((handler) => {
        displayHandler = handler;
      }),
      webRequest: {
        onHeadersReceived: vi.fn(),
        onBeforeSendHeaders: vi.fn(),
      },
    } as unknown as Session;
    const rendererUrl = 'file:///Applications/Obelus.app/Contents/Resources/index.html#/live';
    const frame = { parent: null, url: rendererUrl } as WebFrameMain;
    const sourceFailure = new Error('Failed to get sources.');
    configureObelusSession(targetSession, {
      appEntryUrl: new URL('file:///Applications/Obelus.app/Contents/Resources/index.html'),
      isKnownWebContents: () => true,
      isKnownFrame: (candidate) => candidate === frame,
      getCsp: () => "default-src 'self'",
      getExternalBackendUrl: () => undefined,
      getDisplaySources: () => Promise.reject(sourceFailure),
    });
    const displayResult = vi.fn();

    expect(
      displayHandler?.(
        {
          frame,
          securityOrigin: 'file://',
          userGesture: true,
          audioRequested: true,
          videoRequested: true,
        },
        displayResult
      )
    ).toBeUndefined();
    await Promise.resolve();

    expect(displayResult).toHaveBeenCalledOnce();
    expect(displayResult).toHaveBeenCalledWith({});
    expect(isRecoverableDisplayMediaError(sourceFailure)).toBe(true);
    expect(isRecoverableDisplayMediaError(new Error('Unrelated failure'))).toBe(false);
  });
});
