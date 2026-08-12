import { EventEmitter } from 'node:events';
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, MessagePortMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { LIVE_IPC_CHANNELS, type LiveCaptureSnapshot } from '../ipcTypes';
import { createLiveSelectionRequest, registerLiveIpc } from './registerLiveIpc';

function snapshot(ownerWebContentsId: number | null = null): LiveCaptureSnapshot {
  return {
    lifecycle: ownerWebContentsId === null ? 'idle' : 'starting',
    meetingId: ownerWebContentsId === null ? null : 'meeting_1',
    ownerWebContentsId,
    mode: ownerWebContentsId === null ? null : 'in_person',
    strategy: ownerWebContentsId === null ? null : 'mixed_diarized',
    includeSystemAudio: false,
    startedAtEpochMs: null,
    elapsedMs: 0,
    pausedAtMs: null,
    sources: {
      microphone: {
        state: 'requesting',
        meter: { rms: 0, peak: 0 },
        bytesWritten: 0,
        droppedFrames: 0,
      },
      system: {
        state: 'unavailable',
        meter: { rms: 0, peak: 0 },
        bytesWritten: 0,
        droppedFrames: 0,
      },
      mixed: { state: 'requesting', meter: { rms: 0, peak: 0 }, bytesWritten: 0, droppedFrames: 0 },
    },
    timelineEvents: [],
    finalizedAssets: [],
    recoveredMeetings: [],
    lastError: null,
  };
}

class FakeMessagePort extends EventEmitter {
  readonly postMessage = vi.fn();
  readonly start = vi.fn();
  readonly close = vi.fn();
}

describe('registerLiveIpc', () => {
  it('normalizes and bounds context-menu selections without logging or reshaping them', () => {
    expect(createLiveSelectionRequest('  A selected claim.  ', () => 123)).toStrictEqual({
      text: 'A selected claim.',
      source: 'context-menu',
      capturedAtEpochMs: 123,
    });
    expect(
      createLiveSelectionRequest('A transcript claim.', () => 456, { x: 120, y: 240 })
    ).toStrictEqual({
      text: 'A transcript claim.',
      source: 'context-menu',
      capturedAtEpochMs: 456,
      anchor: { x: 120, y: 240 },
    });
    expect(
      createLiveSelectionRequest('A selected claim.', () => 789, {
        x: Number.NaN,
        y: 240,
      })
    ).not.toHaveProperty('anchor');
    expect(createLiveSelectionRequest('   ')).toBeNull();
    expect(createLiveSelectionRequest('x'.repeat(5_000))?.text).toHaveLength(4_000);
  });

  it('acknowledges only an exact, sender-owned audio manifest', async () => {
    const handles = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel, callback) => handles.set(channel, callback)),
      on: vi.fn(),
    } as unknown as IpcMain;
    const assertMeetingOwner = vi.fn();
    const acknowledgeAudioAssetsPersisted = vi.fn(async () => undefined);
    const acknowledgeRecoveredMeeting = vi.fn();
    registerLiveIpc({
      ipcMain,
      coordinator: {
        getSnapshot: () => snapshot(),
        assertMeetingOwner,
        acknowledgeAudioAssetsPersisted: acknowledgeRecoveredMeeting,
      } as never,
      gateway: {} as never,
      audioStore: { acknowledgeAudioAssetsPersisted } as never,
      sender: { isKnownWebContents: () => true, isTrustedUrl: () => true },
      getSupportStatus: vi.fn(),
      openExternalSource: vi.fn(),
      getAudioPlaybackUrl: vi.fn(),
    });
    const frame = { url: 'http://localhost:5173/#/live' };
    const event = {
      sender: { id: 7, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    const acknowledgement = {
      meetingId: 'meeting_1',
      assets: [
        {
          assetId: '00000000-0000-5000-8000-000000000001',
          checksumSha256: 'a'.repeat(64),
        },
      ],
    };

    await expect(
      handles.get(LIVE_IPC_CHANNELS.acknowledgeAudioAssetsPersisted)?.(event, acknowledgement)
    ).resolves.toBeUndefined();
    expect(assertMeetingOwner).toHaveBeenCalledWith('meeting_1', 7);
    expect(acknowledgeAudioAssetsPersisted).toHaveBeenCalledWith(acknowledgement);
    expect(acknowledgeRecoveredMeeting).toHaveBeenCalledWith('meeting_1');

    acknowledgeAudioAssetsPersisted.mockClear();
    acknowledgeRecoveredMeeting.mockClear();
    await expect(
      handles.get(LIVE_IPC_CHANNELS.acknowledgeAudioAssetsPersisted)?.(event, {
        ...acknowledgement,
        assets: [{ ...acknowledgement.assets[0], checksumSha256: 'not-a-checksum' }],
      })
    ).rejects.toThrow('checksum is invalid');
    expect(acknowledgeAudioAssetsPersisted).not.toHaveBeenCalled();
    expect(acknowledgeRecoveredMeeting).not.toHaveBeenCalled();

    acknowledgeAudioAssetsPersisted.mockRejectedValueOnce(new Error('manifest mismatch'));
    await expect(
      handles.get(LIVE_IPC_CHANNELS.acknowledgeAudioAssetsPersisted)?.(event, acknowledgement)
    ).rejects.toThrow('manifest mismatch');
    expect(acknowledgeRecoveredMeeting).not.toHaveBeenCalled();
  });

  it('acks bounded audio frames over a sender-validated MessagePort and releases it', async () => {
    const handles = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const listeners = new Map<string, (event: IpcMainEvent) => void>();
    const ipcMain = {
      handle: vi.fn((channel, callback) => handles.set(channel, callback)),
      on: vi.fn((channel, callback) => listeners.set(channel, callback)),
    } as unknown as IpcMain;
    const appendAudio = vi.fn(async () => ({ accepted: true, duplicate: false, droppedFrames: 0 }));
    let currentSnapshot = snapshot();
    const coordinator = {
      getSnapshot: vi.fn(() => currentSnapshot),
      start: vi.fn(async () => {
        currentSnapshot = snapshot(7);
        return currentSnapshot;
      }),
      appendAudio,
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      assertMeetingOwner: vi.fn(),
      clearFinalizedMeeting: vi.fn(),
    };
    const registration = registerLiveIpc({
      ipcMain,
      coordinator: coordinator as never,
      gateway: {} as never,
      audioStore: {} as never,
      sender: { isKnownWebContents: () => true, isTrustedUrl: () => true },
      getSupportStatus: vi.fn(),
      openExternalSource: vi.fn(),
      getAudioPlaybackUrl: vi.fn(),
    });
    const frame = { url: 'http://localhost:5173/#/live' };
    const sender = { id: 7, mainFrame: frame };
    const port = new FakeMessagePort();
    listeners.get(LIVE_IPC_CHANNELS.audioPort)?.({
      sender,
      senderFrame: frame,
      ports: [port as unknown as MessagePortMain],
    } as unknown as IpcMainEvent);
    await handles.get(LIVE_IPC_CHANNELS.start)?.(
      { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
      {
        meetingId: 'meeting_1',
        mode: 'in_person',
        strategy: 'mixed_diarized',
        includeSystemAudio: false,
      }
    );

    const audioFrame = {
      meetingId: 'meeting_1',
      captureSessionId: 'capture_1',
      sequence: 0,
      meetingTimeMs: 0,
      durationMs: 80,
      sampleRate: 16000,
      channels: 1,
      pcm: {
        microphone: new ArrayBuffer(2_560),
        mixed: new ArrayBuffer(2_560),
      },
      meters: {
        microphone: { rms: 0, peak: 0 },
        mixed: { rms: 0, peak: 0 },
      },
      workletDroppedFrames: 0,
    };
    port.emit('message', { data: { requestId: 1, frame: audioFrame } });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
    expect(appendAudio).toHaveBeenCalledWith(expect.objectContaining(audioFrame), 7);
    expect(port.postMessage).toHaveBeenCalledWith({
      requestId: 1,
      ok: true,
      result: { accepted: true, duplicate: false, droppedFrames: 0 },
    });

    const reconnectedPort = new FakeMessagePort();
    listeners.get(LIVE_IPC_CHANNELS.audioPort)?.({
      sender,
      senderFrame: frame,
      ports: [reconnectedPort as unknown as MessagePortMain],
    } as unknown as IpcMainEvent);
    expect(port.close).toHaveBeenCalledOnce();
    reconnectedPort.emit('message', {
      data: { requestId: 2, frame: { ...audioFrame, sequence: 1, meetingTimeMs: 80 } },
    });
    await vi.waitFor(() => expect(reconnectedPort.postMessage).toHaveBeenCalledTimes(1));
    expect(appendAudio).toHaveBeenLastCalledWith(
      expect.objectContaining({ sequence: 1, meetingTimeMs: 80 }),
      7
    );
    expect(reconnectedPort.postMessage).toHaveBeenCalledWith({
      requestId: 2,
      ok: true,
      result: { accepted: true, duplicate: false, droppedFrames: 0 },
    });

    await registration.releaseSender(7);
    expect(reconnectedPort.close).toHaveBeenCalledOnce();
  });

  it('scopes local transcription sessions to their meeting and renderer owner', async () => {
    const handles = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel, callback) => handles.set(channel, callback)),
      on: vi.fn(),
    } as unknown as IpcMain;
    const assertMeetingOwner = vi.fn();
    const startSession = vi.fn(async () => ({
      sessionId: 'local_session_1',
      providerSessionId: 'local-provider-session-1',
      model: 'base.en' as const,
    }));
    const appendAudio = vi.fn(async () => ({
      accepted: true,
      droppedFrames: 0,
      turns: [],
    }));
    const stopSession = vi.fn(async () => ({ turns: [], audioDurationSeconds: 0.08 }));
    registerLiveIpc({
      ipcMain,
      coordinator: {
        getSnapshot: () => snapshot(7),
        assertMeetingOwner,
      } as never,
      gateway: {} as never,
      localStt: {
        checkSupport: vi.fn(async () => ({ available: true, model: 'base.en' as const })),
        startSession,
        appendAudio,
        stopSession,
        releaseMeeting: vi.fn(async () => undefined),
      },
      audioStore: {} as never,
      sender: { isKnownWebContents: () => true, isTrustedUrl: () => true },
      getSupportStatus: vi.fn(),
      openExternalSource: vi.fn(),
      getAudioPlaybackUrl: vi.fn(),
    });
    const frame7 = { url: 'http://localhost:5173/#/live' };
    const event7 = {
      sender: { id: 7, mainFrame: frame7 },
      senderFrame: frame7,
    } as unknown as IpcMainInvokeEvent;
    const frame8 = { url: 'http://localhost:5173/#/live' };
    const event8 = {
      sender: { id: 8, mainFrame: frame8 },
      senderFrame: frame8,
    } as unknown as IpcMainInvokeEvent;

    await handles.get(LIVE_IPC_CHANNELS.startLocalStt)?.(event7, {
      meetingId: 'meeting_1',
      sourceKind: 'mixed',
      sampleRate: 16_000,
    });
    const audioRequest = {
      meetingId: 'meeting_1',
      sessionId: 'local_session_1',
      sequence: 0,
      pcm: new ArrayBuffer(2_560),
    };
    await handles.get(LIVE_IPC_CHANNELS.appendLocalSttAudio)?.(event7, audioRequest);
    await expect(
      handles.get(LIVE_IPC_CHANNELS.appendLocalSttAudio)?.(event8, audioRequest)
    ).rejects.toThrow('Local transcription session is not owned');
    await handles.get(LIVE_IPC_CHANNELS.stopLocalStt)?.(event7, {
      meetingId: 'meeting_1',
      sessionId: 'local_session_1',
    });

    expect(startSession).toHaveBeenCalledWith({
      meetingId: 'meeting_1',
      sourceKind: 'mixed',
      sampleRate: 16_000,
    });
    expect(appendAudio).toHaveBeenCalledWith(audioRequest);
    expect(stopSession).toHaveBeenCalledWith({
      meetingId: 'meeting_1',
      sessionId: 'local_session_1',
    });
  });

  it('forwards validated manual claim-detection intent and exact selection', async () => {
    const handles = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel, callback) => handles.set(channel, callback)),
      on: vi.fn(),
    } as unknown as IpcMain;
    const submitClaimDetection = vi.fn(async () => ({ candidates: [], catchingUp: false }));
    const localDetection = vi.fn();
    const assertMeetingOwner = vi.fn();
    registerLiveIpc({
      ipcMain,
      coordinator: {
        getSnapshot: vi.fn(() => snapshot()),
        assertMeetingOwner,
      } as never,
      gateway: { submitClaimDetection } as never,
      localFactCheck: {
        factCheckMode: 'subscription_web',
        detectClaims: localDetection,
      } as never,
      audioStore: {} as never,
      sender: { isKnownWebContents: () => true, isTrustedUrl: () => true },
      getSupportStatus: vi.fn(),
      openExternalSource: vi.fn(),
      getAudioPlaybackUrl: vi.fn(),
    });
    const frame = { url: 'http://localhost:5173/#/live' };
    const event = {
      sender: { id: 7, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    const request = {
      meetingId: 'meeting_1',
      idempotencyKey: 'manual-claim-request-1',
      turns: [{ id: 'turn_1', speakerId: null, startMs: 0, endMs: 100, text: 'Context' }],
      existingClaimKeys: [],
      manual: true,
      manualSelection: 'Selected claim',
    };

    await handles.get(LIVE_IPC_CHANNELS.submitClaimDetection)?.(event, request);

    expect(assertMeetingOwner).toHaveBeenCalledWith('meeting_1', 7);
    expect(submitClaimDetection).toHaveBeenCalledWith(request);
    expect(localDetection).not.toHaveBeenCalled();
  });

  it('routes automatic claim detection through the configured ChatGPT subscription service', async () => {
    const handles = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel, callback) => handles.set(channel, callback)),
      on: vi.fn(),
    } as unknown as IpcMain;
    const gatewayDetection = vi.fn();
    const localDetection = vi.fn(async () => ({
      candidates: [{ exactQuote: 'Night is light and day is dark.' }],
      catchingUp: false,
    }));
    registerLiveIpc({
      ipcMain,
      coordinator: {
        getSnapshot: vi.fn(() => snapshot(7)),
        assertMeetingOwner: vi.fn(),
      } as never,
      gateway: { submitClaimDetection: gatewayDetection } as never,
      localFactCheck: {
        factCheckMode: 'subscription_web',
        detectClaims: localDetection,
      } as never,
      audioStore: {} as never,
      sender: { isKnownWebContents: () => true, isTrustedUrl: () => true },
      getSupportStatus: vi.fn(),
      openExternalSource: vi.fn(),
      getAudioPlaybackUrl: vi.fn(),
    });
    const frame = { url: 'http://localhost:5173/#/live' };
    const event = {
      sender: { id: 7, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    const request = {
      meetingId: 'meeting_1',
      idempotencyKey: 'automatic-claim-request-1',
      turns: [
        {
          id: 'turn_3',
          speakerId: null,
          startMs: 4_000,
          endMs: 6_000,
          text: 'and day is dark.',
        },
      ],
      contextTurns: [
        {
          id: 'turn_1',
          speakerId: null,
          startMs: 0,
          endMs: 2_000,
          text: 'The difference between night and day',
        },
        {
          id: 'turn_2',
          speakerId: null,
          startMs: 1_900,
          endMs: 4_100,
          text: 'is that night is light and',
        },
        {
          id: 'turn_3',
          speakerId: null,
          startMs: 4_000,
          endMs: 6_000,
          text: 'and day is dark.',
        },
      ],
      requiredTurnIds: ['turn_3'],
      existingClaimKeys: [],
    };

    await expect(
      handles.get(LIVE_IPC_CHANNELS.submitClaimDetection)?.(event, request)
    ).resolves.toMatchObject({
      candidates: [expect.objectContaining({ exactQuote: expect.any(String) })],
    });

    expect(localDetection).toHaveBeenCalledWith(request, true);
    expect(gatewayDetection).not.toHaveBeenCalled();
  });

  it('releases durable job ownership when its validated window is destroyed', async () => {
    const handles = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel, callback) => handles.set(channel, callback)),
      on: vi.fn(),
    } as unknown as IpcMain;
    const assertMeetingOwner = vi.fn();
    const pollFactCheck = vi.fn(async (jobId: string) => ({
      jobId,
      status: 'complete' as const,
      result: null,
    }));
    const registration = registerLiveIpc({
      ipcMain,
      coordinator: {
        getSnapshot: () => snapshot(),
        assertMeetingOwner,
      } as never,
      gateway: {
        submitFactCheck: vi.fn(async () => ({ jobId: 'job_1', status: 'pending' as const })),
        pollFactCheck,
      } as never,
      audioStore: {} as never,
      sender: { isKnownWebContents: () => true, isTrustedUrl: () => true },
      getSupportStatus: vi.fn(),
      openExternalSource: vi.fn(),
      getAudioPlaybackUrl: vi.fn(),
    });
    const frame7 = { url: 'http://localhost:5173/#/live' };
    const event7 = {
      sender: { id: 7, mainFrame: frame7 },
      senderFrame: frame7,
    } as unknown as IpcMainInvokeEvent;
    const frame8 = { url: 'http://localhost:5173/#/live' };
    const event8 = {
      sender: { id: 8, mainFrame: frame8 },
      senderFrame: frame8,
    } as unknown as IpcMainInvokeEvent;
    await handles.get(LIVE_IPC_CHANNELS.submitFactCheck)?.(event7, 'quick', {
      meetingId: 'meeting_1',
      claimId: 'claim_1',
      claimVersionId: 'version_1',
      idempotencyKey: 'fact-check-request-1',
      exactQuote: 'A claim',
      normalizedClaim: 'A claim',
      contextTurns: [{ id: 'turn_1', speakerId: null, startMs: 0, endMs: 80, text: 'A claim' }],
      origin: 'manual',
    });
    await expect(
      handles.get(LIVE_IPC_CHANNELS.pollFactCheck)?.(event8, 'meeting_1', 'job_1')
    ).rejects.toThrow('another meeting or window');

    await registration.releaseSender(7);
    await expect(
      handles.get(LIVE_IPC_CHANNELS.pollFactCheck)?.(event8, 'meeting_1', 'job_1')
    ).resolves.toMatchObject({ jobId: 'job_1', status: 'complete' });
    expect(assertMeetingOwner).toHaveBeenCalledWith('meeting_1', 7);
  });

  it('routes local jobs to the configured service and always attempts their deletion', async () => {
    const handles = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel, callback) => handles.set(channel, callback)),
      on: vi.fn(),
    } as unknown as IpcMain;
    const localJobId = `local-fact-${'a'.repeat(40)}`;
    const submitFactCheck = vi.fn(async () => ({
      jobId: localJobId,
      status: 'pending' as const,
    }));
    const pollFactCheck = vi.fn(async (_meetingId: string, jobId: string) => ({
      jobId,
      status: 'complete' as const,
      result: null,
    }));
    const releaseMeeting = vi.fn(async () => undefined);
    const gatewaySubmit = vi.fn();
    const gatewayPoll = vi.fn();
    const gatewayDelete = vi.fn();
    const deleteMeetingAssets = vi.fn(async () => undefined);
    const clearFinalizedMeeting = vi.fn();
    registerLiveIpc({
      ipcMain,
      coordinator: {
        getSnapshot: () => snapshot(),
        assertMeetingOwner: vi.fn(),
        clearFinalizedMeeting,
      } as never,
      gateway: {
        submitFactCheck: gatewaySubmit,
        pollFactCheck: gatewayPoll,
        deleteRemoteMeeting: gatewayDelete,
      } as never,
      localFactCheck: {
        factCheckMode: 'subscription_web',
        checkSupport: vi.fn(),
        submitFactCheck,
        pollFactCheck,
        releaseMeeting,
      } as never,
      audioStore: { deleteMeetingAssets } as never,
      sender: { isKnownWebContents: () => true, isTrustedUrl: () => true },
      getSupportStatus: vi.fn(),
      openExternalSource: vi.fn(),
      getAudioPlaybackUrl: vi.fn(),
    });
    const frame = { url: 'http://localhost:5173/#/live' };
    const event = {
      sender: { id: 7, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    const factCheckRequest = {
      meetingId: 'meeting_1',
      claimId: 'claim_1',
      claimVersionId: 'version_1',
      idempotencyKey: 'fact-check-request-1',
      exactQuote: 'A claim',
      normalizedClaim: 'A claim',
      contextTurns: [{ id: 'turn_1', speakerId: null, startMs: 0, endMs: 80, text: 'A claim' }],
      origin: 'manual',
    };

    await expect(
      handles.get(LIVE_IPC_CHANNELS.submitFactCheck)?.(event, 'quick', factCheckRequest)
    ).resolves.toMatchObject({ jobId: localJobId });
    await expect(
      handles.get(LIVE_IPC_CHANNELS.pollFactCheck)?.(event, 'meeting_1', localJobId)
    ).resolves.toMatchObject({ status: 'complete' });
    await expect(
      handles.get(LIVE_IPC_CHANNELS.deleteRemoteMeeting)?.(event, 'meeting_1')
    ).resolves.toEqual({
      meetingId: 'meeting_1',
      status: 'partial',
      gatewayCleanup: 'complete',
      providerCleanup: 'unsupported',
      limitation:
        'ChatGPT does not expose per-operation deletion for claim identification or fact-checking through this subscription session; provider retention follows the signed-in ChatGPT workspace policy. Local deletion is reported separately.',
    });
    await handles.get(LIVE_IPC_CHANNELS.deleteLocalMeetingAssets)?.(event, 'meeting_1');

    expect(submitFactCheck).toHaveBeenCalledWith('quick', factCheckRequest);
    expect(pollFactCheck).toHaveBeenCalledWith('meeting_1', localJobId);
    expect(gatewaySubmit).not.toHaveBeenCalled();
    expect(gatewayPoll).not.toHaveBeenCalled();
    expect(gatewayDelete).not.toHaveBeenCalled();
    expect(releaseMeeting).toHaveBeenCalledWith('meeting_1');
    expect(deleteMeetingAssets).toHaveBeenCalledWith('meeting_1');
    expect(clearFinalizedMeeting).toHaveBeenCalledWith('meeting_1');

    releaseMeeting.mockClear();
    clearFinalizedMeeting.mockClear();
    deleteMeetingAssets.mockRejectedValueOnce(new Error('audio cleanup failed'));
    await expect(
      handles.get(LIVE_IPC_CHANNELS.deleteLocalMeetingAssets)?.(event, 'meeting_1')
    ).resolves.toEqual({
      status: 'failed',
      error: 'Obelus could not remove one or more local meeting files.',
    });
    expect(releaseMeeting).toHaveBeenCalledWith('meeting_1');
    expect(clearFinalizedMeeting).not.toHaveBeenCalled();
  });

  it('uses direct fallback only when hosted submission fails before accepting a check ID', async () => {
    const handles = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel, callback) => handles.set(channel, callback)),
      on: vi.fn(),
    } as unknown as IpcMain;
    const localJobId = `local-fact-${'b'.repeat(40)}`;
    const gatewaySubmit = vi.fn();
    const localSubmit = vi.fn(async () => ({ jobId: localJobId, status: 'pending' as const }));
    registerLiveIpc({
      ipcMain,
      coordinator: {
        getSnapshot: () => snapshot(7),
        assertMeetingOwner: vi.fn(),
      } as never,
      gateway: {
        checkHealth: vi.fn(async () => ({ available: false, reason: 'Gateway unavailable' })),
        submitFactCheck: gatewaySubmit,
      } as never,
      localFactCheck: {
        factCheckMode: 'subscription_web',
        submitFactCheck: localSubmit,
      } as never,
      factCheckRouting: { preferred: 'hosted', allowDirectFallback: true },
      audioStore: {} as never,
      sender: { isKnownWebContents: () => true, isTrustedUrl: () => true },
      getSupportStatus: vi.fn(),
      openExternalSource: vi.fn(),
      getAudioPlaybackUrl: vi.fn(),
    });
    const frame = { url: 'http://localhost:5173/#/live' };
    const event = {
      sender: { id: 7, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    const request = {
      meetingId: 'meeting_1',
      claimId: 'claim_1',
      claimVersionId: 'version_1',
      idempotencyKey: 'fact-check-request-1',
      exactQuote: 'A claim',
      normalizedClaim: 'A claim',
      contextTurns: [],
      origin: 'manual',
    };

    await expect(
      handles.get(LIVE_IPC_CHANNELS.submitFactCheck)?.(event, 'quick', request)
    ).resolves.toMatchObject({ jobId: localJobId });
    expect(gatewaySubmit).not.toHaveBeenCalled();
    expect(localSubmit).toHaveBeenCalledOnce();
  });

  it('keeps an accepted hosted ID on the gateway and escalates that same check', async () => {
    const handles = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel, callback) => handles.set(channel, callback)),
      on: vi.fn(),
    } as unknown as IpcMain;
    const gatewaySubmit = vi.fn(async () => ({ jobId: 'check_1', status: 'pending' as const }));
    const gatewayPoll = vi.fn(async () => {
      throw new Error('temporary poll failure');
    });
    const gatewayEscalate = vi.fn(async () => ({
      jobId: 'check_1',
      status: 'pending' as const,
    }));
    const localSubmit = vi.fn();
    const localPoll = vi.fn();
    registerLiveIpc({
      ipcMain,
      coordinator: {
        getSnapshot: () => snapshot(7),
        assertMeetingOwner: vi.fn(),
      } as never,
      gateway: {
        checkHealth: vi.fn(async () => ({ available: true })),
        submitFactCheck: gatewaySubmit,
        pollFactCheck: gatewayPoll,
        escalateFactCheck: gatewayEscalate,
      } as never,
      localFactCheck: {
        factCheckMode: 'subscription_web',
        submitFactCheck: localSubmit,
        pollFactCheck: localPoll,
      } as never,
      factCheckRouting: { preferred: 'hosted', allowDirectFallback: true },
      audioStore: {} as never,
      sender: { isKnownWebContents: () => true, isTrustedUrl: () => true },
      getSupportStatus: vi.fn(),
      openExternalSource: vi.fn(),
      getAudioPlaybackUrl: vi.fn(),
    });
    const frame = { url: 'http://localhost:5173/#/live' };
    const event = {
      sender: { id: 7, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
    const request = {
      meetingId: 'meeting_1',
      claimId: 'claim_1',
      claimVersionId: 'version_1',
      idempotencyKey: 'fact-check-request-1',
      exactQuote: 'A claim',
      normalizedClaim: 'A claim',
      contextTurns: [],
      origin: 'manual',
    };

    await handles.get(LIVE_IPC_CHANNELS.submitFactCheck)?.(event, 'quick', request);
    await expect(
      handles.get(LIVE_IPC_CHANNELS.pollFactCheck)?.(event, 'meeting_1', 'check_1', 'quick')
    ).rejects.toThrow('temporary poll failure');
    await expect(
      handles.get(LIVE_IPC_CHANNELS.escalateFactCheck)?.(
        event,
        'meeting_1',
        'check_1',
        'deep-request-1',
        'policy',
        ['What remains unresolved?']
      )
    ).resolves.toMatchObject({ jobId: 'check_1' });

    expect(localSubmit).not.toHaveBeenCalled();
    expect(localPoll).not.toHaveBeenCalled();
    expect(gatewayPoll).toHaveBeenCalledWith('check_1', 'quick');
    expect(gatewayEscalate).toHaveBeenCalledWith('check_1', 'deep-request-1', 'policy', [
      'What remains unresolved?',
    ]);
  });

  it('rehydrates persisted job ownership from its meeting after a main-process restart', async () => {
    const handles = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel, callback) => handles.set(channel, callback)),
      on: vi.fn(),
    } as unknown as IpcMain;
    const assertMeetingOwner = vi.fn();
    const pollFactCheck = vi.fn(async (jobId: string) => ({
      jobId,
      status: 'complete' as const,
      result: null,
    }));
    registerLiveIpc({
      ipcMain,
      coordinator: {
        getSnapshot: () => snapshot(),
        assertMeetingOwner,
      } as never,
      gateway: { pollFactCheck } as never,
      audioStore: {} as never,
      sender: { isKnownWebContents: () => true, isTrustedUrl: () => true },
      getSupportStatus: vi.fn(),
      openExternalSource: vi.fn(),
      getAudioPlaybackUrl: vi.fn(),
    });
    const frame = { url: 'http://localhost:5173/#/live' };
    const event = {
      sender: { id: 9, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;

    await expect(
      handles.get(LIVE_IPC_CHANNELS.pollFactCheck)?.(event, 'meeting_1', 'persisted_job_1')
    ).resolves.toMatchObject({ jobId: 'persisted_job_1', status: 'complete' });
    expect(assertMeetingOwner).toHaveBeenCalledWith('meeting_1', 9);
    expect(pollFactCheck).toHaveBeenCalledWith('persisted_job_1', 'quick');
  });
});
