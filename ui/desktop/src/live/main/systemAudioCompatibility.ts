export const MACOS_SCREEN_CAPTURE_AUDIO_FEATURE = 'MacCatapLoopbackAudioForScreenShare';

export interface ChromiumCommandLine {
  appendSwitch(name: string, value: string): void;
}

export function configureSystemAudioCompatibility(
  commandLine: ChromiumCommandLine,
  platform = process.platform
): void {
  if (platform !== 'darwin') return;
  commandLine.appendSwitch('disable-features', MACOS_SCREEN_CAPTURE_AUDIO_FEATURE);
}
