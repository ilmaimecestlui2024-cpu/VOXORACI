// Voxora Studio — Moteur Audio Natif Temps Réel & Hors-Ligne (C++17 / Oboe / MediaNDK)
// Architecture temps réel sans allocation ni verrou bloquant dans onAudioReady.
// Streaming disque illimité pour multi-piste, chaîne vocale complète et bus de masterisation.

#include <oboe/Oboe.h>
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaExtractor.h>
#include <media/NdkMediaFormat.h>
#include <media/NdkMediaMuxer.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

using namespace oboe;

namespace {

constexpr int kTargetSr = 48000;
constexpr uint32_t kTrackRingFrames = 32768;  // ~682ms stereo streaming buffer per track
constexpr uint32_t kRecRingFrames = 65536;    // ~1.36s capture ring buffer

inline float clampf(float x, float lo, float hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

inline float dbToLin(float db) {
  return powf(10.f, db / 20.f);
}

inline float linToDb(float lin) {
  return 20.f * log10f(fmaxf(lin, 1e-7f));
}

// ---------- Filtre Biquad RBJ ----------
struct Biquad {
  float b0 = 1.f, b1 = 0.f, b2 = 0.f, a1 = 0.f, a2 = 0.f;
  float z1 = 0.f, z2 = 0.f;

  void reset() { z1 = z2 = 0.f; }

  inline float run(float x) {
    if (!std::isfinite(x)) return 0.f;
    float y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    if (fabsf(z1) < 1e-18f) z1 = 0.f;
    if (fabsf(z2) < 1e-18f) z2 = 0.f;
    return std::isfinite(y) ? y : 0.f;
  }

  // type: 0 = lowShelf, 1 = peaking, 2 = highShelf, 3 = highPass, 4 = bandPass
  void set(int type, float fs, float f0, float db, float q) {
    f0 = clampf(f0, 20.f, fs * 0.45f);
    q = fmaxf(q, 0.1f);
    float A = powf(10.f, db / 40.f);
    float w = 6.28318530718f * f0 / fs;
    float c = cosf(w), s = sinf(w);
    float al = s / (2.f * q);
    float sq = 2.f * sqrtf(A) * al;
    float B0 = 1.f, B1 = 0.f, B2 = 0.f, A0 = 1.f, A1 = 0.f, A2 = 0.f;

    if (type == 0) {
      B0 = A * ((A + 1.f) - (A - 1.f) * c + sq);
      B1 = 2.f * A * ((A - 1.f) - (A + 1.f) * c);
      B2 = A * ((A + 1.f) - (A - 1.f) * c - sq);
      A0 = (A + 1.f) + (A - 1.f) * c + sq;
      A1 = -2.f * ((A - 1.f) + (A + 1.f) * c);
      A2 = (A + 1.f) + (A - 1.f) * c - sq;
    } else if (type == 1) {
      B0 = 1.f + al * A;
      B1 = -2.f * c;
      B2 = 1.f - al * A;
      A0 = 1.f + al / A;
      A1 = -2.f * c;
      A2 = 1.f - al / A;
    } else if (type == 2) {
      B0 = A * ((A + 1.f) + (A - 1.f) * c + sq);
      B1 = -2.f * A * ((A - 1.f) + (A + 1.f) * c);
      B2 = A * ((A + 1.f) + (A - 1.f) * c - sq);
      A0 = (A + 1.f) - (A - 1.f) * c + sq;
      A1 = 2.f * ((A - 1.f) - (A + 1.f) * c);
      A2 = (A + 1.f) - (A - 1.f) * c - sq;
    } else if (type == 3) {
      B0 = (1.f + c) * 0.5f;
      B1 = -(1.f + c);
      B2 = (1.f + c) * 0.5f;
      A0 = 1.f + al;
      A1 = -2.f * c;
      A2 = 1.f - al;
    } else {
      B0 = al;
      B1 = 0.f;
      B2 = -al;
      A0 = 1.f + al;
      A1 = -2.f * c;
      A2 = 1.f - al;
    }
    b0 = B0 / A0;
    b1 = B1 / A0;
    b2 = B2 / A0;
    a1 = A1 / A0;
    a2 = A2 / A0;
  }
};

struct CombFilter {
  std::vector<float> buf;
  int idx = 0;
  float lp = 0.f;
  void init(int n) {
    buf.assign(std::max(16, n), 0.f);
    idx = 0;
    lp = 0.f;
  }
  void clear() {
    std::fill(buf.begin(), buf.end(), 0.f);
    idx = 0;
    lp = 0.f;
  }
  inline float run(float x, float fb, float damp) {
    float y = buf[idx];
    lp = y * (1.f - damp) + lp * damp;
    if (fabsf(lp) < 1e-18f) lp = 0.f;
    float nxt = x + lp * fb;
    buf[idx] = fabsf(nxt) < 1e-18f ? 0.f : nxt;
    if (++idx >= (int)buf.size()) idx = 0;
    return y;
  }
};

struct AllpassFilter {
  std::vector<float> buf;
  int idx = 0;
  void init(int n) {
    buf.assign(std::max(16, n), 0.f);
    idx = 0;
  }
  void clear() {
    std::fill(buf.begin(), buf.end(), 0.f);
    idx = 0;
  }
  inline float run(float x) {
    float y = buf[idx];
    buf[idx] = x + y * 0.5f;
    if (++idx >= (int)buf.size()) idx = 0;
    return -x + y;
  }
};

// ---------- Paramètres DSP partagés ----------
struct VocalParams {
  int key = 0;
  int mask = 0xFFF;
  float tuneAmt = 0.65f;
  float tuneSpd = 0.50f;
  float transpose = 0.f;
  float formant = 0.f;      // -12 .. +12 demi-tons

  float gateThreshDb = -52.f;
  float gateAttackMs = 5.f;
  float gateReleaseMs = 120.f;

  float deesserAmt = 0.25f;

  float eqLowDb = 2.f;
  float eqMidDb = 3.f;
  float eqMidFreq = 3200.f;
  float eqHighDb = 4.f;

  float compThreshDb = -18.f;
  float compRatio = 3.5f;
  float compAttackMs = 5.f;
  float compReleaseMs = 140.f;
  float compMakeupDb = 3.f;

  float doublerMix = 0.15f;
  float reverbSize = 0.55f;
  float reverbMix = 0.22f;
  float delayMs = 260.f;
  float delayFb = 0.35f;
  float delayMix = 0.0f;
  bool bypass = false;
};

struct MasterParams {
  float eqLowDb = 0.f;
  float eqHighDb = 1.f;
  float glueThreshDb = -14.f;
  float glueRatio = 2.5f;
  float glueMix = 0.35f;
  float exciterAmt = 0.15f;
  float stereoWidth = 1.08f;
  float limiterCeilingDb = -1.0f;
  float limiterDriveDb = 1.5f;
  bool bypass = false;
};

// ---------- Chaîne DSP Vocale Complète (Temps réel & Offline) ----------
class VocalDsp {
 public:
  void init(int sr) {
    sr_ = sr > 0 ? sr : kTargetSr;
    N_ = std::max(256, (int)(0.024f * sr_));
    H_ = N_ >> 1;
    D_ = std::max(2, (int)lroundf((float)sr_ / 12000.f));
    tMax_ = std::min(480, sr_ / D_ / 75);
    tMin_ = std::max(2, sr_ / D_ / 850);
    L_ = W_ + tMax_ + 1;

    hist_.assign(65536, 0.f);
    ds_.assign(1200, 0.f);
    yin_.assign(512, 0.f);
    delayBuf_.assign(sr_ * 2, 0.f);
    doublerBufL_.assign((int)(0.06f * sr_) + 64, 0.f);
    doublerBufR_.assign((int)(0.06f * sr_) + 64, 0.f);

    const float sc = (float)sr_ / 44100.f;
    const int csL[4] = {1557, 1617, 1491, 1422};
    const int csR[4] = {1580, 1642, 1514, 1445};
    const int as[2] = {225, 556};
    for (int k = 0; k < 4; ++k) {
      combL_[k].init((int)(csL[k] * sc));
      combR_[k].init((int)(csR[k] * sc));
    }
    for (int k = 0; k < 2; ++k) {
      apL_[k].init((int)(as[k] * sc));
      apR_[k].init((int)(as[k] * sc));
    }

    resetState();
    hpIn_.set(3, (float)sr_, 80.f, 0.f, 0.707f);
    deessBand_.set(4, (float)sr_, 6800.f, 0.f, 1.4f);
  }

  void resetState() {
    std::fill(hist_.begin(), hist_.end(), 0.f);
    std::fill(delayBuf_.begin(), delayBuf_.end(), 0.f);
    std::fill(doublerBufL_.begin(), doublerBufL_.end(), 0.f);
    std::fill(doublerBufR_.begin(), doublerBufR_.end(), 0.f);
    for (int k = 0; k < 4; ++k) { combL_[k].clear(); combR_[k].clear(); }
    for (int k = 0; k < 2; ++k) { apL_[k].clear(); apR_[k].clear(); }
    wp_ = 0; sh_ = 0; ph_ = 0.f; sm_ = 0.f; ss_ = 0.f; pk_ = 0.f; mi_ = 0; wetMix_ = 0.f;
    memset(mh_, 0, sizeof(mh_));
    gateEnv_ = 0.f; gateGain_ = 1.f;
    compEnv_ = 0.f; deessEnv_ = 0.f; deessGain_ = 1.f;
    dblPhase_ = 0.f; dblWp_ = 0; delayWp_ = 0; smoothDelaySmp_ = 0.26f * sr_;
    hpIn_.reset(); deessBand_.reset();
    eqL_.reset(); eqM_.reset(); eqH_.reset();
    fmt1_.reset(); fmt2_.reset();
    cb_ = cm_ = cmf_ = ch_ = cfmt_ = 1e9f;
    lastGrDb = 0.f; detMidi = 0.f; corMidi = 0.f;
  }

  void processSample(float inMono, const VocalParams& p, float& outL, float& outR) {
    if (!std::isfinite(inMono)) inMono = 0.f;
    if (p.bypass) {
      float safe = tanhf(inMono * 0.92f);
      outL = outR = safe;
      lastGrDb = 0.f;
      return;
    }

    updateFilters(p);

    // 1. Filtre coupe-bas 80 Hz anti-plop
    float x = hpIn_.run(inMono);

    // 2. Noise Gate
    float gAtk = 1.f - expf(-1.f / (fmaxf(0.5f, p.gateAttackMs) * 0.001f * sr_));
    float gRel = 1.f - expf(-1.f / (fmaxf(5.f, p.gateReleaseMs) * 0.001f * sr_));
    float absX = fabsf(x);
    gateEnv_ += (absX - gateEnv_) * (absX > gateEnv_ ? gAtk : gRel);
    float gateThr = dbToLin(p.gateThreshDb);
    float targetGate = gateEnv_ >= gateThr ? 1.f : 0.02f;
    gateGain_ += (targetGate - gateGain_) * (targetGate > gateGain_ ? gAtk : gRel);
    x *= gateGain_;

    // 3. Ring buffer + YIN + Pitch Shifter
    hist_[wp_ & kMask] = x;
    wp_++;
    if (++sh_ >= 256) {
      sh_ = 0;
      analyze(p);
    }
    float y = pitchShift(p);

    // 4. Formant / Timbre shaping
    if (fabsf(p.formant) > 0.1f) {
      y = fmt2_.run(fmt1_.run(y));
    }

    // 5. De-Esser dynamique sans recalcul par échantillon (split bande fixe 6.8 kHz)
    if (p.deesserAmt > 0.01f) {
      float sibBand = deessBand_.run(y);
      float sib = fabsf(sibBand);
      deessEnv_ += (sib - deessEnv_) * (sib > deessEnv_ ? 0.03f : 0.0015f);
      float thr = 0.045f * (1.1f - p.deesserAmt * 0.85f);
      float targetG = 1.f;
      if (deessEnv_ > thr) {
        float overDb = linToDb(deessEnv_) - linToDb(thr);
        float cutDb = clampf(overDb * 1.3f * p.deesserAmt, 0.f, 14.f);
        targetG = dbToLin(-cutDb);
      }
      deessGain_ += (targetG - deessGain_) * 0.04f;
      y -= (1.f - deessGain_) * sibBand;
    }

    // 6. EQ 3 bandes RBJ
    y = eqH_.run(eqM_.run(eqL_.run(y)));

    // 7. Compresseur vocal + Makeup
    float cAtk = 1.f - expf(-1.f / (fmaxf(0.5f, p.compAttackMs) * 0.001f * sr_));
    float cRel = 1.f - expf(-1.f / (fmaxf(10.f, p.compReleaseMs) * 0.001f * sr_));
    float ay = fabsf(y);
    compEnv_ += (ay - compEnv_) * (ay > compEnv_ ? cAtk : cRel);
    float over = linToDb(compEnv_) - p.compThreshDb;
    float gr = over > 0.f ? -over * (1.f - 1.f / fmaxf(1.f, p.compRatio)) : 0.f;
    lastGrDb = gr;
    y *= dbToLin(gr + p.compMakeupDb);

    // 8. Doubler / Chorus stéréo
    float yL = y, yR = y;
    int dSize = (int)doublerBufL_.size();
    doublerBufL_[dblWp_] = y;
    doublerBufR_[dblWp_] = y;
    if (p.doublerMix > 0.01f) {
      dblPhase_ += 0.65f / (float)sr_;
      if (dblPhase_ >= 1.f) dblPhase_ -= 1.f;
      float lfo = sinf(6.2831853f * dblPhase_);
      float d1 = (0.014f + 0.004f * lfo) * sr_;
      float d2 = (0.021f - 0.004f * lfo) * sr_;
      auto readDbl = [&](const std::vector<float>& buf, float d) {
        int id = (int)d;
        float fr = d - id;
        int i1 = (dblWp_ - id + dSize) % dSize;
        int i2 = (dblWp_ - id - 1 + dSize) % dSize;
        return buf[i1] * (1.f - fr) + buf[i2] * fr;
      };
      float wetL = readDbl(doublerBufL_, d1);
      float wetR = readDbl(doublerBufR_, d2);
      float m = p.doublerMix * 0.6f;
      yL = yL * (1.f - m * 0.35f) + wetL * m;
      yR = yR * (1.f - m * 0.35f) + wetR * m;
    }
    if (++dblWp_ >= dSize) dblWp_ = 0;

    // 9. Réverbération stéréo (Schroeder)
    float fxL = 0.f, fxR = 0.f;
    if (p.reverbMix > 0.01f) {
      float fb = 0.72f + p.reverbSize * 0.20f;
      float sL = 0.f, sR = 0.f;
      for (int k = 0; k < 4; ++k) {
        sL += combL_[k].run(yL, fb, 0.32f);
        sR += combR_[k].run(yR, fb, 0.32f);
      }
      sL *= 0.25f;
      sR *= 0.25f;
      for (int k = 0; k < 2; ++k) {
        sL = apL_[k].run(sL);
        sR = apR_[k].run(sR);
      }
      fxL += sL * p.reverbMix * 0.55f;
      fxR += sR * p.reverbMix * 0.55f;
    }

    // 10. Delay / Écho stéréo avec lissage du temps de delay
    int delMax = (int)delayBuf_.size() / 2;
    float targetDelSmp = clampf(p.delayMs * 0.001f * sr_, 64.f, (float)(delMax - 3));
    smoothDelaySmp_ += (targetDelSmp - smoothDelaySmp_) * 0.002f;
    int delI = (int)smoothDelaySmp_;
    float delFr = smoothDelaySmp_ - (float)delI;
    int rIdx1 = (delayWp_ - delI + delMax) % delMax;
    int rIdx2 = (delayWp_ - delI - 1 + delMax) % delMax;
    float eL = delayBuf_[rIdx1 * 2] * (1.f - delFr) + delayBuf_[rIdx2 * 2] * delFr;
    float eR = delayBuf_[rIdx1 * 2 + 1] * (1.f - delFr) + delayBuf_[rIdx2 * 2 + 1] * delFr;
    delayBuf_[delayWp_ * 2] = yL + eR * clampf(p.delayFb, 0.f, 0.85f);
    delayBuf_[delayWp_ * 2 + 1] = yR + eL * clampf(p.delayFb, 0.f, 0.85f);
    if (++delayWp_ >= delMax) delayWp_ = 0;

    if (p.delayMix > 0.01f) {
      fxL += eL * p.delayMix * 0.6f;
      fxR += eR * p.delayMix * 0.6f;
    }

    // Soft-saturation de protection en sortie vocale
    outL = tanhf((yL + fxL) * 0.88f);
    outR = tanhf((yR + fxR) * 0.88f);
  }

  float lastGrDb = 0.f;
  float detMidi = 0.f;
  float corMidi = 0.f;

 private:
  static constexpr unsigned kMask = 65535;

  void updateFilters(const VocalParams& p) {
    if (p.eqLowDb != cb_ || p.eqMidDb != cm_ || p.eqMidFreq != cmf_ || p.eqHighDb != ch_) {
      cb_ = p.eqLowDb;
      cm_ = p.eqMidDb;
      cmf_ = p.eqMidFreq;
      ch_ = p.eqHighDb;
      eqL_.set(0, (float)sr_, 150.f, cb_, 0.707f);
      eqM_.set(1, (float)sr_, cmf_, cm_, 0.9f);
      eqH_.set(2, (float)sr_, 9500.f, ch_, 0.707f);
    }
    if (p.formant != cfmt_) {
      cfmt_ = p.formant;
      // Formant timbre shifting via spectral envelope tilt & mid-formant shift
      float fShift = powf(2.f, cfmt_ / 12.f);
      float fTarget = clampf(950.f * fShift, 320.f, 2800.f);
      fmt1_.set(1, (float)sr_, fTarget, cfmt_ * 0.55f, 1.1f);
      fmt2_.set(2, (float)sr_, 2600.f, cfmt_ * 0.45f, 0.707f);
    }
  }

  inline float rd(float d) const {
    unsigned cur = wp_ - 2;
    unsigned id = (unsigned)d;
    float fr = d - (float)id;
    float y0 = hist_[(cur - id + 1) & kMask];
    float y1 = hist_[(cur - id) & kMask];
    float y2 = hist_[(cur - id - 1) & kMask];
    float y3 = hist_[(cur - id - 2) & kMask];
    float c0 = y1;
    float c1 = 0.5f * (y2 - y0);
    float c2 = y0 - 2.5f * y1 + 2.f * y2 - 0.5f * y3;
    float c3 = 0.5f * (y3 - y0) + 1.5f * (y1 - y2);
    return ((c3 * fr + c2) * fr + c1) * fr + c0;
  }

  float pitchShift(const VocalParams& p) {
    ss_ += (sm_ - ss_) * 0.004f;
    bool active = fabsf(ss_) >= 0.03f || fabsf(p.transpose) >= 0.03f;
    wetMix_ += ((active ? 1.f : 0.f) - wetMix_) * 0.005f;
    float dry = hist_[(wp_ - 2 - (unsigned)H_) & kMask];
    if (wetMix_ < 0.002f && !active) return dry;
    float r = exp2f(ss_ / 12.f);
    ph_ += (1.f - r) / (float)N_;
    ph_ -= floorf(ph_);
    float f2 = ph_ + 0.5f;
    if (f2 >= 1.f) f2 -= 1.f;
    float w1 = sinf(3.14159265f * ph_);
    w1 *= w1;
    float wet = rd(ph_ * N_) * w1 + rd(f2 * N_) * (1.f - w1);
    return dry * (1.f - wetMix_) + wet * wetMix_;
  }

  void analyze(const VocalParams& p) {
    if (L_ > (int)ds_.size() || tMax_ + 2 > (int)yin_.size()) return;
    unsigned base = wp_ - (unsigned)(L_ * D_);
    for (int k = 0; k < L_; ++k) {
      float s = 0.f;
      for (int j = 0; j < D_; ++j) s += hist_[(base + k * D_ + j) & kMask];
      ds_[k] = s / D_;
    }
    float e = 0.f;
    for (int j = 0; j < W_; ++j) e += ds_[j] * ds_[j];
    float rms = sqrtf(e / W_);
    pk_ = fmaxf(pk_ * 0.9995f, rms);
    bool voiced = false;
    float m = 0.f;
    float gateLin = fmaxf(dbToLin(p.gateThreshDb), 0.04f * pk_);
    if (rms >= gateLin) {
      float run = 0.f;
      for (int t = 1; t <= tMax_; ++t) {
        float a = 0.f;
        for (int j = 0; j < W_; ++j) {
          float q = ds_[j] - ds_[j + t];
          a += q * q;
        }
        run += a;
        yin_[t] = a * t / (run > 0.f ? run : 1.f);
      }
      int t = tMin_;
      while (t < tMax_) {
        if (yin_[t] < 0.15f) {
          while (t + 1 < tMax_ && yin_[t + 1] < yin_[t]) t++;
          break;
        }
        t++;
      }
      if (t < tMax_) {
        float a = yin_[t - 1], b = yin_[t], c = yin_[t + 1];
        float den = a - 2.f * b + c;
        float tt = den != 0.f ? t + (a - c) / (2.f * den) : (float)t;
        float freq = (float)sr_ / D_ / tt;
        if (freq > 65.f && freq < 950.f) {
          m = 69.f + 12.f * log2f(freq / 440.f);
          voiced = true;
        }
      }
    }

    mh_[mi_++ % 5] = voiced ? m : 0.f;
    float v[5];
    int cnt = 0;
    for (int i = 0; i < 5; ++i) if (mh_[i] > 0.f) v[cnt++] = mh_[i];
    if (!voiced || cnt < 2) {
      voiced = false;
    } else {
      std::sort(v, v + cnt);
      m = v[cnt >> 1];
    }

    float want = p.transpose, al = 0.15f;
    if (voiced) {
      int b0 = (int)lroundf(m);
      float best = m, bd = 1e9f;
      for (int k = -6; k <= 6; ++k) {
        int cn = b0 + k;
        int rel = (((cn - p.key) % 12) + 12) % 12;
        if ((p.mask >> rel) & 1) {
          float dd = fabsf((float)cn - m);
          if (dd < bd) { bd = dd; best = (float)cn; }
        }
      }
      want = (best - m) * p.tuneAmt + p.transpose;
      al = 0.04f + 0.96f * p.tuneSpd * p.tuneSpd;
    }
    al = 1.f - sqrtf(1.f - clampf(al, 0.01f, 0.999f));
    sm_ += (want - sm_) * al;
    detMidi = voiced ? m : 0.f;
    corMidi = voiced ? m + sm_ : 0.f;
  }

  int sr_ = kTargetSr, N_ = 1152, H_ = 576, D_ = 4, W_ = 512, tMax_ = 160, tMin_ = 15, L_ = 673;
  unsigned wp_ = 0;
  int sh_ = 0, mi_ = 0;
  float ph_ = 0.f, sm_ = 0.f, ss_ = 0.f, pk_ = 0.f, wetMix_ = 0.f;
  std::vector<float> hist_, ds_, yin_, delayBuf_, doublerBufL_, doublerBufR_;
  float mh_[5] = {0};
  float gateEnv_ = 0.f, gateGain_ = 1.f;
  float compEnv_ = 0.f, deessEnv_ = 0.f, deessGain_ = 1.f;
  float dblPhase_ = 0.f, smoothDelaySmp_ = 12480.f;
  int dblWp_ = 0, delayWp_ = 0;
  Biquad hpIn_, deessBand_, eqL_, eqM_, eqH_, fmt1_, fmt2_;
  CombFilter combL_[4], combR_[4];
  AllpassFilter apL_[2], apR_[2];
  float cb_ = 1e9f, cm_ = 1e9f, cmf_ = 1e9f, ch_ = 1e9f, cfmt_ = 1e9f;
};

// ---------- Bus de Masterisation (EQ + Glue Comp + Exciter + Stereo Imager + Brickwall Limiter) ----------
class MasterDsp {
 public:
  void init(int sr) {
    sr_ = sr > 0 ? sr : kTargetSr;
    lookLen_ = std::max(32, (int)(0.0025f * sr_));
    lookBufL_.assign(lookLen_, 0.f);
    lookBufR_.assign(lookLen_, 0.f);
    resetState();
    atkGlue_ = 1.f - expf(-1.f / (0.015f * sr_));
    relGlue_ = 1.f - expf(-1.f / (0.200f * sr_));
    atkLim_ = 1.f - expf(-1.f / (0.0005f * sr_));
    relLim_ = 1.f - expf(-1.f / (0.080f * sr_));
  }

  void resetState() {
    eqLowL_.reset(); eqLowR_.reset();
    eqHighL_.reset(); eqHighR_.reset();
    excHpL_.reset(); excHpR_.reset();
    excHpL_.set(3, (float)sr_, 3500.f, 0.f, 0.707f);
    excHpR_.set(3, (float)sr_, 3500.f, 0.f, 0.707f);
    std::fill(lookBufL_.begin(), lookBufL_.end(), 0.f);
    std::fill(lookBufR_.begin(), lookBufR_.end(), 0.f);
    lookIdx_ = 0;
    glueEnv_ = 0.f;
    limGain_ = 1.f;
    cl_ = ch_ = 1e9f;
    lastPeakLin = 0.f;
    lastRmsSq = 0.f;
  }

  void processSample(float inL, float inR, const MasterParams& p, float& outL, float& outR) {
    if (!std::isfinite(inL)) inL = 0.f;
    if (!std::isfinite(inR)) inR = 0.f;
    if (p.bypass) {
      outL = tanhf(inL * 0.90f);
      outR = tanhf(inR * 0.90f);
      lastPeakLin = fmaxf(fabsf(outL), fabsf(outR));
      lastRmsSq += ((outL * outL + outR * outR) * 0.5f - lastRmsSq) * 0.001f;
      return;
    }

    if (p.eqLowDb != cl_ || p.eqHighDb != ch_) {
      cl_ = p.eqLowDb;
      ch_ = p.eqHighDb;
      eqLowL_.set(0, (float)sr_, 65.f, cl_, 0.707f);
      eqLowR_.set(0, (float)sr_, 65.f, cl_, 0.707f);
      eqHighL_.set(2, (float)sr_, 12000.f, ch_, 0.707f);
      eqHighR_.set(2, (float)sr_, 12000.f, ch_, 0.707f);
    }

    float L = eqHighL_.run(eqLowL_.run(inL));
    float R = eqHighR_.run(eqLowR_.run(inR));

    // Glue Bus Compressor
    float pk = fmaxf(fabsf(L), fabsf(R));
    glueEnv_ += (pk - glueEnv_) * (pk > glueEnv_ ? atkGlue_ : relGlue_);
    float over = linToDb(glueEnv_) - p.glueThreshDb;
    if (over > 0.f && p.glueMix > 0.01f) {
      float gr = -over * (1.f - 1.f / fmaxf(1.f, p.glueRatio));
      float g = dbToLin(gr);
      float wetL = L * g, wetR = R * g;
      L = L * (1.f - p.glueMix) + wetL * p.glueMix;
      R = R * (1.f - p.glueMix) + wetR * p.glueMix;
    }

    // Harmonic Exciter (saturation douce bande haute)
    if (p.exciterAmt > 0.01f) {
      float hL = excHpL_.run(L);
      float hR = excHpR_.run(R);
      L += tanhf(hL * (1.f + p.exciterAmt * 4.f)) * p.exciterAmt * 0.22f;
      R += tanhf(hR * (1.f + p.exciterAmt * 4.f)) * p.exciterAmt * 0.22f;
    }

    // Stereo Imager (Mid/Side)
    float mid = (L + R) * 0.5f;
    float side = (L - R) * 0.5f * p.stereoWidth;
    L = mid + side;
    R = mid - side;

    // Soft-knee analog saturation + Lookahead Brickwall Limiter (2.5 ms)
    float drive = dbToLin(p.limiterDriveDb);
    L = tanhf(L * drive * 0.72f) / 0.72f;
    R = tanhf(R * drive * 0.72f) / 0.72f;

    float ceilLin = dbToLin(clampf(p.limiterCeilingDb, -6.f, -0.05f));
    float samplePk = fmaxf(fabsf(L), fabsf(R));
    float targetG = samplePk > ceilLin ? ceilLin / samplePk : 1.f;
    limGain_ += (targetG - limGain_) * (targetG < limGain_ ? atkLim_ : relLim_);

    float delL = lookBufL_[lookIdx_];
    float delR = lookBufR_[lookIdx_];
    lookBufL_[lookIdx_] = L;
    lookBufR_[lookIdx_] = R;
    if (++lookIdx_ >= lookLen_) lookIdx_ = 0;

    L = clampf(delL * limGain_, -ceilLin, ceilLin);
    R = clampf(delR * limGain_, -ceilLin, ceilLin);

    outL = L;
    outR = R;
    lastPeakLin = fmaxf(fabsf(L), fabsf(R));
    lastRmsSq += ((L * L + R * R) * 0.5f - lastRmsSq) * 0.001f;
  }

  float lastPeakLin = 0.f;
  float lastRmsSq = 0.f;

 private:
  int sr_ = kTargetSr, lookLen_ = 120, lookIdx_ = 0;
  std::vector<float> lookBufL_, lookBufR_;
  Biquad eqLowL_, eqLowR_, eqHighL_, eqHighR_, excHpL_, excHpR_;
  float cl_ = 1e9f, ch_ = 1e9f;
  float atkGlue_ = 0.001f, relGlue_ = 0.0001f, glueEnv_ = 0.f;
  float atkLim_ = 0.05f, relLim_ = 0.0005f, limGain_ = 1.f;
};

// ---------- Piste Multi-Piste avec Streaming Disque Sans Limite ----------
struct TrackSlot {
  int id = 0;
  std::string rawPath;
  int64_t totalFrames = 0;

  std::atomic<bool> active{true};
  std::atomic<bool> isVocal{false};
  std::atomic<bool> fxEnabled{false};
  std::atomic<bool> mute{false};
  std::atomic<bool> solo{false};
  std::atomic<float> volume{1.0f};
  std::atomic<float> pan{0.0f};
  std::atomic<float> offsetMs{0.0f};

  // Ring buffer stéréo alimenté par le thread lecteur disque (SPSC lock-free)
  std::vector<float> ring;
  std::atomic<uint32_t> rRead{0};
  std::atomic<uint32_t> rWrite{0};
  std::atomic<int64_t> diskFramePos{0};
  std::atomic<bool> seekPending{false};
  std::atomic<int64_t> seekTargetFrame{0};

  FILE* fp = nullptr;
  VocalDsp offlineVocalDsp;

  TrackSlot() : ring(kTrackRingFrames * 2, 0.f) {}
  ~TrackSlot() {
    if (fp) { fclose(fp); fp = nullptr; }
  }
};

// ---------- Importeur / Décodeur Streaming Disque (WAV + MediaNDK MP3/AAC/OGG/FLAC) ----------
static bool endsWithCI(const std::string& s, const char* suf) {
  size_t n = strlen(suf);
  if (s.size() < n) return false;
  for (size_t i = 0; i < n; ++i) {
    char a = (char)tolower((unsigned char)s[s.size() - n + i]);
    char b = (char)tolower((unsigned char)suf[i]);
    if (a != b) return false;
  }
  return true;
}

static bool importWavToRaw(const char* srcPath, const char* dstRawPath,
                           int64_t& outFrames, std::vector<float>& outPeaks) {
  FILE* in = fopen(srcPath, "rb");
  if (!in) return false;
  char riff[12];
  if (fread(riff, 1, 12, in) != 12 || memcmp(riff, "RIFF", 4) != 0 || memcmp(riff + 8, "WAVE", 4) != 0) {
    fclose(in);
    return false;
  }

  uint16_t audioFmt = 1, ch = 1, bits = 16;
  uint32_t sr = 48000, dataSize = 0;
  long dataOffset = 0;

  while (!feof(in)) {
    char id[4];
    uint32_t sz = 0;
    if (fread(id, 1, 4, in) != 4 || fread(&sz, 4, 1, in) != 1) break;
    if (memcmp(id, "fmt ", 4) == 0) {
      std::vector<uint8_t> fmt(sz);
      if (fread(fmt.data(), 1, sz, in) != sz) break;
      if (sz >= 16) {
        memcpy(&audioFmt, fmt.data(), 2);
        memcpy(&ch, fmt.data() + 2, 2);
        memcpy(&sr, fmt.data() + 4, 4);
        memcpy(&bits, fmt.data() + 14, 2);
      }
      if (sz & 1) fseek(in, 1, SEEK_CUR);
    } else if (memcmp(id, "data", 4) == 0) {
      dataOffset = ftell(in);
      dataSize = sz;
      break;
    } else {
      fseek(in, sz + (sz & 1), SEEK_CUR);
    }
  }

  if (dataOffset == 0 || dataSize == 0 || ch == 0 || sr == 0) {
    fclose(in);
    return false;
  }

  FILE* out = fopen(dstRawPath, "wb");
  if (!out) { fclose(in); return false; }

  int bytesPerSample = bits / 8;
  int frameBytes = bytesPerSample * ch;
  int64_t totalInFrames = dataSize / frameBytes;

  const size_t kChunkFrames = 4096;
  std::vector<uint8_t> rawBytes(kChunkFrames * frameBytes);
  std::vector<float> inStereo(kChunkFrames * 2);
  std::vector<float> resampOut;
  resampOut.reserve(kChunkFrames * 4);

  double ratio = (double)sr / (double)kTargetSr;
  double pos = 0.0;
  float prevL = 0.f, prevR = 0.f;
  int64_t framesWritten = 0;

  const int kNumPeaks = 512;
  outPeaks.assign(kNumPeaks, 0.f);
  int64_t estOutFrames = (int64_t)((double)totalInFrames / ratio) + 1;

  int64_t remaining = totalInFrames;
  while (remaining > 0) {
    size_t toRead = (size_t)std::min<int64_t>(remaining, kChunkFrames);
    size_t got = fread(rawBytes.data(), frameBytes, toRead, in);
    if (got == 0) break;
    remaining -= got;

    for (size_t i = 0; i < got; ++i) {
      float L = 0.f, R = 0.f;
      for (int c = 0; c < std::min<int>(ch, 2); ++c) {
        const uint8_t* ptr = rawBytes.data() + i * frameBytes + c * bytesPerSample;
        float val = 0.f;
        if (audioFmt == 3 && bits == 32) {
          memcpy(&val, ptr, 4);
        } else if (bits == 16) {
          int16_t s; memcpy(&s, ptr, 2); val = s / 32768.f;
        } else if (bits == 24) {
          int32_t s = (ptr[0] << 8) | (ptr[1] << 16) | (ptr[2] << 24);
          val = (float)s / 2147483648.f;
        } else if (bits == 32) {
          int32_t s; memcpy(&s, ptr, 4); val = (float)s / 2147483648.f;
        } else if (bits == 8) {
          val = ((int)ptr[0] - 128) / 128.f;
        }
        if (c == 0) L = val; else R = val;
      }
      if (ch == 1) R = L;
      inStereo[i * 2] = L;
      inStereo[i * 2 + 1] = R;
    }

    resampOut.clear();
    while (pos < (double)got) {
      int idx = (int)pos;
      float fr = (float)(pos - idx);
      float L0 = idx > 0 ? inStereo[(idx - 1) * 2] : prevL;
      float R0 = idx > 0 ? inStereo[(idx - 1) * 2 + 1] : prevR;
      float L1 = inStereo[idx * 2];
      float R1 = inStereo[idx * 2 + 1];
      float L = L0 * (1.f - fr) + L1 * fr;
      float R = R0 * (1.f - fr) + R1 * fr;
      resampOut.push_back(L);
      resampOut.push_back(R);

      int pkIdx = (int)((framesWritten * kNumPeaks) / std::max<int64_t>(1, estOutFrames));
      if (pkIdx >= 0 && pkIdx < kNumPeaks) {
        outPeaks[pkIdx] = fmaxf(outPeaks[pkIdx], fmaxf(fabsf(L), fabsf(R)));
      }
      framesWritten++;
      pos += ratio;
    }
    pos -= (double)got;
    prevL = inStereo[(got - 1) * 2];
    prevR = inStereo[(got - 1) * 2 + 1];

    if (!resampOut.empty()) {
      fwrite(resampOut.data(), sizeof(float), resampOut.size(), out);
    }
  }

  fclose(in);
  fclose(out);
  outFrames = framesWritten;
  return framesWritten > 0;
}

static bool importMediaNdkToRaw(const char* srcPath, const char* dstRawPath,
                                int64_t& outFrames, std::vector<float>& outPeaks) {
  int fd = open(srcPath, O_RDONLY);
  if (fd < 0) return false;
  off_t fileSize = lseek(fd, 0, SEEK_END);
  lseek(fd, 0, SEEK_SET);

  AMediaExtractor* ex = AMediaExtractor_new();
  if (!ex) { close(fd); return false; }
  if (AMediaExtractor_setDataSourceFd(ex, fd, 0, fileSize) != AMEDIA_OK) {
    AMediaExtractor_delete(ex);
    close(fd);
    return false;
  }

  int numTracks = (int)AMediaExtractor_getTrackCount(ex);
  int audioTrack = -1;
  AMediaFormat* fmt = nullptr;
  const char* mime = nullptr;

  for (int i = 0; i < numTracks; ++i) {
    AMediaFormat* f = AMediaExtractor_getTrackFormat(ex, i);
    const char* m = nullptr;
    if (f && AMediaFormat_getString(f, AMEDIAFORMAT_KEY_MIME, &m) && m && strncmp(m, "audio/", 6) == 0) {
      audioTrack = i;
      fmt = f;
      mime = m;
      break;
    }
    if (f) AMediaFormat_delete(f);
  }

  if (audioTrack < 0 || !fmt || !mime) {
    AMediaExtractor_delete(ex);
    close(fd);
    return false;
  }

  AMediaExtractor_selectTrack(ex, audioTrack);
  int32_t sr = 44100, ch = 2;
  AMediaFormat_getInt32(fmt, AMEDIAFORMAT_KEY_SAMPLE_RATE, &sr);
  AMediaFormat_getInt32(fmt, AMEDIAFORMAT_KEY_CHANNEL_COUNT, &ch);
  int64_t durationUs = 0;
  AMediaFormat_getInt64(fmt, AMEDIAFORMAT_KEY_DURATION, &durationUs);

  AMediaCodec* codec = AMediaCodec_createDecoderByType(mime);
  if (!codec || AMediaCodec_configure(codec, fmt, nullptr, nullptr, 0) != AMEDIA_OK ||
      AMediaCodec_start(codec) != AMEDIA_OK) {
    if (codec) AMediaCodec_delete(codec);
    AMediaFormat_delete(fmt);
    AMediaExtractor_delete(ex);
    close(fd);
    return false;
  }

  FILE* out = fopen(dstRawPath, "wb");
  if (!out) {
    AMediaCodec_stop(codec);
    AMediaCodec_delete(codec);
    AMediaFormat_delete(fmt);
    AMediaExtractor_delete(ex);
    close(fd);
    return false;
  }

  const int kNumPeaks = 512;
  outPeaks.assign(kNumPeaks, 0.f);
  int64_t estOutFrames = durationUs > 0 ? (durationUs * kTargetSr) / 1000000LL : kTargetSr * 180;

  bool sawInputEos = false, sawOutputEos = false;
  double pos = 0.0;
  float prevL = 0.f, prevR = 0.f;
  int64_t framesWritten = 0;
  std::vector<float> chunkStereo;
  std::vector<float> resampOut;

  while (!sawOutputEos) {
    if (!sawInputEos) {
      ssize_t inIdx = AMediaCodec_dequeueInputBuffer(codec, 5000);
      if (inIdx >= 0) {
        size_t bufSize = 0;
        uint8_t* buf = AMediaCodec_getInputBuffer(codec, (size_t)inIdx, &bufSize);
        ssize_t sampleSize = AMediaExtractor_readSampleData(ex, buf, bufSize);
        if (sampleSize < 0) {
          AMediaCodec_queueInputBuffer(codec, (size_t)inIdx, 0, 0, 0, AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM);
          sawInputEos = true;
        } else {
          int64_t pts = AMediaExtractor_getSampleTime(ex);
          AMediaCodec_queueInputBuffer(codec, (size_t)inIdx, 0, (size_t)sampleSize, (uint64_t)pts, 0);
          AMediaExtractor_advance(ex);
        }
      }
    }

    AMediaCodecBufferInfo info;
    ssize_t outIdx = AMediaCodec_dequeueOutputBuffer(codec, &info, 5000);
    if (outIdx == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
      AMediaFormat* outFmt = AMediaCodec_getOutputFormat(codec);
      if (outFmt) {
        AMediaFormat_getInt32(outFmt, AMEDIAFORMAT_KEY_SAMPLE_RATE, &sr);
        AMediaFormat_getInt32(outFmt, AMEDIAFORMAT_KEY_CHANNEL_COUNT, &ch);
        AMediaFormat_delete(outFmt);
      }
    } else if (outIdx >= 0) {
      if (info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) sawOutputEos = true;
      size_t outSize = 0;
      uint8_t* outBuf = AMediaCodec_getOutputBuffer(codec, (size_t)outIdx, &outSize);
      if (outBuf && info.size > 0 && ch > 0 && sr > 0) {
        const int16_t* pcm = (const int16_t*)(outBuf + info.offset);
        int numFrames = info.size / (2 * ch);
        chunkStereo.resize(numFrames * 2);
        for (int i = 0; i < numFrames; ++i) {
          float L = pcm[i * ch] / 32768.f;
          float R = ch > 1 ? (pcm[i * ch + 1] / 32768.f) : L;
          chunkStereo[i * 2] = L;
          chunkStereo[i * 2 + 1] = R;
        }

        double ratio = (double)sr / (double)kTargetSr;
        resampOut.clear();
        while (pos < (double)numFrames) {
          int idx = (int)pos;
          float fr = (float)(pos - idx);
          float L0 = idx > 0 ? chunkStereo[(idx - 1) * 2] : prevL;
          float R0 = idx > 0 ? chunkStereo[(idx - 1) * 2 + 1] : prevR;
          float L1 = chunkStereo[idx * 2];
          float R1 = chunkStereo[idx * 2 + 1];
          float L = L0 * (1.f - fr) + L1 * fr;
          float R = R0 * (1.f - fr) + R1 * fr;
          resampOut.push_back(L);
          resampOut.push_back(R);

          int pkIdx = (int)((framesWritten * kNumPeaks) / std::max<int64_t>(1, estOutFrames));
          if (pkIdx >= 0 && pkIdx < kNumPeaks) {
            outPeaks[pkIdx] = fmaxf(outPeaks[pkIdx], fmaxf(fabsf(L), fabsf(R)));
          }
          framesWritten++;
          pos += ratio;
        }
        pos -= (double)numFrames;
        if (numFrames > 0) {
          prevL = chunkStereo[(numFrames - 1) * 2];
          prevR = chunkStereo[(numFrames - 1) * 2 + 1];
        }
        if (!resampOut.empty()) {
          fwrite(resampOut.data(), sizeof(float), resampOut.size(), out);
        }
      }
      AMediaCodec_releaseOutputBuffer(codec, (size_t)outIdx, false);
    }
  }

  fclose(out);
  AMediaCodec_stop(codec);
  AMediaCodec_delete(codec);
  AMediaFormat_delete(fmt);
  AMediaExtractor_delete(ex);
  close(fd);
  outFrames = framesWritten;
  return framesWritten > 0;
}

// ---------- Moteur Studio Principal ----------
class VoxoraStudioEngine : public AudioStreamDataCallback {
 public:
  VoxoraStudioEngine() {
    liveVocalDsp_.init(kTargetSr);
    masterDsp_.init(kTargetSr);
    recRing_.assign(kRecRingFrames * 2, 0.f);
  }

  ~VoxoraStudioEngine() { stopAudio(); }

  int startAudio() {
    stopAudio();

    AudioStreamBuilder ib;
    ib.setDirection(Direction::Input)
        ->setPerformanceMode(PerformanceMode::LowLatency)
        ->setSharingMode(SharingMode::Exclusive)
        ->setFormat(AudioFormat::Float)
        ->setChannelCount(1)
        ->setSampleRate(kTargetSr)
        ->setSampleRateConversionQuality(SampleRateConversionQuality::Medium)
        ->setInputPreset(InputPreset::VoiceCommunication);
    bool hasIn = (ib.openStream(in_) == Result::OK);

    AudioStreamBuilder ob;
    ob.setDirection(Direction::Output)
        ->setPerformanceMode(PerformanceMode::LowLatency)
        ->setSharingMode(SharingMode::Exclusive)
        ->setFormat(AudioFormat::Float)
        ->setChannelCount(2)
        ->setSampleRate(kTargetSr)
        ->setSampleRateConversionQuality(SampleRateConversionQuality::Medium)
        ->setDataCallback(std::shared_ptr<AudioStreamDataCallback>(
            this, [](AudioStreamDataCallback*) {}));
    if (ob.openStream(out_) != Result::OK) {
      if (in_) { in_->close(); in_.reset(); }
      return 0;
    }

    sr_ = out_->getSampleRate();
    liveVocalDsp_.init(sr_);
    masterDsp_.init(sr_);
    recHp_.reset();
    recHp_.set(3, (float)sr_, 80.f, 0.f, 0.707f);
    out_->setBufferSizeInFrames(out_->getFramesPerBurst() * 2);

    running_.store(true);
    diskThread_ = std::thread(&VoxoraStudioEngine::diskStreamerLoop, this);

    if (hasIn && in_) in_->requestStart();
    out_->requestStart();
    return 1;
  }

  void stopAudio() {
    stopRecording(nullptr);
    playing_.store(false);
    running_.store(false);
    if (diskThread_.joinable()) diskThread_.join();
    if (out_) { out_->requestStop(); out_->close(); out_.reset(); }
    if (in_) { in_->requestStop(); in_->close(); in_.reset(); }
    gDetMidi.store(0.f);
    gCorMidi.store(0.f);
  }

  // Import illimité d'un fichier audio vers cache disque RAW float32 + calcul des pics
  int importTrack(int id, const char* srcPath, const char* rawPath, bool isVocal,
                  float* outPeaks512, int64_t* outFrames) {
    std::vector<float> peaks;
    int64_t frames = 0;
    bool ok = false;
    if (endsWithCI(srcPath, ".wav")) {
      ok = importWavToRaw(srcPath, rawPath, frames, peaks);
    }
    if (!ok) {
      ok = importMediaNdkToRaw(srcPath, rawPath, frames, peaks);
    }
    if (!ok || frames <= 0) return 0;

    if (outPeaks512 && peaks.size() >= 512) {
      memcpy(outPeaks512, peaks.data(), 512 * sizeof(float));
    }
    if (outFrames) *outFrames = frames;

    auto slot = std::make_unique<TrackSlot>();
    slot->id = id;
    slot->rawPath = rawPath;
    slot->totalFrames = frames;
    slot->isVocal.store(isVocal);
    slot->fxEnabled.store(isVocal);
    slot->fp = fopen(rawPath, "rb");
    slot->offlineVocalDsp.init(sr_);

    std::lock_guard<std::mutex> lk(tracksMtx_);
    tracks_.push_back(std::move(slot));
    updateMaxDurationLocked();
    return 1;
  }

  int registerRawTrack(int id, const char* rawPath, bool isVocal,
                       float* outPeaks512, int64_t* outFrames) {
    FILE* f = fopen(rawPath, "rb");
    if (!f) return 0;
    fseek(f, 0, SEEK_END);
    long bytes = ftell(f);
    fseek(f, 0, SEEK_SET);
    int64_t frames = bytes / (long)(sizeof(float) * 2);
    if (frames <= 0) { fclose(f); return 0; }

    std::vector<float> peaks(512, 0.f);
    float buf[2048];
    int64_t readIdx = 0;
    while (!feof(f)) {
      size_t n = fread(buf, sizeof(float) * 2, 1024, f);
      if (n == 0) break;
      for (size_t i = 0; i < n; ++i) {
        int pkIdx = (int)((readIdx * 512) / std::max<int64_t>(1, frames));
        if (pkIdx >= 0 && pkIdx < 512) {
          peaks[pkIdx] = fmaxf(peaks[pkIdx], fmaxf(fabsf(buf[i * 2]), fabsf(buf[i * 2 + 1])));
        }
        readIdx++;
      }
    }
    fseek(f, 0, SEEK_SET);

    if (outPeaks512) memcpy(outPeaks512, peaks.data(), 512 * sizeof(float));
    if (outFrames) *outFrames = frames;

    auto slot = std::make_unique<TrackSlot>();
    slot->id = id;
    slot->rawPath = rawPath;
    slot->totalFrames = frames;
    slot->isVocal.store(isVocal);
    slot->fxEnabled.store(isVocal);
    slot->fp = f;
    slot->offlineVocalDsp.init(sr_);

    std::lock_guard<std::mutex> lk(tracksMtx_);
    tracks_.push_back(std::move(slot));
    updateMaxDurationLocked();
    return 1;
  }

  void removeTrack(int id) {
    std::lock_guard<std::mutex> lk(tracksMtx_);
    for (auto& t : tracks_) {
      if (t->id == id) t->active.store(false);
    }
    // Le retrait définitif s'effectue hors callback audio
    tracks_.erase(
        std::remove_if(tracks_.begin(), tracks_.end(),
                       [id](const std::unique_ptr<TrackSlot>& t) { return t->id == id; }),
        tracks_.end());
    updateMaxDurationLocked();
  }

  void setTrackParams(int id, float vol, float pan, int mute, int solo, float offsetMs, int fxOn) {
    std::lock_guard<std::mutex> lk(tracksMtx_);
    for (auto& t : tracks_) {
      if (t->id == id) {
        t->volume.store(vol);
        t->pan.store(clampf(pan, -1.f, 1.f));
        t->mute.store(mute != 0);
        t->solo.store(solo != 0);
        t->offsetMs.store(offsetMs);
        t->fxEnabled.store(fxOn != 0);
        break;
      }
    }
  }

  void setTransport(int play, double seekSec) {
    if (seekSec >= 0.0) {
      int64_t target = (int64_t)(seekSec * sr_);
      playheadFrame_.store(target);
      std::lock_guard<std::mutex> lk(tracksMtx_);
      for (auto& t : tracks_) {
        t->seekTargetFrame.store(target);
        t->seekPending.store(true);
      }
    }
    if (play >= 0) playing_.store(play != 0);
  }

  int startRecording(const char* dstRawPath) {
    stopRecording(nullptr);
    recFile_ = fopen(dstRawPath, "wb");
    if (!recFile_) return 0;
    recRead_.store(0);
    recWrite_.store(0);
    recWrittenFrames_ = 0;
    recActive_.store(true);
    return 1;
  }

  void stopRecording(int64_t* outFrames) {
    if (!recActive_.load()) {
      if (outFrames) *outFrames = recWrittenFrames_;
      return;
    }
    recActive_.store(false);
    std::this_thread::sleep_for(std::chrono::milliseconds(40));
    flushRecRingToDisk();
    if (recFile_) {
      fclose(recFile_);
      recFile_ = nullptr;
    }
    if (outFrames) *outFrames = recWrittenFrames_;
  }

  // Rendu Hors-Ligne (Offline Mastering Engine) -> WAV 16/24-bit ou M4A/AAC
  // format: 0 = WAV 16-bit, 1 = WAV 24-bit, 2 = M4A/AAC
  int renderOffline(const char* outPath, int format) {
    renderProgress_.store(0.f);

    struct OfflineTrack {
      FILE* fp = nullptr;
      int64_t totalFrames = 0;
      int64_t offsetFrames = 0;
      float vol = 1.f, pan = 0.f;
      bool fx = false;
      VocalDsp vocalDsp;
    };

    std::vector<OfflineTrack> list;
    int64_t maxFrames = 0;
    {
      std::lock_guard<std::mutex> lk(tracksMtx_);
      bool anySolo = false;
      for (const auto& t : tracks_) if (t->solo.load()) { anySolo = true; break; }
      for (const auto& t : tracks_) {
        if (t->mute.load() || (anySolo && !t->solo.load())) continue;
        FILE* fp = fopen(t->rawPath.c_str(), "rb");
        if (!fp) continue;
        OfflineTrack ot;
        ot.fp = fp;
        ot.totalFrames = t->totalFrames;
        ot.offsetFrames = (int64_t)(t->offsetMs.load() * 0.001f * sr_);
        ot.vol = t->volume.load();
        ot.pan = t->pan.load();
        ot.fx = t->fxEnabled.load();
        ot.vocalDsp.init(sr_);
        list.push_back(std::move(ot));
        int64_t endF = std::max<int64_t>(0, ot.totalFrames + ot.offsetFrames);
        if (endF > maxFrames) maxFrames = endF;
      }
    }

    if (list.empty() || maxFrames <= 0) return 0;

    VocalParams vp;
    MasterParams mp;
    {
      std::lock_guard<std::mutex> lk(paramsMtx_);
      vp = vocalParams_;
      mp = masterParams_;
    }

    MasterDsp offMaster;
    offMaster.init(sr_);

    const int kBlock = 1024;
    std::vector<float> mixL(kBlock), mixR(kBlock), trkBuf(kBlock * 2);

    FILE* wavOut = nullptr;
    AMediaCodec* aacEnc = nullptr;
    AMediaMuxer* muxer = nullptr;
    int muxTrackIdx = -1;
    bool muxStarted = false;
    int outFd = -1;

    if (format == 0 || format == 1) {
      wavOut = fopen(outPath, "wb");
      if (!wavOut) {
        for (auto& t : list) fclose(t.fp);
        return 0;
      }
      uint8_t emptyHdr[44] = {0};
      fwrite(emptyHdr, 1, 44, wavOut);
    } else {
      outFd = open(outPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
      if (outFd < 0) {
        for (auto& t : list) fclose(t.fp);
        return 0;
      }
      AMediaFormat* fmt = AMediaFormat_new();
      AMediaFormat_setString(fmt, AMEDIAFORMAT_KEY_MIME, "audio/mp4a-latm");
      AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_SAMPLE_RATE, sr_);
      AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_CHANNEL_COUNT, 2);
      AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_BIT_RATE, 256000);
      AMediaFormat_setInt32(fmt, AMEDIAFORMAT_KEY_AAC_PROFILE, 2);  // AAC-LC
      aacEnc = AMediaCodec_createEncoderByType("audio/mp4a-latm");
      if (!aacEnc || AMediaCodec_configure(aacEnc, fmt, nullptr, nullptr, AMEDIACODEC_CONFIGURE_FLAG_ENCODE) != AMEDIA_OK ||
          AMediaCodec_start(aacEnc) != AMEDIA_OK) {
        if (aacEnc) AMediaCodec_delete(aacEnc);
        AMediaFormat_delete(fmt);
        close(outFd);
        for (auto& t : list) fclose(t.fp);
        return 0;
      }
      AMediaFormat_delete(fmt);
      muxer = AMediaMuxer_new(outFd, AMEDIAMUXER_OUTPUT_FORMAT_MPEG_4);
    }

    auto drainAac = [&](bool eos) {
      if (!aacEnc || !muxer) return;
      AMediaCodecBufferInfo info;
      while (true) {
        ssize_t idx = AMediaCodec_dequeueOutputBuffer(aacEnc, &info, eos ? 5000 : 0);
        if (idx == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
          if (!muxStarted) {
            AMediaFormat* outFmt = AMediaCodec_getOutputFormat(aacEnc);
            muxTrackIdx = AMediaMuxer_addTrack(muxer, outFmt);
            AMediaMuxer_start(muxer);
            muxStarted = true;
            AMediaFormat_delete(outFmt);
          }
        } else if (idx >= 0) {
          size_t outSz = 0;
          uint8_t* ptr = AMediaCodec_getOutputBuffer(aacEnc, (size_t)idx, &outSz);
          if (ptr && info.size > 0 && muxStarted && !(info.flags & AMEDIACODEC_BUFFER_FLAG_CODEC_CONFIG)) {
            AMediaMuxer_writeSampleData(muxer, (size_t)muxTrackIdx, ptr + info.offset, &info);
          }
          AMediaCodec_releaseOutputBuffer(aacEnc, (size_t)idx, false);
          if (info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) break;
        } else {
          break;
        }
      }
    };

    std::vector<uint8_t> outBytes(kBlock * 2 * 3);
    int64_t cursor = 0;

    while (cursor < maxFrames) {
      int n = (int)std::min<int64_t>(kBlock, maxFrames - cursor);
      std::fill(mixL.begin(), mixL.begin() + n, 0.f);
      std::fill(mixR.begin(), mixR.begin() + n, 0.f);

      for (auto& trk : list) {
        int64_t localStart = cursor - trk.offsetFrames;
        if (localStart + n <= 0 || localStart >= trk.totalFrames) continue;

        float gainL = trk.vol * clampf(1.f - trk.pan, 0.f, 1.f);
        float gainR = trk.vol * clampf(1.f + trk.pan, 0.f, 1.f);

        for (int i = 0; i < n; ++i) {
          int64_t fIdx = localStart + i;
          float sL = 0.f, sR = 0.f;
          if (fIdx >= 0 && fIdx < trk.totalFrames) {
            // Lecture séquentielle propre
            if (i == 0 || fIdx == 0) {
              fseek(trk.fp, (long)(fIdx * 2 * sizeof(float)), SEEK_SET);
            }
            float pair[2] = {0.f, 0.f};
            if (fread(pair, sizeof(float), 2, trk.fp) == 2) {
              sL = pair[0];
              sR = pair[1];
            }
          }
          if (trk.fx) {
            float pL, pR;
            trk.vocalDsp.processSample((sL + sR) * 0.5f, vp, pL, pR);
            sL = pL;
            sR = pR;
          }
          mixL[i] += sL * gainL;
          mixR[i] += sR * gainR;
        }
      }

      // Bus Master avec headroom -2.2 dB pour éviter la saturation multi-piste
      for (int i = 0; i < n; ++i) {
        float mL, mR;
        offMaster.processSample(mixL[i] * 0.78f, mixR[i] * 0.78f, mp, mL, mR);
        mixL[i] = mL;
        mixR[i] = mR;
      }

      if (wavOut) {
        if (format == 0) {
          int16_t* dst = (int16_t*)outBytes.data();
          for (int i = 0; i < n; ++i) {
            dst[i * 2] = (int16_t)(clampf(mixL[i], -1.f, 1.f) * 32767.f);
            dst[i * 2 + 1] = (int16_t)(clampf(mixR[i], -1.f, 1.f) * 32767.f);
          }
          fwrite(dst, sizeof(int16_t), n * 2, wavOut);
        } else {
          uint8_t* dst = outBytes.data();
          for (int i = 0; i < n; ++i) {
            int32_t vL = (int32_t)(clampf(mixL[i], -1.f, 1.f) * 8388607.f);
            int32_t vR = (int32_t)(clampf(mixR[i], -1.f, 1.f) * 8388607.f);
            dst[i * 6 + 0] = (uint8_t)(vL & 0xFF);
            dst[i * 6 + 1] = (uint8_t)((vL >> 8) & 0xFF);
            dst[i * 6 + 2] = (uint8_t)((vL >> 16) & 0xFF);
            dst[i * 6 + 3] = (uint8_t)(vR & 0xFF);
            dst[i * 6 + 4] = (uint8_t)((vR >> 8) & 0xFF);
            dst[i * 6 + 5] = (uint8_t)((vR >> 16) & 0xFF);
          }
          fwrite(dst, 1, n * 6, wavOut);
        }
      } else if (aacEnc) {
        int written = 0;
        while (written < n) {
          ssize_t inIdx = AMediaCodec_dequeueInputBuffer(aacEnc, 10000);
          if (inIdx >= 0) {
            size_t cap = 0;
            uint8_t* dst = AMediaCodec_getInputBuffer(aacEnc, (size_t)inIdx, &cap);
            int maxF = (int)(cap / 4);
            int take = std::min(n - written, maxF);
            int16_t* pcm = (int16_t*)dst;
            for (int i = 0; i < take; ++i) {
              pcm[i * 2] = (int16_t)(clampf(mixL[written + i], -1.f, 1.f) * 32767.f);
              pcm[i * 2 + 1] = (int16_t)(clampf(mixR[written + i], -1.f, 1.f) * 32767.f);
            }
            int64_t ptsUs = ((cursor + written) * 1000000LL) / sr_;
            AMediaCodec_queueInputBuffer(aacEnc, (size_t)inIdx, 0, (size_t)(take * 4), (uint64_t)ptsUs, 0);
            written += take;
          }
          drainAac(false);
        }
      }

      cursor += n;
      renderProgress_.store((float)cursor / (float)maxFrames);
    }

    if (wavOut) {
      uint16_t bits = (format == 1) ? 24 : 16;
      uint16_t ch = 2, pcm = 1, align = (uint16_t)(ch * (bits / 8));
      uint32_t dataLen = (uint32_t)(maxFrames * align);
      uint32_t riff = 36 + dataLen, fmtLen = 16, sr32 = (uint32_t)sr_, byteRate = sr32 * align;
      fseek(wavOut, 0, SEEK_SET);
      fwrite("RIFF", 1, 4, wavOut); fwrite(&riff, 4, 1, wavOut); fwrite("WAVEfmt ", 1, 8, wavOut);
      fwrite(&fmtLen, 4, 1, wavOut); fwrite(&pcm, 2, 1, wavOut); fwrite(&ch, 2, 1, wavOut);
      fwrite(&sr32, 4, 1, wavOut); fwrite(&byteRate, 4, 1, wavOut); fwrite(&align, 2, 1, wavOut);
      fwrite(&bits, 2, 1, wavOut); fwrite("data", 1, 4, wavOut); fwrite(&dataLen, 4, 1, wavOut);
      fclose(wavOut);
    } else if (aacEnc) {
      ssize_t inIdx = AMediaCodec_dequeueInputBuffer(aacEnc, 10000);
      if (inIdx >= 0) {
        AMediaCodec_queueInputBuffer(aacEnc, (size_t)inIdx, 0, 0, 0, AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM);
      }
      drainAac(true);
      if (muxStarted) AMediaMuxer_stop(muxer);
      AMediaMuxer_delete(muxer);
      AMediaCodec_stop(aacEnc);
      AMediaCodec_delete(aacEnc);
      close(outFd);
    }

    for (auto& t : list) fclose(t.fp);
    renderProgress_.store(1.f);
    return 1;
  }

  // ---------- Callback Temps Réel Oboe (Strictement Lock-Free & Zero-Alloc) ----------
  DataCallbackResult onAudioReady(AudioStream*, void* data, int32_t n) override {
    float* out = (float*)data;
    int m = n < 8192 ? n : 8192;
    int got = 0;
    if (in_) {
      auto r = in_->read(inScratch_, m, 0);
      if (r.error() == Result::OK) got = r.value();
    }

    VocalParams vp = vocalParams_;
    MasterParams mp = masterParams_;
    const bool mon = monitorLive_.load();
    const bool isPlay = playing_.load();
    const bool isRec = recActive_.load();

    float inPk = 0.f;

    // Note: l'accès à tracks_ dans onAudioReady utilise try_lock pour ne jamais bloquer le thread RT
    std::unique_lock<std::mutex> trkLock(tracksMtx_, std::try_to_lock);
    bool anySolo = false;
    if (trkLock.owns_lock()) {
      for (const auto& t : tracks_) if (t->solo.load()) { anySolo = true; break; }
    }

    for (int i = 0; i < n; ++i) {
      float mic = i < got ? inScratch_[i] : 0.f;
      if (!std::isfinite(mic)) mic = 0.f;
      inPk = fmaxf(inPk, fabsf(mic));

      float vL = 0.f, vR = 0.f;
      liveVocalDsp_.processSample(mic, vp, vL, vR);

      if (isRec) {
        uint32_t rw = recWrite_.load(std::memory_order_relaxed);
        uint32_t rr = recRead_.load(std::memory_order_acquire);
        if (rw - rr < kRecRingFrames - 1) {
          uint32_t idx = (rw & (kRecRingFrames - 1)) * 2;
          // Filtre coupe-bas 80 Hz + saturation douce de sécurité avant écriture brute
          float cleanRec = clampf(tanhf(recHp_.run(mic) * 0.95f), -0.98f, 0.98f);
          recRing_[idx] = cleanRec;
          recRing_[idx + 1] = cleanRec;
          recWrite_.store(rw + 1, std::memory_order_release);
        }
      }

      float mixL = mon ? vL : 0.f;
      float mixR = mon ? vR : 0.f;

      if (isPlay && trkLock.owns_lock()) {
        float trkSumL = 0.f, trkSumR = 0.f;
        for (const auto& t : tracks_) {
          if (!t->active.load() || t->mute.load() || (anySolo && !t->solo.load())) continue;
          uint32_t rr = t->rRead.load(std::memory_order_relaxed);
          uint32_t rw = t->rWrite.load(std::memory_order_acquire);
          if (rr < rw) {
            uint32_t idx = (rr & (kTrackRingFrames - 1)) * 2;
            float sL = t->ring[idx];
            float sR = t->ring[idx + 1];
            t->rRead.store(rr + 1, std::memory_order_release);
            if (t->fxEnabled.load()) {
              float fxL, fxR;
              t->offlineVocalDsp.processSample((sL + sR) * 0.5f, vp, fxL, fxR);
              sL = fxL; sR = fxR;
            }
            float vol = t->volume.load();
            float pan = t->pan.load();
            trkSumL += sL * vol * clampf(1.f - pan, 0.f, 1.f);
            trkSumR += sR * vol * clampf(1.f + pan, 0.f, 1.f);
          }
        }
        mixL += trkSumL * 0.78f;
        mixR += trkSumR * 0.78f;
        playheadFrame_.fetch_add(1, std::memory_order_relaxed);
      }

      float outL, outR;
      masterDsp_.processSample(mixL, mixR, mp, outL, outR);
      out[i * 2] = outL;
      out[i * 2 + 1] = outR;
    }

    gInLevel.store(inPk);
    gOutLevel.store(masterDsp_.lastPeakLin);
    gLufs.store(clampf(linToDb(sqrtf(fmaxf(masterDsp_.lastRmsSq, 1e-8f))), -70.f, 0.f));
    gCompGr.store(liveVocalDsp_.lastGrDb);
    gDetMidi.store(liveVocalDsp_.detMidi);
    gCorMidi.store(liveVocalDsp_.corMidi);

    return DataCallbackResult::Continue;
  }

  // Getters / Setters atomiques
  void setVocalParams(const VocalParams& vp) {
    std::lock_guard<std::mutex> lk(paramsMtx_);
    vocalParams_ = vp;
  }
  void setMasterParams(const MasterParams& mp) {
    std::lock_guard<std::mutex> lk(paramsMtx_);
    masterParams_ = mp;
  }
  void setMonitor(bool on) { monitorLive_.store(on); }
  double getPlayheadSec() const { return (double)playheadFrame_.load() / (double)sr_; }
  double getTotalDurationSec() const { return (double)maxDurationFrames_.load() / (double)sr_; }
  float getRenderProgress() const { return renderProgress_.load(); }

  std::atomic<float> gInLevel{0.f}, gOutLevel{0.f}, gLufs{-70.f}, gCompGr{0.f};
  std::atomic<float> gDetMidi{0.f}, gCorMidi{0.f};

 private:
  void updateMaxDurationLocked() {
    int64_t mx = 0;
    for (const auto& t : tracks_) {
      int64_t e = t->totalFrames + (int64_t)(t->offsetMs.load() * 0.001f * sr_);
      if (e > mx) mx = e;
    }
    maxDurationFrames_.store(mx);
  }

  void flushRecRingToDisk() {
    if (!recFile_) return;
    float tmp[2048];
    while (true) {
      uint32_t rr = recRead_.load(std::memory_order_relaxed);
      uint32_t rw = recWrite_.load(std::memory_order_acquire);
      uint32_t avail = rw - rr;
      if (avail == 0) break;
      uint32_t take = std::min<uint32_t>(avail, 1024);
      for (uint32_t i = 0; i < take; ++i) {
        uint32_t idx = ((rr + i) & (kRecRingFrames - 1)) * 2;
        tmp[i * 2] = recRing_[idx];
        tmp[i * 2 + 1] = recRing_[idx + 1];
      }
      fwrite(tmp, sizeof(float) * 2, take, recFile_);
      recWrittenFrames_ += take;
      recRead_.store(rr + take, std::memory_order_release);
    }
  }

  void diskStreamerLoop() {
    std::vector<float> tmp(4096 * 2);
    while (running_.load()) {
      flushRecRingToDisk();

      {
        std::lock_guard<std::mutex> lk(tracksMtx_);
        for (auto& t : tracks_) {
          if (!t->active.load() || !t->fp) continue;
          if (t->seekPending.exchange(false)) {
            int64_t target = t->seekTargetFrame.load() - (int64_t)(t->offsetMs.load() * 0.001f * sr_);
            t->rRead.store(0);
            t->rWrite.store(0);
            t->diskFramePos.store(target);
            if (target >= 0 && target < t->totalFrames) {
              fseek(t->fp, (long)(target * 2 * sizeof(float)), SEEK_SET);
            }
          }

          uint32_t rr = t->rRead.load(std::memory_order_acquire);
          uint32_t rw = t->rWrite.load(std::memory_order_relaxed);
          uint32_t freeSpace = (kTrackRingFrames - 1) - (rw - rr);
          if (freeSpace >= 2048) {
            uint32_t toFill = std::min<uint32_t>(freeSpace, 4096);
            int64_t pos = t->diskFramePos.load();
            for (uint32_t i = 0; i < toFill; ++i) {
              float L = 0.f, R = 0.f;
              if (pos >= 0 && pos < t->totalFrames) {
                float pair[2] = {0.f, 0.f};
                if (fread(pair, sizeof(float), 2, t->fp) == 2) { L = pair[0]; R = pair[1]; }
              }
              uint32_t idx = ((rw + i) & (kTrackRingFrames - 1)) * 2;
              t->ring[idx] = L;
              t->ring[idx + 1] = R;
              pos++;
            }
            t->diskFramePos.store(pos);
            t->rWrite.store(rw + toFill, std::memory_order_release);
          }
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(8));
    }
  }

  std::shared_ptr<AudioStream> in_, out_;
  int sr_ = kTargetSr;
  float inScratch_[8192] = {0};

  VocalDsp liveVocalDsp_;
  MasterDsp masterDsp_;
  Biquad recHp_;
  VocalParams vocalParams_;
  MasterParams masterParams_;
  std::mutex paramsMtx_;

  std::vector<std::unique_ptr<TrackSlot>> tracks_;
  std::mutex tracksMtx_;

  std::atomic<bool> running_{false}, playing_{false}, monitorLive_{false}, recActive_{false};
  std::atomic<int64_t> playheadFrame_{0}, maxDurationFrames_{0};
  std::atomic<float> renderProgress_{0.f};

  std::vector<float> recRing_;
  std::atomic<uint32_t> recRead_{0}, recWrite_{0};
  FILE* recFile_ = nullptr;
  int64_t recWrittenFrames_ = 0;

  std::thread diskThread_;
};

VoxoraStudioEngine* gEngine = nullptr;
inline VoxoraStudioEngine* eng() {
  if (!gEngine) gEngine = new VoxoraStudioEngine();
  return gEngine;
}

}  // namespace

#define VX_API extern "C" __attribute__((visibility("default")))

VX_API int32_t vx_start() { return eng()->startAudio(); }
VX_API void vx_stop() { eng()->stopAudio(); }
VX_API void vx_monitor(int32_t on) { eng()->setMonitor(on != 0); }

VX_API void vx_set_vocal(
    int32_t key, int32_t mask, float amt, float spd, float trn, float formant,
    float gateDb, float gateAtkMs, float gateRelMs, float deesser,
    float eqLow, float eqMid, float eqMidFreq, float eqHigh,
    float compThr, float compRatio, float compAtk, float compRel, float compMakeup,
    float doubler, float revSize, float revMix, float delayMs, float delayFb, float delayMix,
    int32_t bypass) {
  VocalParams p;
  p.key = key; p.mask = mask; p.tuneAmt = amt; p.tuneSpd = spd;
  p.transpose = trn; p.formant = formant;
  p.gateThreshDb = gateDb; p.gateAttackMs = gateAtkMs; p.gateReleaseMs = gateRelMs;
  p.deesserAmt = deesser;
  p.eqLowDb = eqLow; p.eqMidDb = eqMid; p.eqMidFreq = eqMidFreq; p.eqHighDb = eqHigh;
  p.compThreshDb = compThr; p.compRatio = compRatio; p.compAttackMs = compAtk;
  p.compReleaseMs = compRel; p.compMakeupDb = compMakeup;
  p.doublerMix = doubler; p.reverbSize = revSize; p.reverbMix = revMix;
  p.delayMs = delayMs; p.delayFb = delayFb; p.delayMix = delayMix;
  p.bypass = (bypass != 0);
  eng()->setVocalParams(p);
}

VX_API void vx_set_master(
    float eqLow, float eqHigh, float glueThr, float glueRatio, float glueMix,
    float exciter, float stereoWidth, float ceilingDb, float driveDb, int32_t bypass) {
  MasterParams m;
  m.eqLowDb = eqLow; m.eqHighDb = eqHigh;
  m.glueThreshDb = glueThr; m.glueRatio = glueRatio; m.glueMix = glueMix;
  m.exciterAmt = exciter; m.stereoWidth = stereoWidth;
  m.limiterCeilingDb = ceilingDb; m.limiterDriveDb = driveDb;
  m.bypass = (bypass != 0);
  eng()->setMasterParams(m);
}

VX_API int32_t vx_import_track(int32_t id, const char* srcPath, const char* rawPath,
                               int32_t isVocal, float* outPeaks512, int64_t* outFrames) {
  return eng()->importTrack(id, srcPath, rawPath, isVocal != 0, outPeaks512, outFrames);
}

VX_API int32_t vx_register_raw_track(int32_t id, const char* rawPath,
                                     int32_t isVocal, float* outPeaks512, int64_t* outFrames) {
  return eng()->registerRawTrack(id, rawPath, isVocal != 0, outPeaks512, outFrames);
}

VX_API void vx_remove_track(int32_t id) { eng()->removeTrack(id); }

VX_API void vx_set_track(int32_t id, float vol, float pan, int32_t mute, int32_t solo,
                         float offsetMs, int32_t fxOn) {
  eng()->setTrackParams(id, vol, pan, mute, solo, offsetMs, fxOn);
}

VX_API void vx_transport(int32_t play, double seekSec) { eng()->setTransport(play, seekSec); }
VX_API double vx_playhead_sec() { return eng()->getPlayheadSec(); }
VX_API double vx_total_sec() { return eng()->getTotalDurationSec(); }

VX_API int32_t vx_rec_start(const char* rawPath) { return eng()->startRecording(rawPath); }
VX_API int64_t vx_rec_stop() {
  int64_t f = 0;
  eng()->stopRecording(&f);
  return f;
}

VX_API int32_t vx_render_offline(const char* outPath, int32_t format) {
  return eng()->renderOffline(outPath, format);
}
VX_API float vx_render_progress() { return eng()->getRenderProgress(); }

VX_API float vx_det() { return eng()->gDetMidi.load(); }
VX_API float vx_cor() { return eng()->gCorMidi.load(); }
VX_API float vx_in_lvl() { return eng()->gInLevel.load(); }
VX_API float vx_out_lvl() { return eng()->gOutLevel.load(); }
VX_API float vx_lufs() { return eng()->gLufs.load(); }
VX_API float vx_comp_gr() { return eng()->gCompGr.load(); }
