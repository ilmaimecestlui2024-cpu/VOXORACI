import {
  MasterSettings,
  VocalSettings,
  encodeStereoWav,
  getScaleMask,
} from './constants';

export interface RenderTrackInput {
  id: string;
  name: string;
  buffer: AudioBuffer;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  offsetMs: number;
  fxEnabled: boolean;
}

class OfflineBiquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; z1 = 0; z2 = 0;
  run(x: number): number {
    const y = this.b0 * x + this.z1;
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
  set(type: number, fs: number, f0: number, db: number, q: number) {
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
    } else if (type === 3) {
      B0 = (1 + c) * 0.5; B1 = -(1 + c); B2 = (1 + c) * 0.5;
      A0 = 1 + al; A1 = -2 * c; A2 = 1 - al;
    } else {
      B0 = al; B1 = 0; B2 = -al; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al;
    }
    this.b0 = B0 / A0; this.b1 = B1 / A0; this.b2 = B2 / A0;
    this.a1 = A1 / A0; this.a2 = A2 / A0;
  }
}

class OfflineVocalChain {
  private sr: number;
  private N: number;
  private H: number;
  private D: number;
  private W = 512;
  private tMax: number;
  private tMin: number;
  private L: number;

  private hist = new Float32Array(65536);
  private wp = 0;
  private sh = 0;
  private ph = 0;
  private sm = 0;
  private ss = 0;
  private wetMix = 0;
  private pk = 0;
  private mi = 0;
  private mh = new Float32Array(5);
  private ds = new Float32Array(1200);
  private yin = new Float32Array(512);

  private hpIn = new OfflineBiquad();
  private deessBand = new OfflineBiquad();
  private eqL = new OfflineBiquad();
  private eqM = new OfflineBiquad();
  private eqH = new OfflineBiquad();
  private fmt1 = new OfflineBiquad();
  private fmt2 = new OfflineBiquad();

  private gateEnv = 0;
  private gateGain = 1;
  private compEnv = 0;
  private deessEnv = 0;
  private deessGain = 1;

  private dblL: Float32Array;
  private dblR: Float32Array;
  private dblWp = 0;
  private dblPhase = 0;

  private combsL: { buf: Float32Array; idx: number; lp: number }[];
  private combsR: { buf: Float32Array; idx: number; lp: number }[];
  private apsL: { buf: Float32Array; idx: number }[];
  private apsR: { buf: Float32Array; idx: number }[];

  private delL: Float32Array;
  private delR: Float32Array;
  private delWp = 0;
  private mask: number;

  constructor(sr: number, private p: VocalSettings) {
    this.sr = sr;
    this.N = Math.max(256, Math.round(0.024 * sr));
    this.H = this.N >> 1;
    this.D = Math.max(2, Math.round(sr / 12000));
    this.tMax = Math.min(480, Math.floor(sr / this.D / 75));
    this.tMin = Math.max(2, Math.floor(sr / this.D / 850));
    this.L = this.W + this.tMax + 1;
    this.mask = getScaleMask(p.scale);

    this.hpIn.set(3, sr, 80, 0, 0.707);
    this.deessBand.set(4, sr, 6800, 0, 1.2);
    this.eqL.set(0, sr, 150, p.eqLowDb, 0.707);
    this.eqM.set(1, sr, p.eqMidFreq, p.eqMidDb, 0.9);
    this.eqH.set(2, sr, 9500, p.eqHighDb, 0.707);
    const fTarget = Math.max(320, Math.min(2800, 950 * Math.pow(2, p.formant / 12)));
    this.fmt1.set(1, sr, fTarget, p.formant * 0.5, 1.1);
    this.fmt2.set(2, sr, 2600, p.formant * 0.4, 0.707);

    const dSz = Math.round(0.06 * sr) + 64;
    this.dblL = new Float32Array(dSz);
    this.dblR = new Float32Array(dSz);

    const sc = sr / 44100;
    this.combsL = [1557, 1617, 1491, 1422].map((c) => ({ buf: new Float32Array(Math.round(c * sc)), idx: 0, lp: 0 }));
    this.combsR = [1580, 1642, 1514, 1445].map((c) => ({ buf: new Float32Array(Math.round(c * sc)), idx: 0, lp: 0 }));
    this.apsL = [225, 556].map((a) => ({ buf: new Float32Array(Math.round(a * sc)), idx: 0 }));
    this.apsR = [225, 556].map((a) => ({ buf: new Float32Array(Math.round(a * sc)), idx: 0 }));

    this.delL = new Float32Array(sr * 2);
    this.delR = new Float32Array(sr * 2);
  }

  private rd(d: number): number {
    const id = d | 0;
    const fr = d - id;
    const cur = (this.wp - 2) >>> 0;
    const y0 = this.hist[(cur - id + 1) & 65535];
    const y1 = this.hist[(cur - id) & 65535];
    const y2 = this.hist[(cur - id - 1) & 65535];
    const y3 = this.hist[(cur - id - 2) & 65535];
    const c0 = y1;
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * fr + c2) * fr + c1) * fr + c0;
  }

  private analyze() {
    const base = (this.wp - this.L * this.D) >>> 0;
    for (let k = 0; k < this.L; k++) {
      let s = 0;
      const off = base + k * this.D;
      for (let j = 0; j < this.D; j++) s += this.hist[(off + j) & 65535];
      this.ds[k] = s / this.D;
    }
    let e = 0;
    for (let j = 0; j < this.W; j++) e += this.ds[j] * this.ds[j];
    const rms = Math.sqrt(e / this.W);
    this.pk = Math.max(this.pk * 0.9995, rms);

    let voiced = false;
    let m = 0;
    const gateLin = Math.max(Math.pow(10, this.p.gateThreshDb / 20), 0.04 * this.pk);
    if (rms >= gateLin) {
      let run = 0;
      for (let t = 1; t <= this.tMax; t++) {
        let a = 0;
        for (let j = 0; j < this.W; j++) {
          const q = this.ds[j] - this.ds[j + t];
          a += q * q;
        }
        run += a;
        this.yin[t] = (a * t) / (run > 0 ? run : 1);
      }
      let t = this.tMin;
      while (t < this.tMax) {
        if (this.yin[t] < 0.15) {
          while (t + 1 < this.tMax && this.yin[t + 1] < this.yin[t]) t++;
          break;
        }
        t++;
      }
      if (t < this.tMax) {
        const a = this.yin[t - 1], b = this.yin[t], c = this.yin[t + 1];
        const den = a - 2 * b + c;
        const tt = den !== 0 ? t + (a - c) / (2 * den) : t;
        const freq = this.sr / this.D / tt;
        if (freq > 65 && freq < 950) {
          m = 69 + 12 * Math.log2(freq / 440);
          voiced = true;
        }
      }
    }

    this.mh[this.mi++ % 5] = voiced ? m : 0;
    const v: number[] = [];
    for (let i = 0; i < 5; i++) if (this.mh[i] > 0) v.push(this.mh[i]);
    if (!voiced || v.length < 2) {
      voiced = false;
    } else {
      v.sort((a, b) => a - b);
      m = v[v.length >> 1];
    }

    let want = this.p.transpose;
    let al = 0.15;
    if (voiced) {
      const b0 = Math.round(m);
      let best = m, bd = 1e9;
      for (let k = -6; k <= 6; k++) {
        const cn = b0 + k;
        const rel = (((cn - this.p.key) % 12) + 12) % 12;
        if ((this.mask >> rel) & 1) {
          const dd = Math.abs(cn - m);
          if (dd < bd) { bd = dd; best = cn; }
        }
      }
      want = (best - m) * (this.p.tuneAmt / 100) + this.p.transpose;
      const spd = this.p.tuneSpeed / 100;
      al = 0.04 + 0.96 * spd * spd;
    }
    al = 1 - Math.sqrt(1 - Math.max(0.01, Math.min(0.999, al)));
    this.sm += (want - this.sm) * al;
  }

  processSample(rawIn: number): [number, number] {
    if (!Number.isFinite(rawIn)) rawIn = 0;
    const cleanIn = this.hpIn.run(rawIn);
    if (this.p.bypass) return [cleanIn, cleanIn];

    const gAtk = 1 - Math.exp(-1 / (Math.max(0.5, this.p.gateAttackMs) * 0.001 * this.sr));
    const gRel = 1 - Math.exp(-1 / (Math.max(5, this.p.gateReleaseMs) * 0.001 * this.sr));
    let x = cleanIn;
    const ax = Math.abs(x);
    this.gateEnv += (ax - this.gateEnv) * (ax > this.gateEnv ? gAtk : gRel);
    const tg = this.gateEnv >= Math.pow(10, this.p.gateThreshDb / 20) ? 1 : 0.01;
    this.gateGain += (tg - this.gateGain) * (tg > this.gateGain ? gAtk : gRel);
    x *= this.gateGain;

    this.hist[this.wp & 65535] = x;
    this.wp = (this.wp + 1) >>> 0;
    if (++this.sh >= 256) {
      this.sh = 0;
      this.analyze();
    }

    this.ss += (this.sm - this.ss) * 0.004;
    const absShift = Math.abs(this.ss);
    const targetWet =
      this.p.tuneAmt < 1 && Math.abs(this.p.transpose) < 0.05
        ? 0
        : absShift < 0.03
        ? 0
        : Math.min(1, (absShift - 0.03) * 10);
    this.wetMix += (targetWet - this.wetMix) * 0.005;

    const dry = this.hist[(this.wp - 2 - this.H) & 65535];
    let y = dry;
    if (this.wetMix >= 0.001) {
      const r = Math.pow(2, Math.max(-24, Math.min(24, this.ss)) / 12);
      this.ph += (1 - r) / this.N;
      this.ph -= Math.floor(this.ph);
      let f2 = this.ph + 0.5;
      if (f2 >= 1) f2 -= 1;
      let w1 = Math.sin(3.14159265359 * this.ph);
      w1 *= w1;
      const wet = this.rd(this.ph * this.N) * w1 + this.rd(f2 * this.N) * (1 - w1);
      y = dry * (1 - this.wetMix) + wet * this.wetMix;
    }

    if (Math.abs(this.p.formant) > 0.1) y = this.fmt2.run(this.fmt1.run(y));

    const deess = this.p.deesser / 100;
    if (deess > 0.01) {
      const sibBand = this.deessBand.run(y);
      const sibAbs = Math.abs(sibBand);
      this.deessEnv += (sibAbs - this.deessEnv) * (sibAbs > this.deessEnv ? 0.03 : 0.0015);
      const thr = 0.045 * (1.1 - deess * 0.85);
      let targetDuck = 1.0;
      if (this.deessEnv > thr) {
        const ratio = thr / (this.deessEnv + 1e-7);
        targetDuck = Math.max(0.25, 1.0 - (1.0 - ratio) * deess * 0.9);
      }
      this.deessGain += (targetDuck - this.deessGain) * 0.02;
      y -= sibBand * (1.0 - this.deessGain);
    }

    y = this.eqH.run(this.eqM.run(this.eqL.run(y)));

    const cAtk = 1 - Math.exp(-1 / (Math.max(0.5, this.p.compAttackMs) * 0.001 * this.sr));
    const cRel = 1 - Math.exp(-1 / (Math.max(10, this.p.compReleaseMs) * 0.001 * this.sr));
    const ay = Math.abs(y);
    this.compEnv += (ay - this.compEnv) * (ay > this.compEnv ? cAtk : cRel);
    const over = 20 * Math.log10(this.compEnv + 1e-7) - this.p.compThreshDb;
    const gr = over > 0 ? -over * (1 - 1 / Math.max(1, this.p.compRatio)) : 0;
    y *= Math.pow(10, (gr + this.p.compMakeupDb) / 20);
    y = Math.tanh(y * 0.85) * 1.08;

    let yL = y, yR = y;
    const dSize = this.dblL.length;
    this.dblL[this.dblWp] = y;
    this.dblR[this.dblWp] = y;
    const dblMix = this.p.doubler / 100;
    if (dblMix > 0.01) {
      this.dblPhase += 0.65 / this.sr;
      if (this.dblPhase >= 1) this.dblPhase -= 1;
      const lfo = Math.sin(6.28318530718 * this.dblPhase);
      const rdDbl = (buf: Float32Array, d: number) => {
        const id = d | 0;
        const fr = d - id;
        return buf[(this.dblWp - id + dSize) % dSize] * (1 - fr) + buf[(this.dblWp - id - 1 + dSize) % dSize] * fr;
      };
      const wL = rdDbl(this.dblL, (0.014 + 0.0035 * lfo) * this.sr);
      const wR = rdDbl(this.dblR, (0.021 - 0.0035 * lfo) * this.sr);
      const m = dblMix * 0.5;
      yL = yL * (1 - m * 0.3) + wL * m;
      yR = yR * (1 - m * 0.3) + wR * m;
    }
    if (++this.dblWp >= dSize) this.dblWp = 0;

    let fxL = 0, fxR = 0;
    const revMix = this.p.reverbMix / 100;
    if (revMix > 0.01) {
      const revFb = 0.7 + (this.p.reverbSize / 100) * 0.2;
      let sL = 0, sR = 0;
      for (let k = 0; k < 4; k++) {
        const cL = this.combsL[k];
        const outC = cL.buf[cL.idx];
        cL.lp = outC * 0.65 + cL.lp * 0.35;
        cL.buf[cL.idx] = yL + cL.lp * revFb;
        if (++cL.idx >= cL.buf.length) cL.idx = 0;
        sL += outC;

        const cR = this.combsR[k];
        const outCR = cR.buf[cR.idx];
        cR.lp = outCR * 0.65 + cR.lp * 0.35;
        cR.buf[cR.idx] = yR + cR.lp * revFb;
        if (++cR.idx >= cR.buf.length) cR.idx = 0;
        sR += outCR;
      }
      sL *= 0.25; sR *= 0.25;
      for (let k = 0; k < 2; k++) {
        const aL = this.apsL[k];
        const oAL = aL.buf[aL.idx];
        aL.buf[aL.idx] = sL + oAL * 0.5;
        if (++aL.idx >= aL.buf.length) aL.idx = 0;
        sL = -sL + oAL;

        const aR = this.apsR[k];
        const oAR = aR.buf[aR.idx];
        aR.buf[aR.idx] = sR + oAR * 0.5;
        if (++aR.idx >= aR.buf.length) aR.idx = 0;
        sR = -sR + oAR;
      }
      fxL += sL * revMix * 0.45;
      fxR += sR * revMix * 0.45;
    }

    const delMax = this.delL.length;
    const delSmp = Math.max(64, Math.min(delMax - 2, Math.round(this.p.delayMs * 0.001 * this.sr)));
    const rIdx = (this.delWp - delSmp + delMax) % delMax;
    const eL = this.delL[rIdx];
    const eR = this.delR[rIdx];
    const fb = Math.max(0, Math.min(0.82, this.p.delayFb / 100));
    this.delL[this.delWp] = yL + eR * fb;
    this.delR[this.delWp] = yR + eL * fb;
    if (++this.delWp >= delMax) this.delWp = 0;
    const delMix = this.p.delayMix / 100;
    if (delMix > 0.01) {
      fxL += eL * delMix * 0.5;
      fxR += eR * delMix * 0.5;
    }

    return [Math.tanh((yL + fxL) * 0.88), Math.tanh((yR + fxR) * 0.88)];
  }
}

class OfflineMasterChain {
  private eqLowL = new OfflineBiquad();
  private eqLowR = new OfflineBiquad();
  private eqHighL = new OfflineBiquad();
  private eqHighR = new OfflineBiquad();
  private excHpL = new OfflineBiquad();
  private excHpR = new OfflineBiquad();
  private atkGlue: number;
  private relGlue: number;
  private atkLim: number;
  private relLim: number;
  private glueEnv = 0;
  private limGain = 1;
  private lookBufL: Float32Array;
  private lookBufR: Float32Array;
  private lookIdx = 0;

  constructor(sr: number, private m: MasterSettings) {
    this.eqLowL.set(0, sr, 65, m.eqLowDb, 0.707);
    this.eqLowR.set(0, sr, 65, m.eqLowDb, 0.707);
    this.eqHighL.set(2, sr, 12000, m.eqHighDb, 0.707);
    this.eqHighR.set(2, sr, 12000, m.eqHighDb, 0.707);
    this.excHpL.set(3, sr, 3500, 0, 0.707);
    this.excHpR.set(3, sr, 3500, 0, 0.707);
    this.atkGlue = 1 - Math.exp(-1 / (0.015 * sr));
    this.relGlue = 1 - Math.exp(-1 / (0.2 * sr));

    const lookLen = Math.max(16, Math.round(0.0025 * sr));
    this.lookBufL = new Float32Array(lookLen);
    this.lookBufR = new Float32Array(lookLen);
    this.atkLim = 1 - Math.exp(-1 / (0.0012 * sr));
    this.relLim = 1 - Math.exp(-1 / (0.09 * sr));
  }

  processSample(L: number, R: number): [number, number] {
    if (!Number.isFinite(L)) L = 0;
    if (!Number.isFinite(R)) R = 0;
    if (this.m.bypass) {
      return [Math.tanh(L * 0.9), Math.tanh(R * 0.9)];
    }
    L = this.eqHighL.run(this.eqLowL.run(L));
    R = this.eqHighR.run(this.eqLowR.run(R));

    const pk = Math.max(Math.abs(L), Math.abs(R));
    this.glueEnv += (pk - this.glueEnv) * (pk > this.glueEnv ? this.atkGlue : this.relGlue);
    const over = 20 * Math.log10(this.glueEnv + 1e-7) - this.m.glueThreshDb;
    const gMix = this.m.glueMix / 100;
    if (over > 0 && gMix > 0.01) {
      const gr = -over * (1 - 1 / Math.max(1, this.m.glueRatio));
      const g = Math.pow(10, gr / 20);
      L = L * (1 - gMix) + L * g * gMix;
      R = R * (1 - gMix) + R * g * gMix;
    }

    const exc = this.m.exciter / 100;
    if (exc > 0.01) {
      L += Math.tanh(this.excHpL.run(L) * (1 + exc * 3)) * exc * 0.2;
      R += Math.tanh(this.excHpR.run(R) * (1 + exc * 3)) * exc * 0.2;
    }

    const mid = (L + R) * 0.5;
    const side = (L - R) * 0.5 * (this.m.stereoWidth / 100);
    const drive = Math.pow(10, this.m.limiterDriveDb / 20);
    L = Math.tanh(((mid + side) * drive) * 0.72) / 0.72;
    R = Math.tanh(((mid - side) * drive) * 0.72) / 0.72;

    const delL = this.lookBufL[this.lookIdx];
    const delR = this.lookBufR[this.lookIdx];
    this.lookBufL[this.lookIdx] = L;
    this.lookBufR[this.lookIdx] = R;
    if (++this.lookIdx >= this.lookBufL.length) this.lookIdx = 0;

    const ceilLin = Math.pow(10, Math.max(-6, Math.min(-0.1, this.m.limiterCeilingDb)) / 20);
    const spk = Math.max(Math.abs(L), Math.abs(R));
    const tg = spk > ceilLin ? ceilLin / spk : 1;
    this.limGain += (tg - this.limGain) * (tg < this.limGain ? this.atkLim : this.relLim);
    return [
      Math.max(-ceilLin, Math.min(ceilLin, delL * this.limGain)),
      Math.max(-ceilLin, Math.min(ceilLin, delR * this.limGain)),
    ];
  }
}

export async function renderMultiTrackOffline(
  tracks: RenderTrackInput[],
  vocalSettings: VocalSettings,
  masterSettings: MasterSettings,
  sampleRate: number,
  format: 'wav16' | 'wav24',
  onProgress: (pct: number) => void
): Promise<Blob> {
  const anySolo = tracks.some((t) => t.solo);
  const active = tracks.filter((t) => !t.mute && (!anySolo || t.solo));

  let maxFrames = 0;
  const prepared = active.map((t) => {
    const offFrames = Math.round((t.offsetMs / 1000) * sampleRate);
    const end = Math.max(0, t.buffer.length + offFrames);
    if (end > maxFrames) maxFrames = end;
    const ch0 = t.buffer.getChannelData(0);
    const ch1 = t.buffer.numberOfChannels > 1 ? t.buffer.getChannelData(1) : ch0;
    return {
      track: t,
      offFrames,
      ch0,
      ch1,
      vocalChain: t.fxEnabled ? new OfflineVocalChain(sampleRate, vocalSettings) : null,
    };
  });

  if (maxFrames <= 0) {
    return encodeStereoWav(new Float32Array(sampleRate), new Float32Array(sampleRate), sampleRate, 16);
  }

  const outL = new Float32Array(maxFrames);
  const outR = new Float32Array(maxFrames);
  const master = new OfflineMasterChain(sampleRate, masterSettings);

  const chunkSize = 8192;
  for (let start = 0; start < maxFrames; start += chunkSize) {
    const end = Math.min(maxFrames, start + chunkSize);
    for (let i = start; i < end; i++) {
      let sumL = 0;
      let sumR = 0;
      for (let k = 0; k < prepared.length; k++) {
        const pt = prepared[k];
        const idx = i - pt.offFrames;
        let sL = 0;
        let sR = 0;
        if (idx >= 0 && idx < pt.ch0.length) {
          sL = pt.ch0[idx];
          sR = pt.ch1[idx];
        }
        if (pt.vocalChain) {
          const [pL, pR] = pt.vocalChain.processSample((sL + sR) * 0.5);
          sL = pL;
          sR = pR;
        }
        const gL = pt.track.volume * Math.max(0, Math.min(1, 1 - pt.track.pan));
        const gR = pt.track.volume * Math.max(0, Math.min(1, 1 + pt.track.pan));
        sumL += sL * gL * 0.78;
        sumR += sR * gR * 0.78;
      }
      const [mL, mR] = master.processSample(sumL, sumR);
      outL[i] = mL;
      outR[i] = mR;
    }
    onProgress(end / maxFrames);
    await new Promise((r) => setTimeout(r, 0));
  }

  return encodeStereoWav(outL, outR, sampleRate, format === 'wav24' ? 24 : 16);
}
