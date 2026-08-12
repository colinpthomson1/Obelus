/**
 * @vitest-environment jsdom
 */
import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveAudioAsset, LiveCaptureSnapshot, LiveSupportStatus } from './ipcTypes';
import type { MeetingArtifact, TranscriptTurn } from './types';

const mocks = vi.hoisted(() => ({
  artifacts: new Map<string, MeetingArtifact>(),
  adapters: [] as Array<{ emit: (event: unknown) => void }>,
  applyRefinedTranscript: vi.fn(),
  applySpeakers: vi.fn(async () => undefined),
  applyTimelineEvent: vi.fn(async () => undefined),
  confirmMeetingCleanup: vi.fn(async () => undefined),
  createMeeting: vi.fn(),
  deleteMeeting: vi.fn(),
  getMeeting: vi.fn(),
  listMeetings: vi.fn(async () => []),
  persistAudioAssets: vi.fn(async (_meetingId: string, _assets: unknown[]) => undefined),
  persistClaimVersions: vi.fn(),
  persistRefinementJob: vi.fn(async () => undefined),
  persistResearch: vi.fn(),
  persistTranscriptTurn: vi.fn(async (_meetingId: string, ..._args: unknown[]) => undefined),
  recoverMeetingJobs: vi.fn(async () => ({
    researchJobs: [],
    refinementJobs: [],
    cleanupJobs: [],
  })),
  updateMeeting: vi.fn(),
  terminateStt: vi.fn(async () => undefined),
  capture: {
    devices: [] as MediaDeviceInfo[],
    microphoneMeter: { rms: 0, peak: 0 },
    systemMeter: { rms: 0, peak: 0 },
    startCapture: vi.fn(async () => ({ includeSystemAudio: false })),
    activateCapture: vi.fn(async () => undefined),
    pauseCapture: vi.fn(async () => undefined),
    resumeCapture: vi.fn(),
    stopCapture: vi.fn(async () => undefined),
    testMicrophone: vi.fn(async () => undefined),
    refreshDevices: vi.fn(async () => undefined),
  },
}));

vi.mock('../acp/meetings', () => ({
  applyRefinedTranscript: mocks.applyRefinedTranscript,
  applySpeakers: mocks.applySpeakers,
  applyTimelineEvent: mocks.applyTimelineEvent,
  confirmMeetingCleanup: mocks.confirmMeetingCleanup,
  createMeeting: mocks.createMeeting,
  deleteMeeting: mocks.deleteMeeting,
  getMeeting: mocks.getMeeting,
  listMeetings: mocks.listMeetings,
  persistAudioAssets: mocks.persistAudioAssets,
  persistClaimVersions: mocks.persistClaimVersions,
  persistRefinementJob: mocks.persistRefinementJob,
  persistResearch: mocks.persistResearch,
  persistTranscriptTurn: mocks.persistTranscriptTurn,
  recoverMeetingJobs: mocks.recoverMeetingJobs,
  updateMeeting: mocks.updateMeeting,
}));

vi.mock('../hooks/useLiveAudioCapture', () => ({
  useLiveAudioCapture: () => mocks.capture,
}));

vi.mock('./assemblyStreamingAdapter', () => ({
  AssemblyStreamingAdapter: class {
    constructor(
      configuration: { providerSessionId: string; model: string },
      private readonly onEvent: (event: unknown) => void
    ) {
      this.providerSessionId = configuration.providerSessionId;
      this.model = configuration.model;
      mocks.adapters.push(this);
    }

    private readonly providerSessionId: string;
    private readonly model: string;

    async connect() {
      this.onEvent({
        type: 'begin',
        providerSessionId: this.providerSessionId,
        requestedModel: this.model,
        configuredModel: this.model,
      });
    }

    emit(event: unknown) {
      this.onEvent(event);
    }

    sendAudio() {}
    async terminate() {
      await mocks.terminateStt();
    }
    close() {}
  },
}));

import { LiveMeetingRuntimeProvider, useLiveMeetingRuntime } from './LiveMeetingRuntimeProvider';

function artifact(id: string, title: string, status: MeetingArtifact['status']): MeetingArtifact {
  const liveTranscriptVersionId = `live-${id}`;
  return {
    id,
    title,
    artifactType: 'meeting',
    mode: 'call',
    status,
    strategy: 'mixed_diarized',
    startedAtMs: 1_786_403_200_000,
    endedAtMs: status === 'complete' ? 1_786_403_258_000 : undefined,
    createdAt: '2026-08-10T22:00:00.000Z',
    updatedAt: '2026-08-10T22:01:00.000Z',
    liveTranscriptVersionId,
    canonicalTranscriptVersionId: liveTranscriptVersionId,
    refinementStatus: status === 'complete' ? 'failed' : 'not_started',
    researchStatus: 'pending',
    versions: [
      {
        id: liveTranscriptVersionId,
        meetingId: id,
        kind: 'live',
        status: 'active',
        revision: 0,
        createdAt: '2026-08-10T22:00:00.000Z',
      },
    ],
    turns: [],
    speakers: [],
    timeline: [],
    claims: [],
    manualFactCheckRequests: [],
    pendingClaimGateSegmentIds: [],
    pendingClaimGateBatches: [],
    audioAssets:
      status === 'complete'
        ? [
            {
              id: `asset-${id}`,
              meetingId: id,
              sourceKind: 'mixed',
              timelinePart: 0,
              format: 'wav',
              sampleRate: 16_000,
              channels: 1,
              timelineStartMs: 0,
              timelineEndMs: 58_000,
              durationMs: 58_000,
              bytes: 1_856_044,
              checksum: 'a'.repeat(64),
              status: 'finalized',
            },
          ]
        : [],
    researchJobs: [],
    refinementJobs: [],
  };
}

function emptySource() {
  return {
    state: 'unavailable' as const,
    meter: { rms: 0, peak: 0 },
    bytesWritten: 0,
    droppedFrames: 0,
  };
}

function captureSnapshot(patch: Partial<LiveCaptureSnapshot> = {}): LiveCaptureSnapshot {
  return {
    lifecycle: 'idle',
    meetingId: null,
    ownerWebContentsId: null,
    mode: null,
    strategy: null,
    includeSystemAudio: false,
    startedAtEpochMs: null,
    elapsedMs: 0,
    pausedAtMs: null,
    sources: {
      microphone: emptySource(),
      system: emptySource(),
      mixed: emptySource(),
    },
    timelineEvents: [],
    finalizedAssets: [],
    recoveredMeetings: [],
    lastError: null,
    ...patch,
  };
}

const support: LiveSupportStatus = {
  platform: 'darwin',
  systemVersion: '13.6.9',
  macosVersion: '13.6.9',
  microphoneOnlySupported: true,
  fullCallCaptureSupported: true,
  systemAudioRequiresHealthCheck: true,
  microphonePermission: 'granted',
  systemAudioPermission: 'not-determined',
  gatewayAvailable: false,
  gatewayUnavailableReason: 'Gateway unavailable',
  localSttAvailable: false,
  localFactCheckMode: 'local_wikimedia',
  localFactCheckAvailable: false,
  directFactCheckFallbackEnabled: false,
};

function finalizedAsset(meetingId: string): LiveAudioAsset {
  return {
    assetId: `asset-${meetingId}`,
    meetingId,
    sourceKind: 'mixed',
    relativePath: `${meetingId}/mixed.wav`,
    format: 'wav',
    sampleRate: 16_000,
    channels: 1,
    durationMs: 8_000,
    bytes: 256_044,
    checksumSha256: 'b'.repeat(64),
    timelineStartMs: 0,
    timelineEndMs: 8_000,
    status: 'finalized',
  };
}

type Runtime = ReturnType<typeof useLiveMeetingRuntime>;
let runtime: Runtime;
let snapshot: LiveCaptureSnapshot;
let api: Record<string, ReturnType<typeof vi.fn>>;

function Harness() {
  runtime = useLiveMeetingRuntime();
  return <div data-testid="meeting-id">{runtime.state.artifact?.id ?? 'setup'}</div>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mocks.artifacts.clear();
  mocks.adapters.length = 0;
  vi.clearAllMocks();
  mocks.terminateStt.mockResolvedValue(undefined);
  const oldArtifact = artifact('meeting-a', 'Previous artifact', 'complete');
  mocks.artifacts.set(oldArtifact.id, oldArtifact);
  mocks.getMeeting.mockImplementation(async (meetingId: string) => {
    const found = mocks.artifacts.get(meetingId);
    if (!found) throw new Error(`Missing fixture ${meetingId}`);
    return found;
  });
  mocks.createMeeting.mockImplementation(async (input: { title?: string }) => {
    const created = artifact('meeting-b', input.title || 'Untitled meeting', 'recording');
    mocks.artifacts.set(created.id, created);
    return created;
  });
  mocks.updateMeeting.mockImplementation(
    async (meetingId: string, patch: Partial<MeetingArtifact>) => {
      const current = mocks.artifacts.get(meetingId);
      if (!current) throw new Error(`Missing fixture ${meetingId}`);
      const updated = { ...current, ...patch } as MeetingArtifact;
      mocks.artifacts.set(meetingId, updated);
      return updated;
    }
  );
  mocks.applyRefinedTranscript.mockImplementation(async () => ({
    ...mocks.artifacts.get('meeting-a')!,
    refinementStatus: 'complete',
  }));
  snapshot = captureSnapshot();
  api = {
    getSnapshot: vi.fn(async () => snapshot),
    getSupportStatus: vi.fn(async () => support),
    start: vi.fn(async (config: { meetingId: string }) => {
      snapshot = captureSnapshot({
        lifecycle: 'recording',
        meetingId: config.meetingId,
        ownerWebContentsId: 1,
        mode: 'call',
        strategy: 'mixed_diarized',
        startedAtEpochMs: Date.now(),
      });
      return snapshot;
    }),
    appendAudio: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(async () => snapshot),
    acknowledgeAudioAssetsPersisted: vi.fn(async () => undefined),
    getSttSession: vi.fn(() => new Promise(() => undefined)),
    completeSttSession: vi.fn(async () => undefined),
    getLocalSttSupport: vi.fn(),
    startLocalStt: vi.fn(),
    appendLocalSttAudio: vi.fn(),
    stopLocalStt: vi.fn(),
    submitClaimDetection: vi.fn(),
    submitFactCheck: vi.fn(),
    pollFactCheck: vi.fn(),
    submitRefinement: vi.fn(),
    pollRefinement: vi.fn(),
    deleteRemoteMeeting: vi.fn(),
    deleteLocalMeetingAssets: vi.fn(),
    getAudioPlaybackUrl: vi.fn(),
    openSource: vi.fn(),
    subscribeSnapshot: vi.fn(() => () => undefined),
    subscribeSelection: vi.fn(() => () => undefined),
  };
  Object.assign(window.electron, { live: api });
});

async function renderRuntime() {
  render(
    <MemoryRouter initialEntries={['/live']}>
      <LiveMeetingRuntimeProvider>
        <Harness />
      </LiveMeetingRuntimeProvider>
    </MemoryRouter>
  );
  await waitFor(() => expect(api.getSupportStatus).toHaveBeenCalled());
}

async function openBackAndStartFresh() {
  await act(async () => runtime.openMeeting('meeting-a'));
  act(() => runtime.closeArtifact());
  act(() => runtime.setSetup({ title: 'Call fallback verification Aug 10 5:00 PM' }));
  await act(async () => runtime.startMeeting(true));
  await waitFor(() => expect(runtime.state.artifact?.id).toBe('meeting-b'));
}

describe('fresh meeting lifecycle ownership', () => {
  it('sends bounded split-turn context and new-turn IDs for automatic subscription detection', async () => {
    mocks.persistClaimVersions.mockImplementation(async (meetingId: string, versions = []) => {
      const current = mocks.artifacts.get(meetingId);
      if (!current) throw new Error(`Missing fixture ${meetingId}`);
      if (!Array.isArray(versions) || versions.length === 0) return current;
      const now = new Date().toISOString();
      const persistedClaims = versions.map((value) => {
        const dto = value as Record<string, unknown>;
        return {
          id: dto.claimId as string,
          meetingId,
          origin: dto.origin as 'automatic',
          duplicateKey: dto.duplicateKey as string,
          status: dto.status as 'queued',
          currentVersionId: dto.claimVersionId as string,
          versions: [
            {
              id: dto.claimVersionId as string,
              claimId: dto.claimId as string,
              version: dto.versionNumber as number,
              sourceTranscriptVersionId: dto.sourceTranscriptVersionId as string,
              exactQuote: dto.exactQuote as string,
              normalizedClaim: dto.normalizedClaim as string,
              speakerId: (dto.speakerId as string | null) ?? undefined,
              startMs: dto.startMs as number,
              endMs: dto.endMs as number,
              segmentIds: dto.segmentIds as string[],
              selectionRationale: dto.selectionRationale as string,
              consequenceScore: dto.consequenceScore as number,
              disputeScore: dto.disputeScore as number,
              specificityScore: dto.specificityScore as number,
              timeSensitive: dto.timeSensitive as boolean,
              lifecycle: 'active' as const,
              createdAt: now,
              assessments: [],
            },
          ],
          spokenAtMs: dto.startMs as number,
          createdAt: now,
          updatedAt: now,
        } satisfies MeetingArtifact['claims'][number];
      });
      const updated = { ...current, claims: [...current.claims, ...persistedClaims] };
      mocks.artifacts.set(meetingId, updated);
      return updated;
    });
    await renderRuntime();
    api.getSttSession.mockResolvedValue({
      sessionId: 'meeting-b-stream',
      websocketUrl: 'wss://example.invalid',
      token: 'test-token',
      expiresAtEpochMs: Date.now() + 60_000,
      model: 'universal-streaming-english',
      configuration: { maxSessionDurationSeconds: 10_800 },
    });
    api.submitClaimDetection.mockImplementation(async (request) => ({
      candidates: [
        {
          exactQuote:
            'The difference between night and day is that night is light and day is dark.',
          normalizedClaim:
            'The difference between night and day is that night is light and day is dark.',
          contextTurnIds: request.contextTurns.map((turn: { id: string }) => turn.id),
          startMs: request.contextTurns[0].startMs,
          endMs: request.contextTurns.at(-1).endMs,
          checkworthy: true,
          consequenceScore: 0.5,
          disputeLikelihoodScore: 0.8,
          specificityScore: 0.9,
          timeSensitive: false,
          selectionRationale: 'A concrete factual assertion that can be checked.',
          semanticDuplicateKey: 'night-day-chatgpt-candidate',
        },
      ],
      catchingUp: false,
    }));
    api.submitFactCheck.mockReturnValue(new Promise(() => undefined));
    await openBackAndStartFresh();
    await waitFor(() => expect(mocks.adapters).toHaveLength(1));

    const fragments = [
      ['night-day-1', 0, 2_200, 'The difference between night and day'],
      ['night-day-2', 2_100, 4_300, 'is that night is light and'],
      ['night-day-3', 4_200, 6_780, 'and day is dark.'],
    ] as const;
    act(() => {
      fragments.forEach(([turnId, startMs, endMs, transcript], index) => {
        mocks.adapters[0].emit({
          type: 'turn',
          providerSessionId: 'meeting-b-stream',
          turnId,
          turnOrder: index,
          revision: 0,
          transcript,
          words: [],
          startMs,
          endMs,
          utteranceBoundary: true,
          endOfTurn: true,
          turnIsFormatted: true,
          durableFinal: true,
          receivedAtMs: Date.now(),
        });
      });
    });

    await waitFor(() => expect(api.submitClaimDetection).toHaveBeenCalled(), { timeout: 3_000 });
    const detection = api.submitClaimDetection.mock.calls[0]?.[0];
    expect(detection.contextTurns.map((turn: { text: string }) => turn.text)).toEqual(
      fragments.map(([, , , text]) => text)
    );
    expect(detection.requiredTurnIds).toEqual(
      detection.turns.map((turn: { id: string }) => turn.id)
    );
    expect(detection.contextTurns).toHaveLength(3);
    expect(
      detection.contextTurns.every((turn: { sourceKind?: string }) => turn.sourceKind === 'mixed')
    ).toBe(true);
    await waitFor(() =>
      expect(mocks.persistClaimVersions).toHaveBeenCalledWith(
        'meeting-b',
        [
          expect.objectContaining({
            origin: 'automatic',
            exactQuote:
              'The difference between night and day is that night is light and day is dark.',
            segmentIds: detection.contextTurns.map((turn: { id: string }) => turn.id),
          }),
        ],
        [],
        expect.objectContaining({ completeBatchIds: [expect.any(String)] })
      )
    );
    await waitFor(() => expect(api.submitFactCheck).toHaveBeenCalled());
    expect(api.submitFactCheck).toHaveBeenCalledWith(
      'quick',
      expect.objectContaining({
        meetingId: 'meeting-b',
        origin: 'automatic',
        exactQuote: 'The difference between night and day is that night is light and day is dark.',
      })
    );
  });

  it('durably anchors a manual fact-check from an active turn before persisting the request', async () => {
    mocks.persistTranscriptTurn.mockImplementationOnce(
      async (meetingId: string, _version: unknown, persistedTurn: unknown) => {
        const current = mocks.artifacts.get(meetingId);
        if (!current) throw new Error(`Missing fixture ${meetingId}`);
        mocks.artifacts.set(meetingId, {
          ...current,
          turns: [...current.turns, persistedTurn as TranscriptTurn],
        });
      }
    );
    mocks.persistClaimVersions.mockImplementation(async (meetingId: string) => {
      const current = mocks.artifacts.get(meetingId);
      if (!current) throw new Error(`Missing fixture ${meetingId}`);
      return current;
    });

    await renderRuntime();
    api.getSttSession.mockResolvedValue({
      sessionId: 'meeting-b-stream',
      websocketUrl: 'wss://example.invalid',
      token: 'test-token',
      expiresAtEpochMs: Date.now() + 60_000,
      model: 'universal-streaming-english',
      configuration: { maxSessionDurationSeconds: 10_800 },
    });
    api.submitClaimDetection.mockResolvedValue({ candidates: [] });
    await openBackAndStartFresh();
    await waitFor(() => expect(mocks.adapters).toHaveLength(1));

    act(() =>
      mocks.adapters[0].emit({
        type: 'turn',
        providerSessionId: 'meeting-b-stream',
        turnId: 'turn-1',
        turnOrder: 1,
        revision: 0,
        transcript: 'Barnes & Noble is a bigger company than Amazon.',
        words: [],
        startMs: 27_000,
        endMs: 29_940,
        utteranceBoundary: true,
        endOfTurn: true,
        turnIsFormatted: true,
        durableFinal: true,
        receivedAtMs: Date.now(),
      })
    );
    await waitFor(() => expect(mocks.persistTranscriptTurn).toHaveBeenCalledOnce());
    const selectedTurn = Object.values(runtime.state.activeTurns).find(
      (turn) => turn.text === 'Barnes & Noble is a bigger company than Amazon.'
    );
    if (!selectedTurn) throw new Error('Expected a visible finalized transcript turn');
    expect(runtime.state.artifact?.turns).toEqual([]);

    await act(async () =>
      runtime.factCheckSelection({
        text: selectedTurn.text,
        turnIds: [selectedTurn.id],
        speakerId: selectedTurn.speakerId,
        startMs: selectedTurn.startMs,
        endMs: selectedTurn.endMs,
        nearbyContext: selectedTurn.text,
      })
    );

    expect(mocks.persistTranscriptTurn.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.persistClaimVersions.mock.invocationCallOrder[0]
    );
    const manualRequests = mocks.persistClaimVersions.mock.calls.flatMap(
      ([, , , claimGate]) => claimGate?.manualFactCheckRequests ?? []
    );
    expect(manualRequests).not.toHaveLength(0);
    expect(manualRequests.every((request) => request.sourceSegmentIds[0] === selectedTurn.id)).toBe(
      true
    );
    const claimVersions = mocks.persistClaimVersions.mock.calls.flatMap(
      ([, versions]) => versions ?? []
    );
    expect(claimVersions).toEqual([
      expect.objectContaining({
        exactQuote: selectedTurn.text,
        segmentIds: [selectedTurn.id],
      }),
    ]);
  });

  it('opens an artifact, returns to setup, and creates a distinct titled meeting', async () => {
    await renderRuntime();
    const oldBefore = JSON.parse(
      JSON.stringify(mocks.artifacts.get('meeting-a'))
    ) as MeetingArtifact;

    await openBackAndStartFresh();

    expect(mocks.createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Call fallback verification Aug 10 5:00 PM',
      })
    );
    expect(runtime.state).toMatchObject({
      artifact: { id: 'meeting-b', title: 'Call fallback verification Aug 10 5:00 PM' },
      runtime: { meetingId: 'meeting-b', lifecycle: 'recording', elapsedMs: 0 },
    });
    expect(mocks.capture.activateCapture).toHaveBeenCalledWith('meeting-b');
    expect(mocks.artifacts.get('meeting-a')).toEqual(oldBefore);
  });

  it('does not close main capture acceptance until the renderer pause boundary has drained', async () => {
    const rendererDrain = deferred<undefined>();
    mocks.capture.pauseCapture.mockReturnValueOnce(rendererDrain.promise);
    await renderRuntime();
    await openBackAndStartFresh();
    api.pause.mockImplementationOnce(async () => {
      snapshot = captureSnapshot({
        lifecycle: 'paused',
        meetingId: 'meeting-b',
        ownerWebContentsId: 1,
        mode: 'call',
        strategy: 'mixed_diarized',
        startedAtEpochMs: Date.now() - 1_000,
        elapsedMs: 1_000,
        pausedAtMs: 1_000,
      });
      return snapshot;
    });

    let pausing!: Promise<void>;
    act(() => {
      pausing = runtime.pauseMeeting();
    });
    await Promise.resolve();
    expect(mocks.capture.pauseCapture).toHaveBeenCalledOnce();
    expect(api.pause).not.toHaveBeenCalled();

    rendererDrain.resolve(undefined);
    await waitFor(() => expect(api.pause).toHaveBeenCalledOnce());
    await act(async () => pausing);

    expect(mocks.capture.pauseCapture.mock.invocationCallOrder[0]).toBeLessThan(
      api.pause.mock.invocationCallOrder[0]
    );
    expect(runtime.state.runtime.lifecycle).toBe('paused');
  });

  it.each(['failure', 'success'] as const)(
    'does not let an old refinement %s replace the new active meeting',
    async (outcome) => {
      const refinement = deferred<unknown>();
      await renderRuntime();
      api.submitRefinement.mockReturnValueOnce(refinement.promise);
      api.getSttSession.mockResolvedValue({
        sessionId: 'meeting-b-stream',
        websocketUrl: 'wss://example.invalid',
        token: 'test-token',
        expiresAtEpochMs: Date.now() + 60_000,
        model: 'universal-streaming-english',
        configuration: { maxSessionDurationSeconds: 10_800 },
      });

      await act(async () => runtime.openMeeting('meeting-a'));
      const oldRefinement = runtime.retryRefinement();
      await waitFor(() => expect(api.submitRefinement).toHaveBeenCalled());
      act(() => runtime.closeArtifact());
      act(() => runtime.setSetup({ title: 'Meeting B' }));
      await act(async () => runtime.startMeeting(true));

      if (outcome === 'failure') {
        refinement.reject({ code: 'gateway_offline', message: 'Offline', retryable: true });
      } else {
        refinement.resolve({
          jobId: 'old-refinement-job',
          status: 'complete',
          result: {
            detectedLanguage: 'en',
            speechModelUsed: 'best',
            audioDurationSeconds: 58,
            utterances: [],
          },
        });
      }
      await act(async () => oldRefinement);

      expect(runtime.state.artifact?.id).toBe('meeting-b');
      expect(runtime.state.runtime).toMatchObject({
        meetingId: 'meeting-b',
        lifecycle: 'recording',
        refinement: 'not_started',
      });
      expect(runtime.state.error).toBeUndefined();
      await waitFor(() => expect(mocks.adapters).toHaveLength(1));
      act(() =>
        mocks.adapters[0].emit({
          type: 'turn',
          providerSessionId: 'meeting-b-stream',
          turnId: 'turn-1',
          turnOrder: 1,
          revision: 0,
          transcript: 'Meeting B owns this durable sentence.',
          words: [],
          startMs: 0,
          endMs: 1_000,
          utteranceBoundary: true,
          endOfTurn: true,
          turnIsFormatted: true,
          durableFinal: true,
          receivedAtMs: Date.now(),
        })
      );
      await waitFor(() => expect(mocks.persistTranscriptTurn).toHaveBeenCalled());
      expect(
        mocks.persistTranscriptTurn.mock.calls.every(([meetingId]) => meetingId === 'meeting-b')
      ).toBe(true);
    }
  );

  it('persists stop assets and status only to the main-process capture meeting', async () => {
    await renderRuntime();
    await openBackAndStartFresh();
    const fractionalElapsedMs = 333_797.3125;
    const asset = {
      ...finalizedAsset('meeting-b'),
      durationMs: fractionalElapsedMs,
      timelineEndMs: fractionalElapsedMs,
    };
    snapshot = captureSnapshot({
      lifecycle: 'recording',
      meetingId: 'meeting-b',
      ownerWebContentsId: 1,
      mode: 'call',
      strategy: 'mixed_diarized',
      startedAtEpochMs: Date.now() - 8_000,
      elapsedMs: fractionalElapsedMs,
    });
    api.stop.mockImplementationOnce(async () => {
      snapshot = captureSnapshot({
        lifecycle: 'complete',
        meetingId: 'meeting-b',
        ownerWebContentsId: 1,
        mode: 'call',
        strategy: 'mixed_diarized',
        startedAtEpochMs: Date.now() - 8_000,
        elapsedMs: fractionalElapsedMs,
        finalizedAssets: [asset],
      });
      return snapshot;
    });
    api.submitRefinement.mockReturnValue(new Promise(() => undefined));
    mocks.persistAudioAssets.mockClear();
    mocks.updateMeeting.mockClear();

    await act(async () => runtime.stopMeeting());

    expect(mocks.persistAudioAssets).toHaveBeenCalledWith(
      'meeting-b',
      expect.arrayContaining([expect.objectContaining({ id: asset.assetId })])
    );
    expect(mocks.updateMeeting).toHaveBeenCalledWith(
      'meeting-b',
      expect.objectContaining({
        status: 'complete',
        endedAtMs: Math.round(
          (mocks.artifacts.get('meeting-b')?.startedAtMs ?? 0) + fractionalElapsedMs
        ),
      })
    );
    expect(
      mocks.persistAudioAssets.mock.calls.every(([meetingId]) => meetingId === 'meeting-b')
    ).toBe(true);
    expect(mocks.updateMeeting.mock.calls.every(([meetingId]) => meetingId === 'meeting-b')).toBe(
      true
    );
    expect(api.acknowledgeAudioAssetsPersisted).toHaveBeenCalledWith({
      meetingId: 'meeting-b',
      assets: [{ assetId: asset.assetId, checksumSha256: asset.checksumSha256 }],
    });
  });

  it('reports recoverable finalization failures without leaking an unhandled stop rejection', async () => {
    await renderRuntime();
    await openBackAndStartFresh();
    const asset = finalizedAsset('meeting-b');
    snapshot = captureSnapshot({
      lifecycle: 'recording',
      meetingId: 'meeting-b',
      ownerWebContentsId: 1,
      mode: 'call',
      strategy: 'mixed_diarized',
      startedAtEpochMs: Date.now() - 8_000,
      elapsedMs: 8_000,
    });
    api.stop.mockImplementationOnce(async () => {
      snapshot = captureSnapshot({
        lifecycle: 'complete',
        meetingId: 'meeting-b',
        ownerWebContentsId: 1,
        mode: 'call',
        strategy: 'mixed_diarized',
        startedAtEpochMs: Date.now() - 8_000,
        elapsedMs: 8_000,
        finalizedAssets: [asset],
      });
      return snapshot;
    });
    mocks.updateMeeting.mockImplementationOnce(async () => {
      throw new Error('Invalid params');
    });

    await act(async () => {
      await expect(runtime.stopMeeting()).resolves.toBeUndefined();
    });

    expect(api.acknowledgeAudioAssetsPersisted).not.toHaveBeenCalled();
    await waitFor(() => expect(runtime.state.runtime.lifecycle).toBe('error'));
    expect(runtime.state.error).toEqual(
      expect.objectContaining({
        code: 'meeting_finalization_failed',
        retryable: true,
      })
    );
    expect(runtime.state.error?.message).toContain('saved the local audio');
  });

  it('freezes endedAt from captured audio before delayed STT termination', async () => {
    api.getSupportStatus.mockResolvedValue({
      ...support,
      gatewayAvailable: true,
    });
    api.getSttSession.mockResolvedValue({
      sessionId: 'meeting-b-stream',
      websocketUrl: 'wss://example.invalid',
      token: 'test-token',
      expiresAtEpochMs: Date.now() + 60_000,
      model: 'universal-streaming-english',
      configuration: { maxSessionDurationSeconds: 10_800 },
    });
    const termination = deferred<undefined>();
    mocks.terminateStt.mockReturnValue(termination.promise);

    await renderRuntime();
    await openBackAndStartFresh();
    await waitFor(() => expect(mocks.adapters).toHaveLength(1));

    const asset = finalizedAsset('meeting-b');
    snapshot = captureSnapshot({
      lifecycle: 'recording',
      meetingId: 'meeting-b',
      ownerWebContentsId: 1,
      mode: 'call',
      strategy: 'mixed_diarized',
      startedAtEpochMs: Date.now() - 8_000,
      elapsedMs: 8_000,
    });
    api.stop.mockImplementationOnce(async () => {
      snapshot = captureSnapshot({
        lifecycle: 'complete',
        meetingId: 'meeting-b',
        ownerWebContentsId: 1,
        mode: 'call',
        strategy: 'mixed_diarized',
        startedAtEpochMs: Date.now() - 8_000,
        elapsedMs: 8_000,
        finalizedAssets: [asset],
      });
      return snapshot;
    });
    api.submitRefinement.mockReturnValue(new Promise(() => undefined));
    mocks.updateMeeting.mockClear();

    let stopping!: Promise<void>;
    act(() => {
      stopping = runtime.stopMeeting();
    });
    await waitFor(() => expect(api.stop).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.terminateStt).toHaveBeenCalledOnce());
    expect(api.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.terminateStt.mock.invocationCallOrder[0]
    );
    expect(
      mocks.updateMeeting.mock.calls.some(
        ([meetingId, patch]) => meetingId === 'meeting-b' && patch.status === 'complete'
      )
    ).toBe(false);

    termination.resolve(undefined);
    await act(async () => stopping);

    expect(mocks.updateMeeting).toHaveBeenCalledWith(
      'meeting-b',
      expect.objectContaining({
        status: 'complete',
        endedAtMs: (mocks.artifacts.get('meeting-b')?.startedAtMs ?? 0) + asset.durationMs,
      })
    );
  });

  it('preserves recovered asset status and acknowledges only after terminal ACP writes', async () => {
    const recovering = artifact('meeting-a', 'Recovered meeting', 'recording');
    mocks.artifacts.set(recovering.id, recovering);
    const recoveredAsset = {
      ...finalizedAsset(recovering.id),
      sourceKind: 'microphone' as const,
      relativePath: `${recovering.id}/microphone.wav`,
    };
    snapshot = captureSnapshot({
      recoveredMeetings: [{ meetingId: recovering.id, assets: [recoveredAsset] }],
    });

    await renderRuntime();
    await waitFor(() => expect(api.acknowledgeAudioAssetsPersisted).toHaveBeenCalled());

    expect(mocks.persistAudioAssets).toHaveBeenCalledWith(recovering.id, [
      expect.objectContaining({ id: recoveredAsset.assetId, status: 'finalized' }),
    ]);
    expect(mocks.updateMeeting).toHaveBeenCalledWith(
      recovering.id,
      expect.objectContaining({ status: 'interrupted', captureStatus: 'interrupted' })
    );
    expect(api.acknowledgeAudioAssetsPersisted).toHaveBeenCalledWith({
      meetingId: recovering.id,
      assets: [
        {
          assetId: recoveredAsset.assetId,
          checksumSha256: recoveredAsset.checksumSha256,
        },
      ],
    });
    expect(mocks.persistAudioAssets.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateMeeting.mock.invocationCallOrder[0]
    );
    expect(mocks.updateMeeting.mock.invocationCallOrder[0]).toBeLessThan(
      api.acknowledgeAudioAssetsPersisted.mock.invocationCallOrder[0]
    );
  });

  it('durably queues a recoverable not_started refinement before acknowledging its audio', async () => {
    const recovering = artifact('meeting-a', 'Recovered meeting', 'interrupted');
    mocks.artifacts.set(recovering.id, recovering);
    const recoveredAsset = {
      ...finalizedAsset(recovering.id),
      durationMs: 333_797.3125,
      timelineEndMs: 333_797.3125,
    };
    snapshot = captureSnapshot({
      recoveredMeetings: [{ meetingId: recovering.id, assets: [recoveredAsset] }],
    });
    api.submitRefinement.mockReturnValue(new Promise(() => undefined));

    await renderRuntime();
    await waitFor(() => expect(api.submitRefinement).toHaveBeenCalledTimes(1));

    const terminalUpdate = mocks.updateMeeting.mock.calls.find(
      ([meetingId, patch]) => meetingId === recovering.id && patch.endedAtMs !== undefined
    );
    expect(terminalUpdate).toEqual([
      recovering.id,
      expect.objectContaining({
        endedAtMs: Math.round((recovering.startedAtMs ?? 0) + recoveredAsset.timelineEndMs),
        refinementStatus: 'queued',
      }),
    ]);
    const terminalUpdateIndex = mocks.updateMeeting.mock.calls.findIndex(
      ([meetingId, patch]) => meetingId === recovering.id && patch.endedAtMs !== undefined
    );
    expect(mocks.updateMeeting.mock.invocationCallOrder[terminalUpdateIndex]).toBeLessThan(
      api.acknowledgeAudioAssetsPersisted.mock.invocationCallOrder[0]
    );
    expect(api.acknowledgeAudioAssetsPersisted.mock.invocationCallOrder[0]).toBeLessThan(
      api.submitRefinement.mock.invocationCallOrder[0]
    );
  });

  it('does not reopen terminal refinement when legacy recovery replays a completed artifact', async () => {
    const completed = artifact('meeting-a', 'Completed meeting', 'complete');
    mocks.artifacts.set(completed.id, completed);
    snapshot = captureSnapshot({
      recoveredMeetings: [{ meetingId: completed.id, assets: [finalizedAsset(completed.id)] }],
    });

    await renderRuntime();
    await waitFor(() => expect(api.acknowledgeAudioAssetsPersisted).toHaveBeenCalled());

    expect(
      mocks.updateMeeting.mock.calls.some(
        ([meetingId, patch]) => meetingId === completed.id && patch.refinementStatus === 'queued'
      )
    ).toBe(false);
    expect(api.submitRefinement).not.toHaveBeenCalled();
    expect(mocks.artifacts.get(completed.id)).toMatchObject({
      status: 'complete',
      refinementStatus: 'failed',
    });
  });

  it('preserves a completed historical not_started refinement during legacy recovery', async () => {
    const completed = {
      ...artifact('meeting-a', 'Completed meeting', 'complete'),
      refinementStatus: 'not_started' as const,
    };
    mocks.artifacts.set(completed.id, completed);
    snapshot = captureSnapshot({
      recoveredMeetings: [{ meetingId: completed.id, assets: [finalizedAsset(completed.id)] }],
    });

    await renderRuntime();
    await waitFor(() => expect(api.acknowledgeAudioAssetsPersisted).toHaveBeenCalled());

    expect(
      mocks.updateMeeting.mock.calls.some(
        ([meetingId, patch]) => meetingId === completed.id && patch.refinementStatus === 'queued'
      )
    ).toBe(false);
    expect(api.submitRefinement).not.toHaveBeenCalled();
    expect(mocks.artifacts.get(completed.id)).toMatchObject({
      status: 'complete',
      refinementStatus: 'not_started',
    });
  });

  it('resumes a queued terminal refinement once after acknowledging its pending audio manifest', async () => {
    const queued = {
      ...artifact('meeting-a', 'Queued recovery', 'interrupted'),
      endedAtMs: 1_786_403_258_000,
      refinementStatus: 'queued' as const,
    };
    mocks.artifacts.set(queued.id, queued);
    snapshot = captureSnapshot({
      recoveredMeetings: [{ meetingId: queued.id, assets: [finalizedAsset(queued.id)] }],
    });
    api.submitRefinement.mockReturnValue(new Promise(() => undefined));

    await renderRuntime();
    await waitFor(() => expect(api.submitRefinement).toHaveBeenCalledTimes(1));

    expect(api.acknowledgeAudioAssetsPersisted).toHaveBeenCalledTimes(1);
    expect(api.acknowledgeAudioAssetsPersisted.mock.invocationCallOrder[0]).toBeLessThan(
      api.submitRefinement.mock.invocationCallOrder[0]
    );
  });

  it('resumes a durable queued refinement after its pending audio manifest was acknowledged', async () => {
    const queued = {
      ...artifact('meeting-a', 'Queued recovery', 'complete'),
      refinementStatus: 'queued' as const,
      refinementJobs: [],
    };
    mocks.artifacts.set(queued.id, queued);
    mocks.listMeetings.mockImplementation(async () => [{ id: queued.id } as never]);
    api.submitRefinement.mockReturnValue(new Promise(() => undefined));

    await renderRuntime();
    await waitFor(() => expect(api.submitRefinement).toHaveBeenCalledTimes(1));

    expect(api.acknowledgeAudioAssetsPersisted).not.toHaveBeenCalled();
  });
});
