import { describe, expect, it } from 'vitest';
import {
  validateAudioFrame,
  validateClaimDetectionRequest,
  validateExternalSourceUrl,
  validateFactCheckRequest,
  validateRefinementRequest,
  validateStartConfig,
  validateSttSessionRequest,
} from './ipcValidation';

describe('live IPC validation', () => {
  it('accepts bounded PCM16 frames and rejects duration mismatches', () => {
    const frame = {
      meetingId: 'meeting_1',
      captureSessionId: 'capture_1',
      sequence: 0,
      meetingTimeMs: 0,
      durationMs: 80,
      sampleRate: 16000,
      channels: 1,
      pcm: { mixed: new ArrayBuffer(2_560) },
      meters: { mixed: { rms: 0, peak: 0 } },
      workletDroppedFrames: 0,
    };
    expect(validateAudioFrame(frame)).toStrictEqual(frame);
    expect(() => validateAudioFrame({ ...frame, pcm: { mixed: new ArrayBuffer(100) } })).toThrow(
      'duration'
    );
  });

  it('does not allow in-person capture to smuggle in system audio', () => {
    expect(() =>
      validateStartConfig({
        meetingId: 'meeting_1',
        mode: 'in_person',
        strategy: 'mixed_diarized',
        includeSystemAudio: true,
      })
    ).toThrow('cannot include');
  });

  it('requires a caller-persisted STT idempotency key', () => {
    const request = {
      meetingId: 'meeting_1',
      idempotencyKey: 'stt-session-1',
      strategy: 'mixed_diarized',
      sourceKind: 'mixed',
    };
    expect(validateSttSessionRequest(request)).toStrictEqual(request);
    expect(() => validateSttSessionRequest({ ...request, idempotencyKey: undefined })).toThrow(
      'idempotencyKey'
    );
    expect(() => validateSttSessionRequest({ ...request, idempotencyKey: 'short' })).toThrow(
      'idempotencyKey'
    );
  });

  it('allows only credential-free HTTP(S) source URLs', () => {
    expect(validateExternalSourceUrl('https://example.com/report')).toBe(
      'https://example.com/report'
    );
    expect(() => validateExternalSourceUrl('file:///etc/passwd')).toThrow('Only HTTP');
    expect(() => validateExternalSourceUrl('https://user:password@example.com')).toThrow(
      'credentials'
    );
  });

  it('reconstructs strict gateway DTOs and normalizes hashes and nullable speakers', () => {
    const claim = validateClaimDetectionRequest({
      meetingId: 'meeting_1',
      idempotencyKey: 'claim-request-1',
      turns: [{ id: 'turn_1', startMs: 0, endMs: 100, text: 'Claim' }],
      ignored: { nested: 'not forwarded' },
    });
    expect(claim).toStrictEqual({
      meetingId: 'meeting_1',
      idempotencyKey: 'claim-request-1',
      turns: [{ id: 'turn_1', speakerId: null, startMs: 0, endMs: 100, text: 'Claim' }],
    });

    const automatic = validateClaimDetectionRequest({
      meetingId: 'meeting_1',
      idempotencyKey: 'automatic-claim-request-1',
      turns: [{ id: 'turn_3', startMs: 200, endMs: 300, text: 'and day is dark.' }],
      contextTurns: [
        {
          id: 'turn_1',
          startMs: 0,
          endMs: 100,
          text: 'Night is light',
          sourceKind: 'microphone',
        },
        {
          id: 'turn_3',
          startMs: 200,
          endMs: 300,
          text: 'and day is dark.',
          sourceKind: 'microphone',
        },
      ],
      requiredTurnIds: ['turn_3'],
    });
    expect(automatic).toMatchObject({
      contextTurns: [
        expect.objectContaining({ id: 'turn_1', speakerId: null, sourceKind: 'microphone' }),
        expect.objectContaining({ id: 'turn_3', speakerId: null, sourceKind: 'microphone' }),
      ],
      requiredTurnIds: ['turn_3'],
    });
    expect(() =>
      validateClaimDetectionRequest({
        ...automatic,
        requiredTurnIds: ['missing_turn'],
      })
    ).toThrow('must reference supplied turns');

    expect(
      validateClaimDetectionRequest({
        meetingId: 'meeting_1',
        idempotencyKey: 'manual-claim-request-1',
        turns: [{ id: 'turn_1', startMs: 0, endMs: 100, text: 'Nearby context' }],
        manual: true,
        manualSelection: 'Selected claim',
      })
    ).toStrictEqual({
      meetingId: 'meeting_1',
      idempotencyKey: 'manual-claim-request-1',
      turns: [{ id: 'turn_1', speakerId: null, startMs: 0, endMs: 100, text: 'Nearby context' }],
      manual: true,
      manualSelection: 'Selected claim',
    });
    expect(() =>
      validateClaimDetectionRequest({
        meetingId: 'meeting_1',
        idempotencyKey: 'manual-claim-request-1',
        turns: [{ id: 'turn_1', startMs: 0, endMs: 100, text: 'Nearby context' }],
        manual: true,
      })
    ).toThrow('manualSelection');

    const checksum = 'A'.repeat(64);
    const refinement = validateRefinementRequest({
      meetingId: 'meeting_1',
      idempotencyKey: 'refinement-request-1',
      sourceTranscriptVersionId: 'transcript_1',
      manifestChecksum: checksum,
      contentType: 'audio/wav',
      ignored: 'not forwarded',
      parts: [
        {
          assetId: 'asset_1',
          sourceKind: 'mixed',
          checksumSha256: checksum,
          timelineStartMs: 0,
          timelineEndMs: 80,
          providerInputStartMs: 0,
          providerInputEndMs: 80,
          ignored: true,
        },
      ],
    });
    expect(refinement.manifestChecksum).toBe(checksum.toLowerCase());
    expect(refinement.parts[0].checksumSha256).toBe(checksum.toLowerCase());
    expect(refinement).not.toHaveProperty('ignored');
    expect(refinement.parts[0]).not.toHaveProperty('ignored');
    expect(() =>
      validateRefinementRequest({
        ...refinement,
        parts: [refinement.parts[0], { ...refinement.parts[0] }],
      })
    ).toThrow('unique');
  });

  it('allows a manual standalone fact-check without transcript context', () => {
    const request = {
      meetingId: 'meeting_1',
      claimId: 'claim_1',
      claimVersionId: 'claim_version_1',
      idempotencyKey: 'fact-check-request-1',
      exactQuote: 'The selected standalone claim.',
      normalizedClaim: 'The selected standalone claim.',
      contextTurns: [],
      origin: 'manual' as const,
    };

    expect(validateFactCheckRequest(request)).toStrictEqual(request);
    expect(() =>
      validateClaimDetectionRequest({
        meetingId: 'meeting_1',
        idempotencyKey: 'claim-request-1',
        turns: [],
      })
    ).toThrow('invalid number of turns');
  });

  it('validates V2 fact-check metadata and immutable context turn IDs', () => {
    const request = {
      meetingId: 'meeting_1',
      claimId: 'claim_1',
      claimVersionId: 'claim_version_1',
      idempotencyKey: 'fact-check-request-1',
      exactQuote: 'A bounded claim.',
      normalizedClaim: 'A bounded claim.',
      contextTurns: [
        { id: 'turn_1', speakerId: null, startMs: 0, endMs: 100, text: 'A bounded claim.' },
      ],
      requiredTurnIds: ['turn_1'],
      origin: 'automatic' as const,
      timeSensitive: true,
      consequenceScore: 0.8,
      autoEscalate: false,
    };

    expect(validateFactCheckRequest(request)).toStrictEqual(request);
    expect(() =>
      validateFactCheckRequest({ ...request, requiredTurnIds: ['missing_turn'] })
    ).toThrow('must reference supplied contextTurns');
    expect(() => validateFactCheckRequest({ ...request, consequenceScore: 1.1 })).toThrow(
      'outside the allowed range'
    );
  });
});
