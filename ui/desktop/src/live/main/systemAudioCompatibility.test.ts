import { describe, expect, it, vi } from 'vitest';
import {
  configureSystemAudioCompatibility,
  MACOS_SCREEN_CAPTURE_AUDIO_FEATURE,
} from './systemAudioCompatibility';

describe('system audio compatibility', () => {
  it('uses the ScreenCaptureKit audio path on macOS', () => {
    const appendSwitch = vi.fn();

    configureSystemAudioCompatibility({ appendSwitch }, 'darwin');

    expect(appendSwitch).toHaveBeenCalledWith(
      'disable-features',
      MACOS_SCREEN_CAPTURE_AUDIO_FEATURE
    );
  });

  it('does not change Chromium capture behavior on other platforms', () => {
    const appendSwitch = vi.fn();

    configureSystemAudioCompatibility({ appendSwitch }, 'win32');

    expect(appendSwitch).not.toHaveBeenCalled();
  });
});
