import type { LiveAudioSourceKind } from './ipcTypes';
import type { TimedWord } from './types';

export const LOCAL_STT_MODEL = 'base.en' as const;
export const LOCAL_STT_SAMPLE_RATE = 16_000 as const;

export interface LocalSttSupport {
  available: boolean;
  model: typeof LOCAL_STT_MODEL;
  reason?: string;
}

export interface LocalSttStartRequest {
  meetingId: string;
  sourceKind: LiveAudioSourceKind;
  sampleRate: typeof LOCAL_STT_SAMPLE_RATE;
}

export interface LocalSttStartResponse {
  sessionId: string;
  providerSessionId: string;
  model: typeof LOCAL_STT_MODEL;
}

export interface LocalSttAppendRequest {
  meetingId: string;
  sessionId: string;
  sequence: number;
  pcm: ArrayBuffer;
}

export interface LocalSttTurn {
  turnId: string;
  turnOrder: number;
  revision: number;
  durableFinal: boolean;
  utteranceBoundary: boolean;
  text: string;
  words: TimedWord[];
  startMs: number;
  endMs: number;
}

export interface LocalSttAppendResult {
  accepted: boolean;
  droppedFrames: number;
  turns: LocalSttTurn[];
}

export interface LocalSttStopRequest {
  meetingId: string;
  sessionId: string;
}

export interface LocalSttStopResult {
  turns: LocalSttTurn[];
  audioDurationSeconds: number;
}

export interface LocalSttClient {
  getLocalSttSupport(): Promise<LocalSttSupport>;
  startLocalStt(request: LocalSttStartRequest): Promise<LocalSttStartResponse>;
  appendLocalSttAudio(request: LocalSttAppendRequest): Promise<LocalSttAppendResult>;
  stopLocalStt(request: LocalSttStopRequest): Promise<LocalSttStopResult>;
}
