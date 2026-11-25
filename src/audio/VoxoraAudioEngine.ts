import {
  DEFAULT_MASTER_SETTINGS,
  DEFAULT_VOCAL_SETTINGS,
  MasterSettings,
  VocalSettings,
  getScaleMask,
} from './constants';
import { renderMultiTrackOffline } from './OfflineDspRenderer';

export type VocalSourceMode = 'mic' | 'synth';

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

export interface StudioTrack {
  id: string;
  name: string;
  isVocal: boolean;
  fxEnabled: boolean;
  buffer: AudioBuffer;
  durationSec: number;
  peaks: number[];
  volume: number; // 0..1.5
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  offsetMs: number; // -500..500
}

export interface ExportedMix {
  id: string;
  name: string;
  formatLabel: string;
  blob: Blob;
  url: string;
  durationSec: number;
  sizeBytes: number;
  createdAt: Date;
}

export interface TelemetryData {
  det: number;
  cor: number;
  voiced: boolean;
  inLevel: number;
  outLevel: number;
  lufs: number;
  grDb: number;
  sampleRate: number;
  latencyMs: number;
}

interface ActiveNodeGraph {
  source: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  vocalWorklet?: AudioWorkletNode;
}

const HISTORY_LEN = 220;

export class VoxoraAudioEngine {
  private ctx: AudioContext | null = null;
  private vocalWorklet: AudioWorkletNode | null = null;
  private masterWorklet: AudioWorkletNode | null = null;
  private inputGain: GainNode | null = null;
  private monitorGain: GainNode | null = null;
  private tracksMixBus: GainNode | null = null;

  // Live vocal source
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private synthStopFn: (() => void) | null = null;
  private sourceMode: VocalSourceMode = 'mic';
  private selectedDeviceId = '';

  // Multi-track unlimited list & active playback nodes
  private tracks: StudioTrack[] = [];
  private activeNodes: Map<string, ActiveNodeGraph> = new Map();
  private isPlaying = false;
  private playStartCtxTime = 0;
  private playheadOffsetSec = 0;

  // Live recording chunks (raw mic buffer -> becomes a StudioTrack on timeline!)
  private recChunks: Float32Array[] = [];
  private recTotalSamples = 0;
  private isRecording = false;
  private recStartSec = 0;

  // Settings
  private vocalSettings: VocalSettings = { ...DEFAULT_VOCAL_SETTINGS };
  private masterSettings: MasterSettings = { ...DEFAULT_MASTER_SETTINGS };
  private monitorEnabled = true;

  // 60fps canvas ring buffers
  public readonly detHistory = new Float32Array(HISTORY_LEN);
  public readonly corHistory = new Float32Array(HISTORY_LEN);
  public historyWriteIdx = 0;
  public latestTelemetry: TelemetryData = {
    det: 0,
    cor: 0,
    voiced: false,
    inLevel: 0,
    outLevel: 0,
    lufs: -70,
    grDb: 0,
    sampleRate: 48000,
    latencyMs: 0,
  };

  private onTelemetryCb: ((t: TelemetryData) => void) | null = null;
  private lastUiEmit = 0;

  public setTelemetryCallback(cb: (t: TelemetryData) => void) {
    this.onTelemetryCb = cb;
  }

  public async enumerateInputs(): Promise<AudioInputDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const list = await navigator.mediaDevices.enumerateDevices();
    return list
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Microphone ${i + 1}`,
      }));
  }

  public async ensureReady(mode: VocalSourceMode = this.sourceMode, deviceId?: string): Promise<{
    ok: boolean;
    error?: string;
    sampleRate: number;
    latencyMs: number;
  }> {
    this.sourceMode = mode;
    if (deviceId !== undefined) this.selectedDeviceId = deviceId;

    try {
      if (!this.ctx) {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new AudioCtx({ latencyHint: 'interactive' });
      }
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }

      if (!this.vocalWorklet || !this.masterWorklet) {
        await Promise.all([
          this.ctx.audioWorklet.addModule('/worklets/voxora-processor.js'),
          this.ctx.audioWorklet.addModule('/worklets/voxora-master-processor.js'),
        ]);

        this.inputGain = this.ctx.createGain();
        this.monitorGain = this.ctx.createGain();
        this.monitorGain.gain.value = this.monitorEnabled ? 1 : 0;
        this.tracksMixBus = this.ctx.createGain();

        this.vocalWorklet = new AudioWorkletNode(this.ctx, 'voxora-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });

        this.masterWorklet = new AudioWorkletNode(this.ctx, 'voxora-master-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });

        this.inputGain.connect(this.vocalWorklet);
        this.vocalWorklet.connect(this.monitorGain);
        this.monitorGain.connect(this.masterWorklet);
        this.tracksMixBus.connect(this.masterWorklet);
        this.masterWorklet.connect(this.ctx.destination);

        this.vocalWorklet.port.onmessage = (ev) => this.onVocalMsg(ev.data);
        this.masterWorklet.port.onmessage = (ev) => this.onMasterMsg(ev.data);
      }

      this.pushVocalSettings();
      this.pushMasterSettings();

      await this.connectSource(mode, this.selectedDeviceId);

      const baseLat = this.ctx.baseLatency ?? 0;
      const outLat = (this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
      const latencyMs = Math.round((baseLat + outLat) * 1000 + 20);
      this.latestTelemetry.sampleRate = this.ctx.sampleRate;
      this.latestTelemetry.latencyMs = latencyMs;

      return { ok: true, sampleRate: this.ctx.sampleRate, latencyMs };
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Accès au microphone refusé. Autorise le micro dans ton navigateur ou utilise le Synthé de test.'
          : err instanceof Error
          ? err.message
          : 'Impossible d’initialiser le moteur audio.';
      return { ok: false, error: msg, sampleRate: 48000, latencyMs: 0 };
    }
  }

  public async switchSource(mode: VocalSourceMode, deviceId?: string): Promise<string | null> {
    this.sourceMode = mode;
    if (deviceId !== undefined) this.selectedDeviceId = deviceId;
    if (!this.ctx || !this.inputGain) return null;
    try {
      await this.connectSource(mode, this.selectedDeviceId);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'Erreur de source audio.';
    }
  }

  private async connectSource(mode: VocalSourceMode, deviceId: string) {
    this.disconnectSource();
    if (!this.ctx || !this.inputGain) return;

    if (mode === 'mic') {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
      this.micStream = stream;
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.inputGain);
    } else {
      this.startTestSynth();
    }
  }

  private disconnectSource() {
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    if (this.synthStopFn) {
      this.synthStopFn();
      this.synthStopFn = null;
    }
  }

  private startTestSynth() {
    if (!this.ctx || !this.inputGain) return;
    const ctx = this.ctx;
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    const lfo = ctx.createOscillator();
    const lfoG = ctx.createGain();
    lfo.frequency.value = 5.3;
    lfoG.gain.value = 3.0;
    lfo.connect(lfoG);
    lfoG.connect(osc1.frequency);

    const fmt = ctx.createBiquadFilter();
    fmt.type = 'bandpass';
    fmt.frequency.value = 740;
    fmt.Q.value = 2.0;

    const amp = ctx.createGain();
    amp.gain.value = 0.22;

    osc1.connect(fmt);
    fmt.connect(amp);
    amp.connect(this.inputGain);

    const notes = [60.3, 62.2, 63.7, 65.4, 67.3, 65.6, 63.2, 60.4];
    let step = 0;
    const tick = () => {
      const midi = notes[step++ % notes.length];
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      osc1.frequency.setTargetAtTime(f, ctx.currentTime, 0.035);
    };
    tick();
    const id = window.setInterval(tick, 620);
    osc1.start();
    lfo.start();
    this.synthStopFn = () => {
      window.clearInterval(id);
      try {
        osc1.stop();
        lfo.stop();
        osc1.disconnect();
        lfo.disconnect();
        amp.disconnect();
      } catch {
        // ignore
      }
    };
  }

  public stopEngine() {
    this.stopPlayback();
    this.disconnectSource();
    if (this.vocalWorklet) {
      this.vocalWorklet.disconnect();
      this.vocalWorklet = null;
    }
    if (this.masterWorklet) {
      this.masterWorklet.disconnect();
      this.masterWorklet = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.detHistory.fill(0);
    this.corHistory.fill(0);
  }

  public setMonitor(on: boolean) {
    this.monitorEnabled = on;
    if (this.ctx && this.monitorGain) {
      this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.015);
    }
  }

  public updateVocalSettings(v: VocalSettings) {
    this.vocalSettings = { ...v };
    this.pushVocalSettings();
  }

  public updateMasterSettings(m: MasterSettings) {
    this.masterSettings = { ...m };
    this.pushMasterSettings();
  }

  private pushVocalSettings() {
    const v = this.vocalSettings;
    const payload = {
      type: 'params',
      data: {
        key: v.key,
        mask: getScaleMask(v.scale),
        tuneAmt: v.tuneAmt / 100,
        tuneSpeed: v.tuneSpeed / 100,
        transpose: v.transpose,
        formant: v.formant,
        gateThreshDb: v.gateThreshDb,
        gateAttackMs: v.gateAttackMs,
        gateReleaseMs: v.gateReleaseMs,
        deesser: v.deesser / 100,
        eqLowDb: v.eqLowDb,
        eqMidDb: v.eqMidDb,
        eqMidFreq: v.eqMidFreq,
        eqHighDb: v.eqHighDb,
        compThreshDb: v.compThreshDb,
        compRatio: v.compRatio,
        compAttackMs: v.compAttackMs,
        compReleaseMs: v.compReleaseMs,
        compMakeupDb: v.compMakeupDb,
        doubler: v.doubler / 100,
        reverbSize: v.reverbSize / 100,
        reverbMix: v.reverbMix / 100,
        delayMs: v.delayMs,
        delayFb: v.delayFb / 100,
        delayMix: v.delayMix / 100,
        bypass: v.bypass,
      },
    };
    this.vocalWorklet?.port.postMessage(payload);
    this.activeNodes.forEach((node) => {
      node.vocalWorklet?.port.postMessage(payload);
    });
  }

  private pushMasterSettings() {
    const m = this.masterSettings;
    this.masterWorklet?.port.postMessage({
      type: 'params',
      data: {
        eqLowDb: m.eqLowDb,
        eqHighDb: m.eqHighDb,
        glueThreshDb: m.glueThreshDb,
        glueRatio: m.glueRatio,
        glueMix: m.glueMix / 100,
        exciter: m.exciter / 100,
        stereoWidth: m.stereoWidth / 100,
        limiterCeilingDb: m.limiterCeilingDb,
        limiterDriveDb: m.limiterDriveDb,
        bypass: m.bypass,
      },
    });
  }

  // ---------- Unlimited Multi-Track Import & Management ----------
  public async decodeAudioFile(file: File, isVocal: boolean): Promise<StudioTrack> {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
    }
    const arr = await file.arrayBuffer();
    const buffer = await this.ctx.decodeAudioData(arr);
    const peaks = this.computePeaks(buffer, 240);

    return {
      id: `trk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: file.name,
      isVocal,
      fxEnabled: isVocal,
      buffer,
      durationSec: buffer.duration,
      peaks,
      volume: 1.0,
      pan: 0,
      mute: false,
      solo: false,
      offsetMs: 0,
    };
  }

  private computePeaks(buffer: AudioBuffer, count: number): number[] {
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    const len = ch0.length;
    const step = Math.max(1, Math.floor(len / count));
    const stride = Math.max(1, Math.floor(step / 64)); // Fast subsampled peak scan even on multi-hour files
    const peaks: number[] = [];
    for (let i = 0; i < count; i++) {
      let mx = 0;
      const start = i * step;
      const end = Math.min(len, start + step);
      for (let j = start; j < end; j += stride) {
        const v = Math.max(Math.abs(ch0[j]), Math.abs(ch1[j]));
        if (v > mx) mx = v;
      }
      peaks.push(mx);
    }
    return peaks;
  }

  public syncTracks(tracks: StudioTrack[]) {
    this.tracks = tracks;
    const anySolo = tracks.some((t) => t.solo);
    for (const t of tracks) {
      const node = this.activeNodes.get(t.id);
      if (node && this.ctx) {
        const audible = !t.mute && (!anySolo || t.solo);
        node.gain.gain.setTargetAtTime(audible ? t.volume : 0, this.ctx.currentTime, 0.015);
        node.pan.pan.setTargetAtTime(t.pan, this.ctx.currentTime, 0.015);
      }
    }
  }

  public startPlayback(tracks: StudioTrack[], fromSec?: number) {
    if (!this.ctx || !this.tracksMixBus) return;
    this.tracks = tracks;
    this.stopActiveTrackNodes();

    if (fromSec !== undefined) {
      this.playheadOffsetSec = Math.max(0, fromSec);
    }

    const now = this.ctx.currentTime + 0.03;
    this.playStartCtxTime = now - this.playheadOffsetSec;
    const anySolo = tracks.some((t) => t.solo);

    for (const t of tracks) {
      const src = this.ctx.createBufferSource();
      src.buffer = t.buffer;

      const gain = this.ctx.createGain();
      const audible = !t.mute && (!anySolo || t.solo);
      gain.gain.value = audible ? t.volume : 0;

      const pan = this.ctx.createStereoPanner();
      pan.pan.value = t.pan;

      let vocalNode: AudioWorkletNode | undefined;
      if (t.fxEnabled) {
        vocalNode = new AudioWorkletNode(this.ctx, 'voxora-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        src.connect(vocalNode);
        vocalNode.connect(gain);
      } else {
        src.connect(gain);
      }

      gain.connect(pan);
      pan.connect(this.tracksMixBus);

      const effectiveSec = this.playheadOffsetSec - t.offsetMs / 1000;
      if (effectiveSec < t.durationSec) {
        if (effectiveSec >= 0) {
          src.start(now, effectiveSec);
        } else {
          src.start(now + Math.abs(effectiveSec), 0);
        }
      }

      this.activeNodes.set(t.id, { source: src, gain, pan, vocalWorklet: vocalNode });
    }

    this.isPlaying = true;
    this.pushVocalSettings();
  }

  public pausePlayback() {
    if (!this.isPlaying) return;
    this.playheadOffsetSec = this.getPlayheadSec();
    this.stopActiveTrackNodes();
    this.isPlaying = false;
  }

  public stopPlayback() {
    this.stopActiveTrackNodes();
    this.isPlaying = false;
    this.playheadOffsetSec = 0;
  }

  public seekTo(sec: number, tracks: StudioTrack[]) {
    this.playheadOffsetSec = Math.max(0, sec);
    if (this.isPlaying) {
      this.startPlayback(tracks, this.playheadOffsetSec);
    }
  }

  public getPlayheadSec(): number {
    if (!this.isPlaying || !this.ctx) return this.playheadOffsetSec;
    return Math.max(0, this.ctx.currentTime - this.playStartCtxTime);
  }

  public getTotalDurationSec(tracks: StudioTrack[]): number {
    let mx = 0;
    for (const t of tracks) {
      const end = Math.max(0, t.durationSec + t.offsetMs / 1000);
      if (end > mx) mx = end;
    }
    return mx;
  }

  private stopActiveTrackNodes() {
    this.activeNodes.forEach((n) => {
      try {
        n.source.stop();
        n.source.disconnect();
        n.vocalWorklet?.disconnect();
        n.gain.disconnect();
        n.pan.disconnect();
      } catch {
        // ignore
      }
    });
    this.activeNodes.clear();
  }

  // ---------- Live Vocal Recording -> Adds Directly as Multi-Track ----------
  public startRecording() {
    this.recChunks = [];
    this.recTotalSamples = 0;
    this.isRecording = true;
    this.recStartSec = this.getPlayheadSec();
    this.vocalWorklet?.port.postMessage({ type: 'rec', on: true });
  }

  public async stopRecordingAndBuildTrack(takeIdx: number): Promise<StudioTrack | null> {
    this.isRecording = false;
    this.vocalWorklet?.port.postMessage({ type: 'rec', on: false });
    await new Promise((r) => setTimeout(r, 80));

    if (!this.ctx || this.recTotalSamples === 0) return null;

    const merged = new Float32Array(this.recTotalSamples);
    let offset = 0;
    for (const ch of this.recChunks) {
      merged.set(ch, offset);
      offset += ch.length;
    }
    this.recChunks = [];
    this.recTotalSamples = 0;

    const sr = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, merged.length, sr);
    buffer.copyToChannel(merged, 0);

    return {
      id: `rec-${Date.now()}`,
      name: `Voix enregistrée #${takeIdx}`,
      isVocal: true,
      fxEnabled: true,
      buffer,
      durationSec: buffer.duration,
      peaks: this.computePeaks(buffer, 240),
      volume: 1.0,
      pan: 0,
      mute: false,
      solo: false,
      offsetMs: Math.round(this.recStartSec * 1000),
    };
  }

  // ---------- Offline Mastering Render & Export ----------
  public async exportMixOffline(
    tracks: StudioTrack[],
    format: 'wav16' | 'wav24',
    onProgress: (p: number) => void
  ): Promise<ExportedMix> {
    const sr = this.ctx?.sampleRate ?? 48000;
    const blob = await renderMultiTrackOffline(
      tracks,
      this.vocalSettings,
      this.masterSettings,
      sr,
      format,
      onProgress
    );
    const url = URL.createObjectURL(blob);
    const dur = this.getTotalDurationSec(tracks);
    const stamp = new Date().toLocaleTimeString('fr-FR', { hour12: false }).replace(/:/g, '-');
    return {
      id: `exp-${Date.now()}`,
      name: `Voxora_Master_${stamp}.wav`,
      formatLabel: format === 'wav24' ? 'WAV 24-bit' : 'WAV 16-bit',
      blob,
      url,
      durationSec: dur,
      sizeBytes: blob.size,
      createdAt: new Date(),
    };
  }

  private onVocalMsg(msg: {
    type: string;
    det?: number;
    cor?: number;
    voiced?: boolean;
    inPk?: number;
    grDb?: number;
    sr?: number;
    samples?: Float32Array;
  }) {
    if (msg.type === 'telemetry') {
      this.detHistory[this.historyWriteIdx] = msg.det ?? 0;
      this.corHistory[this.historyWriteIdx] = msg.cor ?? 0;
      this.historyWriteIdx = (this.historyWriteIdx + 1) % HISTORY_LEN;

      this.latestTelemetry = {
        ...this.latestTelemetry,
        det: msg.det ?? 0,
        cor: msg.cor ?? 0,
        voiced: Boolean(msg.voiced),
        inLevel: msg.inPk ?? 0,
        grDb: msg.grDb ?? 0,
        sampleRate: msg.sr ?? this.latestTelemetry.sampleRate,
      };
      this.emitTelemetry();
    } else if (msg.type === 'rec-chunk' && msg.samples && this.isRecording) {
      this.recChunks.push(msg.samples);
      this.recTotalSamples += msg.samples.length;
    }
  }

  private onMasterMsg(msg: { type: string; outPk?: number; lufs?: number }) {
    if (msg.type === 'master-telemetry') {
      this.latestTelemetry = {
        ...this.latestTelemetry,
        outLevel: msg.outPk ?? 0,
        lufs: msg.lufs ?? -70,
      };
      this.emitTelemetry();
    }
  }

  private emitTelemetry() {
    const now = performance.now();
    if (now - this.lastUiEmit > 45) {
      this.lastUiEmit = now;
      this.onTelemetryCb?.(this.latestTelemetry);
    }
  }
}
