import type {
  MeetingClaimGateBatchDto,
  MeetingDto,
  MeetingManualFactCheckRequestDto,
} from '@aaif/goose-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  manualFactCheckRequestFromDto,
  pendingClaimGateBatchFromDto,
  updateMeeting,
} from './meetings';

const { meetingsUpdate } = vi.hoisted(() => ({ meetingsUpdate: vi.fn() }));

vi.mock('./acpConnection', () => ({
  getAcpClient: async () => ({ goose: { meetingsUpdate_unstable: meetingsUpdate } }),
}));

beforeEach(() => meetingsUpdate.mockReset());

describe('pendingClaimGateBatchFromDto', () => {
  it('recovers the immutable durable turn snapshot instead of a newer transcript revision', () => {
    const batch: MeetingClaimGateBatchDto = {
      id: '1cc5860e-35b2-486c-b7a6-c59d69f42a85',
      meetingId: '2cb389ac-e5ba-476b-867d-a478099bf3fb',
      idempotencyKey: 'claim-gate:durable-before-crash',
      segmentIds: ['e0d3e827-403b-4149-857e-d572911cb3e1'],
      turns: [
        {
          id: 'e0d3e827-403b-4149-857e-d572911cb3e1',
          speakerId: 'speaker-1',
          startMs: 0,
          endMs: 1_000,
          text: 'The original revision entered the durable batch.',
          revisionNumber: 0,
          sourceKind: 'mixed',
        },
      ],
      createdAtMs: 1_000,
    };

    expect(pendingClaimGateBatchFromDto(batch)).toEqual({
      id: batch.id,
      meetingId: batch.meetingId,
      idempotencyKey: batch.idempotencyKey,
      turns: [
        {
          id: batch.turns[0].id,
          speakerId: 'speaker-1',
          startMs: 0,
          endMs: 1_000,
          text: 'The original revision entered the durable batch.',
          revision: 0,
          sourceKind: 'mixed',
        },
      ],
      createdAtMs: 1_000,
    });
  });
});

describe('manualFactCheckRequestFromDto', () => {
  it('restores the durable selection, immutable context, status, and typed error', () => {
    const request: MeetingManualFactCheckRequestDto = {
      id: '38eff50c-9088-4211-8c85-a2c0a94a6755',
      meetingId: '2cb389ac-e5ba-476b-867d-a478099bf3fb',
      exactSelection: 'The selected claim.',
      contextTurns: [
        {
          id: 'e0d3e827-403b-4149-857e-d572911cb3e1',
          speakerId: null,
          startMs: 500,
          endMs: 1_500,
          text: 'The selected claim.',
          revisionNumber: 3,
          sourceKind: 'text',
        },
      ],
      sourceSegmentIds: [],
      speakerId: null,
      startMs: 500,
      endMs: 1_500,
      status: 'retry_wait',
      error: { code: 'gateway_offline', message: 'Retry later.', retryable: true },
      contentHash: 'hash',
      createdAtMs: 2_000,
      updatedAtMs: 3_000,
    };

    expect(manualFactCheckRequestFromDto(request)).toEqual({
      id: request.id,
      meetingId: request.meetingId,
      exactSelection: request.exactSelection,
      contextTurns: [
        {
          id: request.contextTurns[0].id,
          speakerId: undefined,
          startMs: 500,
          endMs: 1_500,
          text: 'The selected claim.',
          revision: 3,
          sourceKind: 'text',
        },
      ],
      sourceSegmentIds: [],
      speakerId: undefined,
      startMs: 500,
      endMs: 1_500,
      status: 'retry_wait',
      error: { code: 'gateway_offline', message: 'Retry later.', retryable: true },
      createdAtMs: 2_000,
      updatedAtMs: 3_000,
    });
  });
});

describe('updateMeeting', () => {
  it('persists capture completion independently from queued refinement', async () => {
    const meeting: MeetingDto = {
      id: '2cb389ac-e5ba-476b-867d-a478099bf3fb',
      title: 'Completed local recording',
      artifactType: 'meeting',
      mode: 'call',
      status: 'complete',
      startedAtMs: 1_000,
      endedAtMs: 32_000,
      captureConfig: {
        liveStrategy: 'mixed_diarized',
        microphoneDeviceId: null,
        systemAudioEnabled: false,
        exactSpeakerCount: null,
      },
      captureStatus: 'complete',
      refinementStatus: 'queued',
      researchStatus: 'not_started',
      lastError: null,
      createdAtMs: 1_000,
      updatedAtMs: 32_000,
    };
    meetingsUpdate.mockResolvedValue({ meeting });

    await updateMeeting(meeting.id, {
      status: 'complete',
      endedAtMs: meeting.endedAtMs ?? undefined,
      captureStatus: 'complete',
      refinementStatus: 'queued',
    });

    expect(meetingsUpdate).toHaveBeenCalledWith({
      meetingId: meeting.id,
      title: null,
      status: 'complete',
      endedAtMs: 32_000,
      captureStatus: 'complete',
      refinementStatus: 'queued',
      researchStatus: null,
      error: null,
      clearError: false,
    });
  });
});
