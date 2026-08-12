import { describe, expect, it } from 'vitest';
import {
  isRecordingWithoutTranscription,
  localTranscriptionEmptyStateDetail,
} from './LiveTranscript';

describe('LiveTranscript local transcription state', () => {
  it('does not call a healthy local stream unavailable when research is offline', () => {
    expect(isRecordingWithoutTranscription('recording', 'connecting')).toBe(false);
    expect(isRecordingWithoutTranscription('recording', 'streaming')).toBe(false);
    expect(isRecordingWithoutTranscription('recording', 'disconnected')).toBe(true);
    expect(isRecordingWithoutTranscription('recording', 'error')).toBe(true);
  });

  it('describes local startup, streaming, and recovery truthfully', () => {
    expect(localTranscriptionEmptyStateDetail('connecting', true)).toContain('starting');
    expect(localTranscriptionEmptyStateDetail('streaming', true)).toContain('active');
    expect(localTranscriptionEmptyStateDetail('reconnecting', true)).toContain('reconnecting');
    expect(localTranscriptionEmptyStateDetail('reconnecting', true)).not.toContain('active');
    expect(localTranscriptionEmptyStateDetail('streaming', false)).toBeUndefined();
  });
});
