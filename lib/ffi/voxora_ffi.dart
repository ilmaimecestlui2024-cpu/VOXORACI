import 'dart:ffi';
import 'dart:isolate';
import 'package:ffi/ffi.dart';
import '../models/studio_models.dart';

typedef _VxVoid = Void Function();
typedef _VxStart = Int32 Function();
typedef _VxSetInt = Void Function(Int32);
typedef _VxGetFloat = Float Function();
typedef _VxGetDouble = Double Function();

typedef _VxSetVocal = Void Function(
  Int32, Int32, Float, Float, Float, Float,
  Float, Float, Float, Float,
  Float, Float, Float, Float,
  Float, Float, Float, Float, Float,
  Float, Float, Float, Float, Float, Float,
  Int32,
);

typedef _VxSetMaster = Void Function(
  Float, Float, Float, Float, Float,
  Float, Float, Float, Float, Int32,
);

typedef _VxImportTrack = Int32 Function(
  Int32, Pointer<Utf8>, Pointer<Utf8>, Int32, Pointer<Float>, Pointer<Int64>,
);

typedef _VxRegisterRaw = Int32 Function(
  Int32, Pointer<Utf8>, Int32, Pointer<Float>, Pointer<Int64>,
);

typedef _VxSetTrack = Void Function(
  Int32, Float, Float, Int32, Int32, Float, Int32,
);

typedef _VxTransport = Void Function(Int32, Double);
typedef _VxRecStart = Int32 Function(Pointer<Utf8>);
typedef _VxRecStop = Int64 Function();
typedef _VxRenderOffline = Int32 Function(Pointer<Utf8>, Int32);

class ImportResult {
  const ImportResult({
    required this.ok,
    required this.peaks,
    required this.totalFrames,
  });
  final bool ok;
  final List<double> peaks;
  final int totalFrames;
}

class VoxoraFfi {
  VoxoraFfi._() {
    _lib = DynamicLibrary.open('libvoxora.so');
    _start = _lib.lookupFunction<_VxStart, int Function()>('vx_start');
    _stop = _lib.lookupFunction<_VxVoid, void Function()>('vx_stop');
    _monitor = _lib.lookupFunction<_VxSetInt, void Function(int)>('vx_monitor');
    _setVocal = _lib.lookupFunction<
        _VxSetVocal,
        void Function(
          int, int, double, double, double, double,
          double, double, double, double,
          double, double, double, double,
          double, double, double, double, double,
          double, double, double, double, double, double,
          int,
        )>('vx_set_vocal');
    _setMaster = _lib.lookupFunction<
        _VxSetMaster,
        void Function(
          double, double, double, double, double,
          double, double, double, double, int,
        )>('vx_set_master');
    _importTrack = _lib.lookupFunction<
        _VxImportTrack,
        int Function(int, Pointer<Utf8>, Pointer<Utf8>, int, Pointer<Float>, Pointer<Int64>)>(
        'vx_import_track');
    _registerRaw = _lib.lookupFunction<
        _VxRegisterRaw,
        int Function(int, Pointer<Utf8>, int, Pointer<Float>, Pointer<Int64>)>(
        'vx_register_raw_track');
    _removeTrack = _lib.lookupFunction<_VxSetInt, void Function(int)>('vx_remove_track');
    _setTrack = _lib.lookupFunction<
        _VxSetTrack,
        void Function(int, double, double, int, int, double, int)>('vx_set_track');
    _transport = _lib.lookupFunction<_VxTransport, void Function(int, double)>('vx_transport');
    _playheadSec = _lib.lookupFunction<_VxGetDouble, double Function()>('vx_playhead_sec');
    _totalSec = _lib.lookupFunction<_VxGetDouble, double Function()>('vx_total_sec');
    _recStart = _lib.lookupFunction<_VxRecStart, int Function(Pointer<Utf8>)>('vx_rec_start');
    _recStop = _lib.lookupFunction<_VxRecStop, int Function()>('vx_rec_stop');
    _renderOffline = _lib.lookupFunction<_VxRenderOffline, int Function(Pointer<Utf8>, int)>(
        'vx_render_offline');
    _renderProgress = _lib.lookupFunction<_VxGetFloat, double Function()>('vx_render_progress');
    _det = _lib.lookupFunction<_VxGetFloat, double Function()>('vx_det');
    _cor = _lib.lookupFunction<_VxGetFloat, double Function()>('vx_cor');
    _inLvl = _lib.lookupFunction<_VxGetFloat, double Function()>('vx_in_lvl');
    _outLvl = _lib.lookupFunction<_VxGetFloat, double Function()>('vx_out_lvl');
    _lufs = _lib.lookupFunction<_VxGetFloat, double Function()>('vx_lufs');
    _compGr = _lib.lookupFunction<_VxGetFloat, double Function()>('vx_comp_gr');
  }

  static final VoxoraFfi instance = VoxoraFfi._();

  late final DynamicLibrary _lib;
  late final int Function() _start;
  late final void Function() _stop;
  late final void Function(int) _monitor;
  late final void Function(
    int, int, double, double, double, double,
    double, double, double, double,
    double, double, double, double,
    double, double, double, double, double,
    double, double, double, double, double, double,
    int,
  ) _setVocal;
  late final void Function(
    double, double, double, double, double,
    double, double, double, double, int,
  ) _setMaster;
  late final int Function(int, Pointer<Utf8>, Pointer<Utf8>, int, Pointer<Float>, Pointer<Int64>)
      _importTrack;
  late final int Function(int, Pointer<Utf8>, int, Pointer<Float>, Pointer<Int64>) _registerRaw;
  late final void Function(int) _removeTrack;
  late final void Function(int, double, double, int, int, double, int) _setTrack;
  late final void Function(int, double) _transport;
  late final double Function() _playheadSec;
  late final double Function() _totalSec;
  late final int Function(Pointer<Utf8>) _recStart;
  late final int Function() _recStop;
  late final int Function(Pointer<Utf8>, int) _renderOffline;
  late final double Function() _renderProgress;
  late final double Function() _det;
  late final double Function() _cor;
  late final double Function() _inLvl;
  late final double Function() _outLvl;
  late final double Function() _lufs;
  late final double Function() _compGr;

  bool start() => _start() == 1;
  void stop() => _stop();
  void setMonitor(bool on) => _monitor(on ? 1 : 0);

  void applyVocal(VocalSettings v) {
    _setVocal(
      v.key,
      v.scaleMask,
      v.tuneAmt / 100.0,
      v.tuneSpeed / 100.0,
      v.transpose,
      v.formant,
      v.gateThreshDb,
      v.gateAttackMs,
      v.gateReleaseMs,
      v.deesser / 100.0,
      v.eqLowDb,
      v.eqMidDb,
      v.eqMidFreq,
      v.eqHighDb,
      v.compThreshDb,
      v.compRatio,
      v.compAttackMs,
      v.compReleaseMs,
      v.compMakeupDb,
      v.doubler / 100.0,
      v.reverbSize / 100.0,
      v.reverbMix / 100.0,
      v.delayMs,
      v.delayFb / 100.0,
      v.delayMix / 100.0,
      v.bypass ? 1 : 0,
    );
  }

  void applyMaster(MasterSettings m) {
    _setMaster(
      m.eqLowDb,
      m.eqHighDb,
      m.glueThreshDb,
      m.glueRatio,
      m.glueMix / 100.0,
      m.exciter / 100.0,
      m.stereoWidth / 100.0,
      m.limiterCeilingDb,
      m.limiterDriveDb,
      m.bypass ? 1 : 0,
    );
  }

  Future<ImportResult> importTrackAsync(
      int id, String srcPath, String rawPath, bool isVocal) {
    return Isolate.run(() {
      final lib = DynamicLibrary.open('libvoxora.so');
      final fn = lib.lookupFunction<
          _VxImportTrack,
          int Function(int, Pointer<Utf8>, Pointer<Utf8>, int, Pointer<Float>,
              Pointer<Int64>)>('vx_import_track');
      final sPtr = srcPath.toNativeUtf8();
      final rPtr = rawPath.toNativeUtf8();
      final peaksPtr = calloc<Float>(512);
      final framesPtr = calloc<Int64>(1);
      final ok = fn(id, sPtr, rPtr, isVocal ? 1 : 0, peaksPtr, framesPtr);
      final peaks = List<double>.generate(512, (i) => peaksPtr[i]);
      final frames = framesPtr[0];
      malloc.free(sPtr);
      malloc.free(rPtr);
      calloc.free(peaksPtr);
      calloc.free(framesPtr);
      return ImportResult(ok: ok == 1, peaks: peaks, totalFrames: frames);
    });
  }

  ImportResult registerRawTrack(int id, String rawPath, bool isVocal) {
    final rPtr = rawPath.toNativeUtf8();
    final peaksPtr = calloc<Float>(512);
    final framesPtr = calloc<Int64>(1);
    final ok = _registerRaw(id, rPtr, isVocal ? 1 : 0, peaksPtr, framesPtr);
    final peaks = List<double>.generate(512, (i) => peaksPtr[i]);
    final frames = framesPtr[0];
    malloc.free(rPtr);
    calloc.free(peaksPtr);
    calloc.free(framesPtr);
    return ImportResult(ok: ok == 1, peaks: peaks, totalFrames: frames);
  }

  void removeTrack(int id) => _removeTrack(id);

  void updateTrack(AudioTrackModel t) {
    _setTrack(
      t.id,
      t.volume,
      t.pan,
      t.mute ? 1 : 0,
      t.solo ? 1 : 0,
      t.offsetMs,
      t.fxEnabled ? 1 : 0,
    );
  }

  void setTransport({bool? play, double? seekSec}) {
    _transport(play == null ? -1 : (play ? 1 : 0), seekSec ?? -1.0);
  }

  double get playheadSec => _playheadSec();
  double get totalSec => _totalSec();

  bool startRecording(String rawPath) {
    final p = rawPath.toNativeUtf8();
    final ok = _recStart(p);
    malloc.free(p);
    return ok == 1;
  }

  int stopRecording() => _recStop();

  Future<bool> renderOfflineAsync(String outPath, int formatCode) {
    return Isolate.run(() {
      final lib = DynamicLibrary.open('libvoxora.so');
      final fn = lib.lookupFunction<_VxRenderOffline,
          int Function(Pointer<Utf8>, int)>('vx_render_offline');
      final p = outPath.toNativeUtf8();
      final ok = fn(p, formatCode);
      malloc.free(p);
      return ok == 1;
    });
  }

  double get renderProgress => _renderProgress();
  double get detMidi => _det();
  double get corMidi => _cor();
  double get inLevel => _inLvl();
  double get outLevel => _outLvl();
  double get lufs => _lufs();
  double get compGrDb => _compGr();
}
