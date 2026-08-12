import { randomUUID } from 'node:crypto';
import type {
  LiveAppendAudioResult,
  LiveAudioFrame,
  LiveAudioMeter,
  LiveAudioSourceKind,
  LiveAudioAsset,
  LiveCaptureError,
  LiveCaptureSnapshot,
  LiveCaptureSourceSnapshot,
  LiveCaptureStartConfig,
} from '../ipcTypes';
import { AudioFinalizeError, type LiveAudioAssetStore } from './AudioAssetWriter';

interface CaptureSessionSequence {
  lastSequence: number;
  lastMeetingTimeMs: number;
  lastDurationMs: number;
  workletDroppedFrames: number;
}

export interface LiveCaptureCoordinatorOptions {
  audioStore: LiveAudioAssetStore;
  now?: () => number;
  createId?: () => string;
  onSnapshot?: (snapshot: LiveCaptureSnapshot) => void;
  recoveredAssets?: LiveAudioAsset[];
}

const EMPTY_METER: LiveAudioMeter = { rms: 0, peak: 0 };

function emptySource(state: LiveCaptureSourceSnapshot['state']): LiveCaptureSourceSnapshot {
  return {
    state,
    meter: { ...EMPTY_METER },
    bytesWritten: 0,
    droppedFrames: 0,
  };
}

function initialSnapshot(): LiveCaptureSnapshot {
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
      microphone: emptySource('unavailable'),
      system: emptySource('unavailable'),
      mixed: emptySource('unavailable'),
    },
    timelineEvents: [],
    finalizedAssets: [],
    recoveredMeetings: [],
    lastError: null,
  };
}

function cloneSnapshot(snapshot: LiveCaptureSnapshot): LiveCaptureSnapshot {
  return {
    ...snapshot,
    sources: {
      microphone: {
        ...snapshot.sources.microphone,
        meter: { ...snapshot.sources.microphone.meter },
      },
      system: { ...snapshot.sources.system, meter: { ...snapshot.sources.system.meter } },
      mixed: { ...snapshot.sources.mixed, meter: { ...snapshot.sources.mixed.meter } },
    },
    timelineEvents: snapshot.timelineEvents.map((event) => ({ ...event })),
    finalizedAssets: snapshot.finalizedAssets.map((asset) => ({ ...asset })),
    recoveredMeetings: snapshot.recoveredMeetings.map((meeting) => ({
      meetingId: meeting.meetingId,
      assets: meeting.assets.map((asset) => ({ ...asset })),
    })),
    lastError: snapshot.lastError ? { ...snapshot.lastError } : null,
  };
}

export class LiveCaptureCoordinator {
  private snapshot = initialSnapshot();
  private readonly audioStore: LiveAudioAssetStore;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly onSnapshot?: (snapshot: LiveCaptureSnapshot) => void;
  private readonly sequences = new Map<string, CaptureSessionSequence>();
  private readonly meetingOwners = new Map<string, number>();
  private stopPromise: Promise<LiveCaptureSnapshot> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBroadcastAt = 0;

  constructor(options: LiveCaptureCoordinatorOptions) {
    this.audioStore = options.audioStore;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.onSnapshot = options.onSnapshot;
    const recoveredGroups = new Map<string, LiveAudioAsset[]>();
    for (const asset of options.recoveredAssets ?? []) {
      const group = recoveredGroups.get(asset.meetingId) ?? [];
      group.push(asset);
      recoveredGroups.set(asset.meetingId, group);
    }
    const recoveredMeetings = [...recoveredGroups]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([meetingId, assets]) => ({ meetingId, assets }));
    const recoveredMeetingId = recoveredMeetings[0]?.meetingId;
    if (recoveredMeetingId) {
      const recoveredAssets = recoveredMeetings[0].assets;
      this.snapshot = {
        ...initialSnapshot(),
        lifecycle: 'interrupted',
        meetingId: recoveredMeetingId,
        includeSystemAudio: recoveredAssets.some((asset) => asset.sourceKind === 'system'),
        elapsedMs: Math.max(0, ...recoveredAssets.map((asset) => asset.timelineEndMs)),
        sources: {
          microphone: emptySource(
            recoveredAssets.some((asset) => asset.sourceKind === 'microphone')
              ? 'ended'
              : 'unavailable'
          ),
          system: emptySource(
            recoveredAssets.some((asset) => asset.sourceKind === 'system') ? 'ended' : 'unavailable'
          ),
          mixed: emptySource(
            recoveredAssets.some((asset) => asset.sourceKind === 'mixed') ? 'ended' : 'unavailable'
          ),
        },
        finalizedAssets: recoveredAssets,
        recoveredMeetings,
        lastError: {
          code: 'CAPTURE_RECOVERED_AFTER_INTERRUPTION',
          message: 'Obelus recovered local audio after the previous meeting was interrupted.',
          retryable: false,
        },
      };
    }
  }

  getSnapshot(): LiveCaptureSnapshot {
    this.refreshElapsed();
    return cloneSnapshot(this.snapshot);
  }

  async start(
    config: LiveCaptureStartConfig,
    ownerWebContentsId: number
  ): Promise<LiveCaptureSnapshot> {
    if (this.isActive()) {
      if (
        this.snapshot.meetingId === config.meetingId &&
        this.snapshot.ownerWebContentsId === ownerWebContentsId
      ) {
        return this.getSnapshot();
      }
      throw new Error('Another live meeting is already active');
    }
    this.assertMeetingOwner(config.meetingId, ownerWebContentsId);

    this.clearTimers();
    this.sequences.clear();
    this.stopPromise = null;
    const sources: LiveAudioSourceKind[] = ['microphone', 'mixed'];
    if (config.includeSystemAudio) sources.push('system');
    this.snapshot = {
      ...initialSnapshot(),
      recoveredMeetings: this.snapshot.recoveredMeetings,
      lifecycle: 'starting',
      meetingId: config.meetingId,
      ownerWebContentsId,
      mode: config.mode,
      strategy: config.strategy,
      includeSystemAudio: config.includeSystemAudio,
      sources: {
        microphone: emptySource('requesting'),
        system: emptySource(config.includeSystemAudio ? 'requesting' : 'unavailable'),
        mixed: emptySource('requesting'),
      },
    };
    this.broadcast(true);

    try {
      await this.audioStore.startMeeting(config.meetingId, sources);
      this.broadcast(true);
      return this.getSnapshot();
    } catch {
      this.setError({
        code: 'AUDIO_ASSET_START_FAILED',
        message: 'Obelus could not start the local meeting audio files.',
        retryable: true,
      });
      throw new Error('Unable to start live recording');
    }
  }

  async appendAudio(
    frame: LiveAudioFrame,
    senderWebContentsId: number
  ): Promise<LiveAppendAudioResult> {
    this.assertOwner(senderWebContentsId);
    if (this.snapshot.lifecycle === 'paused') {
      return { accepted: false, duplicate: false, droppedFrames: 0 };
    }
    if (
      (this.snapshot.lifecycle !== 'starting' && this.snapshot.lifecycle !== 'recording') ||
      frame.meetingId !== this.snapshot.meetingId
    ) {
      throw new Error('Live recording is not accepting audio');
    }
    const activatesRecording = this.snapshot.lifecycle === 'starting';
    if (
      activatesRecording &&
      (!frame.pcm.microphone || !frame.pcm.mixed || !frame.meters.microphone)
    ) {
      throw new Error('The first live frame must verify microphone and mixed audio');
    }
    const activationEpochMs = activatesRecording
      ? this.now() - Math.round(frame.meetingTimeMs)
      : null;

    const elapsedMs = this.currentElapsedMs();
    if (frame.meetingTimeMs > elapsedMs + 2_000) {
      throw new Error('Audio frame timestamp is invalid');
    }
    if (frame.pcm.system && !this.snapshot.includeSystemAudio) {
      throw new Error('System audio is not enabled for this meeting');
    }

    const prior = this.sequences.get(frame.captureSessionId);
    if (prior && frame.sequence <= prior.lastSequence) {
      return { accepted: false, duplicate: true, droppedFrames: 0 };
    }
    if (prior && frame.meetingTimeMs + frame.durationMs < prior.lastMeetingTimeMs) {
      throw new Error('Audio frame arrived out of timeline order');
    }

    const sequenceGap = prior ? Math.max(0, frame.sequence - prior.lastSequence - 1) : 0;
    const workletGap = prior
      ? Math.max(0, frame.workletDroppedFrames - prior.workletDroppedFrames)
      : frame.workletDroppedFrames;
    const droppedFrames = Math.max(sequenceGap, workletGap);
    if (droppedFrames > 0) {
      const gapDuration = droppedFrames * frame.durationMs;
      const estimatedStart = prior
        ? prior.lastMeetingTimeMs + prior.lastDurationMs
        : Math.max(0, frame.meetingTimeMs - gapDuration);
      this.snapshot.timelineEvents.push({
        id: this.createId(),
        kind: 'capture_gap',
        startMs: estimatedStart,
        endMs: frame.meetingTimeMs,
        droppedFrames,
      });
    }

    let bytesBySource: Record<LiveAudioSourceKind, number>;
    try {
      bytesBySource = await this.audioStore.appendFrame(frame);
    } catch {
      this.refreshElapsed();
      this.closeOpenPause(this.snapshot.elapsedMs);
      this.clearTimers();
      let recoveredAssets = false;
      try {
        this.snapshot.finalizedAssets = await this.audioStore.finalizeMeeting(
          frame.meetingId,
          'interrupted'
        );
        recoveredAssets = true;
      } catch (finalizeError) {
        this.snapshot.finalizedAssets =
          finalizeError instanceof AudioFinalizeError ? finalizeError.recoveredAssets : [];
      }
      this.setError({
        code: 'AUDIO_ASSET_WRITE_FAILED',
        message: recoveredAssets
          ? 'Obelus stopped recording after a local audio write failed.'
          : 'Obelus stopped recording, and the local audio files need recovery.',
        retryable: !recoveredAssets,
      });
      throw new Error('Unable to write live audio');
    }

    this.sequences.set(frame.captureSessionId, {
      lastSequence: frame.sequence,
      lastMeetingTimeMs: frame.meetingTimeMs,
      lastDurationMs: frame.durationMs,
      workletDroppedFrames: frame.workletDroppedFrames,
    });

    if (activatesRecording) {
      this.snapshot.startedAtEpochMs = activationEpochMs;
      this.snapshot.elapsedMs = Math.round(frame.meetingTimeMs + frame.durationMs);
      this.snapshot.lifecycle = 'recording';
      this.snapshot.sources.microphone.state = 'ready';
      this.snapshot.sources.mixed.state = 'ready';
      if (this.snapshot.includeSystemAudio) this.snapshot.sources.system.state = 'ready';
      this.startTimer();
    }

    for (const source of Object.keys(frame.pcm) as LiveAudioSourceKind[]) {
      const sourceSnapshot = this.snapshot.sources[source];
      sourceSnapshot.state = 'active';
      sourceSnapshot.bytesWritten = bytesBySource[source];
      sourceSnapshot.droppedFrames += droppedFrames;
      const meter = frame.meters[source];
      if (meter) sourceSnapshot.meter = { ...meter };
    }
    this.broadcast(false);
    return { accepted: true, duplicate: false, droppedFrames };
  }

  async pause(senderWebContentsId: number): Promise<LiveCaptureSnapshot> {
    this.assertOwner(senderWebContentsId);
    if (this.snapshot.lifecycle === 'paused') return this.getSnapshot();
    if (this.snapshot.lifecycle !== 'recording') throw new Error('Live meeting is not recording');
    const elapsedMs = this.currentElapsedMs();
    this.snapshot.lifecycle = 'paused';
    this.snapshot.pausedAtMs = elapsedMs;
    this.snapshot.timelineEvents.push({
      id: this.createId(),
      kind: 'pause',
      startMs: elapsedMs,
    });
    this.setSourcesMuted();
    this.broadcast(true);
    return this.getSnapshot();
  }

  async resume(senderWebContentsId: number): Promise<LiveCaptureSnapshot> {
    this.assertOwner(senderWebContentsId);
    if (this.snapshot.lifecycle === 'recording') return this.getSnapshot();
    if (this.snapshot.lifecycle !== 'paused') throw new Error('Live meeting is not paused');
    const elapsedMs = this.currentElapsedMs();
    const openPause = [...this.snapshot.timelineEvents]
      .reverse()
      .find((event) => event.kind === 'pause' && event.endMs === undefined);
    if (openPause) openPause.endMs = elapsedMs;
    this.snapshot.timelineEvents.push({
      id: this.createId(),
      kind: 'resume',
      startMs: elapsedMs,
      endMs: elapsedMs,
    });
    this.snapshot.lifecycle = 'recording';
    this.snapshot.pausedAtMs = null;
    this.snapshot.sources.microphone.state = 'ready';
    this.snapshot.sources.mixed.state = 'ready';
    if (this.snapshot.includeSystemAudio) this.snapshot.sources.system.state = 'ready';
    this.broadcast(true);
    return this.getSnapshot();
  }

  async stop(senderWebContentsId: number): Promise<LiveCaptureSnapshot> {
    this.assertOwner(senderWebContentsId);
    if (this.stopPromise) return await this.stopPromise;
    if (this.snapshot.lifecycle === 'complete') return this.getSnapshot();
    if (this.snapshot.lifecycle === 'error' && this.snapshot.finalizedAssets.length > 0) {
      return this.getSnapshot();
    }
    if (!this.isActive()) throw new Error('No live meeting is active');
    this.stopPromise = this.finalize('complete', 'finalized');
    return await this.stopPromise;
  }

  async ownerDestroyed(ownerWebContentsId: number): Promise<void> {
    if (
      this.snapshot.ownerWebContentsId === ownerWebContentsId &&
      this.isActive() &&
      !this.stopPromise
    ) {
      this.stopPromise = this.finalize('interrupted', 'interrupted');
      await this.stopPromise.catch(() => undefined);
    }
    for (const [meetingId, senderId] of this.meetingOwners) {
      if (senderId === ownerWebContentsId) this.meetingOwners.delete(meetingId);
    }
    if (this.snapshot.ownerWebContentsId === ownerWebContentsId) {
      this.snapshot.ownerWebContentsId = null;
      this.broadcast(true);
    }
  }

  assertMeetingOwner(meetingId: string, senderWebContentsId: number): void {
    const owner = this.meetingOwners.get(meetingId);
    if (owner !== undefined && owner !== senderWebContentsId) {
      throw new Error('Live meeting is owned by another window');
    }
    if (
      this.isActive() &&
      this.snapshot.meetingId === meetingId &&
      this.snapshot.ownerWebContentsId !== senderWebContentsId
    ) {
      throw new Error('Live meeting is owned by another window');
    }
    this.meetingOwners.set(meetingId, senderWebContentsId);
    if (this.snapshot.meetingId === meetingId && this.snapshot.ownerWebContentsId === null) {
      this.snapshot.ownerWebContentsId = senderWebContentsId;
    }
  }

  clearFinalizedMeeting(meetingId: string): void {
    if (this.snapshot.meetingId !== meetingId) return;
    if (this.isActive()) throw new Error('Stop the live meeting before deleting its audio');
    this.clearTimers();
    this.sequences.clear();
    this.stopPromise = null;
    this.meetingOwners.delete(meetingId);
    const remainingRecovered = this.snapshot.recoveredMeetings.filter(
      (meeting) => meeting.meetingId !== meetingId
    );
    this.snapshot = { ...initialSnapshot(), recoveredMeetings: remainingRecovered };
    this.broadcast(true);
  }

  acknowledgeAudioAssetsPersisted(meetingId: string): void {
    const recoveredTarget = this.snapshot.recoveredMeetings.some(
      (meeting) => meeting.meetingId === meetingId
    );
    if (!recoveredTarget) return;
    const recoveredMeetings = this.snapshot.recoveredMeetings.filter(
      (meeting) => meeting.meetingId !== meetingId
    );
    if (!(this.snapshot.meetingId === meetingId && this.isActive())) {
      this.meetingOwners.delete(meetingId);
    }
    if (this.snapshot.meetingId === meetingId && !this.isActive()) {
      this.clearTimers();
      this.sequences.clear();
      this.stopPromise = null;
      this.snapshot = { ...initialSnapshot(), recoveredMeetings };
    } else {
      this.snapshot = { ...this.snapshot, recoveredMeetings };
    }
    this.broadcast(true);
  }

  markSystemSleep(): void {
    if (!this.isActive()) return;
    const elapsedMs = this.currentElapsedMs();
    this.snapshot.timelineEvents.push({
      id: this.createId(),
      kind: 'sleep',
      startMs: elapsedMs,
    });
    this.broadcast(true);
  }

  markSystemResume(): void {
    if (!this.isActive()) return;
    const elapsedMs = this.currentElapsedMs();
    const sleep = [...this.snapshot.timelineEvents]
      .reverse()
      .find((event) => event.kind === 'sleep' && event.endMs === undefined);
    if (sleep) sleep.endMs = elapsedMs;
    this.snapshot.timelineEvents.push({
      id: this.createId(),
      kind: 'wake',
      startMs: elapsedMs,
      endMs: elapsedMs,
    });
    this.broadcast(true);
  }

  private async finalize(
    lifecycle: 'complete' | 'interrupted',
    assetStatus: 'finalized' | 'interrupted'
  ): Promise<LiveCaptureSnapshot> {
    const meetingId = this.snapshot.meetingId;
    if (!meetingId) throw new Error('No live meeting is active');
    this.snapshot.elapsedMs = this.capturedElapsedMs();
    this.snapshot.lifecycle = 'stopping';
    this.closeOpenPause(this.snapshot.elapsedMs);
    this.clearTimers();
    this.setSourcesMuted();
    this.broadcast(true);

    try {
      this.snapshot.finalizedAssets = await this.audioStore.finalizeMeeting(meetingId, assetStatus);
      this.snapshot.elapsedMs = Math.max(
        this.snapshot.elapsedMs,
        ...this.snapshot.finalizedAssets.map((asset) => asset.timelineEndMs)
      );
      this.snapshot.lifecycle = lifecycle;
      this.snapshot.pausedAtMs = null;
      for (const source of Object.values(this.snapshot.sources)) {
        if (source.state !== 'unavailable') source.state = 'ended';
        source.meter = { ...EMPTY_METER };
      }
      this.broadcast(true);
      return this.getSnapshot();
    } catch (error) {
      if (error instanceof AudioFinalizeError) {
        this.snapshot.finalizedAssets = error.recoveredAssets;
      }
      this.setError({
        code: 'AUDIO_ASSET_FINALIZE_FAILED',
        message: 'The meeting stopped, but one or more local audio files need recovery.',
        retryable: true,
      });
      throw new Error('Unable to finalize live audio');
    }
  }

  private isActive(): boolean {
    return ['starting', 'recording', 'paused', 'stopping'].includes(this.snapshot.lifecycle);
  }

  private assertOwner(senderWebContentsId: number): void {
    if (this.snapshot.ownerWebContentsId !== senderWebContentsId) {
      throw new Error('Live meeting is owned by another window');
    }
  }

  private currentElapsedMs(): number {
    return this.snapshot.startedAtEpochMs === null
      ? this.snapshot.elapsedMs
      : Math.max(this.snapshot.elapsedMs, this.now() - this.snapshot.startedAtEpochMs);
  }

  private refreshElapsed(): void {
    if (['starting', 'recording', 'paused'].includes(this.snapshot.lifecycle)) {
      this.snapshot.elapsedMs = this.currentElapsedMs();
    }
  }

  private capturedElapsedMs(): number {
    const capturedEndMs = Math.max(
      0,
      ...[...this.sequences.values()].map(
        (sequence) => sequence.lastMeetingTimeMs + sequence.lastDurationMs
      )
    );
    return capturedEndMs > 0 ? capturedEndMs : this.snapshot.elapsedMs;
  }

  private closeOpenPause(endMs: number): void {
    const openPause = [...this.snapshot.timelineEvents]
      .reverse()
      .find((event) => event.kind === 'pause' && event.endMs === undefined);
    if (openPause) openPause.endMs = endMs;
  }

  private setSourcesMuted(): void {
    for (const source of Object.values(this.snapshot.sources)) {
      if (source.state !== 'unavailable' && source.state !== 'ended') source.state = 'muted';
      source.meter = { ...EMPTY_METER };
    }
  }

  private setError(error: LiveCaptureError): void {
    this.clearTimers();
    this.snapshot.lifecycle = 'error';
    this.snapshot.lastError = error;
    this.setSourcesMuted();
    this.broadcast(true);
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      this.refreshElapsed();
      this.broadcast(true);
    }, 250);
  }

  private clearTimers(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.timer = null;
    this.broadcastTimer = null;
  }

  private broadcast(immediate: boolean): void {
    if (!this.onSnapshot) return;
    const now = this.now();
    if (immediate || now - this.lastBroadcastAt >= 100) {
      if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
      this.lastBroadcastAt = now;
      this.onSnapshot(this.getSnapshot());
      return;
    }
    if (!this.broadcastTimer) {
      this.broadcastTimer = setTimeout(
        () => {
          this.broadcastTimer = null;
          this.lastBroadcastAt = this.now();
          this.onSnapshot?.(this.getSnapshot());
        },
        100 - (now - this.lastBroadcastAt)
      );
    }
  }
}
