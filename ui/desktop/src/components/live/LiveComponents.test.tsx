/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialMeetingState, meetingReducer } from '../../live/meetingReducer';
import type { Assessment, Claim, MeetingArtifact, Speaker, TranscriptTurn } from '../../live/types';
import { ClaimCard } from './ClaimCard';
import { ClaimRail } from './ClaimRail';
import { GlobalRecordingIndicator } from './GlobalRecordingIndicator';
import { LiveSetupView } from './LiveSetupView';
import { LiveMeetingHeader } from './LiveMeetingHeader';
import { LiveMeetingView } from './LiveMeetingView';
import { LiveTranscript } from './LiveTranscript';
import { LiveUtterance } from './LiveUtterance';
import { MeetingAudioPlayer } from './MeetingAudioPlayer';
import { TranscriptRefinementStatus } from './TranscriptRefinementStatus';

const mocked = vi.hoisted(() => ({ runtime: {} as Record<string, unknown> }));

vi.mock('../../live/LiveMeetingRuntimeProvider', () => ({
  useLiveMeetingRuntime: () => mocked.runtime,
}));

function turn(patch: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return {
    id: '4e4df86f-91cf-439d-b74f-08075eb1fb34',
    meetingId: '34821d05-fad2-44ba-ad46-31ad1b9fbf7e',
    transcriptVersionId: '1738bb22-aa73-43d9-bf1d-f5622d9ccbc0',
    provider: 'assemblyai',
    providerSessionId: 'stream-1',
    providerTurnId: '1',
    providerTurnOrder: 1,
    revision: 0,
    status: 'partial',
    provisionalSpeakerLabel: 'Speaker A',
    sourceKind: 'mixed',
    startMs: 1_000,
    endMs: 2_000,
    text: 'Participation nearly',
    words: [],
    utteranceBoundary: false,
    endOfTurn: false,
    formatted: false,
    receivedAtMs: 2_100,
    ...patch,
  };
}

function artifact(activeTurn: TranscriptTurn, claims: Claim[] = []): MeetingArtifact {
  return {
    id: activeTurn.meetingId,
    title: 'Community interview',
    artifactType: 'meeting',
    mode: 'call',
    status: 'recording',
    strategy: 'mixed_diarized',
    startedAtMs: 0,
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:00Z',
    liveTranscriptVersionId: activeTurn.transcriptVersionId,
    refinementStatus: 'not_started',
    researchStatus: 'pending',
    versions: [],
    turns: [activeTurn],
    speakers: [],
    timeline: [],
    claims,
    manualFactCheckRequests: [],
    pendingClaimGateSegmentIds: [],
    pendingClaimGateBatches: [],
    audioAssets: [],
    researchJobs: [],
    refinementJobs: [],
  };
}

function runtimeFor(activeTurn: TranscriptTurn) {
  const setFollowingLive = vi.fn();
  const jumpToLive = vi.fn();
  return {
    state: {
      ...initialMeetingState,
      runtime: { ...initialMeetingState.runtime, lifecycle: 'recording' as const },
      artifact: artifact(activeTurn),
      activeTurns: { [`${activeTurn.providerSessionId}:${activeTurn.providerTurnId}`]: activeTurn },
      turnOrder: [`${activeTurn.providerSessionId}:${activeTurn.providerTurnId}`],
    },
    setFollowingLive,
    jumpToLive,
    setViewVersion: vi.fn(),
    factCheckSelection: vi.fn(),
    selectClaim: vi.fn(),
    renameSpeaker: vi.fn(),
  };
}

function assessment(patch: Partial<Assessment> = {}): Assessment {
  return {
    id: '9434afaf-6b96-4727-b4ea-aa84b0e2b682',
    claimVersionId: '845f3a55-c39f-49f3-8382-30aa93e37e62',
    stage: 'preliminary',
    attempt: 1,
    status: 'complete',
    current: true,
    verdict: 'Needs context',
    confidence: 'Medium',
    conclusion: 'The cited annual report supports most of the stated increase.',
    support: ['The report shows year-over-year growth.'],
    contradiction: [],
    caveats: [],
    limitations: [],
    citations: {
      conclusion: ['S1'],
      support: [['S1']],
      contradiction: [],
      caveats: [],
      limitations: [],
    },
    sources: [
      {
        id: 'be37c226-085b-47a3-b238-685889af6ff9',
        citationKey: 'S1',
        url: 'https://example.org/report',
        canonicalUrl: 'https://example.org/report',
        publisher: 'Example Institute',
        title: 'Annual report',
        accessedAt: '2026-08-10T00:00:00Z',
        excerpt: 'Participation increased.',
        retrievalKind: 'page_extract',
        stance: 'supports',
        qualityScore: 0.9,
        qualityRationale: 'Primary annual reporting.',
      },
    ],
    ...patch,
  };
}

function findingClaim(assessments: Assessment[], status: Claim['status'] = 'complete'): Claim {
  return {
    id: '0e7d20ef-c40b-4243-a2b0-8b905f0eaacd',
    meetingId: '34821d05-fad2-44ba-ad46-31ad1b9fbf7e',
    origin: 'automatic',
    duplicateKey: 'participation-growth',
    status,
    currentVersionId: '845f3a55-c39f-49f3-8382-30aa93e37e62',
    spokenAtMs: 1_000,
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:00Z',
    versions: [
      {
        id: '845f3a55-c39f-49f3-8382-30aa93e37e62',
        claimId: '0e7d20ef-c40b-4243-a2b0-8b905f0eaacd',
        version: 1,
        exactQuote: 'Participation nearly doubled.',
        normalizedClaim: 'Participation nearly doubled in one year.',
        segmentIds: [],
        lifecycle: 'active',
        createdAt: '2026-08-10T00:00:00Z',
        assessments,
      },
    ],
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}</output>;
}

describe('live fact-check components', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('removes the system-audio silence banner after matching capture recovery', () => {
    const activeTurn = turn();
    const runtime = runtimeFor(activeTurn);
    const warningState = meetingReducer(runtime.state, {
      type: 'failed',
      error: {
        code: 'system_audio_silent',
        message: 'System Audio is connected but silent.',
        retryable: true,
      },
    });
    mocked.runtime = { ...runtime, state: warningState };
    const view = render(<LiveMeetingView />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Computer audio is connected but quiet. Your microphone is still recording. Play audio from the call to confirm computer-audio capture.'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('retry when possible');

    mocked.runtime = {
      ...runtime,
      state: meetingReducer(warningState, {
        type: 'capture_warning_recovered',
        code: 'system_audio_silent',
      }),
    };
    view.rerender(<LiveMeetingView />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps listening while transcription reconnects independently of research', () => {
    const runtime = runtimeFor(turn());
    runtime.state = {
      ...runtime.state,
      runtime: {
        ...runtime.state.runtime,
        gateway: 'unavailable',
        stt: 'reconnecting',
      },
      artifact: { ...runtime.state.artifact, turns: [] },
      activeTurns: {},
      turnOrder: [],
    };
    mocked.runtime = runtime;
    render(<LiveTranscript />);

    expect(screen.getByText('Recording locally · Reconnecting transcription…')).toBeInTheDocument();
    expect(screen.getByText('Listening for the first words…')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Every live utterance stays beside its current speaker label and settles in place when finalized.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('Recording audio · transcript unavailable')).not.toBeInTheDocument();
  });

  it('does not claim a live transcript exists when refinement fails without turns', () => {
    const runtime = runtimeFor(turn());
    const failedState = {
      ...runtime.state,
      runtime: {
        ...runtime.state.runtime,
        lifecycle: 'complete' as const,
        gateway: 'unavailable' as const,
        refinement: 'failed' as const,
      },
      artifact: {
        ...runtime.state.artifact,
        status: 'complete' as const,
        refinementStatus: 'failed' as const,
        turns: [],
      },
      activeTurns: {},
      turnOrder: [],
      error: {
        code: 'live_operation_failed',
        message: 'Transcript refinement failed; the live transcript remains available.',
        retryable: true,
      },
    };
    mocked.runtime = { ...runtime, state: failedState, retryRefinement: vi.fn() };
    render(<LiveMeetingView />);

    expect(screen.getByText('Refinement unavailable')).toBeInTheDocument();
    expect(screen.getByText('Recording saved · no transcript')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Transcript refinement failed. Your local recording is saved, but no live transcript was produced.'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('live transcript remains available');
    expect(screen.getByRole('alert')).not.toHaveTextContent('retry when possible');
  });

  it('keeps growing partial text beside its provisional speaker and promotes it in place', () => {
    const partial = turn();
    mocked.runtime = runtimeFor(partial);
    const view = render(<LiveTranscript />);

    expect(screen.getByText('Speaker A')).toBeInTheDocument();
    expect(screen.getByText('Participation nearly')).toBeInTheDocument();
    expect(screen.getByText('Participation nearly').closest('p')).toHaveClass('text-neutral-600');
    expect(document.querySelectorAll('[id^="turn-"]')).toHaveLength(1);

    const final = turn({
      revision: 1,
      status: 'revised',
      text: 'Participation nearly doubled.',
      endOfTurn: true,
      formatted: true,
      utteranceBoundary: true,
    });
    mocked.runtime = runtimeFor(final);
    view.rerender(<LiveTranscript />);

    expect(screen.queryByText('Participation nearly')).not.toBeInTheDocument();
    expect(screen.getByText('Participation nearly doubled.')).toBeInTheDocument();
    expect(screen.getByText('Participation nearly doubled.').closest('p')).not.toHaveClass(
      'text-neutral-600'
    );
    expect(document.querySelectorAll('[id^="turn-"]')).toHaveLength(1);
  });

  it('renders named and explicitly unknown active speakers without moving text out of the row', () => {
    const namedTurn = turn({ speakerId: 'speaker-1' });
    const namedRuntime = runtimeFor(namedTurn);
    const namedSpeaker: Speaker = {
      id: 'speaker-1',
      defaultLabel: 'Speaker 1',
      displayName: 'Avery',
      displayNameSource: 'manual',
      manualAssignmentLocked: true,
    };
    namedRuntime.state.artifact.speakers = [namedSpeaker];
    mocked.runtime = namedRuntime;
    const view = render(<LiveTranscript />);

    expect(screen.getByText('Avery')).toBeInTheDocument();
    expect(screen.getByText('Participation nearly')).toBeInTheDocument();
    expect(document.querySelectorAll('[id^="turn-"]')).toHaveLength(1);

    const unknownTurn = turn({ provisionalSpeakerLabel: 'UNKNOWN' });
    mocked.runtime = runtimeFor(unknownTurn);
    view.rerender(<LiveTranscript />);
    expect(screen.getByText('Identifying speaker…')).toBeInTheDocument();
    expect(document.querySelectorAll('[id^="turn-"]')).toHaveLength(1);
  });

  it('pauses following when requested and offers a jump back to the live edge', () => {
    const activeTurn = turn({ status: 'final', text: 'A settled final turn.' });
    const runtime = runtimeFor(activeTurn);
    runtime.state.followingLive = false;
    runtime.state.unseenFinalTurns = 2;
    mocked.runtime = runtime;
    render(<LiveTranscript />);

    fireEvent.click(screen.getByRole('button', { name: /jump to live/i }));
    expect(runtime.jumpToLive).toHaveBeenCalledOnce();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('pauses auto-scroll when the reader leaves the live edge and resumes near the bottom', () => {
    const activeTurn = turn({ status: 'final', text: 'A settled final turn.' });
    const runtime = runtimeFor(activeTurn);
    mocked.runtime = runtime;
    const view = render(<LiveTranscript />);
    const { container } = view;
    const scroller = container.querySelector('.overflow-y-auto');
    if (!(scroller instanceof HTMLElement)) throw new Error('Expected transcript scroller');
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 120 },
    });

    fireEvent.scroll(scroller);
    expect(runtime.setFollowingLive).toHaveBeenLastCalledWith(false);

    runtime.state.followingLive = false;
    mocked.runtime = runtime;
    view.rerender(<LiveTranscript />);
    scroller.scrollTop = 570;
    fireEvent.scroll(scroller);
    expect(runtime.setFollowingLive).toHaveBeenLastCalledWith(true);
  });

  it('presents reconnect, sleep, and capture-gap state without hiding the transcript', () => {
    const activeTurn = turn({ status: 'final', text: 'Local recording continues.' });
    const runtime = runtimeFor(activeTurn);
    runtime.state.runtime.stt = 'reconnecting';
    runtime.state.artifact.timeline = [
      {
        id: 'timeline-sleep',
        meetingId: activeTurn.meetingId,
        kind: 'sleep',
        startMs: 200,
      },
      {
        id: 'timeline-gap',
        meetingId: activeTurn.meetingId,
        kind: 'capture_gap',
        startMs: 500,
        label: 'System audio paused during device change',
      },
    ];
    mocked.runtime = runtime;
    render(<LiveTranscript />);

    expect(screen.getByText(/recording locally · reconnecting transcription/i)).toBeInTheDocument();
    expect(screen.getByText(/computer slept · audio was not captured/i)).toBeInTheDocument();
    expect(screen.getByText('System audio paused during device change')).toBeInTheDocument();
    expect(screen.getByText('Local recording continues.')).toBeInTheDocument();
  });

  it('preserves a cited preliminary finding when deeper research fails', () => {
    const claim = findingClaim([assessment()], 'failed');
    mocked.runtime = { selectClaim: vi.fn(), openSource: vi.fn() };
    render(<ClaimCard claim={claim} selected={false} />);

    expect(screen.getByText('Needs context')).toBeInTheDocument();
    expect(screen.getByText('Example Institute')).toBeInTheDocument();
    expect(screen.getByText(/deeper research could not finish/i)).toBeInTheDocument();
  });

  it('shows a local preliminary as terminal without a false deeper-research spinner', () => {
    const activeTurn = turn({ status: 'final' });
    const claim = findingClaim([assessment()], 'preliminary');
    mocked.runtime = {
      state: { ...initialMeetingState, artifact: artifact(activeTurn, [claim]) },
      selectClaim: vi.fn(),
      openSource: vi.fn(),
    };

    render(<ClaimCard claim={claim} selected={false} />);

    expect(screen.getByText('Preliminary')).toBeInTheDocument();
    expect(screen.queryByText(/researching more/i)).not.toBeInTheDocument();
  });

  it('lets the user escalate an accepted hosted preliminary check', () => {
    const activeTurn = turn({ status: 'final' });
    const claim = findingClaim([assessment()], 'preliminary');
    const meetingArtifact = artifact(activeTurn, [claim]);
    meetingArtifact.researchJobs = [
      {
        id: 'preliminary-job',
        claimVersionId: claim.currentVersionId,
        stage: 'preliminary',
        gatewayJobId: 'check_1',
        idempotencyKey: 'fact-check-request-1',
        status: 'complete',
        attemptCount: 1,
      },
    ];
    const escalateClaim = vi.fn().mockResolvedValue(undefined);
    mocked.runtime = {
      state: { ...initialMeetingState, artifact: meetingArtifact },
      selectClaim: vi.fn(),
      openSource: vi.fn(),
      rerunClaim: vi.fn(),
      escalateClaim,
      reportClaimProblem: vi.fn(),
    };

    render(<ClaimCard claim={claim} selected />);
    fireEvent.click(screen.getByRole('button', { name: /research further/i }));

    expect(escalateClaim).toHaveBeenCalledWith(claim.id);
  });

  it('shows deeper research only while a hosted deep job is actually active', () => {
    const activeTurn = turn({ status: 'final' });
    const claim = findingClaim([assessment()], 'deep_running');
    const meetingArtifact = artifact(activeTurn, [claim]);
    meetingArtifact.researchJobs = [
      {
        id: 'hosted-deep-job',
        claimVersionId: claim.currentVersionId,
        stage: 'deep',
        idempotencyKey: 'hosted-deep-job',
        status: 'running',
        attemptCount: 1,
      },
    ];
    mocked.runtime = {
      state: { ...initialMeetingState, artifact: meetingArtifact },
      selectClaim: vi.fn(),
      openSource: vi.fn(),
    };

    render(<ClaimCard claim={claim} selected={false} />);

    expect(screen.getByText(/researching more/i)).toBeInTheDocument();
  });

  it('shows a locally identified manual claim and the real research-unavailable reason', () => {
    const activeTurn = turn({ status: 'final' });
    const claim = { ...findingClaim([], 'queued'), origin: 'manual' as const };
    const meetingArtifact = artifact(activeTurn, [claim]);
    meetingArtifact.researchJobs = [
      {
        id: 'research-job-1',
        claimVersionId: claim.currentVersionId,
        stage: 'preliminary',
        idempotencyKey: 'research-job-1',
        status: 'retry_wait',
        attemptCount: 1,
        error: {
          code: 'gateway_unavailable',
          message:
            'Claim saved locally. Evidence research needs the Obelus research gateway, which is not configured.',
          retryable: true,
        },
      },
    ];
    const rerunClaim = vi.fn();
    mocked.runtime = {
      state: { ...initialMeetingState, artifact: meetingArtifact },
      selectClaim: vi.fn(),
      openSource: vi.fn(),
      rerunClaim,
    };

    render(<ClaimCard claim={claim} selected />);

    expect(screen.getByText(/manual check/i)).toBeInTheDocument();
    expect(screen.getByText(/claim saved locally/i)).toBeInTheDocument();
    expect(screen.getByText('Research unavailable')).toBeInTheDocument();
    expect(
      screen.queryByText(/supported|disputed|needs context|unverified/i)
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry check now/i }));
    expect(rerunClaim).toHaveBeenCalledWith(claim.id);
  });

  it('shows immediate feedback for a durable context-menu request before its claim is created', () => {
    const activeTurn = turn({ status: 'final' });
    const meetingArtifact = artifact(activeTurn);
    meetingArtifact.manualFactCheckRequests = [
      {
        id: 'manual-request-1',
        meetingId: meetingArtifact.id,
        exactSelection: 'Barnes and Noble is a bigger company than Amazon.',
        contextTurns: [],
        sourceSegmentIds: [],
        status: 'queued',
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      },
    ];
    mocked.runtime = {
      state: { ...initialMeetingState, artifact: meetingArtifact },
      setClaimRailOpen: vi.fn(),
    };

    render(<ClaimRail />);

    expect(screen.getByText('Manual check queued')).toBeInTheDocument();
    expect(screen.getByText(/preparing the selected claim/i)).toBeInTheDocument();
  });

  it('states that automatic overflow was not queued when the claim limit is reached', () => {
    const activeTurn = turn({ status: 'final' });
    mocked.runtime = {
      state: {
        ...initialMeetingState,
        artifact: artifact(activeTurn),
        backpressure: true,
        backpressureReason: 'limit',
      },
      setClaimRailOpen: vi.fn(),
    };

    render(<ClaimRail />);

    expect(screen.getByText(/automatic claim limit reached/i)).toHaveTextContent(
      'Additional candidates were not queued'
    );
  });

  it('keeps ChatGPT and public-web processing disclosed when subscription research is unavailable', () => {
    const activeTurn = turn({ status: 'final' });
    mocked.runtime = {
      state: {
        ...initialMeetingState,
        artifact: artifact(activeTurn),
      },
      support: {
        localFactCheckMode: 'subscription_web',
        localFactCheckAvailable: false,
      },
      setClaimRailOpen: vi.fn(),
    };

    render(<ClaimRail />);

    expect(screen.getByText(/Preliminary AI research/i)).toHaveTextContent(/public web sources/i);
    expect(screen.getByText(/Preliminary AI research/i)).toHaveTextContent(/go to ChatGPT/i);
    expect(screen.getByText(/Preliminary AI research/i)).toHaveTextContent(
      /Review cited sources before relying/i
    );
  });

  it('discloses explicit direct fallback and its accepted-ID boundary', () => {
    const activeTurn = turn({ status: 'final' });
    mocked.runtime = {
      state: { ...initialMeetingState, artifact: artifact(activeTurn) },
      support: {
        localFactCheckMode: 'hosted',
        directFactCheckFallbackEnabled: true,
      },
      setClaimRailOpen: vi.fn(),
    };

    render(<ClaimRail />);

    expect(screen.getByText(/explicit direct fallback/i)).toHaveTextContent(/to ChatGPT/i);
    expect(screen.getByText(/explicit direct fallback/i)).toHaveTextContent(
      /never occurs after a hosted check ID is accepted/i
    );
  });

  it('promotes a preliminary finding to its deep packet and routes citations through secure open', () => {
    const openSource = vi.fn().mockResolvedValue(undefined);
    const preliminary = assessment();
    const deep = assessment({
      id: 'e51427a5-c99e-44a3-b1ac-81af4e9bd71f',
      stage: 'deep',
      attempt: 2,
      verdict: 'Needs context',
      confidence: 'High',
      conclusion: 'The larger source set finds growth, but not a doubling.',
      contradiction: ['The audited total rose by 71 percent, not 100 percent.'],
      citations: {
        conclusion: ['S2'],
        support: [['S2']],
        contradiction: [['S2']],
        caveats: [],
        limitations: [],
      },
      sources: [
        {
          ...preliminary.sources[0],
          id: 'a0596c20-8754-4455-b302-bae60b67959b',
          citationKey: 'S2',
          publisher: 'State Auditor',
          title: 'Audited participation table',
          url: 'https://auditor.example.gov/participation',
          canonicalUrl: 'https://auditor.example.gov/participation',
        },
      ],
    });
    mocked.runtime = {
      selectClaim: vi.fn(),
      openSource,
      rerunClaim: vi.fn(),
      reportClaimProblem: vi.fn(),
    };
    render(<ClaimCard claim={findingClaim([preliminary, deep])} selected />);

    expect(screen.getByText('Research complete')).toBeInTheDocument();
    expect(screen.getByText('Needs context')).toBeInTheDocument();
    expect(screen.getByText(/larger source set finds growth/i)).toBeInTheDocument();
    expect(screen.getByText('Evidence inventory')).toBeInTheDocument();
    expect(screen.getByText(/S2 · State Auditor · Page extract/i)).toBeInTheDocument();
    expect(screen.getByText(/bounded set/i)).toHaveTextContent(/not a preloaded database/i);
    expect(screen.getByText(/bounded set/i)).toHaveTextContent(
      /or a claim that every page online was searched/i
    );
    expect(screen.getAllByRole('button', { name: 'Open source S2' }).length).toBeGreaterThan(1);

    fireEvent.click(screen.getAllByRole('button', { name: /state auditor/i })[0]);
    expect(openSource).toHaveBeenCalledOnce();
    expect(openSource).toHaveBeenCalledWith('https://auditor.example.gov/participation');
  });

  it('keeps a stronger preliminary finding visible when deep research is weaker', () => {
    const preliminary = assessment({
      id: 'preliminary-strong',
      verdict: 'Disputed',
      confidence: 'High',
      conclusion: 'Direct measurements contradict the claim.',
    });
    const deep = assessment({
      id: 'deep-weak',
      stage: 'deep',
      attempt: 2,
      verdict: 'Unverified',
      confidence: 'Low',
      conclusion: 'The deeper search did not resolve the claim.',
    });
    mocked.runtime = {
      selectClaim: vi.fn(),
      openSource: vi.fn(),
      rerunClaim: vi.fn(),
      reportClaimProblem: vi.fn(),
    };

    render(<ClaimCard claim={findingClaim([preliminary, deep])} selected />);

    expect(screen.getByText('Disputed')).toBeInTheDocument();
    expect(screen.getByText(/direct measurements contradict/i)).toBeInTheDocument();
    expect(screen.getByText(/preliminary finding retained/i)).toBeInTheDocument();
    expect(screen.queryByText(/deeper search did not resolve/i)).not.toBeInTheDocument();
  });

  it('routes a bounded in-transcript selection with its speaker, timing, and context anchor', async () => {
    const factCheckSelection = vi.fn().mockResolvedValue(undefined);
    const activeTurn = turn({
      speakerId: 'speaker-1',
      text: 'Revenue increased 42 percent.',
      status: 'final',
      endOfTurn: true,
      formatted: true,
    });
    mocked.runtime = {
      factCheckSelection,
      selectClaim: vi.fn(),
      support: {
        localFactCheckMode: 'subscription_web',
        localFactCheckAvailable: false,
      },
    };
    const { container } = render(<LiveUtterance turn={activeTurn} claims={[]} />);
    const utterance = container.querySelector(`[data-turn-id="${activeTurn.id}"]`);
    const textNode = screen.getByText(activeTurn.text).firstChild;
    if (!(utterance instanceof HTMLElement) || !textNode) {
      throw new Error('Expected selectable transcript text');
    }
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '42 percent',
      rangeCount: 1,
      removeAllRanges: vi.fn(),
      getRangeAt: () => ({
        commonAncestorContainer: textNode,
        getBoundingClientRect: () => ({ left: 80, width: 40, top: 120 }),
      }),
    } as unknown as ReturnType<typeof window.getSelection>);

    fireEvent.mouseUp(utterance);
    expect(factCheckSelection).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /fact-check selected text/i })).toHaveTextContent(
      'Check with ChatGPT + web'
    );
    expect(screen.getByRole('button', { name: /fact-check selected text/i })).toHaveAttribute(
      'title',
      expect.stringMatching(/selected claim.*retrieved evidence.*ChatGPT/i)
    );
    fireEvent.click(screen.getByRole('button', { name: /fact-check selected text/i }));
    await waitFor(() => expect(factCheckSelection).toHaveBeenCalledOnce());
    expect(factCheckSelection).toHaveBeenCalledWith({
      text: '42 percent',
      turnIds: [activeTurn.id],
      speakerId: 'speaker-1',
      startMs: activeTurn.startMs,
      endMs: activeTurn.endMs,
      nearbyContext: activeTurn.text,
      anchor: { x: 100, y: 120 },
    });
  });

  it('does not offer a paid fact-check action for provisional transcript text', () => {
    const factCheckSelection = vi.fn().mockResolvedValue(undefined);
    const activeTurn = turn({ text: 'Revenue increased' });
    mocked.runtime = { factCheckSelection, selectClaim: vi.fn() };
    const { container } = render(<LiveUtterance turn={activeTurn} claims={[]} />);
    const utterance = container.querySelector(`[data-turn-id="${activeTurn.id}"]`);
    const textNode = screen.getByText(activeTurn.text).firstChild;
    if (!(utterance instanceof HTMLElement) || !textNode) {
      throw new Error('Expected selectable transcript text');
    }
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => activeTurn.text,
      rangeCount: 1,
      removeAllRanges: vi.fn(),
      getRangeAt: () => ({
        commonAncestorContainer: textNode,
        getBoundingClientRect: () => ({ left: 80, width: 40, top: 120 }),
      }),
    } as unknown as ReturnType<typeof window.getSelection>);

    fireEvent.mouseUp(utterance);
    expect(screen.queryByRole('button', { name: /fact-check selected text/i })).toBeNull();
    expect(factCheckSelection).not.toHaveBeenCalled();
  });

  it('explains unsupported call capture and starts a truthful microphone-only fallback', () => {
    const startMeeting = vi.fn();
    mocked.runtime = {
      state: initialMeetingState,
      devices: [],
      support: {
        checkingPermissions: false,
        systemAudioSupported: false,
        systemAudioPermission: 'unknown',
        microphonePermission: 'prompt',
        gatewayState: 'ready',
      },
      setSetup: vi.fn(),
      startMeeting,
      refreshDevices: vi.fn(),
      testMicrophone: vi.fn(),
    };
    render(<LiveSetupView />);

    expect(
      screen.getByText('System audio unavailable · microphone-only works')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /start mic only/i }));
    expect(startMeeting).toHaveBeenCalledWith(true);
  });

  it('switches between call and in-person setup while preserving the permission fallback', () => {
    const setSetup = vi.fn();
    const startMeeting = vi.fn();
    mocked.runtime = {
      state: initialMeetingState,
      devices: [],
      support: {
        checkingPermissions: false,
        systemAudioSupported: true,
        systemAudioPermission: 'denied',
        microphonePermission: 'granted',
        gatewayState: 'ready',
      },
      setSetup,
      startMeeting,
      refreshDevices: vi.fn(),
      testMicrophone: vi.fn(),
    };
    render(<LiveSetupView />);

    fireEvent.click(screen.getByRole('button', { name: /^in person/i }));
    expect(setSetup).toHaveBeenCalledWith({ mode: 'in_person', micOnly: true });
    fireEvent.click(screen.getByRole('button', { name: /start mic only/i }));
    expect(startMeeting).toHaveBeenCalledWith(true);
    expect(
      screen.getByText('Blocked in macOS settings · microphone-only works')
    ).toBeInTheDocument();
  });

  it('shows a failed startup reason and immediately allows another attempt', () => {
    mocked.runtime = {
      state: {
        ...initialMeetingState,
        runtime: { ...initialMeetingState.runtime, lifecycle: 'error' },
        error: {
          code: 'capture_start_timeout',
          message: 'Audio startup did not respond.',
          retryable: true,
        },
      },
      devices: [],
      support: {
        checkingPermissions: false,
        systemAudioSupported: true,
        systemAudioPermission: 'granted',
        microphonePermission: 'granted',
        gatewayState: 'ready',
      },
      setSetup: vi.fn(),
      startMeeting: vi.fn(),
      refreshDevices: vi.fn(),
      testMicrophone: vi.fn(),
    };

    render(<LiveSetupView />);

    expect(screen.getByRole('alert')).toHaveTextContent('Audio startup did not respond.');
    expect(screen.getByRole('button', { name: /start recording/i })).toBeEnabled();
  });

  it('waits for native permission resolution before enabling recording', () => {
    mocked.runtime = {
      state: initialMeetingState,
      devices: [],
      support: {
        checkingPermissions: true,
        systemAudioSupported: false,
        systemAudioPermission: 'unknown',
        microphonePermission: 'unknown',
        gatewayState: 'unavailable',
      },
      setSetup: vi.fn(),
      startMeeting: vi.fn(),
      refreshDevices: vi.fn(),
      testMicrophone: vi.fn(),
    };
    render(<LiveSetupView />);

    expect(screen.getByText('Checking microphone and system audio…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /checking permissions/i })).toBeDisabled();
  });

  it('does not promise a reconnect when the research gateway is unconfigured', () => {
    mocked.runtime = {
      state: initialMeetingState,
      devices: [],
      support: {
        checkingPermissions: false,
        systemAudioSupported: false,
        systemAudioPermission: 'unknown',
        microphonePermission: 'granted',
        gatewayState: 'unavailable',
        gatewayUnavailableReason: 'The Obelus research gateway is not configured.',
        localSttAvailable: true,
      },
      setSetup: vi.fn(),
      startMeeting: vi.fn(),
      refreshDevices: vi.fn(),
      testMicrophone: vi.fn(),
    };

    render(<LiveSetupView />);

    expect(screen.getByText(/evidence research needs the Obelus gateway/i)).toBeInTheDocument();
    expect(screen.queryByText(/research.*will reconnect/i)).not.toBeInTheDocument();
  });

  it('discloses ChatGPT, public-web retrieval, and preliminary evidence scope before recording', () => {
    mocked.runtime = {
      state: initialMeetingState,
      devices: [],
      support: {
        checkingPermissions: false,
        systemAudioSupported: false,
        systemAudioPermission: 'unknown',
        microphonePermission: 'granted',
        gatewayState: 'unavailable',
        gatewayUnavailableReason: 'The Obelus research gateway is not configured.',
        localSttAvailable: true,
        localFactCheckMode: 'subscription_web',
        localFactCheckAvailable: true,
        localFactCheckModel: 'gpt-5.6-sol',
      },
      setSetup: vi.fn(),
      startMeeting: vi.fn(),
      refreshDevices: vi.fn(),
      testMicrophone: vi.fn(),
    };

    render(<LiveSetupView />);

    expect(
      screen.getByText(/automatic detection sends bounded finalized transcript/i)
    ).toHaveTextContent(/identified claims and retrieved evidence.*ChatGPT/i);
    expect(
      screen.getByText(/recorded audio and on-device transcription stay on this Mac/i)
    ).toHaveTextContent(/search queries and page requests go to public web sources/i);
    expect(
      screen.getByText(/recorded audio and on-device transcription stay on this Mac/i)
    ).toHaveTextContent(/bounded finalized transcript excerpts go to ChatGPT/i);
    expect(
      screen.getByText(/preliminary fact-checks using ChatGPT and public-web evidence/i)
    ).toBeInTheDocument();
  });

  it('keeps ChatGPT and the web disclosed when subscription research is unavailable', () => {
    mocked.runtime = {
      state: initialMeetingState,
      devices: [],
      support: {
        checkingPermissions: false,
        systemAudioSupported: false,
        systemAudioPermission: 'unknown',
        microphonePermission: 'granted',
        gatewayState: 'unavailable',
        gatewayUnavailableReason: 'The Obelus research gateway is not configured.',
        localSttAvailable: true,
        localFactCheckMode: 'subscription_web',
        localFactCheckAvailable: false,
        localFactCheckUnavailableReason: 'Sign in to ChatGPT in Obelus.',
      },
      setSetup: vi.fn(),
      startMeeting: vi.fn(),
      refreshDevices: vi.fn(),
      testMicrophone: vi.fn(),
    };

    render(<LiveSetupView />);

    expect(
      screen.getByText(/automatic detection sends bounded finalized transcript/i)
    ).toHaveTextContent(/retrieved evidence.*ChatGPT/i);
    expect(screen.getByText(/fact-checking with ChatGPT/i)).toHaveTextContent(
      /Sign in to ChatGPT/i
    );
    expect(screen.queryByText(/configured Obelus research gateway/i)).not.toBeInTheDocument();
  });

  it('labels subscription research as unavailable without hiding its ChatGPT routing identity', () => {
    const support = {
      localFactCheckMode: 'subscription_web',
      localFactCheckAvailable: false,
      localFactCheckUnavailableReason: 'ChatGPT authorization expired.',
    };
    mocked.runtime = {
      state: initialMeetingState,
      support,
      pauseMeeting: vi.fn(),
      resumeMeeting: vi.fn(),
      stopMeeting: vi.fn(),
      closeArtifact: vi.fn(),
      swapSpeakers: vi.fn(),
    };

    const { rerender } = render(<LiveMeetingHeader />);

    expect(screen.getByText(/Research ChatGPT · unavailable/i)).toBeInTheDocument();
    const unavailableStatus = screen.getByTitle(/ChatGPT with public-web evidence unavailable/i);
    expect(unavailableStatus).toHaveAttribute(
      'title',
      expect.stringMatching(/ChatGPT authorization expired/i)
    );
    expect(unavailableStatus.firstElementChild).toHaveClass('bg-status-disputed');

    support.localFactCheckAvailable = true;
    rerender(<LiveMeetingHeader />);

    expect(screen.getByText(/Research ChatGPT · preliminary/i)).toBeInTheDocument();
    expect(
      screen.getByTitle('Research: ChatGPT with public-web evidence').firstElementChild
    ).toHaveClass('bg-brand-aqua');
  });

  it('keeps a global recording return control when another route is open', () => {
    mocked.runtime = {
      state: {
        ...initialMeetingState,
        runtime: {
          ...initialMeetingState.runtime,
          lifecycle: 'recording',
          elapsedMs: 65_000,
        },
      },
    };
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <GlobalRecordingIndicator />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText('Recording')).toBeInTheDocument();
    expect(screen.getByText('1:05')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /return to live meeting/i }));
    expect(screen.getByRole('status', { name: 'Current route' })).toHaveTextContent('/live');
    expect(screen.queryByText('Recording')).not.toBeInTheDocument();
  });

  it('switches between live and refined versions and exposes a deterministic refinement retry', () => {
    const activeTurn = turn({ status: 'final', text: 'The live wording.' });
    const runtime = runtimeFor(activeTurn);
    runtime.state.artifact.canonicalTranscriptVersionId = 'refined-version';
    runtime.state.artifact.versions = [
      {
        id: 'refined-version',
        meetingId: runtime.state.artifact.id,
        kind: 'refined',
        status: 'complete',
        revision: 1,
        createdAt: '2026-08-10T00:00:00Z',
      },
    ];
    mocked.runtime = runtime;
    const view = render(<LiveTranscript />);

    fireEvent.click(screen.getByRole('button', { name: 'Refined' }));
    fireEvent.click(screen.getByRole('button', { name: 'Live' }));
    expect(runtime.setViewVersion.mock.calls).toEqual([['refined'], ['live']]);

    const retryRefinement = vi.fn().mockResolvedValue(undefined);
    runtime.state.artifact.refinementStatus = 'failed';
    mocked.runtime = { state: runtime.state, retryRefinement };
    view.rerender(<TranscriptRefinementStatus />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retryRefinement).toHaveBeenCalledOnce();
  });

  it('does not report completed local preliminary research as still running', () => {
    const activeTurn = turn({ status: 'final' });
    const claim = findingClaim([assessment()], 'preliminary');
    const runtime = runtimeFor(activeTurn);
    runtime.state.artifact = artifact(activeTurn, [claim]);
    runtime.state.artifact.refinementStatus = 'complete';
    runtime.state.artifact.researchJobs = [
      {
        id: 'local-preliminary-job',
        claimVersionId: claim.currentVersionId,
        stage: 'preliminary',
        idempotencyKey: 'local-preliminary-job',
        status: 'complete',
        attemptCount: 1,
      },
    ];
    mocked.runtime = runtime;

    render(<TranscriptRefinementStatus />);

    expect(screen.getByText('Refined transcript ready')).toBeInTheDocument();
    expect(screen.queryByText(/research packets? still running/i)).not.toBeInTheDocument();
  });

  it.each(['pending', 'running', 'retry_wait'] as const)(
    'counts a %s research job as still running',
    (researchStatus) => {
      const activeTurn = turn({ status: 'final' });
      const runtime = runtimeFor(activeTurn);
      runtime.state.artifact.refinementStatus = 'complete';
      runtime.state.artifact.researchJobs = [
        {
          id: `research-job-${researchStatus}`,
          claimVersionId: 'claim-version-1',
          stage: 'deep',
          idempotencyKey: `research-job-${researchStatus}`,
          status: researchStatus,
          attemptCount: 1,
        },
      ];
      mocked.runtime = runtime;

      render(<TranscriptRefinementStatus />);

      expect(screen.getByText(/1 research packet still running/i)).toBeInTheDocument();
    }
  );

  it.each(['failed', 'cancelled', 'complete'] as const)(
    'does not count a %s research job as still running',
    (researchStatus) => {
      const activeTurn = turn({ status: 'final' });
      const runtime = runtimeFor(activeTurn);
      runtime.state.artifact.refinementStatus = 'complete';
      runtime.state.artifact.researchJobs = [
        {
          id: `research-job-${researchStatus}`,
          claimVersionId: 'claim-version-1',
          stage: 'deep',
          idempotencyKey: `research-job-${researchStatus}`,
          status: researchStatus,
          attemptCount: 1,
        },
      ];
      mocked.runtime = runtime;

      render(<TranscriptRefinementStatus />);

      expect(screen.queryByText(/research packets? still running/i)).not.toBeInTheDocument();
    }
  );

  it('keeps Refined unavailable until a distinct completed refined version exists', () => {
    const activeTurn = turn({ status: 'final' });
    const runtime = runtimeFor(activeTurn);
    runtime.state.artifact.liveTranscriptVersionId = activeTurn.transcriptVersionId;
    runtime.state.artifact.canonicalTranscriptVersionId = activeTurn.transcriptVersionId;
    runtime.state.artifact.versions = [
      {
        id: activeTurn.transcriptVersionId,
        meetingId: runtime.state.artifact.id,
        kind: 'live',
        status: 'active',
        revision: 0,
        createdAt: '2026-08-10T00:00:00Z',
      },
    ];
    mocked.runtime = runtime;
    const view = render(<LiveTranscript />);
    expect(screen.getByRole('button', { name: 'Refined' })).toBeDisabled();

    runtime.state.artifact.canonicalTranscriptVersionId = 'refined-version';
    runtime.state.artifact.versions.push({
      id: 'refined-version',
      meetingId: runtime.state.artifact.id,
      kind: 'refined',
      status: 'complete',
      revision: 1,
      createdAt: '2026-08-10T00:10:00Z',
    });
    mocked.runtime = runtime;
    view.rerender(<LiveTranscript />);
    expect(screen.getByRole('button', { name: 'Refined' })).toBeEnabled();
  });

  it('plays a recovered interrupted mixed WAV through the controlled audio protocol', async () => {
    const activeTurn = turn({ status: 'final' });
    const runtime = runtimeFor(activeTurn);
    runtime.state.artifact.status = 'interrupted';
    runtime.state.artifact.audioAssets = [
      {
        id: '94c15b58-6aaa-41e0-9bca-dcfda2838935',
        meetingId: runtime.state.artifact.id,
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
    ];
    mocked.runtime = runtime;
    const getAudioPlaybackUrl = vi
      .fn()
      .mockResolvedValue('obelus-audio://playback/recovered.wav?signature=fixture');
    Object.assign(window.electron, { live: { getAudioPlaybackUrl } });

    render(<MeetingAudioPlayer />);

    await waitFor(() => expect(getAudioPlaybackUrl).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('Meeting audio')).toHaveAttribute(
      'src',
      'obelus-audio://playback/recovered.wav?signature=fixture'
    );
  });
});
