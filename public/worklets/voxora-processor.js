// Voxora Studio — Real-Time AudioWorklet Vocal DSP Engine (Clean, Zero-Clip, Low-Artifact)
// DC/HPF -> Noise Gate -> YIN Auto-Tune (24ms OLA Cubic) -> Formant -> Smooth De-Esser
// -> 3-Band RBJ EQ -> Compressor -> Doubler/Chorus -> Stereo Reverb -> Stereo Delay -> Soft Limiter

class Biquad {
  constructor() {
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.z1 = 0;
    this.z2 = 0;
  }

  reset() {
    this.z1 = 0;
    this.z2 = 0;
  }

  run(x) {
    let y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    // Anti-denormal & NaN guard
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
    const qSafe = Math.max(0.1, q);
    const A = Math.pow(10, db / 40);
    const w = (6.28318530718 * freq) / fs;
    const c = Math.cos(w);
    const s = Math.sin(w);
    const al = s / (2 * qSafe);
    const sq = 2 * Math.sqrt(A) * al;
    let B0 = 1, B1 = 0, B2 = 0, A0 = 1, A1 = 0, A2 = 0;

    if (type === 0) {
      B0 = A * (A + 1 - (A - 1) * c + sq);
      B1 = 2 * A * (A - 1 - (A + 1) * c);
      B2 = A * (A + 1 - (A - 1) * c - sq);
      A0 = A + 1 + (A - 1) * c + sq;
      A1 = -2 * (A - 1 + (A + 1) * c);
      A2 = A + 1 + (A - 1) * c - sq;
    } else if (type === 1) {
      B0 = 1 + al * A;
      B1 = -2 * c;
      B2 = 1 - al * A;
      A0 = 1 + al / A;
      A1 = -2 * c;
      A2 = 1 - al / A;
    } else if (type === 2) {
      B0 = A * (A + 1 + (A - 1) * c + sq);
      B1 = -2 * A * (A - 1 + (A + 1) * c);
      B2 = A * (A + 1 + (A - 1) * c - sq);
      A0 = A + 1 - (A - 1) * c + sq;
      A1 = 2 * (A - 1 - (A + 1) * c);
      A2 = A + 1 - (A - 1) * c - sq;
    } else if (type === 3) {
      B0 = (1 + c) * 0.5;
      B1 = -(1 + c);
      B2 = (1 + c) * 0.5;
      A0 = 1 + al;
      A1 = -2 * c;
      A2 = 1 - al;
    } else {
      B0 = al;
      B1 = 0;
      B2 = -al;
      A0 = 1 + al;
      A1 = -2 * c;
      A2 = 1 - al;
    }

    this.b0 = B0 / A0;
    this.b1 = B1 / A0;
    this.b2 = B2 / A0;
    this.a1 = A1 / A0;
    this.a2 = A2 / A0;
  }
}

class CombFilter {
  constructor(size) {
    this.buf = new Float32Array(Math.max(16, size));
    this.idx = 0;
    this.lp = 0;
  }
  clear() {
    this.buf.fill(0);
    this.idx = 0;
    this.lp = 0;
  }
  run(x, fb, damp) {
    const y = this.buf[this.idx];
    this.lp = y * (1 - damp) + this.lp * damp;
    if (Math.abs(this.lp) < 1e-18) this.lp = 0;
    this.buf[this.idx] = x + this.lp * fb;
    if (++this.idx >= this.buf.length) this.idx = 0;
    return y;
  }
}

class AllpassFilter {
  constructor(size) {
    this.buf = new Float32Array(Math.max(16, size));
    this.idx = 0;
  }
  clear() {
    this.buf.fill(0);
    this.idx = 0;
  }
  run(x) {
    const y = this.buf[this.idx];
    this.buf[this.idx] = x + y * 0.5;
    if (++this.idx >= this.buf.length) this.idx = 0;
    return -x + y;
  }
}

const RING_SIZE = 65536;
const RING_MASK = RING_SIZE - 1;

class VoxoraStudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate || 48000;
    this.sr = sr;
    // 24ms grain window for crisp vocal transients without slap-back artifacts
    this.N = Math.max(256, Math.round(0.024 * sr));
    this.H = this.N >> 1;

    // Vocal parameters
    this.key = 0;
    this.mask = 0xfff;
    this.tuneAmt = 0.65;
    this.tuneSpeed = 0.5;
    this.transpose = 0.0;
    this.formant = 0.0;

    this.gateThreshDb = -52;
    this.gateAttackMs = 5;
    this.gateReleaseMs = 120;

    this.deesser = 0.25;
    this.eqLowDb = 2.0;
    this.eqMidDb = 3.0;
    this.eqMidFreq = 3200;
    this.eqHighDb = 4.0;

    this.compThreshDb = -18;
    this.compRatio = 3.5;
    this.compAttackMs = 5;
    this.compReleaseMs = 140;
    this.compMakeupDb = 3;

    this.doubler = 0.15;
    this.reverbSize = 0.55;
    this.reverbMix = 0.22;
    this.delayMs = 260;
    this.delayFb = 0.35;
    this.delayMix = 0.0;
    this.bypass = false;

    this.recording = false;
    this.recBatch = new Float32Array(2048);
    this.recBatchIdx = 0;
    this.disposed = false;
    this.postTelemetry = true;

    // Pitch / YIN buffers (pre-allocated, zero GC in process())
    this.hist = new Float32Array(RING_SIZE);
    this.wp = 0;
    this.sh = 0;
    this.ph = 0;
    this.sm = 0;
    this.ss = 0;
    this.wetMix = 0;
    this.pitchActive = false;
    this.pk = 0;
    this.mi = 0;
    this.mh = new Float32Array(5);
    this.sortBuf = new Float32Array(5);

    this.D = Math.max(2, Math.round(sr / 12000));
    this.W = 512;
    this.tMax = Math.min(480, Math.floor(sr / this.D / 75));
    this.tMin = Math.max(2, Math.floor(sr / this.D / 850));
    this.L = this.W + this.tMax + 1;
    this.ds = new Float32Array(1200);
    this.yin = new Float32Array(512);

    // Static filter topology (no per-sample coefficient recalculation!)
    this.hpIn = new Biquad();
    this.hpIn.set(3, sr, 105, 0, 0.707); // 105 Hz HPF cleans vocal mud & sub clash
    this.deessBand = new Biquad();
    this.deessBand.set(4, sr, 6800, 0, 1.2); // Static bandpass for sibilance split
    this.eqL = new Biquad();
    this.eqM = new Biquad();
    this.eqH = new Biquad();
    this.fmt1 = new Biquad();
    this.fmt2 = new Biquad();

    this.cb = 1e9;
    this.cm = 1e9;
    this.cmf = 1e9;
    this.ch = 1e9;
    this.cfmt = 1e9;
    this.updateFilters();

    this.gateEnv = 0;
    this.gateGain = 1;
    this.compEnv = 0;
    this.deessEnv = 0;
    this.deessGain = 1;

    const dSize = Math.round(0.06 * sr) + 64;
    this.dblBufL = new Float32Array(dSize);
    this.dblBufR = new Float32Array(dSize);
    this.dblWp = 0;
    this.dblPhase = 0;

    const sc = sr / 44100;
    const csL = [1557, 1617, 1491, 1422];
    const csR = [1580, 1642, 1514, 1445];
    const as = [225, 556];
    this.combsL = csL.map((c) => new CombFilter(Math.round(c * sc)));
    this.combsR = csR.map((c) => new CombFilter(Math.round(c * sc)));
    this.apsL = as.map((a) => new AllpassFilter(Math.round(a * sc)));
    this.apsR = as.map((a) => new AllpassFilter(Math.round(a * sc)));

    this.delayMax = sr * 2;
    this.delayBufL = new Float32Array(this.delayMax);
    this.delayBufR = new Float32Array(this.delayMax);
    this.delayWp = 0;
    this.smoothDelaySmp = Math.round(260 * 0.001 * sr);

    this.detNote = 0;
    this.corNote = 0;
    this.voiced = false;
    this.inPk = 0;
    this.grDb = 0;
    this.telemCountdown = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'params') {
        Object.assign(this, m.data);
      } else if (m.type === 'config') {
        if (m.data && typeof m.data.postTelemetry === 'boolean') {
          this.postTelemetry = m.data.postTelemetry;
        }
      } else if (m.type === 'dispose') {
        this.disposed = true;
      } else if (m.type === 'rec') {
        const nextRec = Boolean(m.on);
        if (this.recording && !nextRec && this.recBatchIdx > 0) {
          const tail = this.recBatch.slice(0, this.recBatchIdx);
          this.port.postMessage({ type: 'rec-chunk', samples: tail }, [tail.buffer]);
          this.recBatchIdx = 0;
        }
        this.recording = nextRec;
      } else if (m.type === 'reset') {
        this.hist.fill(0);
        this.mh.fill(0);
        this.dblBufL.fill(0);
        this.dblBufR.fill(0);
        this.delayBufL.fill(0);
        this.delayBufR.fill(0);
        this.combsL.forEach((c) => c.clear());
        this.combsR.forEach((c) => c.clear());
        this.apsL.forEach((a) => a.clear());
        this.apsR.forEach((a) => a.clear());
        this.sm = 0;
        this.ss = 0;
        this.wetMix = 0;
        this.pitchActive = false;
        this.pk = 0;
        this.detNote = 0;
        this.corNote = 0;
      }
    };
  }

  updateFilters() {
    if (
      this.eqLowDb !== this.cb ||
      this.eqMidDb !== this.cm ||
      this.eqMidFreq !== this.cmf ||
      this.eqHighDb !== this.ch
    ) {
      this.cb = this.eqLowDb;
      this.cm = this.eqMidDb;
      this.cmf = this.eqMidFreq;
      this.ch = this.eqHighDb;
      this.eqL.set(0, this.sr, 150, this.cb, 0.707);
      this.eqM.set(1, this.sr, this.cmf, this.cm, 0.9);
      this.eqH.set(2, this.sr, 9500, this.ch, 0.707);
    }
    if (this.formant !== this.cfmt) {
      this.cfmt = this.formant;
      const fShift = Math.pow(2, this.cfmt / 12);
      const fTarget = Math.max(320, Math.min(2800, 950 * fShift));
      this.fmt1.set(1, this.sr, fTarget, this.cfmt * 0.5, 1.1);
      this.fmt2.set(2, this.sr, 2600, this.cfmt * 0.4, 0.707);
    }
  }

  rd(d) {
    const id = d | 0;
    const fr = d - id;
    const cur = (this.wp - 2) >>> 0;
    const y0 = this.hist[(cur - id + 1) & RING_MASK];
    const y1 = this.hist[(cur - id) & RING_MASK];
    const y2 = this.hist[(cur - id - 1) & RING_MASK];
    const y3 = this.hist[(cur - id - 2) & RING_MASK];
    const c0 = y1;
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * fr + c2) * fr + c1) * fr + c0;
  }

  pitchShift() {
    this.ss += (this.sm - this.ss) * 0.005;
    const absShift = Math.abs(this.ss);
    const hasTranspose = Math.abs(this.transpose) >= 0.05;
    const fxEnabled = this.tuneAmt >= 0.01 || hasTranspose;

    // Clean hysteresis prevents 50/50 dry+wet comb-filter phasing around pitch target
    if (!fxEnabled) {
      this.pitchActive = false;
    } else if (hasTranspose || (this.voiced && absShift >= 0.08)) {
      this.pitchActive = true;
    } else if ((!this.voiced && absShift < 0.06) || absShift < 0.03) {
      this.pitchActive = false;
    }

    const targetWet = this.pitchActive ? 1 : 0;
    this.wetMix += (targetWet - this.wetMix) * 0.02;
    const dry = this.hist[(this.wp - 2 - this.H) & RING_MASK];
    if (this.wetMix < 0.002) return dry;

    const r = Math.pow(2, Math.max(-24, Math.min(24, this.ss)) / 12);
    this.ph += (1 - r) / this.N;
    this.ph -= Math.floor(this.ph);
    let f2 = this.ph + 0.5;
    if (f2 >= 1) f2 -= 1;

    let w1 = Math.sin(3.14159265359 * this.ph);
    w1 *= w1;
    const wet = this.rd(this.ph * this.N) * w1 + this.rd(f2 * this.N) * (1 - w1);
    return dry * (1 - this.wetMix) + wet * this.wetMix;
  }

  analyze() {
    const D = this.D;
    const W = this.W;
    const tMax = this.tMax;
    const tMin = this.tMin;
    const L = this.L;
    if (L > 1200 || tMax + 2 > 512) return;

    const base = (this.wp - L * D) >>> 0;
    for (let k = 0; k < L; k++) {
      let s = 0;
      const offset = base + k * D;
      for (let j = 0; j < D; j++) s += this.hist[(offset + j) & RING_MASK];
      this.ds[k] = s / D;
    }

    let e = 0;
    for (let j = 0; j < W; j++) e += this.ds[j] * this.ds[j];
    const rms = Math.sqrt(e / W);
    this.pk = Math.max(this.pk * 0.9995, rms);

    let voiced = false;
    let m = 0;
    const gateLin = Math.max(Math.pow(10, this.gateThreshDb / 20), 0.04 * this.pk);

    if (rms >= gateLin) {
      let run = 0;
      for (let t = 1; t <= tMax; t++) {
        let a = 0;
        for (let j = 0; j < W; j++) {
          const q = this.ds[j] - this.ds[j + t];
          a += q * q;
        }
        run += a;
        this.yin[t] = (a * t) / (run > 0 ? run : 1);
      }
      let t = tMin;
      while (t < tMax) {
        if (this.yin[t] < 0.15) {
          while (t + 1 < tMax && this.yin[t + 1] < this.yin[t]) t++;
          break;
        }
        t++;
      }
      if (t < tMax) {
        const a = this.yin[t - 1];
        const b = this.yin[t];
        const c = this.yin[t + 1];
        const den = a - 2 * b + c;
        const tt = den !== 0 ? t + (a - c) / (2 * den) : t;
        const freq = this.sr / D / tt;
        if (freq > 65 && freq < 950) {
          m = 69 + 12 * Math.log2(freq / 440);
          voiced = true;
        }
      }
    }

    this.mh[this.mi++ % 5] = voiced ? m : 0;
    let cnt = 0;
    for (let i = 0; i < 5; i++) {
      if (this.mh[i] > 0) this.sortBuf[cnt++] = this.mh[i];
    }
    if (!voiced || cnt < 2) {
      voiced = false;
    } else {
      // Zero-allocation insertion sort
      for (let i = 1; i < cnt; i++) {
        const keyVal = this.sortBuf[i];
        let j = i - 1;
        while (j >= 0 && this.sortBuf[j] > keyVal) {
          this.sortBuf[j + 1] = this.sortBuf[j];
          j--;
        }
        this.sortBuf[j + 1] = keyVal;
      }
      m = this.sortBuf[cnt >> 1];
    }

    let want = this.transpose;
    let al = 0.25;
    if (voiced) {
      const b0 = Math.round(m);
      let best = m;
      let bd = 1e9;
      for (let k = -6; k <= 6; k++) {
        const cn = b0 + k;
        const rel = (((cn - this.key) % 12) + 12) % 12;
        if ((this.mask >> rel) & 1) {
          const dd = Math.abs(cn - m);
          if (dd < bd) {
            bd = dd;
            best = cn;
          }
        }
      }
      want = (best - m) * this.tuneAmt + this.transpose;
      al = 0.04 + 0.96 * this.tuneSpeed * this.tuneSpeed;
    }

    al = 1 - Math.sqrt(1 - Math.max(0.01, Math.min(0.999, al)));
    this.sm += (want - this.sm) * al;
    this.voiced = voiced;
    this.detNote = voiced ? m : 0;
    this.corNote = voiced ? m + this.sm : 0;
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outL = output[0];
    const outR = output.length > 1 ? output[1] : outL;
    const inL = input && input.length > 0 ? input[0] : null;
    const inR = input && input.length > 1 ? input[1] : null;
    const n = outL.length;

    this.updateFilters();

    const gAtk = 1 - Math.exp(-1 / (Math.max(0.5, this.gateAttackMs) * 0.001 * this.sr));
    const gRel = 1 - Math.exp(-1 / (Math.max(5, this.gateReleaseMs) * 0.001 * this.sr));
    const gateThr = Math.pow(10, this.gateThreshDb / 20);

    const cAtk = 1 - Math.exp(-1 / (Math.max(0.5, this.compAttackMs) * 0.001 * this.sr));
    const cRel = 1 - Math.exp(-1 / (Math.max(10, this.compReleaseMs) * 0.001 * this.sr));
    const makeupLin = Math.pow(10, this.compMakeupDb / 20);

    const dSize = this.dblBufL.length;
    const targetDelSmp = Math.max(64, Math.min(this.delayMax - 2, Math.round(this.delayMs * 0.001 * this.sr)));
    const fb = Math.max(0, Math.min(0.82, this.delayFb));
    const revFb = Math.min(0.85, 0.68 + this.reverbSize * 0.17);

    // Phase-safe & single-channel-safe stereo-to-mono summing (prevents phase cancellation or -6 dB drop)
    let stereoMode = 0; // 0: mono/L-only, 1: (L+R)*0.5, 2: R-only, 3: (L-R)*0.5 (phase inverted)
    if (inL && inR) {
      let dot = 0;
      let eL = 0;
      let eR = 0;
      for (let i = 0; i < n; i++) {
        const l = inL[i];
        const r = inR[i];
        dot += l * r;
        eL += l * l;
        eR += r * r;
      }
      if (eR < eL * 0.02) {
        stereoMode = 0;
      } else if (eL < eR * 0.02) {
        stereoMode = 2;
      } else if (dot < -0.15 * Math.sqrt(eL * eR + 1e-12)) {
        stereoMode = 3;
      } else {
        stereoMode = 1;
      }
    }

    for (let i = 0; i < n; i++) {
      let rawIn = 0;
      if (inL) {
        if (stereoMode === 1) rawIn = (inL[i] + inR[i]) * 0.5;
        else if (stereoMode === 2) rawIn = inR[i];
        else if (stereoMode === 3) rawIn = (inL[i] - inR[i]) * 0.5;
        else rawIn = inL[i];
      }
      if (!Number.isFinite(rawIn)) rawIn = 0;

      // Clean 105 Hz HPF on vocal input removes sub-rumble & mud before recording and DSP
      const cleanIn = this.hpIn.run(rawIn);
      const absRaw = Math.abs(cleanIn);
      if (absRaw > this.inPk) this.inPk = absRaw;

      if (this.recording) {
        // Gentle protective soft-saturation keeps recorded raw voice safe from digital overs
        const recSmp = Math.abs(cleanIn) > 0.85 ? Math.tanh(cleanIn) * 0.96 : cleanIn;
        this.recBatch[this.recBatchIdx++] = recSmp;
        if (this.recBatchIdx >= this.recBatch.length) {
          const copy = this.recBatch.slice();
          this.port.postMessage({ type: 'rec-chunk', samples: copy }, [copy.buffer]);
          this.recBatchIdx = 0;
        }
      }

      if (this.bypass) {
        const safeOut = Math.tanh(cleanIn * 0.95);
        outL[i] = safeOut;
        if (outR !== outL) outR[i] = safeOut;
        this.grDb = 0;
        continue;
      }

      // 1. Noise Gate
      let x = cleanIn;
      const ax = Math.abs(x);
      this.gateEnv += (ax - this.gateEnv) * (ax > this.gateEnv ? gAtk : gRel);
      const tg = this.gateEnv >= gateThr ? 1 : 0.01;
      this.gateGain += (tg - this.gateGain) * (tg > this.gateGain ? gAtk : gRel);
      x *= this.gateGain;

      // 2. Pitch analysis & shifter
      this.hist[this.wp & RING_MASK] = x;
      this.wp = (this.wp + 1) >>> 0;
      if (++this.sh >= 256) {
        this.sh = 0;
        this.analyze();
      }
      let y = this.pitchShift();

      // 3. Formant
      if (Math.abs(this.formant) > 0.1) {
        y = this.fmt2.run(this.fmt1.run(y));
      }

      // 4. Smooth zero-zipper De-Esser (static 6.8 kHz band split + smoothed scalar ducking)
      if (this.deesser > 0.01) {
        const sibBand = this.deessBand.run(y);
        const sibAbs = Math.abs(sibBand);
        this.deessEnv += (sibAbs - this.deessEnv) * (sibAbs > this.deessEnv ? 0.03 : 0.0015);
        const thr = 0.045 * (1.1 - this.deesser * 0.85);
        let targetDuck = 1.0;
        if (this.deessEnv > thr) {
          const ratio = thr / (this.deessEnv + 1e-7);
          targetDuck = Math.max(0.25, 1.0 - (1.0 - ratio) * this.deesser * 0.9);
        }
        this.deessGain += (targetDuck - this.deessGain) * 0.02;
        y -= sibBand * (1.0 - this.deessGain);
      }

      // 5. 3-Band EQ
      y = this.eqH.run(this.eqM.run(this.eqL.run(y)));

      // 6. Compressor
      const ay = Math.abs(y);
      this.compEnv += (ay - this.compEnv) * (ay > this.compEnv ? cAtk : cRel);
      const over = 20 * Math.log10(this.compEnv + 1e-7) - this.compThreshDb;
      const gr = over > 0 ? -over * (1 - 1 / Math.max(1, this.compRatio)) : 0;
      this.grDb = gr;
      y *= Math.pow(10, gr / 20) * makeupLin;

      // Protective soft saturation after EQ+Comp so Doubler/Reverb never get overloaded
      y = Math.tanh(y * 0.82) * 0.96;

      // 7. Doubler / Chorus
      let yL = y;
      let yR = y;
      this.dblBufL[this.dblWp] = y;
      this.dblBufR[this.dblWp] = y;
      if (this.doubler > 0.01) {
        this.dblPhase += 0.65 / this.sr;
        if (this.dblPhase >= 1) this.dblPhase -= 1;
        const lfo = Math.sin(6.28318530718 * this.dblPhase);
        const d1 = (0.014 + 0.0035 * lfo) * this.sr;
        const d2 = (0.021 - 0.0035 * lfo) * this.sr;
        const readDbl = (buf, d) => {
          const id = d | 0;
          const fr = d - id;
          const i1 = (this.dblWp - id + dSize) % dSize;
          const i2 = (this.dblWp - id - 1 + dSize) % dSize;
          return buf[i1] * (1 - fr) + buf[i2] * fr;
        };
        const wL = readDbl(this.dblBufL, d1);
        const wR = readDbl(this.dblBufR, d2);
        const m = this.doubler * 0.38;
        yL = yL * (1 - m * 0.25) + wL * m;
        yR = yR * (1 - m * 0.25) - wR * m * 0.75;
      }
      if (++this.dblWp >= dSize) this.dblWp = 0;

      // 8. Stereo Reverb (soft-saturated return prevents resonant overload)
      let fxL = 0;
      let fxR = 0;
      if (this.reverbMix > 0.01) {
        let sL = 0;
        let sR = 0;
        for (let k = 0; k < 4; k++) {
          sL += this.combsL[k].run(yL, revFb, 0.38);
          sR += this.combsR[k].run(yR, revFb, 0.38);
        }
        sL *= 0.25;
        sR *= 0.25;
        for (let k = 0; k < 2; k++) {
          sL = this.apsL[k].run(sL);
          sR = this.apsR[k].run(sR);
        }
        fxL += Math.tanh(sL * 0.85) * this.reverbMix * 0.42;
        fxR += Math.tanh(sR * 0.85) * this.reverbMix * 0.42;
      }

      // 9. Smoothed Stereo Delay with feedback soft-saturation
      this.smoothDelaySmp += (targetDelSmp - this.smoothDelaySmp) * 0.002;
      const delSmp = this.smoothDelaySmp | 0;
      const rIdx = (this.delayWp - delSmp + this.delayMax) % this.delayMax;
      const eL = this.delayBufL[rIdx];
      const eR = this.delayBufR[rIdx];
      this.delayBufL[this.delayWp] = Math.tanh((yL + eR * fb) * 0.9);
      this.delayBufR[this.delayWp] = Math.tanh((yR + eL * fb) * 0.9);
      if (++this.delayWp >= this.delayMax) this.delayWp = 0;

      if (this.delayMix > 0.01) {
        fxL += eL * this.delayMix * 0.48;
        fxR += eR * this.delayMix * 0.48;
      }

      // Soft-clipped vocal bus output (clean headroom, never digital harsh clipping)
      outL[i] = Math.tanh((yL + fxL) * 0.85);
      if (outR !== outL) outR[i] = Math.tanh((yR + fxR) * 0.85);
    }

    if (this.postTelemetry) {
      this.telemCountdown += n;
      if (this.telemCountdown >= 1280) {
        this.port.postMessage({
          type: 'telemetry',
          det: this.detNote,
          cor: this.corNote,
          voiced: this.voiced,
          inPk: this.inPk,
          grDb: this.grDb,
          sr: this.sr,
        });
        this.inPk = 0;
        this.telemCountdown = 0;
      }
    }

    return true;
  }
}

registerProcessor('voxora-processor', VoxoraStudioProcessor);
