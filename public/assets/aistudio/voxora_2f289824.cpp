// Voxora : moteur d'auto-tune en direct (Oboe, entrée + sortie à faible latence).
// Détection de hauteur YIN + correction vers la gamme + décaleur de hauteur granulaire.
#include <oboe/Oboe.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <thread>
#include <vector>

using namespace oboe;

static std::atomic<int> gKey{0}, gMask{0xFFF}, gRecOn{0};
static std::atomic<float> gAmt{.65f}, gSpd{.5f}, gTrn{0.f}, gDet{0.f}, gCor{0.f};
static std::atomic<float> gBass{0.f}, gPres{0.f}, gAir{0.f}, gComp{0.f}, gRev{0.f}, gEcho{0.f};

// Filtre biquad (formules RBJ) : 0 = grave, 1 = présence, 2 = aigu
struct Bq {
  float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
  float run(float x) {
    float y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  }
  void set(int type, float fs, float f0, float db, float q) {
    float A = powf(10.f, db / 40.f), w = 6.2831853f * f0 / fs, c = cosf(w), s = sinf(w);
    float al = s / (2 * q), sq = 2 * sqrtf(A) * al, B0, B1, B2, A0, A1, A2;
    if (type == 0) {
      B0 = A * ((A + 1) - (A - 1) * c + sq); B1 = 2 * A * ((A - 1) - (A + 1) * c);
      B2 = A * ((A + 1) - (A - 1) * c - sq); A0 = (A + 1) + (A - 1) * c + sq;
      A1 = -2 * ((A - 1) + (A + 1) * c); A2 = (A + 1) + (A - 1) * c - sq;
    } else if (type == 1) {
      B0 = 1 + al * A; B1 = -2 * c; B2 = 1 - al * A;
      A0 = 1 + al / A; A1 = -2 * c; A2 = 1 - al / A;
    } else {
      B0 = A * ((A + 1) + (A - 1) * c + sq); B1 = -2 * A * ((A - 1) + (A + 1) * c);
      B2 = A * ((A + 1) + (A - 1) * c - sq); A0 = (A + 1) - (A - 1) * c + sq;
      A1 = 2 * ((A - 1) - (A + 1) * c); A2 = (A + 1) - (A - 1) * c - sq;
    }
    b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0;
  }
};
struct Comb {  // réverbération de Schroeder
  std::vector<float> b; int i = 0; float lp = 0;
  void init(int n) { b.assign(n, 0.f); i = 0; lp = 0; }
  float run(float x, float fb, float damp) {
    float y = b[i]; lp = y * (1 - damp) + lp * damp; b[i] = x + lp * fb;
    if (++i >= (int)b.size()) i = 0;
    return y;
  }
};
struct Ap {
  std::vector<float> b; int i = 0;
  void init(int n) { b.assign(n, 0.f); i = 0; }
  float run(float x) {
    float y = b[i]; b[i] = x + y * .5f;
    if (++i >= (int)b.size()) i = 0;
    return -x + y;
  }
};

class Engine : public AudioStreamDataCallback {
 public:
  bool start() {
    stop();
    AudioStreamBuilder ib;
    ib.setDirection(Direction::Input)
        ->setPerformanceMode(PerformanceMode::LowLatency)
        ->setSharingMode(SharingMode::Exclusive)
        ->setFormat(AudioFormat::Float)
        ->setChannelCount(1)
        ->setSampleRate(48000)
        ->setSampleRateConversionQuality(SampleRateConversionQuality::Medium)
        ->setInputPreset(InputPreset::VoicePerformance);
    if (ib.openStream(in_) != Result::OK) return false;

    AudioStreamBuilder ob;
    ob.setDirection(Direction::Output)
        ->setPerformanceMode(PerformanceMode::LowLatency)
        ->setSharingMode(SharingMode::Exclusive)
        ->setFormat(AudioFormat::Float)
        ->setChannelCount(1)
        ->setSampleRate(48000)
        ->setSampleRateConversionQuality(SampleRateConversionQuality::Medium)
        ->setDataCallback(std::shared_ptr<AudioStreamDataCallback>(
            this, [](AudioStreamDataCallback*) {}));
    if (ob.openStream(out_) != Result::OK) {
      in_->close();
      in_.reset();
      return false;
    }
    sr_ = out_->getSampleRate();
    N_ = (int)(.04f * sr_);
    H_ = N_ / 2;
    out_->setBufferSizeInFrames(out_->getFramesPerBurst() * 2);
    memset(hist_, 0, sizeof(hist_));
    wp_ = 0; sh_ = 0; ph_ = 0; sm_ = 0; ss_ = 0; pk_ = 0; mi_ = 0;
    memset(mh_, 0, sizeof(mh_));
    // effets : réinitialisation (hors thread audio)
    eqL_ = Bq(); eqP_ = Bq(); eqH_ = Bq();
    cb_ = cp_ = ca_ = 1e9f;
    const int cs[4] = {1557, 1617, 1491, 1422}, as[2] = {225, 556};
    for (int k = 0; k < 4; k++) comb_[k].init((int)(cs[k] * (float)sr_ / 44100.f));
    for (int k = 0; k < 2; k++) ap_[k].init((int)(as[k] * (float)sr_ / 44100.f));
    en_ = (int)(.26f * sr_); eb_.assign(en_, 0.f); ei_ = 0;
    atk_ = 1.f - expf(-1.f / (.005f * sr_)); rel_ = 1.f - expf(-1.f / (.15f * sr_)); env_ = 0;
    in_->requestStart();
    out_->requestStart();
    return true;
  }

  void stop() {
    if (out_) { out_->requestStop(); out_->close(); out_.reset(); }
    if (in_) { in_->requestStop(); in_->close(); in_.reset(); }
    gDet = 0; gCor = 0;
  }

  void rec(int on) {
    gRecOn = 0;
    if (on) {
      rec_.clear();
      rec_.reserve((size_t)sr_ * 300);  // 5 minutes maximum
      gRecOn = 1;
    }
  }

  int save(const char* path) {
    gRecOn = 0;
    std::this_thread::sleep_for(std::chrono::milliseconds(60));
    FILE* f = fopen(path, "wb");
    if (!f) return 0;
    uint32_t n = (uint32_t)rec_.size(), dataLen = n * 2, sr = (uint32_t)sr_;
    uint32_t riff = 36 + dataLen, fmtLen = 16, byteRate = sr * 2;
    uint16_t pcm = 1, ch = 1, align = 2, bits = 16;
    fwrite("RIFF", 1, 4, f); fwrite(&riff, 4, 1, f); fwrite("WAVEfmt ", 1, 8, f);
    fwrite(&fmtLen, 4, 1, f); fwrite(&pcm, 2, 1, f); fwrite(&ch, 2, 1, f);
    fwrite(&sr, 4, 1, f); fwrite(&byteRate, 4, 1, f); fwrite(&align, 2, 1, f);
    fwrite(&bits, 2, 1, f); fwrite("data", 1, 4, f); fwrite(&dataLen, 4, 1, f);
    for (uint32_t i = 0; i < n; i++) {
      float v = rec_[i] > 1.f ? 1.f : (rec_[i] < -1.f ? -1.f : rec_[i]);
      int16_t s = (int16_t)(v * 32767.f);
      fwrite(&s, 2, 1, f);
    }
    fclose(f);
    return 1;
  }

  DataCallbackResult onAudioReady(AudioStream*, void* data, int32_t n) override {
    float* o = (float*)data;
    int m = n < 8192 ? n : 8192, got = 0;
    if (in_) {
      auto r = in_->read(tmp_, m, 0);
      if (r.error() == Result::OK) got = r.value();
    }
    const bool recOn = gRecOn.load() != 0;
    updEq();
    for (int i = 0; i < n; i++) {
      hist_[wp_ & MASK] = i < got ? tmp_[i] : 0.f;
      wp_++;
      if (++sh_ >= 256) { sh_ = 0; analyze(); }
      float y = process();
      o[i] = y;
      if (recOn && rec_.size() < rec_.capacity()) rec_.push_back(y);
    }
    return DataCallbackResult::Continue;
  }

 private:
  static constexpr unsigned MASK = 65535;

  float rd(float d) {  // lecture avec interpolation, d échantillons en arrière
    unsigned cur = wp_ - 1, id = (unsigned)d;
    float fr = d - (float)id;
    return hist_[(cur - id) & MASK] * (1.f - fr) + hist_[(cur - id - 1) & MASK] * fr;
  }

  void updEq() {
    float b = gBass.load(), p = gPres.load(), a = gAir.load();
    if (b != cb_ || p != cp_ || a != ca_) {
      cb_ = b; cp_ = p; ca_ = a;
      eqL_.set(0, (float)sr_, 150.f, b, .707f);
      eqP_.set(1, (float)sr_, 3200.f, p, .9f);
      eqH_.set(2, (float)sr_, 9500.f, a, .707f);
    }
  }

  float fx(float x) {
    float y = eqH_.run(eqP_.run(eqL_.run(x)));
    float c = gComp.load();
    if (c > .01f) {  // compresseur
      float a = fabsf(y), thr = -12.f - c * 25.f, ratio = 1.f + c * 7.f;
      env_ += (a - env_) * (a > env_ ? atk_ : rel_);
      float over = 20.f * log10f(env_ + 1e-9f) - thr;
      float gdb = (over > 0 ? -over * (1.f - 1.f / ratio) : 0.f) - thr * (1.f - 1.f / ratio) * .4f;
      y *= powf(10.f, gdb / 20.f);
    }
    float rv = gRev.load(), ec = gEcho.load(), w = 0.f;
    if (rv > .01f) {  // réverbération
      float s = 0.f;
      for (int k = 0; k < 4; k++) s += comb_[k].run(y, .84f, .3f);
      s *= .25f;
      for (int k = 0; k < 2; k++) s = ap_[k].run(s);
      w += s * rv * .6f;
    }
    if (ec > .01f) {  // écho
      float e = eb_[ei_];
      eb_[ei_] = y + e * .35f;
      if (++ei_ >= en_) ei_ = 0;
      w += e * ec * .6f;
    }
    y += w;
    return y > .98f ? .98f : (y < -.98f ? -.98f : y);
  }

  float process() { return fx(pitch()); }

  float pitch() {
    ss_ += (sm_ - ss_) * .004f;  // lissage par échantillon
    float mix = fminf(1.f, fabsf(ss_) * 3.f);
    float dry = hist_[(wp_ - 1 - (unsigned)H_) & MASK];
    if (mix < .001f) return dry;
    float r = exp2f(ss_ / 12.f);
    ph_ += (1.f - r) / (float)N_;
    ph_ -= floorf(ph_);
    float f2 = ph_ + .5f;
    if (f2 >= 1.f) f2 -= 1.f;
    float w1 = sinf(3.14159265f * ph_);
    w1 *= w1;
    float wet = rd(ph_ * N_) * w1 + rd(f2 * N_) * (1.f - w1);
    return dry * (1.f - mix) + wet * mix;
  }

  void analyze() {
    const int D = 4, W = 512, tMax = sr_ / D / 80, tMin = sr_ / D / 800, L = W + tMax + 1;
    if (L > 1100 || tMax + 2 > 400) return;
    unsigned base = wp_ - (unsigned)(L * D);
    for (int k = 0; k < L; k++) {
      float s = 0;
      for (int j = 0; j < D; j++) s += hist_[(base + k * D + j) & MASK];
      ds_[k] = s / D;
    }
    float e = 0;
    for (int j = 0; j < W; j++) e += ds_[j] * ds_[j];
    float rms = sqrtf(e / W);
    pk_ = fmaxf(pk_ * .9995f, rms);
    bool voiced = false;
    float m = 0;
    if (rms >= fmaxf(.003f, .05f * pk_)) {
      float run = 0;
      for (int t = 1; t <= tMax; t++) {
        float a = 0;
        for (int j = 0; j < W; j++) { float q = ds_[j] - ds_[j + t]; a += q * q; }
        run += a;
        d_[t] = a * t / (run > 0 ? run : 1.f);
      }
      int t = tMin;
      while (t < tMax) {
        if (d_[t] < .15f) { while (t + 1 < tMax && d_[t + 1] < d_[t]) t++; break; }
        t++;
      }
      if (t < tMax) {
        float a = d_[t - 1], b = d_[t], c = d_[t + 1], den = a - 2 * b + c;
        float tt = den != 0 ? t + (a - c) / (2 * den) : (float)t;
        m = 69.f + 12.f * log2f(((float)sr_ / D / tt) / 440.f);
        voiced = true;
      }
    }
    mh_[mi_++ % 5] = voiced ? m : 0.f;  // médiane des 5 dernières détections
    float v[5];
    int cnt = 0;
    for (int i = 0; i < 5; i++) if (mh_[i] > 0) v[cnt++] = mh_[i];
    if (!voiced || cnt < 2) {
      voiced = false;
    } else {
      for (int i = 1; i < cnt; i++) {
        float x = v[i]; int j = i - 1;
        while (j >= 0 && v[j] > x) { v[j + 1] = v[j]; j--; }
        v[j + 1] = x;
      }
      m = v[cnt / 2];
    }
    float want = gTrn.load(), al = .15f;
    if (voiced) {
      int key = gKey.load(), mask = gMask.load(), b0 = (int)lroundf(m);
      float best = m, bd = 1e9f;
      for (int k = -6; k <= 6; k++) {
        int cn = b0 + k, rel = (((cn - key) % 12) + 12) % 12;
        if ((mask >> rel) & 1) {
          float dd = fabsf((float)cn - m);
          if (dd < bd) { bd = dd; best = (float)cn; }
        }
      }
      want = (best - m) * gAmt.load() + gTrn.load();
      float s = gSpd.load();
      al = .04f + .96f * s * s;
    }
    al = 1.f - sqrtf(1.f - al);  // hop de 256 échantillons
    sm_ += (want - sm_) * al;
    gDet = voiced ? m : 0.f;
    gCor = voiced ? m + sm_ : 0.f;
  }

  std::shared_ptr<AudioStream> in_, out_;
  int sr_ = 48000, N_ = 1920, H_ = 960, sh_ = 0, mi_ = 0;
  unsigned wp_ = 0;
  float ph_ = 0, sm_ = 0, ss_ = 0, pk_ = 0;
  float hist_[65536] = {0}, tmp_[8192] = {0}, ds_[1100] = {0}, d_[400] = {0}, mh_[5] = {0};
  Bq eqL_, eqP_, eqH_;
  Comb comb_[4];
  Ap ap_[2];
  std::vector<float> eb_;
  int en_ = 12480, ei_ = 0;
  float cb_ = 1e9f, cp_ = 1e9f, ca_ = 1e9f, atk_ = .004f, rel_ = .0001f, env_ = 0;
  std::vector<float> rec_;
};

static Engine* E = nullptr;
#define API extern "C" __attribute__((visibility("default")))

API int vx_start() { if (!E) E = new Engine(); return E->start() ? 1 : 0; }
API void vx_stop() { if (E) E->stop(); }
API void vx_set(int key, int mask, float amt, float spd, float trn) {
  gKey = key; gMask = mask; gAmt = amt; gSpd = spd; gTrn = trn;
}
API void vx_fx(float bass, float pres, float air, float comp, float rev, float echo) {
  gBass = bass; gPres = pres; gAir = air; gComp = comp; gRev = rev; gEcho = echo;
}
API float vx_det() { return gDet.load(); }
API float vx_cor() { return gCor.load(); }
API void vx_rec(int on) { if (E) E->rec(on); }
API int vx_save(const char* path) { return E ? E->save(path) : 0; }
