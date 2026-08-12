import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeetingRefinementJobUpsertDto } from '@aaif/goose-sdk';
import {
  artifactOwnsPresentation,
  canRunSttSession,
  captureLifecycle,
  captureTimelineEventIsDurable,
  deriveSttState,
  gatewayStateAfterSttBegin,
  manualFactCheckContext,
  meetingCleanupConfirmation,
  meetingStopTerminalState,
  pollGatewayJobUntilSettled,
  refinementFailureDisposition,
  reconstructArtifactAudioAssets,
  recoveredAssetsMissingPersistence,
  releaseSttProvider,
  resolveCaptureArtifact,
  researchAttemptPlan,
  researchFailureDisposition,
  resumableRecoveredCleanupJob,
  resumableRecoveredRefinementJob,
  resumableRecoveredResearchJob,
  resolveManualClaimCandidates,
  resolveManualClaimCandidatesWithFallback,
  reusableFactCheckArtifact,
  retryDurableOperation,
  selectionFactCheckInputFromActiveDom,
  shouldRunDeepResearch,
  shouldReconnectStt,
  runExclusiveLiveOperation,
  runDurableRefinementOperation,
  startMeetingRecoveryLoop,
  sttSourcesForCapture,
  terminateSttProvidersForGap,
  timelineEventFromCapture,
  transcriptVersionUpsert,
  translateSttEventToMeetingClock,
} from './LiveMeetingRuntimeProvider';
import type { LiveAudioAsset, LiveAudioSourceKind } from './ipcTypes';
import { initialMeetingState } from './meetingReducer';
import type { ManualFactCheckRequest, MeetingArtifact } from './types';

const sourceSet = (...sources: LiveAudioSourceKind[]) => new Set(sources);

afterEach(() => vi.useRealTimers());

describe('local stop terminal state', () => {
  it('only re-persists recovered audio rows that are not already exact', () => {
    const recovered: LiveAudioAsset = {
      assetId: 'asset-1',
      meetingId: 'meeting-1',
      sourceKind: 'mixed' as const,
      relativePath: 'meeting-1/mixed.wav',
      format: 'wav' as const,
      sampleRate: 16_000,
      channels: 1,
      durationMs: 1_000,
      bytes: 32_044,
      checksumSha256: 'a'.repeat(64),
      timelineStartMs: 0,
      timelineEndMs: 1_000,
      status: 'finalized' as const,
    };
    const artifact = {
      id: 'meeting-1',
      audioAssets: [
        {
          id: recovered.assetId,
          meetingId: recovered.meetingId,
          sourceKind: recovered.sourceKind,
          timelinePart: 0,
          format: recovered.format,
          sampleRate: recovered.sampleRate,
          channels: recovered.channels,
          timelineStartMs: recovered.timelineStartMs,
          timelineEndMs: recovered.timelineEndMs,
          durationMs: recovered.durationMs,
          bytes: recovered.bytes,
          checksum: recovered.checksumSha256,
          status: recovered.status,
        },
      ],
    } as MeetingArtifact;

    expect(recoveredAssetsMissingPersistence(artifact, [recovered])).toEqual([]);
    expect(
      recoveredAssetsMissingPersistence(artifact, [
        { ...recovered, assetId: 'asset-2', status: 'interrupted' },
      ])
    ).toEqual([{ ...recovered, assetId: 'asset-2', status: 'interrupted' }]);
  });

  it('keeps background artifact results scoped away from the active presentation', () => {
    const activeArtifact = {
      id: 'meeting-b',
    } as MeetingArtifact;
    expect(artifactOwnsPresentation({ artifact: activeArtifact }, 'meeting-b')).toBe(true);
    expect(artifactOwnsPresentation({ artifact: activeArtifact }, 'meeting-a')).toBe(false);
  });

  it('resolves stop persistence from the capture-owned meeting instead of a stale selection', async () => {
    const selected = { id: 'meeting-a' } as MeetingArtifact;
    const captured = { id: 'meeting-b' } as MeetingArtifact;
    const loadArtifact = vi.fn(async () => captured);

    await expect(resolveCaptureArtifact('meeting-b', selected, loadArtifact)).resolves.toBe(
      captured
    );
    expect(loadArtifact).toHaveBeenCalledWith('meeting-b');

    loadArtifact.mockClear();
    await expect(resolveCaptureArtifact('meeting-a', selected, loadArtifact)).resolves.toBe(
      selected
    );
    expect(loadArtifact).not.toHaveBeenCalled();
  });

  it('treats coordinator completion as complete before optional refinement finishes', () => {
    expect(captureLifecycle('complete')).toBe('complete');
    expect(
      meetingStopTerminalState(
        {
          lifecycle: 'complete',
          finalizedAssets: [{ status: 'finalized' }],
        },
        false
      )
    ).toEqual({
      lifecycle: 'complete',
      captureStatus: 'complete',
      refinementStatus: 'queued',
    });
  });

  it('keeps interrupted capture terminal while allowing separate refinement work', () => {
    expect(
      meetingStopTerminalState(
        {
          lifecycle: 'complete',
          finalizedAssets: [{ status: 'interrupted' }],
        },
        false
      )
    ).toEqual({
      lifecycle: 'interrupted',
      captureStatus: 'interrupted',
      refinementStatus: 'queued',
    });
  });

  it('reports transcript persistence separately from successful audio finalization', () => {
    expect(
      meetingStopTerminalState(
        {
          lifecycle: 'complete',
          finalizedAssets: [{ status: 'finalized' }],
        },
        true
      )
    ).toEqual({
      lifecycle: 'interrupted',
      captureStatus: 'complete',
      refinementStatus: 'retry_wait',
    });
  });
});

describe('research stage progression', () => {
  it('retains a local quick result as the limited preliminary instead of duplicating the same work', () => {
    expect(shouldRunDeepResearch('quick', {})).toBe(false);
  });

  it('advances only when the gateway policy explicitly recommends deep research', () => {
    expect(shouldRunDeepResearch('quick', { escalation: { recommended: true } })).toBe(true);
    expect(shouldRunDeepResearch('quick', { escalation: { recommended: false } })).toBe(false);
    expect(shouldRunDeepResearch('deep', { escalation: { recommended: true } })).toBe(false);
  });

  it('uses bounded exponential polling and stops immediately when cancelled', async () => {
    const poll = vi.fn(async (jobId: string) => ({ jobId, status: 'running' as const }));
    const delays: number[] = [];
    const current = await pollGatewayJobUntilSettled(
      { jobId: 'check_1', status: 'pending' },
      poll,
      {
        delaysMs: [100, 200, 400],
        wait: async (delayMs) => {
          delays.push(delayMs);
          return true;
        },
      }
    );

    expect(delays).toEqual([100, 200, 400]);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(current).toEqual({ jobId: 'check_1', status: 'running' });

    const controller = new AbortController();
    controller.abort();
    poll.mockClear();
    await expect(
      pollGatewayJobUntilSettled({ jobId: 'check_1', status: 'pending' }, poll, {
        signal: controller.signal,
        delaysMs: [100],
        wait: async () => true,
      })
    ).resolves.toEqual({ jobId: 'check_1', status: 'pending' });
    expect(poll).not.toHaveBeenCalled();
  });

  it('resumes retry_wait work with the accepted ID and original idempotency key', () => {
    const recovery = {
      id: 'research-job-1',
      claimVersionId: 'claim-version-1',
      stage: 'preliminary' as const,
      gatewayJobId: 'local-fact-old',
      idempotencyKey: 'claim-version-1:quick:1',
      status: 'retry_wait' as const,
      attemptCount: 1,
    };

    expect(researchAttemptPlan('claim-version-1', 'quick', recovery)).toMatchObject({
      attemptCount: 1,
      idempotencyKey: 'claim-version-1:quick:1',
      pollJobId: 'local-fact-old',
    });
    expect(
      researchAttemptPlan('claim-version-1', 'quick', { ...recovery, status: 'pending' })
    ).toMatchObject({
      attemptCount: 1,
      idempotencyKey: 'claim-version-1:quick:1',
      pollJobId: 'local-fact-old',
    });
  });

  it('bounds automatic research retries while leaving nonretryable failures terminal', () => {
    const retryable = { code: 'provider_unavailable', message: 'Offline', retryable: true };
    expect(researchFailureDisposition(retryable, 1)).toMatchObject({
      status: 'retry_wait',
      completedAtMs: null,
      error: { retryable: true },
    });
    expect(researchFailureDisposition(retryable, 3)).toMatchObject({
      status: 'failed',
      error: { retryable: false },
    });
    expect(
      researchFailureDisposition(
        { code: 'invalid_local_research_response', message: 'Invalid', retryable: false },
        1
      )
    ).toMatchObject({ status: 'failed', error: { retryable: false } });
  });
});

describe('durable refinement failure progression', () => {
  const uploadingJob: MeetingRefinementJobUpsertDto = {
    id: 'e86c3525-7427-49dd-989f-c1e6817985de',
    sourceTranscriptVersionId: '019fed92-72d8-7160-804a-d31faa2598dc',
    inputManifestChecksum: 'manifest-checksum',
    provider: 'assemblyai',
    model: 'gateway-configured',
    gatewayJobId: null,
    idempotencyKey: '019fed92-72d6-7e53-ad3a-2feaa6d97908:manifest-checksum:assemblyai',
    status: 'uploading',
    attemptCount: 1,
    nextRetryAtMs: null,
    usage: null,
    latencyMs: null,
    startedAtMs: 500,
    completedAtMs: null,
    error: null,
  };

  it('moves the same durable job to retry_wait when submit throws after uploading persistence', async () => {
    const writes: MeetingRefinementJobUpsertDto[] = [];
    const persistJob = vi.fn(async (_meetingId, job: MeetingRefinementJobUpsertDto) => {
      writes.push({ ...job, error: job.error ? { ...job.error } : null });
    });
    const submit = vi.fn().mockRejectedValue(new Error('Gateway is not configured'));

    const outcome = await runDurableRefinementOperation(
      '019fed92-72d6-7e53-ad3a-2feaa6d97908',
      uploadingJob,
      submit,
      persistJob,
      'Transcript refinement needs the configured gateway.',
      () => 1_000
    );

    expect(outcome).toMatchObject({
      ok: false,
      failure: {
        status: 'retry_wait',
        nextRetryAtMs: 6_000,
        completedAtMs: null,
        error: {
          code: 'live_operation_failed',
          message: 'Transcript refinement needs the configured gateway.',
          retryable: true,
        },
      },
    });
    expect(writes.map((job) => job.status)).toEqual(['uploading', 'retry_wait']);
    expect(writes[1]).toMatchObject({
      id: uploadingJob.id,
      sourceTranscriptVersionId: uploadingJob.sourceTranscriptVersionId,
      inputManifestChecksum: uploadingJob.inputManifestChecksum,
      idempotencyKey: uploadingJob.idempotencyKey,
      attemptCount: 1,
      gatewayJobId: null,
      status: 'retry_wait',
    });
    expect(writes).not.toContainEqual(expect.objectContaining({ status: 'complete' }));
  });

  it('terminalizes nonretryable and exhausted failures', () => {
    expect(
      refinementFailureDisposition(
        { code: 'invalid_refinement', message: 'Invalid response', retryable: false },
        1,
        10_000
      )
    ).toMatchObject({
      status: 'failed',
      nextRetryAtMs: null,
      completedAtMs: 10_000,
      error: { retryable: false },
    });
    expect(
      refinementFailureDisposition(
        { code: 'gateway_unavailable', message: 'Offline', retryable: true },
        3,
        10_000
      )
    ).toMatchObject({
      status: 'failed',
      nextRetryAtMs: null,
      completedAtMs: 10_000,
      error: { retryable: false },
    });
  });
});

describe('sttSourcesForCapture', () => {
  it('uses one mixed session for mixed diarization', () => {
    expect(sttSourcesForCapture('mixed_diarized', true)).toEqual(['mixed']);
  });

  it('uses independent microphone and system sessions when both sources are enabled', () => {
    expect(sttSourcesForCapture('source_separated', true)).toEqual(['microphone', 'system']);
  });

  it('keeps source-separated microphone-only capture to one session', () => {
    expect(sttSourcesForCapture('source_separated', false)).toEqual(['microphone']);
  });
});

describe('deriveSttState', () => {
  const desired: LiveAudioSourceKind[] = ['microphone', 'system'];

  it('reports streaming only when every desired source has begun', () => {
    expect(
      deriveSttState(
        desired,
        sourceSet('microphone', 'system'),
        sourceSet('microphone', 'system'),
        sourceSet(),
        'connecting'
      )
    ).toBe('streaming');
  });

  it('keeps parallel initial connections in the connecting state', () => {
    expect(
      deriveSttState(
        desired,
        sourceSet('microphone', 'system'),
        sourceSet('microphone'),
        sourceSet(),
        'connecting'
      )
    ).toBe('connecting');
  });

  it('reports a reconnect while a sibling source remains live', () => {
    expect(
      deriveSttState(
        desired,
        sourceSet('microphone'),
        sourceSet('microphone'),
        sourceSet('system'),
        'streaming'
      )
    ).toBe('reconnecting');
  });

  it('preserves a terminal source error while a sibling remains live', () => {
    expect(
      deriveSttState(
        desired,
        sourceSet('microphone'),
        sourceSet('microphone'),
        sourceSet(),
        'error'
      )
    ).toBe('error');
  });
});

describe('local STT runtime isolation', () => {
  it('persists truthful local provider and model metadata', () => {
    const artifact = {
      id: 'f46bc702-a584-4f71-b3e8-3b8ae7bc5f7f',
      liveTranscriptVersionId: '1738bb22-aa73-43d9-bf1d-f5622d9ccbc0',
      startedAtMs: 1_000,
      versions: [],
    } as unknown as MeetingArtifact;

    expect(transcriptVersionUpsert(artifact, 'faster_whisper', 'base.en')).toMatchObject({
      id: artifact.liveTranscriptVersionId,
      provider: 'faster_whisper',
      model: 'base.en',
    });
  });

  it('marks transcription independently without claiming the research gateway recovered', () => {
    expect(gatewayStateAfterSttBegin('unavailable', 'faster_whisper', true)).toBe('unavailable');
    expect(gatewayStateAfterSttBegin('degraded', 'faster_whisper', true)).toBe('degraded');
    expect(gatewayStateAfterSttBegin('unavailable', 'assemblyai', true)).toBe('ready');
  });

  it('bounds local retries without disabling hosted recovery', () => {
    expect(shouldReconnectStt('faster_whisper', true, 0)).toBe(true);
    expect(shouldReconnectStt('faster_whisper', true, 3)).toBe(false);
    expect(shouldReconnectStt('assemblyai', true, 3)).toBe(true);
    expect(shouldReconnectStt('assemblyai', false, 0)).toBe(false);
  });

  it('awaits provider termination so a pause keeps the local transcript tail', async () => {
    let flushed = false;
    const terminate = vi.fn(async () => {
      await Promise.resolve();
      flushed = true;
    });
    const close = vi.fn();

    await terminateSttProvidersForGap([{ connect: vi.fn(), sendAudio: vi.fn(), terminate, close }]);

    expect(flushed).toBe(true);
    expect(terminate).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('does not let a reconnect run until asynchronous local release has finished', async () => {
    let finishRelease!: () => void;
    const release = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const close = vi.fn();
    const reconnect = vi.fn();
    const provider = {
      connect: vi.fn(),
      sendAudio: vi.fn(),
      terminate: vi.fn(),
      close,
      waitUntilReleased: vi.fn(() => release),
    };

    const operation = releaseSttProvider(provider).then(reconnect);
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    expect(reconnect).not.toHaveBeenCalled();

    finishRelease();
    await operation;
    expect(reconnect).toHaveBeenCalledOnce();
  });
});

describe('gap lifecycle contracts', () => {
  it('bounds durable turn-write retries and acknowledges a later successful attempt', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const result = await retryDurableOperation(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('temporary local write failure');
        return 'saved';
      },
      [25, 50, 100],
      async (delayMs) => {
        waits.push(delayMs);
      }
    );

    expect(result).toBe('saved');
    expect(attempts).toBe(3);
    expect(waits).toEqual([25, 50]);
  });

  it('stops retrying after the configured durable-write budget', async () => {
    let attempts = 0;
    await expect(
      retryDurableOperation(
        async () => {
          attempts += 1;
          throw new Error('persistent local write failure');
        },
        [1, 2],
        async () => undefined
      )
    ).rejects.toThrow('persistent local write failure');
    expect(attempts).toBe(3);
  });

  it('does not open or reconnect STT sessions while a capture gap is suspended', () => {
    expect(canRunSttSession('recording', false)).toBe(true);
    expect(canRunSttSession('recording', true)).toBe(false);
    expect(canRunSttSession('paused', false)).toBe(false);
  });

  it('persists open pause gaps so Rust can close them idempotently after resume', () => {
    const openPause = {
      id: '660842f5-c78f-45ea-bf61-d9f34f518c0c',
      kind: 'pause' as const,
      startMs: 1_000,
    };
    expect(captureTimelineEventIsDurable(openPause)).toBe(true);
    expect(captureTimelineEventIsDurable({ ...openPause, endMs: 6_000 })).toBe(true);
    expect(
      timelineEventFromCapture('f46bc702-a584-4f71-b3e8-3b8ae7bc5f7f', {
        ...openPause,
        endMs: 6_000,
      })
    ).toMatchObject({
      kind: 'pause',
      startMs: 1_000,
      endMs: 6_000,
      label: 'Recording paused',
    });
  });

  it('reconstructs controlled interrupted WAV inputs for refinement retry', () => {
    const artifact: MeetingArtifact = {
      id: 'f46bc702-a584-4f71-b3e8-3b8ae7bc5f7f',
      title: 'Recovered fixture',
      artifactType: 'meeting',
      mode: 'call',
      status: 'interrupted',
      strategy: 'mixed_diarized',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      refinementStatus: 'failed',
      researchStatus: 'pending',
      versions: [],
      turns: [],
      speakers: [],
      timeline: [],
      claims: [],
      manualFactCheckRequests: [],
      pendingClaimGateSegmentIds: [],
      pendingClaimGateBatches: [],
      audioAssets: [
        {
          id: '94c15b58-6aaa-41e0-9bca-dcfda2838935',
          meetingId: 'f46bc702-a584-4f71-b3e8-3b8ae7bc5f7f',
          sourceKind: 'mixed',
          timelinePart: 0,
          format: 'wav',
          sampleRate: 16_000,
          channels: 1,
          timelineStartMs: 0,
          timelineEndMs: 8_000,
          durationMs: 8_000,
          bytes: 256_044,
          checksum: 'a'.repeat(64),
          status: 'interrupted',
        },
      ],
      researchJobs: [],
      refinementJobs: [],
    };

    expect(reconstructArtifactAudioAssets(artifact)).toEqual([
      expect.objectContaining({
        assetId: '94c15b58-6aaa-41e0-9bca-dcfda2838935',
        sourceKind: 'mixed',
        status: 'interrupted',
        timelineEndMs: 8_000,
      }),
    ]);
  });
});

describe('manual fact-check artifact selection', () => {
  const artifact = {
    id: 'f46bc702-a584-4f71-b3e8-3b8ae7bc5f7f',
    turns: [],
  } as unknown as MeetingArtifact;

  it('keeps an in-transcript selection on its loaded completed artifact', () => {
    expect(
      reusableFactCheckArtifact(
        { turnIds: ['turn-1'] },
        {
          artifact,
          runtime: { ...initialMeetingState.runtime, meetingId: undefined, lifecycle: 'setup' },
        }
      )
    ).toBe(artifact);
  });

  it('does not reuse unrelated history for a global context-menu selection', () => {
    expect(
      reusableFactCheckArtifact(
        {},
        {
          artifact,
          runtime: { ...initialMeetingState.runtime, meetingId: undefined, lifecycle: 'setup' },
        }
      )
    ).toBeUndefined();
  });

  it('attaches a plain selection only while that artifact is actively recording', () => {
    expect(
      reusableFactCheckArtifact(
        {},
        {
          artifact,
          runtime: {
            ...initialMeetingState.runtime,
            meetingId: artifact.id,
            lifecycle: 'recording',
          },
        }
      )
    ).toBe(artifact);
  });

  it('persists selected transcript turns with adjacent immutable context in order', () => {
    const turn = (id: string, order: number, text: string) =>
      ({
        id,
        meetingId: artifact.id,
        transcriptVersionId: 'live-version-1',
        providerTurnOrder: order,
        revision: 0,
        speakerId: 'speaker-1',
        sourceKind: 'mixed',
        startMs: order * 1_000,
        endMs: order * 1_000 + 900,
        text,
      }) as never;
    const contextualArtifact = {
      ...artifact,
      turns: [
        turn('turn-1', 1, 'Before.'),
        turn('turn-2', 2, 'Selected.'),
        turn('turn-3', 3, 'After.'),
      ],
    };

    const context = manualFactCheckContext(
      contextualArtifact,
      { text: 'Selected', turnIds: ['turn-2'] },
      'manual-request-1',
      'Selected'
    );

    expect(context.sourceSegmentIds).toEqual(['turn-2']);
    expect(context.contextTurns.map((turn) => [turn.id, turn.text, turn.revision])).toEqual([
      ['turn-1', 'Before.', 0],
      ['turn-2', 'Selected.', 0],
      ['turn-3', 'After.', 0],
    ]);
  });

  it('uses a synthetic context snapshot without segment IDs for standalone text checks', () => {
    const context = manualFactCheckContext(
      artifact,
      { text: 'Selected claim' },
      'manual-request-1',
      'Selected claim'
    );

    expect(context.sourceSegmentIds).toEqual([]);
    expect(context.contextTurns).toEqual([
      expect.objectContaining({ text: 'Selected claim', revision: 0, sourceKind: 'text' }),
    ]);
  });

  it('turns a native context-menu selection into a visible manual claim when detection is offline', async () => {
    const selection = {
      text: 'Barnes and Noble is a bigger company than Amazon.',
      source: 'context-menu' as const,
      capturedAtEpochMs: 1_000,
    };
    const context = manualFactCheckContext(
      artifact,
      { text: selection.text },
      'context-menu-request-1',
      selection.text
    );
    const request = {
      id: 'context-menu-request-1',
      meetingId: artifact.id,
      exactSelection: selection.text,
      contextTurns: context.contextTurns,
      sourceSegmentIds: context.sourceSegmentIds,
      status: 'processing',
      createdAtMs: selection.capturedAtEpochMs,
      updatedAtMs: selection.capturedAtEpochMs,
    } as ManualFactCheckRequest;

    const candidates = await resolveManualClaimCandidatesWithFallback(request, async () => {
      throw new Error('gateway unavailable');
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        exactQuote: selection.text,
        normalizedClaim: selection.text,
        contextTurnIds: [],
      }),
    ]);
  });

  it('anchors a cross-row native selection and excludes transcript gutter text', () => {
    const transcriptTurn = (id: string, order: number, text: string) =>
      ({
        id,
        meetingId: artifact.id,
        transcriptVersionId: 'live-version-1',
        provider: 'faster_whisper',
        providerSessionId: 'local-session-1',
        providerTurnId: String(order),
        providerTurnOrder: order,
        revision: 0,
        status: 'final',
        speakerId: 'speaker-1',
        sourceKind: 'mixed',
        startMs: order * 1_000,
        endMs: order * 1_000 + 900,
        text,
        words: [],
        utteranceBoundary: true,
        endOfTurn: true,
        formatted: true,
        receivedAtMs: order * 1_000 + 950,
      }) as const;
    const first = transcriptTurn(
      '1f60da22-680c-454a-b975-b2931d1f56e2',
      1,
      'So in my experience Barnes & Noble is a bigger company'
    );
    const second = transcriptTurn(
      'a9761dd0-01f0-43d9-ad13-dde23185652b',
      2,
      'company than Amazon.'
    );
    document.body.innerHTML = `
      <div data-turn-id="${first.id}">
        <span>Identifying speaker…</span><time>0:15</time>
        <p data-transcript-text>${first.text}</p>
      </div>
      <div data-turn-id="${second.id}">
        <span>Identifying speaker…</span><time>0:18</time>
        <p data-transcript-text>${second.text}</p>
      </div>
    `;
    const firstText = document.querySelectorAll('[data-transcript-text]')[0].firstChild;
    const secondText = document.querySelectorAll('[data-transcript-text]')[1].firstChild;
    if (!firstText || !secondText) throw new Error('Expected transcript text nodes');
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(secondText, secondText.textContent?.length ?? 0);
    Object.defineProperty(range, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 20, top: 40, width: 100 }),
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const input = selectionFactCheckInputFromActiveDom(
      {
        text: 'Identifying speaker…0:15 So in my experience Barnes & Noble is a bigger company Identifying speaker…0:18 company than Amazon.',
        source: 'context-menu',
        capturedAtEpochMs: 1_000,
      },
      {
        artifact: { ...artifact, turns: [first, second] } as unknown as MeetingArtifact,
        activeTurns: {},
      }
    );

    expect(input).toEqual({
      text: 'So in my experience Barnes & Noble is a bigger company than Amazon.',
      turnIds: [first.id, second.id],
      speakerId: 'speaker-1',
      startMs: first.startMs,
      endMs: second.endMs,
      nearbyContext: 'So in my experience Barnes & Noble is a bigger company than Amazon.',
      anchor: { x: 70, y: 40 },
    });
    selection?.removeAllRanges();
    document.body.replaceChildren();
  });

  it('uses model decomposition and falls back to the whole selection without punctuation splitting', async () => {
    const request = {
      id: 'manual-request-1',
      meetingId: artifact.id,
      exactSelection: 'Revenue rose; costs fell.',
      contextTurns: [],
      sourceSegmentIds: [],
      status: 'processing',
      createdAtMs: 0,
      updatedAtMs: 0,
    } as ManualFactCheckRequest;
    const fallback = await resolveManualClaimCandidates(request, []);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({
      exactQuote: 'Revenue rose; costs fell.',
      contextTurnIds: [],
    });

    const modelChildren = await resolveManualClaimCandidates(request, [
      {
        ...fallback[0],
        exactQuote: 'Revenue rose',
        normalizedClaim: 'Revenue rose',
        semanticDuplicateKey: 'revenue-rose',
        contextTurnIds: ['adjacent-turn'],
      },
      {
        ...fallback[0],
        exactQuote: 'costs fell',
        normalizedClaim: 'costs fell',
        semanticDuplicateKey: 'costs-fell',
        contextTurnIds: ['adjacent-turn'],
      },
    ]);
    expect(modelChildren.map((candidate) => candidate.exactQuote)).toEqual([
      'Revenue rose',
      'costs fell',
    ]);
    expect(modelChildren.every((candidate) => candidate.contextTurnIds.length === 0)).toBe(true);
  });
});

describe('restart-safe recovery loop', () => {
  it('reconciles active work once at startup and keeps periodic scans non-mutating', async () => {
    vi.useFakeTimers();
    const modes: boolean[] = [];
    const stop = startMeetingRecoveryLoop(async (reconcileActiveWork, controls) => {
      modes.push(reconcileActiveWork);
      controls.acknowledgeStartupReconciliation();
    }, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(modes).toEqual([true, false, false]);
    stop();
  });

  it('reconciles once again after an application restart', async () => {
    vi.useFakeTimers();
    const modes: boolean[] = [];
    const runOnce = async (
      reconcileActiveWork: boolean,
      controls: {
        acknowledgeStartupReconciliation: () => void;
      }
    ) => {
      modes.push(reconcileActiveWork);
      controls.acknowledgeStartupReconciliation();
    };

    const stopFirstRun = startMeetingRecoveryLoop(runOnce, 1_000);
    await Promise.resolve();
    stopFirstRun();
    const stopRestartedRun = startMeetingRecoveryLoop(runOnce, 1_000);
    await Promise.resolve();
    stopRestartedRun();

    expect(modes).toEqual([true, true]);
  });

  it('resumes every nonterminal durable research job', () => {
    expect(resumableRecoveredResearchJob('pending')).toBe(true);
    expect(resumableRecoveredResearchJob('retry_wait')).toBe(true);
    expect(resumableRecoveredResearchJob('running')).toBe(true);
    expect(resumableRecoveredRefinementJob('queued')).toBe(true);
    expect(resumableRecoveredRefinementJob('retry_wait')).toBe(true);
    expect(resumableRecoveredRefinementJob('processing')).toBe(false);
    expect(
      resumableRecoveredCleanupJob({
        localStatus: 'complete',
        gatewayStatus: 'retry_wait',
        providerStatus: 'unavailable',
      })
    ).toBe(true);
    expect(
      resumableRecoveredCleanupJob({
        localStatus: 'complete',
        gatewayStatus: 'running',
        providerStatus: 'pending',
      })
    ).toBe(false);
    expect(
      resumableRecoveredCleanupJob({
        localStatus: 'failed',
        gatewayStatus: 'pending',
        providerStatus: 'complete',
      })
    ).toBe(false);
  });

  it('does not relaunch a periodic recovery while the normal job is still in flight', async () => {
    const inFlight = new Set<string>();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submit = vi.fn(async () => pending);

    const normalOperation = runExclusiveLiveOperation(inFlight, 'job-1', submit);
    const periodicRecovery = runExclusiveLiveOperation(inFlight, 'job-1', submit);

    await expect(periodicRecovery).resolves.toBeUndefined();
    expect(submit).toHaveBeenCalledOnce();
    release();
    await expect(normalOperation).resolves.toBeUndefined();
    expect(inFlight).toEqual(new Set());
  });

  it('terminalizes truthful provider-retention limitations without retrying forever', () => {
    expect(
      meetingCleanupConfirmation('complete', {
        meetingId: 'meeting-1',
        status: 'partial',
        gatewayCleanup: 'complete',
        providerCleanup: 'partial',
        limitation: 'One provider upload follows the provider retention policy.',
      })
    ).toEqual({
      localStatus: 'complete',
      gatewayStatus: 'complete',
      providerStatus: 'unavailable',
      limitation: 'One provider upload follows the provider retention policy.',
      error: {
        code: 'provider_retention_limitation',
        message: 'One provider upload follows the provider retention policy.',
        retryable: false,
      },
    });
  });
});

describe('translateSttEventToMeetingClock', () => {
  it('anchors a rotated provider session and its words to the shared meeting clock', () => {
    const translated = translateSttEventToMeetingClock(
      {
        type: 'turn',
        providerSessionId: 'session-system-2',
        turnId: 'turn-1',
        turnOrder: 1,
        revision: 0,
        transcript: 'The shared clock stays monotonic.',
        words: [
          {
            id: 'word-1',
            text: 'The',
            startMs: 100,
            endMs: 250,
            final: true,
          },
        ],
        startMs: 100,
        endMs: 1_000,
        utteranceBoundary: true,
        endOfTurn: true,
        turnIsFormatted: true,
        durableFinal: true,
        receivedAtMs: 181_100,
      },
      180_000
    );

    expect(translated.type).toBe('turn');
    if (translated.type !== 'turn') throw new Error('Expected a turn event');
    expect(translated.startMs).toBe(180_100);
    expect(translated.endMs).toBe(181_000);
    expect(translated.words[0]).toMatchObject({ startMs: 180_100, endMs: 180_250 });
  });
});
