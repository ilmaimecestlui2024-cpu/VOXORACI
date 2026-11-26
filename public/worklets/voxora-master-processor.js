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
    this.glueThreshDb = -14;
    this.glueRatio = 2.5;
    this.glueMix = 0.35;
    this.exciter = 0.15;
    this.stereoWidth = 1.08;
    this.limiterCeilingDb = -1.0;
    this.limiterDriveDb = 1.5;
    this.bypass = false;

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

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'params') {
        Object.assign(this, e.data.data);
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
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outL = output[0];
    const outR = output.length > 1 ? output[1] : outL;
    const inL = input && input.length > 0 ? input[0] : null;
    const inR = input && input.length > 1 ? input[1] : inL;
    const n = outL.length;

    this.updEq();
    const drive = Math.pow(10, this.limiterDriveDb / 20);
    const ceilLin = Math.pow(10, Math.max(-6, Math.min(-0.1, this.limiterCeilingDb)) / 20);

    for (let i = 0; i < n; i++) {
      let L = inL ? inL[i] : 0;
      let R = inR ? inR[i] : L;
      if (!Number.isFinite(L)) L = 0;
      if (!Number.isFinite(R)) R = 0;

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
        L = (mid + side) * drive;
        R = (mid - side) * drive;

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
