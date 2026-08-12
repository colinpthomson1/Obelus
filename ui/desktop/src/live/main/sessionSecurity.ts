import { desktopCapturer } from 'electron';
import type { DesktopCapturerSource, Session, WebContents, WebFrameMain } from 'electron';

export const OBELUS_SESSION_PARTITION = 'persist:obelus';

export interface ConfigureObelusSessionOptions {
  appEntryUrl: URL;
  isKnownWebContents: (webContents: WebContents) => boolean;
  isKnownFrame: (frame: WebFrameMain) => boolean;
  getCsp: () => string;
  getExternalBackendUrl: () => string | undefined;
  gatewayBaseUrl?: string;
  getDisplaySources?: () => Promise<DesktopCapturerSource[]>;
}

const configuredSessions = new WeakSet<Session>();
const packagedFileSecurityOrigins = new Set(['file://', 'file:///', 'null']);
const recoverableDisplayMediaErrors = new WeakSet<object>();
const electronDisplaySourceFailureMessage = 'Failed to get sources.';

export function isRecoverableDisplayMediaError(error: unknown): boolean {
  if (isObject(error) && recoverableDisplayMediaErrors.has(error)) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message === electronDisplaySourceFailureMessage;
}

export function createTrustedRendererUrlPredicate(appEntryUrl: URL): (url: string) => boolean {
  const trustedOrigin = appEntryUrl.origin;
  const trustedFileDirectory =
    appEntryUrl.protocol === 'file:'
      ? appEntryUrl.pathname.slice(0, appEntryUrl.pathname.lastIndexOf('/') + 1)
      : null;

  return (rawUrl: string): boolean => {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.username || parsed.password) return false;
      if (trustedFileDirectory !== null) {
        return parsed.protocol === 'file:' && parsed.pathname.startsWith(trustedFileDirectory);
      }
      return parsed.origin === trustedOrigin;
    } catch {
      return false;
    }
  };
}

export function shouldRewriteOriginForRequest(
  requestUrl: string,
  externalBackendUrl?: string,
  gatewayBaseUrl?: string
): boolean {
  let request: URL;
  try {
    request = new URL(requestUrl);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(request.protocol)) return false;
  if (request.hostname === 'streaming.assemblyai.com') return false;
  if (sameOrigin(request, gatewayBaseUrl)) return false;
  if (externalBackendUrl && sameOrigin(request, externalBackendUrl)) return true;
  return (
    (request.hostname === '127.0.0.1' || request.hostname === 'localhost') &&
    request.port !== '5173'
  );
}

export function configureObelusSession(
  targetSession: Session,
  options: ConfigureObelusSessionOptions
): void {
  if (configuredSessions.has(targetSession)) return;
  configuredSessions.add(targetSession);
  const isTrustedUrl = createTrustedRendererUrlPredicate(options.appEntryUrl);
  const isTrustedRequestOrigin = (origin: string, fallbackUrl: string): boolean => {
    if (options.appEntryUrl.protocol === 'file:' && isPackagedFileSecurityOrigin(origin)) {
      return isTrustedUrl(fallbackUrl);
    }
    return isTrustedUrl(origin || fallbackUrl);
  };

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl =
      'requestingUrl' in details && typeof details.requestingUrl === 'string'
        ? details.requestingUrl
        : webContents.getURL();
    const trusted =
      options.isKnownWebContents(webContents) &&
      details.isMainFrame === true &&
      isTrustedRequestOrigin(requestingUrl, webContents.getURL());
    if (!trusted) {
      callback(false);
      return;
    }

    if (permission === 'display-capture') {
      callback(true);
      return;
    }
    const mediaTypes =
      permission === 'media' && 'mediaTypes' in details && Array.isArray(details.mediaTypes)
        ? details.mediaTypes
        : [];
    callback(
      permission === 'media' &&
        (mediaTypes.length === 0 || mediaTypes.includes('audio')) &&
        !mediaTypes.includes('video')
    );
  });

  targetSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (
      !webContents ||
      !options.isKnownWebContents(webContents) ||
      details.isMainFrame !== true ||
      !isTrustedRequestOrigin(requestingOrigin, webContents.getURL())
    ) {
      return false;
    }
    const requestedPermission: string = permission;
    if (requestedPermission === 'display-capture') return true;
    if (requestedPermission !== 'media') return false;
    const mediaType = 'mediaType' in details ? details.mediaType : undefined;
    return mediaType === undefined || mediaType === 'audio';
  });

  targetSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      const respond = createDisplayMediaResponder(callback);
      const frame = request.frame;
      const trustedSecurityOrigin = isTrustedRequestOrigin(
        request.securityOrigin,
        frame?.url ?? ''
      );
      const trusted =
        frame !== null &&
        request.userGesture &&
        request.audioRequested &&
        request.videoRequested &&
        frame.parent === null &&
        options.isKnownFrame(frame) &&
        isTrustedUrl(frame.url) &&
        trustedSecurityOrigin;
      if (!trusted) {
        respond({});
        return;
      }

      let sourceLookup: Promise<DesktopCapturerSource[]>;
      try {
        sourceLookup = (options.getDisplaySources ?? defaultDisplaySources)();
      } catch (error) {
        rememberRecoverableDisplayMediaError(error);
        respond({});
        return;
      }
      void sourceLookup.then(
        (sources) => {
          const source =
            sources.find((candidate) => candidate.id.startsWith('screen:')) ?? sources[0];
          if (!source) {
            respond({});
            return;
          }
          respond({
            video: source,
            audio: 'loopback',
          } as Parameters<typeof callback>[0]);
        },
        (error: unknown) => {
          rememberRecoverableDisplayMediaError(error);
          respond({});
        }
      );
    },
    { useSystemPicker: false }
  );

  targetSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isTrustedUrl(details.url)) {
      callback({ cancel: false, responseHeaders: details.responseHeaders });
      return;
    }
    const responseHeaders = { ...details.responseHeaders };
    for (const key of Object.keys(responseHeaders)) {
      if (key.toLowerCase() === 'content-security-policy') delete responseHeaders[key];
    }
    responseHeaders['Content-Security-Policy'] = [options.getCsp()];
    callback({ cancel: false, responseHeaders });
  });

  targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    const trustedInitiator =
      details.webContents !== undefined &&
      options.isKnownWebContents(details.webContents) &&
      details.frame !== undefined &&
      details.frame !== null &&
      details.frame.parent === null &&
      options.isKnownFrame(details.frame) &&
      isTrustedUrl(details.frame.url);
    if (
      trustedInitiator &&
      shouldRewriteOriginForRequest(
        details.url,
        options.getExternalBackendUrl(),
        options.gatewayBaseUrl
      )
    ) {
      requestHeaders.Origin = 'http://localhost:5173';
    }
    callback({ cancel: false, requestHeaders });
  });
}

function isPackagedFileSecurityOrigin(origin: string): boolean {
  return packagedFileSecurityOrigins.has(origin);
}

function createDisplayMediaResponder<Result>(
  callback: (result: Result) => void
): (result: Result) => void {
  let responded = false;
  return (result) => {
    if (responded) return;
    responded = true;
    try {
      callback(result);
    } catch (error) {
      rememberRecoverableDisplayMediaError(error);
      return;
    }
  };
}

function rememberRecoverableDisplayMediaError(error: unknown): void {
  if (isObject(error)) recoverableDisplayMediaErrors.add(error);
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

async function defaultDisplaySources(): Promise<DesktopCapturerSource[]> {
  return await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
}

function sameOrigin(request: URL, candidate: string | undefined): boolean {
  if (!candidate) return false;
  try {
    return request.origin === new URL(candidate).origin;
  } catch {
    return false;
  }
}
