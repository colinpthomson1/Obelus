import { systemPreferences } from 'electron';
import type { LiveFactCheckMode, LiveSupportStatus, MediaPermissionState } from '../ipcTypes';
import type { GatewayClient } from './GatewayClient';
import type { LocalSttSupport } from '../localSttProtocol';
import {
  CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL,
  LOCAL_FACT_CHECK_EVIDENCE_SCOPE,
  LOCAL_FACT_CHECK_MODEL,
  SUBSCRIPTION_WEB_EVIDENCE_SCOPE,
  type LocalFactCheckSupport,
} from '../localFactCheckProtocol';

let microphonePermissionRequestInFlight: Promise<MediaPermissionState> | undefined;

export interface LiveSupportInputs {
  platform: string;
  systemVersion: string;
  microphonePermission: MediaPermissionState;
  gatewayAvailable: boolean;
  gatewayUnavailableReason?: string;
  localSttAvailable?: boolean;
  localSttModel?: string;
  localSttUnavailableReason?: string;
  localFactCheckMode?: LiveFactCheckMode;
  localFactCheckAvailable?: boolean;
  localFactCheckModel?: string;
  localFactCheckEvidenceScope?: string;
  localFactCheckUnavailableReason?: string;
  directFactCheckFallbackEnabled?: boolean;
}

export function evaluateLiveSupport(inputs: LiveSupportInputs): LiveSupportStatus {
  const macosVersion = inputs.platform === 'darwin' ? normalizeVersion(inputs.systemVersion) : null;
  const macosSupportsSystemAudio =
    macosVersion !== null && compareVersions(macosVersion, '13.0.0') >= 0;
  const microphoneOnlySupported = !isBlocked(inputs.microphonePermission);
  const fullCallCaptureSupported = macosSupportsSystemAudio && microphoneOnlySupported;

  const systemAudioPermission: MediaPermissionState = 'unknown';

  let callUnavailableReason: string | undefined;
  if (inputs.platform !== 'darwin') {
    callUnavailableReason =
      'System audio capture is not available on this platform. Microphone-only recording remains available.';
  } else if (macosVersion === null) {
    callUnavailableReason =
      'Obelus could not confirm system audio support on this Mac. Microphone-only recording remains available.';
  } else if (!macosSupportsSystemAudio) {
    callUnavailableReason =
      'Built-in system audio capture needs macOS 13 or newer. Microphone-only recording remains available.';
  } else if (isBlocked(inputs.microphonePermission)) {
    callUnavailableReason = 'Microphone access is blocked in macOS Privacy & Security settings.';
  }

  return {
    platform: inputs.platform,
    systemVersion: inputs.systemVersion,
    macosVersion,
    microphoneOnlySupported,
    fullCallCaptureSupported,
    systemAudioRequiresHealthCheck: macosSupportsSystemAudio,
    microphonePermission: inputs.microphonePermission,
    systemAudioPermission,
    gatewayAvailable: inputs.gatewayAvailable,
    gatewayUnavailableReason: inputs.gatewayUnavailableReason,
    localSttAvailable: inputs.localSttAvailable ?? false,
    localSttModel: inputs.localSttModel,
    localSttUnavailableReason: inputs.localSttUnavailableReason,
    localFactCheckMode: inputs.localFactCheckMode ?? 'hosted',
    localFactCheckAvailable: inputs.localFactCheckAvailable ?? false,
    localFactCheckModel: inputs.localFactCheckModel,
    localFactCheckEvidenceScope: inputs.localFactCheckEvidenceScope,
    localFactCheckUnavailableReason: inputs.localFactCheckUnavailableReason,
    directFactCheckFallbackEnabled: inputs.directFactCheckFallbackEnabled ?? false,
    callUnavailableReason,
  };
}

export async function getLiveSupportStatus(
  gateway: GatewayClient,
  localStt?: { checkSupport(): Promise<LocalSttSupport> },
  localFactCheck?: {
    factCheckMode?: Extract<LiveFactCheckMode, 'subscription_web' | 'local_wikimedia'>;
    checkSupport(): Promise<LocalFactCheckSupport>;
  },
  directFactCheckFallbackEnabled = false
): Promise<LiveSupportStatus> {
  const configuredFactCheckMode = localFactCheck?.factCheckMode ?? 'subscription_web';
  const fallbackModel =
    configuredFactCheckMode === 'subscription_web'
      ? CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL
      : LOCAL_FACT_CHECK_MODEL;
  const fallbackEvidenceScope =
    configuredFactCheckMode === 'subscription_web'
      ? SUBSCRIPTION_WEB_EVIDENCE_SCOPE
      : LOCAL_FACT_CHECK_EVIDENCE_SCOPE;
  const [health, microphonePermission, localSttSupport, localFactCheckSupport] = await Promise.all([
    gateway.checkHealth(),
    resolveMicrophonePermission(process.platform),
    localStt?.checkSupport() ??
      Promise.resolve({
        available: false,
        model: 'base.en' as const,
        reason: 'Local transcription is not configured.',
      }),
    localFactCheck?.checkSupport().catch(() => ({
      available: false,
      mode: configuredFactCheckMode,
      model: fallbackModel,
      evidenceScope: fallbackEvidenceScope,
      reason: 'Fact-checking could not be reached.',
    })) ??
      Promise.resolve({
        available: false,
        mode: 'hosted' as const,
        model: 'gateway-configured',
        evidenceScope: 'Configured Obelus research gateway.',
        reason: 'Fact-checking is not configured.',
      }),
  ]);
  return evaluateLiveSupport({
    platform: process.platform,
    systemVersion: getSystemVersion(),
    microphonePermission,
    gatewayAvailable: health.available,
    gatewayUnavailableReason: health.reason,
    localSttAvailable: localSttSupport.available,
    localSttModel: localSttSupport.model,
    localSttUnavailableReason: localSttSupport.reason,
    localFactCheckMode:
      localFactCheck && (!directFactCheckFallbackEnabled || !health.available)
        ? localFactCheckSupport.mode
        : 'hosted',
    localFactCheckAvailable: localFactCheckSupport.available,
    localFactCheckModel: localFactCheckSupport.model,
    localFactCheckEvidenceScope: localFactCheckSupport.evidenceScope,
    localFactCheckUnavailableReason: localFactCheckSupport.reason,
    directFactCheckFallbackEnabled,
  });
}

export async function resolveMicrophonePermission(platform: string): Promise<MediaPermissionState> {
  const currentPermission = readPermission('microphone');
  if (platform !== 'darwin' || currentPermission !== 'not-determined') {
    return currentPermission;
  }

  if (!microphonePermissionRequestInFlight) {
    microphonePermissionRequestInFlight = requestMicrophonePermission().finally(() => {
      microphonePermissionRequestInFlight = undefined;
    });
  }
  return microphonePermissionRequestInFlight;
}

async function requestMicrophonePermission(): Promise<MediaPermissionState> {
  try {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    const refreshedPermission = readPermission('microphone');
    return refreshedPermission === 'not-determined' || refreshedPermission === 'unknown'
      ? granted
        ? 'granted'
        : 'denied'
      : refreshedPermission;
  } catch {
    return readPermission('microphone');
  }
}

function readPermission(mediaType: 'microphone'): MediaPermissionState {
  try {
    const status = systemPreferences.getMediaAccessStatus(mediaType);
    return ['not-determined', 'granted', 'denied', 'restricted', 'unknown'].includes(status)
      ? (status as MediaPermissionState)
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function getSystemVersion(): string {
  const electronProcess = process as typeof process & { getSystemVersion?: () => string };
  try {
    return electronProcess.getSystemVersion?.() ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function normalizeVersion(version: string): string | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  return match ? `${match[1]}.${match[2]}.${match[3] ?? '0'}` : null;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isBlocked(permission: MediaPermissionState): boolean {
  return permission === 'denied' || permission === 'restricted';
}
