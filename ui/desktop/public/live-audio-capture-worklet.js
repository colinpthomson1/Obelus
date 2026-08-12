const TARGET_SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 1280;

class LiveAudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.includeSystemAudio = options.processorOptions?.includeSystemAudio === true;
    this.resampleRatio = sampleRate / TARGET_SAMPLE_RATE;
    this.resampleCursor = 0;
    this.nativeMicrophone = [];
    this.nativeSystem = [];
    this.outputMicrophone = [];
    this.outputSystem = [];
    this.outputMixed = [];
    this.sequence = 0;
    this.emittedSamples = 0;
    this.droppedFrames = 0;
    this.active = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'activate') {
        this.resampleCursor = 0;
        this.nativeMicrophone.length = 0;
        this.nativeSystem.length = 0;
        this.outputMicrophone.length = 0;
        this.outputSystem.length = 0;
        this.outputMixed.length = 0;
        this.sequence = 0;
        this.emittedSamples = 0;
        this.droppedFrames = 0;
        this.active = true;
        this.port.postMessage({ type: 'activated' });
        return;
      }
      if (event.data?.type === 'flush') {
        this.drainResampler();
        this.emitFrame(true);
        this.port.postMessage({ type: 'flushed', sequence: this.sequence });
      }
    };
  }

  process(inputs, outputs) {
    const microphone = inputs[0]?.[0];
    const system = inputs[1]?.[0];
    const inputLength = Math.max(microphone?.length ?? 0, system?.length ?? 0);
    for (let index = 0; index < inputLength; index += 1) {
      this.nativeMicrophone.push(microphone?.[index] ?? 0);
      this.nativeSystem.push(this.includeSystemAudio ? (system?.[index] ?? 0) : 0);
    }
    this.drainResampler();
    while (this.outputMixed.length >= FRAME_SAMPLES) this.emitFrame(false);

    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    return true;
  }

  drainResampler() {
    while (this.resampleCursor + 1 < this.nativeMicrophone.length) {
      const left = Math.floor(this.resampleCursor);
      const fraction = this.resampleCursor - left;
      const microphone = interpolate(
        this.nativeMicrophone[left],
        this.nativeMicrophone[left + 1],
        fraction
      );
      const system = interpolate(this.nativeSystem[left], this.nativeSystem[left + 1], fraction);
      this.outputMicrophone.push(microphone);
      this.outputSystem.push(system);
      this.outputMixed.push(clamp(microphone + system));
      this.resampleCursor += this.resampleRatio;
    }

    const consumed = Math.min(
      Math.floor(this.resampleCursor),
      Math.max(0, this.nativeMicrophone.length - 1)
    );
    if (consumed > 0) {
      this.nativeMicrophone.splice(0, consumed);
      this.nativeSystem.splice(0, consumed);
      this.resampleCursor -= consumed;
    }
  }

  emitFrame(flush) {
    const sampleCount = flush ? Math.min(FRAME_SAMPLES, this.outputMixed.length) : FRAME_SAMPLES;
    if (sampleCount === 0) return;

    const microphone = this.outputMicrophone.splice(0, sampleCount);
    const system = this.outputSystem.splice(0, sampleCount);
    const mixed = this.outputMixed.splice(0, sampleCount);
    const microphonePcm = pcm16(microphone);
    const systemPcm = pcm16(system);
    const mixedPcm = pcm16(mixed);
    const pcm = {
      microphone: microphonePcm.buffer,
      mixed: mixedPcm.buffer,
    };
    const meters = {
      microphone: meter(microphone),
      mixed: meter(mixed),
    };
    const transfer = [microphonePcm.buffer, mixedPcm.buffer];
    if (this.includeSystemAudio) {
      pcm.system = systemPcm.buffer;
      meters.system = meter(system);
      transfer.push(systemPcm.buffer);
    }

    this.port.postMessage(
      {
        type: 'frame',
        sequence: this.sequence,
        timestampMs: (this.emittedSamples / TARGET_SAMPLE_RATE) * 1000,
        durationMs: (sampleCount / TARGET_SAMPLE_RATE) * 1000,
        sampleRate: TARGET_SAMPLE_RATE,
        channels: 1,
        pcm,
        meters,
        droppedFrames: this.droppedFrames,
        active: this.active,
      },
      transfer
    );
    this.sequence += 1;
    this.emittedSamples += sampleCount;
  }
}

function interpolate(left, right, fraction) {
  return left + (right - left) * fraction;
}

function clamp(value) {
  return Math.max(-1, Math.min(1, value));
}

function pcm16(samples) {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = clamp(samples[index]);
    output[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return output;
}

function meter(samples) {
  if (samples.length === 0) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (const value of samples) {
    const absolute = Math.abs(value);
    peak = Math.max(peak, absolute);
    sum += value * value;
  }
  return { rms: Math.sqrt(sum / samples.length), peak };
}

registerProcessor('obelus-live-audio-capture', LiveAudioCaptureProcessor);
