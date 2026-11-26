// Voxora Studio — Real-Time AudioWorklet Master Bus Processor
// Master EQ -> Glue Bus Compressor -> Harmonic Exciter -> Stereo Imager -> 2.5ms Lookahead Brickwall Limiter

class MasterBiquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }
  run(x) {
    let y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    if (!Number.isFinite(y)) {
      this.z1 = 0;
      this.z2 = 0;
      return 0;
    }
    if (Math.abs(this.z1) < 1e-18) this.z1 = 0;
    if (Math.abs(this.z2) < 1e-18) this.z2 = 0;
    return y;
  }
  set(type, fs, f0, db, q) {
    const freq = Math.max(20, Math.min(fs * 0.45, f0));
    const A = Math.pow(10, db / 40);
    const w = (6.28318530718 * freq) / fs;
    const c = Math.cos(w), s = Math.sin(w);
    const al = s / (2 * Math.max(0.1, q));
    const sq = 2 * Math.sqrt(A) * al;
    let B0 = 1, B1 = 0, B2 = 0, A0 = 1, A1 = 0, A2 = 0;
    if (type === 0) {
      B0 = A * (A + 1 - (A - 1) * c + sq); B1 = 2 * A * (A - 1 - (A + 1) * c);
      B2 = A * (A + 1 - (A - 1) * c - sq); A0 = A + 1 + (A - 1) * c + sq;
      A1 = -2 * (A - 1 + (A + 1) * c); A2 = A + 1 + (A - 1) * c - sq;
    } else if (type === 1) {
      B0 = 1 + al * A; B1 = -2 * c; B2 = 1 - al * A;
      A0 = 1 + al / A; A1 = -2 * c; A2 = 1 - al / A;
    } else if (type === 2) {
      B0 = A * (A + 1 + (A - 1) * c + sq); B1 = -2 * A * (A - 1 + (A + 1) * c);
      B2 = A * (A + 1 + (A - 1) * c - sq); A0 = A + 1 - (A - 1) * c + sq;
      A1 = 2 * (A - 1 - (A + 1) * c); A2 = A + 1 - (A - 1) * c - sq;
    } else {
      B0 = (1 + c) * 0.5; B1 = -(1 + c); B2 = (1 + c) * 0.5;
      A0 = 1 + al; A1 = -2 * c; A2 = 1 - al;
    }
    this.b0 = B0 / A0; this.b1 = B1 / A0; this.b2 = B2 / A0;
    this.a1 = A1 / A0; this.a2 = A2 / A0;
  }
}

class VoxoraMasterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate || 48000;
    this.sr = sr;

    this.eqLowDb = 0;
    this.eqHighDb = 1;
    this.glueThreshDb = -12;
    this.glueRatio = 2.2;
    this.glueMix = 0.28;
    this.exciter = 0.15;
    this.stereoWidth = 1.05;
    this.limiterCeilingDb = -1.0;
    this.limiterDriveDb = 1.2;
    this.bypass = false;

    // Smart Mix Separation: Beat Pocket EQ (320 Hz & 2.4 kHz) + Vocal Sidechain Ducking + Mono Check
    this.mixBalance = true;
    this.hasVocal = false;
    this.monoCheck = false;

    this.beatLowMidL = new MasterBiquad();
    this.beatLowMidR = new MasterBiquad();
    this.beatPresL = new MasterBiquad();
    this.beatPresR = new MasterBiquad();
    this.beatLowMidL.set(1, sr, 320, -1.8, 0.8);
    this.beatLowMidR.set(1, sr, 320, -1.8, 0.8);
    this.beatPresL.set(1, sr, 2400, -2.8, 0.75);
    this.beatPresR.set(1, sr, 2400, -2.8, 0.75);

    this.vocHpL = new MasterBiquad();
    this.vocHpR = new MasterBiquad();
    this.vocHpL.set(3, sr, 100, 0, 0.707);
    this.vocHpR.set(3, sr, 100, 0, 0.707);

    this.scAtk = 1 - Math.exp(-1 / (0.012 * sr));
    this.scRel = 1 - Math.exp(-1 / (0.180 * sr));
    this.scEnv = 0;
    this.duckGain = 1;

    this.eqLowL = new MasterBiquad();
    this.eqLowR = new MasterBiquad();
    this.eqHighL = new MasterBiquad();
    this.eqHighR = new MasterBiquad();
    this.excHpL = new MasterBiquad();
    this.excHpR = new MasterBiquad();
    this.excHpL.set(3, sr, 3500, 0, 0.707);
    this.excHpR.set(3, sr, 3500, 0, 0.707);

    this.cl = 1e9;
    this.ch = 1e9;
    this.updEq();

    this.atkGlue = 1 - Math.exp(-1 / (0.015 * sr));
    this.relGlue = 1 - Math.exp(-1 / (0.200 * sr));
    this.glueEnv = 0;

    // 2.5ms Lookahead Brickwall Limiter (zero transient crackles!)
    this.lookLen = Math.max(16, Math.round(0.0025 * sr));
    this.lookBufL = new Float32Array(this.lookLen);
    this.lookBufR = new Float32Array(this.lookLen);
    this.lookIdx = 0;
    this.atkLim = 1 - Math.exp(-1 / (0.0012 * sr));
    this.relLim = 1 - Math.exp(-1 / (0.090 * sr));
    this.limGain = 1;

    this.peakHold = 0;
    this.rmsSq = 0;
    this.countdown = 0;
    this.disposed = false;

    this.port.onmessage = (e) => {
      if (!e.data) return;
      if (e.data.type === 'params') {
        Object.assign(this, e.data.data);
      } else if (e.data.type === 'dispose') {
        this.disposed = true;
      }
    };
  }

  updEq() {
    if (this.eqLowDb !== this.cl || this.eqHighDb !== this.ch) {
      this.cl = this.eqLowDb;
      this.ch = this.eqHighDb;
      this.eqLowL.set(0, this.sr, 65, this.cl, 0.707);
      this.eqLowR.set(0, this.sr, 65, this.cl, 0.707);
      this.eqHighL.set(2, this.sr, 12000, this.ch, 0.707);
      this.eqHighR.set(2, this.sr, 12000, this.ch, 0.707);
    }
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const beatIn = inputs[0];
    const vocIn = inputs[1];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outL = output[0];
    const outR = output.length > 1 ? output[1] : outL;
    const bInL = beatIn && beatIn.length > 0 ? beatIn[0] : null;
    const bInR = beatIn && beatIn.length > 1 ? beatIn[1] : bInL;
    const vInL = vocIn && vocIn.length > 0 ? vocIn[0] : null;
    const vInR = vocIn && vocIn.length > 1 ? vocIn[1] : vInL;
    const n = outL.length;

    this.updEq();
    const drive = Math.pow(10, this.limiterDriveDb / 20);
    const ceilLin = Math.pow(10, Math.max(-6, Math.min(-0.1, this.limiterCeilingDb)) / 20);
    const pocketActive = this.mixBalance && this.hasVocal && !this.bypass;

    for (let i = 0; i < n; i++) {
      let bL = bInL ? bInL[i] : 0;
      let bR = bInR ? bInR[i] : bL;
      let vL = vInL ? vInL[i] : 0;
      let vR = vInR ? vInR[i] : vL;
      if (!Number.isFinite(bL)) bL = 0;
      if (!Number.isFinite(bR)) bR = 0;
      if (!Number.isFinite(vL)) vL = 0;
      if (!Number.isFinite(vR)) vR = 0;

      if (pocketActive) {
        // 1. Clean 100 Hz HPF on vocal bus prevents low-end mud
        vL = this.vocHpL.run(vL);
        vR = this.vocHpR.run(vR);

        // 2. Carve gentle 320 Hz & 2.4 kHz vocal pocket in the instrumental
        bL = this.beatPresL.run(this.beatLowMidL.run(bL));
        bR = this.beatPresR.run(this.beatLowMidR.run(bR));

        // 3. Musical vocal-triggered sidechain ducking (up to -2.8 dB)
        const vPk = Math.max(Math.abs(vL), Math.abs(vR));
        this.scEnv += (vPk - this.scEnv) * (vPk > this.scEnv ? this.scAtk : this.scRel);
        let targetDuck = 1.0;
        if (this.scEnv > 0.01585) {
          const overDb = 20 * Math.log10(this.scEnv / 0.01585);
          const cutDb = Math.min(2.8, overDb * 0.22);
          targetDuck = Math.pow(10, -cutDb / 20);
        }
        this.duckGain += (targetDuck - this.duckGain) * (targetDuck < this.duckGain ? this.scAtk : this.scRel);
        bL *= this.duckGain;
        bR *= this.duckGain;
      } else {
        this.duckGain += (1.0 - this.duckGain) * 0.01;
        bL *= this.duckGain;
        bR *= this.duckGain;
      }

      let L = bL + vL;
      let R = bR + vR;

      if (!this.bypass) {
        L = this.eqHighL.run(this.eqLowL.run(L));
        R = this.eqHighR.run(this.eqLowR.run(R));

        const pk = Math.max(Math.abs(L), Math.abs(R));
        this.glueEnv += (pk - this.glueEnv) * (pk > this.glueEnv ? this.atkGlue : this.relGlue);
        const over = 20 * Math.log10(this.glueEnv + 1e-7) - this.glueThreshDb;
        if (over > 0 && this.glueMix > 0.01) {
          const gr = -over * (1 - 1 / Math.max(1, this.glueRatio));
          const g = Math.pow(10, gr / 20);
          L = L * (1 - this.glueMix) + L * g * this.glueMix;
          R = R * (1 - this.glueMix) + R * g * this.glueMix;
        }

        if (this.exciter > 0.01) {
          const hL = this.excHpL.run(L);
          const hR = this.excHpR.run(R);
          L += Math.tanh(hL * (1 + this.exciter * 3)) * this.exciter * 0.2;
          R += Math.tanh(hR * (1 + this.exciter * 3)) * this.exciter * 0.2;
        }

        const mid = (L + R) * 0.5;
        const side = (L - R) * 0.5 * this.stereoWidth;
        if (this.monoCheck) {
          L = mid * drive;
          R = mid * drive;
        } else {
          L = (mid + side) * drive;
          R = (mid - side) * drive;
        }

        // Soft-knee analog saturation before lookahead limiter
        L = Math.tanh(L * 0.72) / 0.72;
        R = Math.tanh(R * 0.72) / 0.72;

        // Lookahead delay read & write
        const delL = this.lookBufL[this.lookIdx];
        const delR = this.lookBufR[this.lookIdx];
        this.lookBufL[this.lookIdx] = L;
        this.lookBufR[this.lookIdx] = R;
        if (++this.lookIdx >= this.lookLen) this.lookIdx = 0;

        // Peak detection on incoming sample ramps gain smoothly before delayed peak exits
        const spk = Math.max(Math.abs(L), Math.abs(R));
        const tg = spk > ceilLin ? ceilLin / spk : 1;
        this.limGain += (tg - this.limGain) * (tg < this.limGain ? this.atkLim : this.relLim);

        L = Math.max(-ceilLin, Math.min(ceilLin, delL * this.limGain));
        R = Math.max(-ceilLin, Math.min(ceilLin, delR * this.limGain));
      } else {
        if (this.monoCheck) {
          const mid = (L + R) * 0.5;
          L = mid;
          R = mid;
        }
        L = Math.tanh(L * 0.9);
        R = Math.tanh(R * 0.9);
      }

      outL[i] = L;
      if (outR !== outL) outR[i] = R;

      const ap = Math.max(Math.abs(L), Math.abs(R));
      if (ap > this.peakHold) this.peakHold = ap;
      this.rmsSq += ((L * L + R * R) * 0.5 - this.rmsSq) * 0.001;
    }

    this.countdown += n;
    if (this.countdown >= 1280) {
      const lufs = Math.max(-70, Math.min(0, 20 * Math.log10(Math.sqrt(Math.max(this.rmsSq, 1e-8)))));
      this.port.postMessage({
        type: 'master-telemetry',
        outPk: this.peakHold,
        lufs,
      });
      this.peakHold = 0;
      this.countdown = 0;
    }

    return true;
  }
}

registerProcessor('voxora-master-processor', VoxoraMasterProcessor);
