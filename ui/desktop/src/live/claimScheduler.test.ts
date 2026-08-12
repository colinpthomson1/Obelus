import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  automaticClaimIdentity,
  claimGateBatchBeginInput,
  ClaimScheduler,
  createClaimGateBatch,
  detectClaimCandidatesWithLocalFallback,
  detectLocalClaimCandidates,
  expandLocalClaimContext,
  subscriptionClaimSchedulerOptions,
  type ClaimCandidate,
  type ClaimGateBatch,
  type ClaimSchedulerCallbacks,
} from './claimScheduler';
import type { Claim, TranscriptTurn } from './types';

const finalizedTurn: TranscriptTurn = {
  id: 'e0d3e827-403b-4149-857e-d572911cb3e1',
  meetingId: '2cb389ac-e5ba-476b-867d-a478099bf3fb',
  transcriptVersionId: 'eb6b6bd0-54a0-4404-9de5-e1c420918e48',
  provider: 'assemblyai',
  providerSessionId: 'session-1',
  providerTurnId: '1',
  providerTurnOrder: 1,
  revision: 0,
  status: 'final',
  sourceKind: 'mixed',
  startMs: 0,
  endMs: 1_000,
  text: 'The program served 18,000 people last year.',
  words: [],
  utteranceBoundary: true,
  endOfTurn: true,
  formatted: true,
  receivedAtMs: 1_100,
};

const options = {
  maxGateCallsPerHour: 30,
  maxAcceptedClaimsPerHour: 10,
  maxBurstClaims: 2,
  burstWindowMs: 60_000,
  minBatchDelayMs: 60_000,
  maxTurnsPerBatch: 4,
};

function candidate(text: string, duplicateKey = text): ClaimCandidate {
  return {
    exactQuote: text,
    normalizedClaim: text,
    contextTurnIds: [finalizedTurn.id],
    startMs: finalizedTurn.startMs,
    endMs: finalizedTurn.endMs,
    checkworthy: true,
    consequenceScore: 0.8,
    disputeLikelihoodScore: 0.8,
    specificityScore: 0.8,
    timeSensitive: false,
    selectionRationale: 'Test candidate',
    semanticDuplicateKey: duplicateKey,
  };
}

function persistedClaim(source: ClaimCandidate): Claim {
  return {
    id: `claim-${source.semanticDuplicateKey}`,
    meetingId: finalizedTurn.meetingId,
    origin: 'automatic',
    duplicateKey: source.semanticDuplicateKey,
    status: 'queued',
    currentVersionId: `version-${source.semanticDuplicateKey}`,
    versions: [
      {
        id: `version-${source.semanticDuplicateKey}`,
        claimId: `claim-${source.semanticDuplicateKey}`,
        version: 1,
        exactQuote: source.exactQuote,
        normalizedClaim: source.normalizedClaim,
        startMs: source.startMs,
        endMs: source.endMs,
        segmentIds: source.contextTurnIds,
        lifecycle: 'active',
        createdAt: '2026-08-10T20:00:00.000Z',
        assessments: [],
      },
    ],
    spokenAtMs: source.startMs,
    createdAt: '2026-08-10T20:00:00.000Z',
    updatedAt: '2026-08-10T20:00:00.000Z',
  };
}

function callbacks(patch: Partial<ClaimSchedulerCallbacks> = {}): ClaimSchedulerCallbacks & {
  beginBatch: ReturnType<typeof vi.fn>;
  detect: ReturnType<typeof vi.fn>;
  commitBatch: ReturnType<typeof vi.fn>;
  onBackpressure: ReturnType<typeof vi.fn>;
} {
  const handlers = {
    beginBatch: vi.fn<ClaimSchedulerCallbacks['beginBatch']>().mockResolvedValue(undefined),
    detect: vi.fn<ClaimSchedulerCallbacks['detect']>().mockResolvedValue([]),
    commitBatch: vi.fn<ClaimSchedulerCallbacks['commitBatch']>().mockResolvedValue(undefined),
    onBackpressure: vi.fn<ClaimSchedulerCallbacks['onBackpressure']>(),
  };
  return Object.assign(handlers, patch) as ClaimSchedulerCallbacks & typeof handlers;
}

describe('ClaimScheduler', () => {
  it('does not exhaust subscription detection during a 30-minute continuous transcript', async () => {
    let now = 0;
    const handlers = callbacks({
      detect: vi.fn<ClaimSchedulerCallbacks['detect']>().mockResolvedValue({
        candidates: [],
        source: 'remote',
        countAgainstRemoteBudget: true,
      }),
    });
    const scheduler = new ClaimScheduler(
      finalizedTurn.meetingId,
      () => [],
      handlers,
      subscriptionClaimSchedulerOptions,
      () => now
    );
    for (let index = 0; index < 400; index += 1) {
      scheduler.addFinalTurn({
        ...finalizedTurn,
        id: `subscription-turn-${index}`,
        providerTurnId: `${index}`,
        providerTurnOrder: index,
        revision: 0,
        startMs: index * 4_500,
        endMs: index * 4_500 + 1_000,
      });
      await scheduler.flush();
      now += 4_500;
    }

    expect(handlers.detect).toHaveBeenCalledTimes(400);
    expect(handlers.onBackpressure).not.toHaveBeenCalledWith(true, 'limit');
    scheduler.dispose();
  });

  it('upgrades an already-created scheduler when subscription support resolves', async () => {
    vi.useFakeTimers();
    const handlers = callbacks({
      detect: vi.fn<ClaimSchedulerCallbacks['detect']>().mockResolvedValue({
        candidates: [],
        source: 'remote',
        countAgainstRemoteBudget: true,
      }),
    });
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, {
      ...options,
      maxGateCallsPerHour: 1,
    });
    scheduler.addFinalTurn(finalizedTurn);
    await scheduler.flush();
    scheduler.addFinalTurn({
      ...finalizedTurn,
      id: 'subscription-upgrade-turn',
      providerTurnId: 'subscription-upgrade-turn',
      providerTurnOrder: 2,
      startMs: 2_000,
      endMs: 3_000,
    });
    await scheduler.flush();
    expect(handlers.detect).toHaveBeenCalledOnce();
    expect(handlers.onBackpressure).toHaveBeenLastCalledWith(true, 'limit');

    scheduler.setMaxGateCallsPerHour(subscriptionClaimSchedulerOptions.maxGateCallsPerHour);
    await scheduler.flush();

    expect(handlers.detect).toHaveBeenCalledTimes(2);
    expect(handlers.onBackpressure).toHaveBeenLastCalledWith(false, undefined);
    scheduler.dispose();
  });

  afterEach(() => vi.useRealTimers());

  it('only begins and sends finalized turns to detection', async () => {
    vi.useFakeTimers();
    const handlers = callbacks();
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, options);
    scheduler.addFinalTurn({
      ...finalizedTurn,
      id: window.crypto.randomUUID(),
      status: 'partial',
    });
    await scheduler.flush();
    expect(handlers.beginBatch).not.toHaveBeenCalled();
    scheduler.addFinalTurn(finalizedTurn);
    await scheduler.flush();
    expect(handlers.beginBatch).toHaveBeenCalledOnce();
    expect(handlers.detect).toHaveBeenCalledOnce();
    scheduler.dispose();
  });

  it('does not commit an in-flight detection after disposal', async () => {
    let resolveDetection!: (value: ClaimCandidate[]) => void;
    const handlers = callbacks({
      detect: vi.fn(
        () =>
          new Promise<ClaimCandidate[]>((resolve) => {
            resolveDetection = resolve;
          })
      ),
    });
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, options);
    scheduler.addFinalTurn(finalizedTurn);
    const flushing = scheduler.flush();
    await vi.waitFor(() => expect(handlers.detect).toHaveBeenCalledOnce());

    scheduler.dispose();
    resolveDetection([candidate(finalizedTurn.text)]);
    await flushing;

    expect(handlers.commitBatch).not.toHaveBeenCalled();
    expect(handlers.onBackpressure).not.toHaveBeenCalled();
  });

  it('does not requeue a failed in-flight detection after disposal', async () => {
    let rejectDetection!: (reason?: unknown) => void;
    const handlers = callbacks({
      detect: vi.fn(
        () =>
          new Promise<ClaimCandidate[]>((_resolve, reject) => {
            rejectDetection = reject;
          })
      ),
    });
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, options);
    scheduler.addFinalTurn(finalizedTurn);
    const flushing = scheduler.flush();
    await vi.waitFor(() => expect(handlers.detect).toHaveBeenCalledOnce());

    scheduler.dispose();
    rejectDetection(new Error('cancelled by meeting deletion'));
    await flushing;
    scheduler.addFinalTurn({ ...finalizedTurn, id: 'turn-after-disposal' });
    await scheduler.flush();

    expect(handlers.detect).toHaveBeenCalledOnce();
    expect(handlers.commitBatch).not.toHaveBeenCalled();
    expect(handlers.onBackpressure).not.toHaveBeenCalled();
  });

  it('identifies the Barnes and Noble comparison locally when the gateway is absent', async () => {
    const comparisonTurn = {
      ...finalizedTurn,
      text: 'Barnes and Noble is a bigger company than Amazon.',
    };
    const detection = await detectClaimCandidatesWithLocalFallback(async () => {
      throw new Error('gateway unavailable');
    }, [comparisonTurn]);

    expect(detection.source).toBe('local');
    expect(detection.countAgainstRemoteBudget).toBe(false);
    expect(detection.candidates).toEqual([
      expect.objectContaining({
        exactQuote: comparisonTurn.text,
        normalizedClaim: comparisonTurn.text,
        contextTurnIds: [comparisonTurn.id],
        checkworthy: true,
      }),
    ]);
  });

  it('keeps a batch pending whenever subscription detection fails and heuristics find nothing', async () => {
    const ordinaryAssertion = {
      ...finalizedTurn,
      text: 'The difference between night and day is that night is light and day is dark.',
    };
    const retryable = Object.assign(new Error('ChatGPT timed out'), {
      code: 'chatgpt_timeout',
      retryable: true,
    });

    await expect(
      detectClaimCandidatesWithLocalFallback(async () => {
        throw retryable;
      }, [ordinaryAssertion])
    ).rejects.toBe(retryable);

    const authRequired = Object.assign(new Error('Sign in required'), {
      code: 'chatgpt_auth_required',
      retryable: false,
    });
    await expect(
      detectClaimCandidatesWithLocalFallback(async () => {
        throw authRequired;
      }, [ordinaryAssertion])
    ).rejects.toBe(authRequired);
  });

  it('retries the same durable batch after an invalid subscription response', async () => {
    vi.useFakeTimers();
    const turn = {
      ...finalizedTurn,
      text: 'The difference between night and day is that night is light and day is dark.',
    };
    const retryable = Object.assign(new Error('Invalid model response'), {
      code: 'invalid_chatgpt_claim_detection_response',
      retryable: true,
    });
    const detectedBatches: string[] = [];
    const handlers = callbacks({
      detect: vi.fn<ClaimSchedulerCallbacks['detect']>(async (batch) => {
        detectedBatches.push(`${batch.id}:${batch.idempotencyKey}`);
        if (detectedBatches.length === 1) throw retryable;
        return {
          candidates: [candidate(turn.text, 'night-day')],
          source: 'remote',
          countAgainstRemoteBudget: true,
        };
      }),
    });
    const scheduler = new ClaimScheduler(turn.meetingId, () => [], handlers, options);
    scheduler.addFinalTurn(turn);

    await scheduler.flush();
    expect(handlers.beginBatch).toHaveBeenCalledOnce();
    expect(handlers.commitBatch).not.toHaveBeenCalled();
    expect(handlers.onBackpressure).toHaveBeenLastCalledWith(true, 'gateway');

    await scheduler.flush();
    expect(handlers.beginBatch).toHaveBeenCalledOnce();
    expect(detectedBatches[1]).toBe(detectedBatches[0]);
    expect(handlers.commitBatch).toHaveBeenCalledWith(expect.any(Object), [
      expect.objectContaining({ exactQuote: turn.text }),
    ]);
    scheduler.dispose();
  });

  it('does not mistake a first-person contraction for a named factual subject', () => {
    expect(
      detectLocalClaimCandidates([
        {
          ...finalizedTurn,
          text: "I'm gonna have to go wrap it up pretty soon.",
        },
      ])
    ).toEqual([]);
  });

  it.each(['Testing 1, 2, 3, 4.', 'testing 1234.', 'Mic check one two three.'])(
    'does not spend an automatic claim slot on audio calibration: %s',
    (text) => {
      expect(detectLocalClaimCandidates([{ ...finalizedTurn, text }])).toEqual([]);
    }
  );

  it('waits when a comparison fragment has no factual subject', () => {
    expect(
      detectLocalClaimCandidates([
        {
          ...finalizedTurn,
          text: 'larger than the Earth, Barnes & Noble is a bigger company',
        },
      ])
    ).toEqual([]);
  });

  it('reconstructs one normalized comparison across adjacent finalized turns', async () => {
    const first = {
      ...finalizedTurn,
      id: '1250f0df-48c4-4b19-92c8-c7677d78cbaa',
      providerTurnId: 'split-1',
      providerTurnOrder: 1,
      speakerId: 'speaker-1',
      startMs: 0,
      endMs: 2_000,
      text: 'So in my experience Barnes & Noble is a bigger company',
    };
    const second = {
      ...finalizedTurn,
      id: 'd0048118-01cd-425d-91c8-e3028399eed7',
      providerTurnId: 'split-2',
      providerTurnOrder: 2,
      speakerId: 'speaker-1',
      startMs: 2_050,
      endMs: 3_000,
      text: 'company than Amazon.',
    };

    expect(detectLocalClaimCandidates([first])).toEqual([]);
    const context = expandLocalClaimContext([second], [first, second]);
    const detection = await detectClaimCandidatesWithLocalFallback(
      async () => {
        throw new Error('gateway unavailable');
      },
      [second],
      [],
      context
    );

    expect(detection.candidates).toEqual([
      expect.objectContaining({
        exactQuote: 'Barnes & Noble is a bigger company than Amazon.',
        normalizedClaim: 'Barnes & Noble is a bigger company than Amazon.',
        contextTurnIds: [first.id, second.id],
        speakerId: 'speaker-1',
        startMs: first.startMs,
        endMs: second.endMs,
      }),
    ]);
  });

  it('reconstructs the exact real three-fragment comparison as one atomic claim', async () => {
    const fragments = [
      {
        ...finalizedTurn,
        id: 'd59525b4-c928-5338-ab57-4c8b50e929b5',
        providerTurnId: 'real-split-1',
        providerTurnOrder: 9,
        startMs: 36_000,
        endMs: 39_000,
        text: 'playback, the first test statement is that Barnes &',
      },
      {
        ...finalizedTurn,
        id: '6581b348-0712-5f4c-98ee-5fa1f792b4d9',
        providerTurnId: 'real-split-2',
        providerTurnOrder: 10,
        startMs: 39_000,
        endMs: 41_820,
        text: 'Noble is a bigger company than Amazon, that',
      },
      {
        ...finalizedTurn,
        id: 'ef94a01d-7b46-5c5a-b0f1-747900b6a799',
        providerTurnId: 'real-split-3',
        providerTurnOrder: 11,
        startMs: 42_000,
        endMs: 45_000,
        text: 'Statement is intentionally questionable and should trigger a',
      },
    ];
    const context = expandLocalClaimContext([fragments[2]], fragments);

    expect(context.map((turn) => turn.id)).toEqual(fragments.map((turn) => turn.id));
    expect(detectLocalClaimCandidates(context, [], new Set([fragments[2].id]))).toEqual([
      expect.objectContaining({
        exactQuote: 'Barnes & Noble is a bigger company than Amazon',
        normalizedClaim: 'Barnes & Noble is a bigger company than Amazon',
        contextTurnIds: fragments.map((turn) => turn.id),
        startMs: fragments[0].startMs,
        endMs: fragments[2].endMs,
      }),
    ]);
  });

  it('waits for a concrete comparison RHS and recovers adjacent runtime claims atomically', async () => {
    vi.useFakeTimers();
    const intro = [
      {
        ...finalizedTurn,
        id: 'c5cd320f-3be3-5c04-8067-47f82062fec4',
        providerTurnId: 'local-turn-3',
        providerTurnOrder: 3,
        startMs: 20_160,
        endMs: 20_940,
        text: 'This is a public',
      },
      {
        ...finalizedTurn,
        id: '78b10023-e487-5d3b-8878-272cced4851c',
        providerTurnId: 'local-turn-4',
        providerTurnOrder: 4,
        startMs: 21_000,
        endMs: 23_860,
        text: 'Public synthetic end-to-end test of opulence live capture',
      },
    ];
    const turns = [
      {
        ...finalizedTurn,
        id: 'f10e85a7-ddc9-55f7-9483-5d119e3b1396',
        providerTurnId: 'local-turn-5',
        providerTurnOrder: 5,
        startMs: 24_000,
        endMs: 26_920,
        text: 'and evidence research. The moon is larger than the',
      },
      {
        ...finalizedTurn,
        id: '7c045c32-2add-5243-9adf-4b67deed5071',
        providerTurnId: 'local-turn-6',
        providerTurnOrder: 6,
        startMs: 27_000,
        endMs: 29_940,
        text: 'Earth, Barnes & Noble is a bigger company than Amazon.',
      },
      {
        ...finalizedTurn,
        id: '9121960e-64ba-5e95-8442-03b903fc687f',
        providerTurnId: 'local-turn-7',
        providerTurnOrder: 7,
        startMs: 30_000,
        endMs: 33_000,
        text: 'on, the Pacific Ocean is smaller than the Atlantic',
      },
    ];
    const availableTurns = [...intro];
    const persistedClaims: Claim[] = [];
    const committedQuotes: string[] = [];
    const handlers = callbacks({
      detect: vi.fn<ClaimSchedulerCallbacks['detect']>(async (batch) => {
        return detectClaimCandidatesWithLocalFallback(
          async () => {
            throw new Error('gateway unavailable');
          },
          batch.turns,
          batch.existingClaims,
          expandLocalClaimContext(batch.turns, availableTurns)
        );
      }),
      commitBatch: vi.fn<ClaimSchedulerCallbacks['commitBatch']>(async (_batch, candidates) => {
        for (const detected of candidates) {
          committedQuotes.push(detected.exactQuote);
          persistedClaims.push(persistedClaim(detected));
        }
      }),
    });
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => persistedClaims, handlers, {
      ...options,
      maxBurstClaims: 3,
    });

    for (const turn of turns) {
      availableTurns.push(turn);
      scheduler.addFinalTurn(turn);
      await scheduler.flush();
    }

    expect(committedQuotes).toEqual([
      'The moon is larger than the Earth',
      'Barnes & Noble is a bigger company than Amazon.',
      'Pacific Ocean is smaller than the Atlantic',
    ]);
    scheduler.dispose();
  });

  it('does not auto-identify a generic conversational assertion', () => {
    expect(detectLocalClaimCandidates([{ ...finalizedTurn, text: 'This is good.' }])).toEqual([]);
  });

  it('commits an automatic local claim instead of retrying an unavailable detector forever', async () => {
    vi.useFakeTimers();
    const comparisonTurn = {
      ...finalizedTurn,
      text: 'Barnes and Noble is a bigger company than Amazon.',
    };
    const handlers = callbacks({
      detect: vi.fn(async (batch) =>
        detectClaimCandidatesWithLocalFallback(
          async () => {
            throw new Error('gateway unavailable');
          },
          batch.turns,
          batch.existingClaims
        )
      ),
    });
    const scheduler = new ClaimScheduler(comparisonTurn.meetingId, () => [], handlers, options);
    scheduler.addFinalTurn(comparisonTurn);

    await scheduler.flush();

    expect(handlers.commitBatch).toHaveBeenCalledOnce();
    expect(handlers.commitBatch.mock.calls[0][1]).toEqual([
      expect.objectContaining({ exactQuote: comparisonTurn.text }),
    ]);
    expect(handlers.onBackpressure).toHaveBeenLastCalledWith(false, undefined);
    scheduler.dispose();
  });

  it('preserves gateway catching-up state until a later explicit clear', async () => {
    vi.useFakeTimers();
    const handlers = callbacks({
      detect: vi
        .fn<ClaimSchedulerCallbacks['detect']>()
        .mockResolvedValueOnce({
          candidates: [],
          source: 'remote',
          countAgainstRemoteBudget: true,
          gatewayCatchingUp: true,
        })
        .mockResolvedValueOnce({
          candidates: [],
          source: 'remote',
          countAgainstRemoteBudget: true,
          gatewayCatchingUp: false,
        }),
    });
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, options);
    scheduler.addFinalTurn(finalizedTurn);
    await scheduler.flush();
    expect(handlers.onBackpressure).toHaveBeenLastCalledWith(true, 'gateway');

    scheduler.addFinalTurn({
      ...finalizedTurn,
      id: '022f35ca-0e06-4599-98c7-cfaef00b0612',
      providerTurnId: '2',
      providerTurnOrder: 2,
      startMs: 2_000,
      endMs: 3_000,
    });
    await scheduler.flush();
    expect(handlers.onBackpressure).toHaveBeenLastCalledWith(false, undefined);
    scheduler.dispose();
  });

  it('marks burst overflow as not queued instead of claiming it is catching up', async () => {
    vi.useFakeTimers();
    const handlers = callbacks({
      detect: vi.fn<ClaimSchedulerCallbacks['detect']>().mockResolvedValue({
        candidates: [
          candidate('Amazon employs 1,000 people.', 'amazon'),
          candidate('Noble employs 2,000 people.', 'noble'),
        ],
        source: 'remote',
        countAgainstRemoteBudget: true,
        gatewayCatchingUp: false,
      }),
    });
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, {
      ...options,
      maxBurstClaims: 1,
    });
    scheduler.addFinalTurn(finalizedTurn);
    await scheduler.flush();

    expect(handlers.commitBatch).toHaveBeenCalledWith(expect.any(Object), [
      expect.objectContaining({ semanticDuplicateKey: 'amazon' }),
    ]);
    expect(handlers.onBackpressure).toHaveBeenLastCalledWith(true, 'limit');
    scheduler.dispose();
  });

  it('deduplicates the real overlapping fragments before reserving the Pacific claim burst slot', async () => {
    vi.useFakeTimers();
    const firstBarnes = {
      ...candidate(
        'playback, the first test statement is that Barnes & Noble is a bigger company than Amazon, that',
        'barnes-first-fragment'
      ),
      contextTurnIds: ['barnes-fragment-1', 'barnes-fragment-2'],
    };
    const repeatedBarnes = {
      ...candidate(
        'Noble is a bigger company than Amazon, that Statement is intentionally questionable and should trigger a',
        'barnes-second-fragment'
      ),
      contextTurnIds: ['barnes-fragment-2', 'barnes-fragment-3'],
    };
    const pacific = {
      ...candidate(
        "The Earth's Pacific Ocean is larger than the Atlantic Ocean.",
        'pacific-atlantic'
      ),
      contextTurnIds: ['pacific-fragment'],
    };
    const handlers = callbacks({
      detect: vi.fn<ClaimSchedulerCallbacks['detect']>().mockResolvedValue({
        candidates: [firstBarnes, repeatedBarnes, pacific],
        source: 'remote',
        countAgainstRemoteBudget: true,
      }),
    });
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, {
      ...options,
      maxBurstClaims: 2,
    });
    scheduler.addFinalTurn(finalizedTurn);

    await scheduler.flush();

    expect(handlers.commitBatch).toHaveBeenCalledWith(expect.any(Object), [
      {
        ...firstBarnes,
        exactQuote: 'Barnes & Noble is a bigger company than Amazon',
        normalizedClaim: 'Barnes & Noble is a bigger company than Amazon',
      },
      pacific,
    ]);
    expect(handlers.onBackpressure).toHaveBeenLastCalledWith(false, undefined);
    scheduler.dispose();
  });

  it('keeps distinct comparisons that share a source segment', async () => {
    vi.useFakeTimers();
    const larger = {
      ...candidate('The Pacific Ocean is larger than the Atlantic Ocean.', 'ocean-area'),
      contextTurnIds: ['shared-ocean-segment'],
    };
    const deeper = {
      ...candidate('The Pacific Ocean is deeper than the Atlantic Ocean.', 'ocean-depth'),
      contextTurnIds: ['shared-ocean-segment'],
    };
    const handlers = callbacks({
      detect: vi.fn<ClaimSchedulerCallbacks['detect']>().mockResolvedValue([larger, deeper]),
    });
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, options);
    scheduler.addFinalTurn(finalizedTurn);

    await scheduler.flush();

    expect(handlers.commitBatch).toHaveBeenCalledWith(expect.any(Object), [larger, deeper]);
    scheduler.dispose();
  });

  it('deduplicates an overlapping fragment against the stable persisted source anchors', async () => {
    vi.useFakeTimers();
    const persistedBarnes = {
      ...candidate(
        'playback, the first test statement is that Barnes & Noble is a bigger company than Amazon, that',
        'persisted-barnes'
      ),
      contextTurnIds: ['barnes-fragment-1', 'barnes-fragment-2'],
    };
    const replayedBarnes = {
      ...candidate(
        'Noble is a bigger company than Amazon, that Statement is intentionally questionable and should trigger a',
        'replayed-barnes'
      ),
      contextTurnIds: ['barnes-fragment-2', 'barnes-fragment-3'],
    };
    const pacific = {
      ...candidate('The Pacific Ocean is larger than the Atlantic Ocean.', 'persisted-pacific'),
      contextTurnIds: ['pacific-fragment'],
    };
    const handlers = callbacks({
      detect: vi
        .fn<ClaimSchedulerCallbacks['detect']>()
        .mockResolvedValue([replayedBarnes, pacific]),
    });
    const scheduler = new ClaimScheduler(
      finalizedTurn.meetingId,
      () => [persistedClaim(persistedBarnes)],
      handlers,
      { ...options, maxBurstClaims: 1 }
    );
    scheduler.addFinalTurn(finalizedTurn);

    await scheduler.flush();

    expect(handlers.commitBatch).toHaveBeenCalledWith(expect.any(Object), [pacific]);
    expect(handlers.onBackpressure).toHaveBeenLastCalledWith(false, undefined);
    scheduler.dispose();
  });

  it('creates no verdict, assessment, or source during local identification', () => {
    const [candidate] = detectLocalClaimCandidates([
      { ...finalizedTurn, text: 'Barnes and Noble is a bigger company than Amazon.' },
    ]);

    expect(candidate).toBeDefined();
    expect(candidate).not.toHaveProperty('verdict');
    expect(candidate).not.toHaveProperty('assessment');
    expect(candidate).not.toHaveProperty('sources');
    expect(candidate.selectionRationale).toContain('Evidence research is still required');
  });

  it('preserves an exact failed gateway batch and reuses its durable identity', async () => {
    vi.useFakeTimers();
    const handlers = callbacks({
      detect: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]),
    });
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, options);
    scheduler.addFinalTurn(finalizedTurn);

    await scheduler.flush();
    await scheduler.flush();

    expect(handlers.beginBatch).toHaveBeenCalledOnce();
    expect(handlers.detect).toHaveBeenCalledTimes(2);
    expect(handlers.detect.mock.calls[1][0]).toMatchObject({
      id: handlers.detect.mock.calls[0][0].id,
      idempotencyKey: handlers.detect.mock.calls[0][0].idempotencyKey,
      turns: [
        expect.objectContaining({
          id: finalizedTurn.id,
          revision: finalizedTurn.revision,
          text: finalizedTurn.text,
        }),
      ],
    });
    scheduler.dispose();
  });

  it('replays gateway success after ACP failure with the same deterministic batch', async () => {
    vi.useFakeTimers();
    const handlers = callbacks({
      commitBatch: vi
        .fn()
        .mockRejectedValueOnce(new Error('ACP unavailable after gateway success'))
        .mockResolvedValueOnce(undefined),
    });
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, options);
    scheduler.addFinalTurn(finalizedTurn);

    await scheduler.flush();
    await scheduler.flush();

    expect(handlers.beginBatch).toHaveBeenCalledOnce();
    expect(handlers.detect).toHaveBeenCalledTimes(2);
    expect(handlers.commitBatch).toHaveBeenCalledTimes(2);
    expect(handlers.commitBatch.mock.calls[1][0]).toEqual(handlers.commitBatch.mock.calls[0][0]);
    scheduler.dispose();
  });

  it('atomically commits a zero-candidate batch', async () => {
    vi.useFakeTimers();
    const handlers = callbacks();
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, options);
    scheduler.addFinalTurn(finalizedTurn);

    await scheduler.flush();

    expect(handlers.commitBatch).toHaveBeenCalledWith(expect.any(Object), []);
    scheduler.dispose();
  });

  it('recovers durable exact grouping before unbatched segments after reload', async () => {
    vi.useFakeTimers();
    const recoveredTurns = [
      finalizedTurn,
      {
        ...finalizedTurn,
        id: 'a28be89d-e737-45bf-b778-27ac76f7cd0b',
        providerTurnId: '2',
        providerTurnOrder: 2,
        startMs: 1_100,
      },
    ];
    const recovered: ClaimGateBatch = {
      ...createClaimGateBatch(finalizedTurn.meetingId, recoveredTurns),
      id: '1cc5860e-35b2-486c-b7a6-c59d69f42a85',
      idempotencyKey: 'claim-gate:durable-before-crash',
    };
    const unbatched = {
      ...finalizedTurn,
      id: '9d90b6ac-b899-4fc5-a0d5-ab14b150774e',
      providerTurnId: '3',
      providerTurnOrder: 3,
      startMs: 2_200,
    };
    const handlers = callbacks();
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, options);
    scheduler.recoverBatch(recovered);
    scheduler.addFinalTurn(unbatched);

    await scheduler.flush();
    await scheduler.flush();

    expect(handlers.beginBatch).toHaveBeenCalledOnce();
    expect(handlers.detect.mock.calls[0][0]).toMatchObject({
      id: recovered.id,
      turns: recovered.turns,
    });
    expect(handlers.detect.mock.calls[1][0].turns).toEqual([
      expect.objectContaining({
        id: unbatched.id,
        revision: unbatched.revision,
        text: unbatched.text,
      }),
    ]);
    scheduler.dispose();
  });

  it('gates a later revision as a distinct durable inventory item', async () => {
    vi.useFakeTimers();
    const handlers = callbacks();
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, options);
    scheduler.addFinalTurn(finalizedTurn);
    await scheduler.flush();
    scheduler.addFinalTurn({ ...finalizedTurn, revision: 1, status: 'revised' });
    await scheduler.flush();

    expect(handlers.beginBatch).toHaveBeenCalledTimes(2);
    expect(handlers.beginBatch.mock.calls[1][0].id).not.toBe(
      handlers.beginBatch.mock.calls[0][0].id
    );
    scheduler.dispose();
  });

  it('ignores a replay of a committed revision but gates a higher revision', async () => {
    vi.useFakeTimers();
    const handlers = callbacks();
    const scheduler = new ClaimScheduler(finalizedTurn.meetingId, () => [], handlers, options);
    scheduler.addFinalTurn(finalizedTurn);
    await scheduler.flush();
    scheduler.addFinalTurn({ ...finalizedTurn });
    await scheduler.flush();

    expect(handlers.beginBatch).toHaveBeenCalledOnce();
    expect(handlers.detect).toHaveBeenCalledOnce();

    scheduler.addFinalTurn({ ...finalizedTurn, revision: 1, status: 'revised' });
    await scheduler.flush();
    expect(handlers.beginBatch).toHaveBeenCalledTimes(2);
    expect(handlers.detect).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('derives stable batch, claim, and version identities for crash replay', () => {
    const firstBatch = createClaimGateBatch(finalizedTurn.meetingId, [finalizedTurn]);
    const replayedBatch = createClaimGateBatch(finalizedTurn.meetingId, [finalizedTurn]);
    expect(replayedBatch).toEqual(firstBatch);
    expect(automaticClaimIdentity(finalizedTurn.meetingId, firstBatch.id, 'served-people')).toEqual(
      automaticClaimIdentity(finalizedTurn.meetingId, firstBatch.id, 'served-people')
    );
  });

  it('begins the exact immutable turn revision that will be sent to the gateway', () => {
    const batch = createClaimGateBatch(finalizedTurn.meetingId, [finalizedTurn]);

    expect(claimGateBatchBeginInput(batch)).toEqual({
      id: batch.id,
      idempotencyKey: batch.idempotencyKey,
      turns: [
        {
          id: finalizedTurn.id,
          speakerId: null,
          startMs: finalizedTurn.startMs,
          endMs: finalizedTurn.endMs,
          text: finalizedTurn.text,
          revisionNumber: 0,
          sourceKind: 'mixed',
        },
      ],
    });
  });
});
