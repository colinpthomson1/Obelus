import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface WorkletHarness {
  active: boolean;
  sequence: number;
  emittedSamples: number;
  droppedFrames: number;
  resampleCursor: number;
  nativeMicrophone: number[];
  nativeSystem: number[];
  outputMicrophone: number[];
  outputSystem: number[];
  outputMixed: number[];
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  emitFrame(flush: boolean): void;
  port: {
    onmessage?: (event: { data: { type: string } }) => void;
    postMessage(message: Record<string, unknown>): void;
  };
}

describe('live audio capture worklet', () => {
  it('atomically resets the recording clock and buffers at activation', async () => {
    const source = await readFile(
      path.join(process.cwd(), 'public', 'live-audio-capture-worklet.js'),
      'utf8'
    );
    const posted: Record<string, unknown>[] = [];
    let Processor: (new (options: unknown) => WorkletHarness) | undefined;
    class AudioWorkletProcessorHarness {
      readonly port = {
        onmessage: undefined as WorkletHarness['port']['onmessage'],
        postMessage: (message: Record<string, unknown>) => posted.push(message),
      };
    }
    runInNewContext(source, {
      sampleRate: 48_000,
      AudioWorkletProcessor: AudioWorkletProcessorHarness,
      registerProcessor: (name: string, constructor: new (options: unknown) => WorkletHarness) => {
        expect(name).toBe('obelus-live-audio-capture');
        Processor = constructor;
      },
    });
    if (!Processor) throw new Error('Worklet processor was not registered');
    const processor = new Processor({ processorOptions: { includeSystemAudio: true } });
    processor.nativeMicrophone.push(1, 2);
    processor.nativeSystem.push(1, 2);
    processor.outputMicrophone.push(1);
    processor.outputSystem.push(1);
    processor.outputMixed.push(1);
    processor.sequence = 12;
    processor.emittedSamples = 15_360;
    processor.droppedFrames = 3;
    processor.resampleCursor = 0.5;

    processor.port.onmessage?.({ data: { type: 'activate' } });

    expect(processor).toMatchObject({
      active: true,
      sequence: 0,
      emittedSamples: 0,
      droppedFrames: 0,
      resampleCursor: 0,
      nativeMicrophone: [],
      nativeSystem: [],
      outputMicrophone: [],
      outputSystem: [],
      outputMixed: [],
    });
    expect(posted[posted.length - 1]).toEqual({ type: 'activated' });

    processor.outputMicrophone.push(...new Array(1_280).fill(0));
    processor.outputSystem.push(...new Array(1_280).fill(0));
    processor.outputMixed.push(...new Array(1_280).fill(0));
    processor.emitFrame(false);
    expect(posted[posted.length - 1]).toMatchObject({
      type: 'frame',
      sequence: 0,
      timestampMs: 0,
      durationMs: 80,
      active: true,
    });
    const pcm = posted[posted.length - 1].pcm as Record<string, ArrayBuffer>;
    expect(pcm.microphone.byteLength).toBe(2_560);
    expect(pcm.system.byteLength).toBe(2_560);
    expect(pcm.mixed.byteLength).toBe(2_560);
  });

  it.each([44_100, 48_000])(
    'preserves the exact 16 kHz duration when resampling %i Hz input across worklet quanta',
    async (nativeSampleRate) => {
      const source = await readFile(
        path.join(process.cwd(), 'public', 'live-audio-capture-worklet.js'),
        'utf8'
      );
      let Processor: (new (options: unknown) => WorkletHarness) | undefined;
      class AudioWorkletProcessorHarness {
        readonly port = {
          onmessage: undefined as WorkletHarness['port']['onmessage'],
          postMessage: () => undefined,
        };
      }
      runInNewContext(source, {
        sampleRate: nativeSampleRate,
        AudioWorkletProcessor: AudioWorkletProcessorHarness,
        registerProcessor: (
          _name: string,
          constructor: new (options: unknown) => WorkletHarness
        ) => {
          Processor = constructor;
        },
      });
      if (!Processor) throw new Error('Worklet processor was not registered');
      const processor = new Processor({ processorOptions: { includeSystemAudio: false } });
      processor.port.onmessage?.({ data: { type: 'activate' } });

      let remaining = nativeSampleRate * 10;
      while (remaining > 0) {
        const sampleCount = Math.min(128, remaining);
        processor.process([[new Float32Array(sampleCount)]], [[new Float32Array(sampleCount)]]);
        remaining -= sampleCount;
      }
      processor.port.onmessage?.({ data: { type: 'flush' } });

      expect(processor.emittedSamples).toBeGreaterThanOrEqual(159_999);
      expect(processor.emittedSamples).toBeLessThanOrEqual(160_000);
    }
  );
});
