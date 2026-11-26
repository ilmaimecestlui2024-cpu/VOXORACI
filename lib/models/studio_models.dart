import 'dart:convert';

const kNoteNames = [
  'Do',
  'Do#',
  'Ré',
  'Ré#',
  'Mi',
  'Fa',
  'Fa#',
  'Sol',
  'Sol#',
  'La',
  'La#',
  'Si',
];

const kScales = <String, List<int>>{
  'Chromatique': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  'Majeure': [0, 2, 4, 5, 7, 9, 11],
  'Mineure': [0, 2, 3, 5, 7, 8, 10],
  'Pentatonique majeure': [0, 2, 4, 7, 9],
  'Pentatonique mineure': [0, 3, 5, 7, 10],
  'Mineure harmonique': [0, 2, 3, 5, 7, 8, 11],
  'Dorienne': [0, 2, 3, 5, 7, 9, 10],
  'Mixolydienne': [0, 2, 4, 5, 7, 9, 10],
};

class VocalSettings {
  const VocalSettings({
    this.key = 0,
    this.scale = 'Chromatique',
    this.tuneAmt = 65,
    this.tuneSpeed = 50,
    this.transpose = 0,
    this.formant = 0,
    this.gateThreshDb = -52,
    this.gateAttackMs = 5,
    this.gateReleaseMs = 120,
    this.deesser = 25,
    this.eqLowDb = -1.5,
    this.eqMidDb = 3,
    this.eqMidFreq = 3000,
    this.eqHighDb = 3.5,
    this.compThreshDb = -18,
    this.compRatio = 3.2,
    this.compAttackMs = 8,
    this.compReleaseMs = 130,
    this.compMakeupDb = 3.5,
    this.doubler = 12,
    this.reverbSize = 50,
    this.reverbMix = 20,
    this.delayMs = 260,
    this.delayFb = 32,
    this.delayMix = 0,
    this.bypass = false,
  });

  final int key;
  final String scale;
  final double tuneAmt;
  final double tuneSpeed;
  final double transpose;
  final double formant;
  final double gateThreshDb;
  final double gateAttackMs;
  final double gateReleaseMs;
  final double deesser;
  final double eqLowDb;
  final double eqMidDb;
  final double eqMidFreq;
  final double eqHighDb;
  final double compThreshDb;
  final double compRatio;
  final double compAttackMs;
  final double compReleaseMs;
  final double compMakeupDb;
  final double doubler;
  final double reverbSize;
  final double reverbMix;
  final double delayMs;
  final double delayFb;
  final double delayMix;
  final bool bypass;

  int get scaleMask =>
      (kScales[scale] ?? kScales['Chromatique']!).fold(0, (m, d) => m | (1 << d));

  VocalSettings copyWith({
    int? key,
    String? scale,
    double? tuneAmt,
    double? tuneSpeed,
    double? transpose,
    double? formant,
    double? gateThreshDb,
    double? gateAttackMs,
    double? gateReleaseMs,
    double? deesser,
    double? eqLowDb,
    double? eqMidDb,
    double? eqMidFreq,
    double? eqHighDb,
    double? compThreshDb,
    double? compRatio,
    double? compAttackMs,
    double? compReleaseMs,
    double? compMakeupDb,
    double? doubler,
    double? reverbSize,
    double? reverbMix,
    double? delayMs,
    double? delayFb,
    double? delayMix,
    bool? bypass,
  }) {
    return VocalSettings(
      key: key ?? this.key,
      scale: scale ?? this.scale,
      tuneAmt: tuneAmt ?? this.tuneAmt,
      tuneSpeed: tuneSpeed ?? this.tuneSpeed,
      transpose: transpose ?? this.transpose,
      formant: formant ?? this.formant,
      gateThreshDb: gateThreshDb ?? this.gateThreshDb,
      gateAttackMs: gateAttackMs ?? this.gateAttackMs,
      gateReleaseMs: gateReleaseMs ?? this.gateReleaseMs,
      deesser: deesser ?? this.deesser,
      eqLowDb: eqLowDb ?? this.eqLowDb,
      eqMidDb: eqMidDb ?? this.eqMidDb,
      eqMidFreq: eqMidFreq ?? this.eqMidFreq,
      eqHighDb: eqHighDb ?? this.eqHighDb,
      compThreshDb: compThreshDb ?? this.compThreshDb,
      compRatio: compRatio ?? this.compRatio,
      compAttackMs: compAttackMs ?? this.compAttackMs,
      compReleaseMs: compReleaseMs ?? this.compReleaseMs,
      compMakeupDb: compMakeupDb ?? this.compMakeupDb,
      doubler: doubler ?? this.doubler,
      reverbSize: reverbSize ?? this.reverbSize,
      reverbMix: reverbMix ?? this.reverbMix,
      delayMs: delayMs ?? this.delayMs,
      delayFb: delayFb ?? this.delayFb,
      delayMix: delayMix ?? this.delayMix,
      bypass: bypass ?? this.bypass,
    );
  }

  Map<String, dynamic> toJson() => {
        'tuneAmt': tuneAmt,
        'tuneSpeed': tuneSpeed,
        'formant': formant,
        'gateThreshDb': gateThreshDb,
        'deesser': deesser,
        'eqLowDb': eqLowDb,
        'eqMidDb': eqMidDb,
        'eqMidFreq': eqMidFreq,
        'eqHighDb': eqHighDb,
        'compThreshDb': compThreshDb,
        'compRatio': compRatio,
        'compMakeupDb': compMakeupDb,
        'doubler': doubler,
        'reverbSize': reverbSize,
        'reverbMix': reverbMix,
        'delayMs': delayMs,
        'delayFb': delayFb,
        'delayMix': delayMix,
      };

  VocalSettings applyPresetMap(Map<String, dynamic> m) => copyWith(
        tuneAmt: (m['tuneAmt'] as num?)?.toDouble(),
        tuneSpeed: (m['tuneSpeed'] as num?)?.toDouble(),
        formant: (m['formant'] as num?)?.toDouble(),
        gateThreshDb: (m['gateThreshDb'] as num?)?.toDouble(),
        deesser: (m['deesser'] as num?)?.toDouble(),
        eqLowDb: (m['eqLowDb'] as num?)?.toDouble(),
        eqMidDb: (m['eqMidDb'] as num?)?.toDouble(),
        eqMidFreq: (m['eqMidFreq'] as num?)?.toDouble(),
        eqHighDb: (m['eqHighDb'] as num?)?.toDouble(),
        compThreshDb: (m['compThreshDb'] as num?)?.toDouble(),
        compRatio: (m['compRatio'] as num?)?.toDouble(),
        compMakeupDb: (m['compMakeupDb'] as num?)?.toDouble(),
        doubler: (m['doubler'] as num?)?.toDouble(),
        reverbSize: (m['reverbSize'] as num?)?.toDouble(),
        reverbMix: (m['reverbMix'] as num?)?.toDouble(),
        delayMs: (m['delayMs'] as num?)?.toDouble(),
        delayFb: (m['delayFb'] as num?)?.toDouble(),
        delayMix: (m['delayMix'] as num?)?.toDouble(),
      );
}

class MasterSettings {
  const MasterSettings({
    this.eqLowDb = 0,
    this.eqHighDb = 1,
    this.glueThreshDb = -12,
    this.glueRatio = 2.2,
    this.glueMix = 28,
    this.exciter = 15,
    this.stereoWidth = 105,
    this.limiterCeilingDb = -1.0,
    this.limiterDriveDb = 1.2,
    this.bypass = false,
  });

  final double eqLowDb;
  final double eqHighDb;
  final double glueThreshDb;
  final double glueRatio;
  final double glueMix;
  final double exciter;
  final double stereoWidth;
  final double limiterCeilingDb;
  final double limiterDriveDb;
  final bool bypass;

  MasterSettings copyWith({
    double? eqLowDb,
    double? eqHighDb,
    double? glueThreshDb,
    double? glueRatio,
    double? glueMix,
    double? exciter,
    double? stereoWidth,
    double? limiterCeilingDb,
    double? limiterDriveDb,
    bool? bypass,
  }) {
    return MasterSettings(
      eqLowDb: eqLowDb ?? this.eqLowDb,
      eqHighDb: eqHighDb ?? this.eqHighDb,
      glueThreshDb: glueThreshDb ?? this.glueThreshDb,
      glueRatio: glueRatio ?? this.glueRatio,
      glueMix: glueMix ?? this.glueMix,
      exciter: exciter ?? this.exciter,
      stereoWidth: stereoWidth ?? this.stereoWidth,
      limiterCeilingDb: limiterCeilingDb ?? this.limiterCeilingDb,
      limiterDriveDb: limiterDriveDb ?? this.limiterDriveDb,
      bypass: bypass ?? this.bypass,
    );
  }
}

class VocalPresetItem {
  const VocalPresetItem({
    required this.name,
    required this.isCustom,
    required this.data,
  });

  final String name;
  final bool isCustom;
  final Map<String, dynamic> data;

  String encode() => jsonEncode({'name': name, 'data': data});

  static VocalPresetItem decode(String raw) {
    final obj = jsonDecode(raw) as Map<String, dynamic>;
    return VocalPresetItem(
      name: obj['name'] as String,
      isCustom: true,
      data: Map<String, dynamic>.from(obj['data'] as Map),
    );
  }
}

final List<VocalPresetItem> kBuiltInPresets = [
  const VocalPresetItem(
    name: 'Naturel',
    isCustom: false,
    data: {
      'tuneAmt': 0.0, 'tuneSpeed': 50.0, 'formant': 0.0, 'gateThreshDb': -54.0,
      'deesser': 15.0, 'eqLowDb': 0.0, 'eqMidDb': 1.5, 'eqMidFreq': 3000.0,
      'eqHighDb': 2.0, 'compThreshDb': -14.0, 'compRatio': 2.2, 'compMakeupDb': 1.5,
      'doubler': 0.0, 'reverbSize': 35.0, 'reverbMix': 10.0, 'delayMs': 250.0,
      'delayFb': 25.0, 'delayMix': 0.0,
    },
  ),
  const VocalPresetItem(
    name: 'Pop Studio',
    isCustom: false,
    data: {
      'tuneAmt': 65.0, 'tuneSpeed': 50.0, 'formant': 0.0, 'gateThreshDb': -52.0,
      'deesser': 30.0, 'eqLowDb': 2.0, 'eqMidDb': 3.0, 'eqMidFreq': 3200.0,
      'eqHighDb': 4.5, 'compThreshDb': -18.0, 'compRatio': 3.5, 'compMakeupDb': 3.5,
      'doubler': 18.0, 'reverbSize': 55.0, 'reverbMix': 22.0, 'delayMs': 260.0,
      'delayFb': 32.0, 'delayMix': 8.0,
    },
  ),
  const VocalPresetItem(
    name: 'Trap/Modern Vocal',
    isCustom: false,
    data: {
      'tuneAmt': 100.0, 'tuneSpeed': 100.0, 'formant': 0.5, 'gateThreshDb': -48.0,
      'deesser': 35.0, 'eqLowDb': -1.0, 'eqMidDb': 3.5, 'eqMidFreq': 3500.0,
      'eqHighDb': 5.0, 'compThreshDb': -22.0, 'compRatio': 5.0, 'compMakeupDb': 5.0,
      'doubler': 24.0, 'reverbSize': 65.0, 'reverbMix': 26.0, 'delayMs': 280.0,
      'delayFb': 42.0, 'delayMix': 22.0,
    },
  ),
  const VocalPresetItem(
    name: 'Rap/BoomBap',
    isCustom: false,
    data: {
      'tuneAmt': 15.0, 'tuneSpeed': 35.0, 'formant': -1.0, 'gateThreshDb': -50.0,
      'deesser': 28.0, 'eqLowDb': 3.0, 'eqMidDb': 4.0, 'eqMidFreq': 2400.0,
      'eqHighDb': 2.5, 'compThreshDb': -20.0, 'compRatio': 4.5, 'compMakeupDb': 4.0,
      'doubler': 8.0, 'reverbSize': 30.0, 'reverbMix': 10.0, 'delayMs': 220.0,
      'delayFb': 25.0, 'delayMix': 6.0,
    },
  ),
  const VocalPresetItem(
    name: 'Radio/Podcast',
    isCustom: false,
    data: {
      'tuneAmt': 0.0, 'tuneSpeed': 40.0, 'formant': -1.5, 'gateThreshDb': -46.0,
      'deesser': 32.0, 'eqLowDb': 4.0, 'eqMidDb': 4.5, 'eqMidFreq': 2800.0,
      'eqHighDb': -2.0, 'compThreshDb': -24.0, 'compRatio': 6.0, 'compMakeupDb': 6.0,
      'doubler': 0.0, 'reverbSize': 20.0, 'reverbMix': 0.0, 'delayMs': 200.0,
      'delayFb': 20.0, 'delayMix': 0.0,
    },
  ),
  const VocalPresetItem(
    name: 'Doubler/Atmosphère',
    isCustom: false,
    data: {
      'tuneAmt': 75.0, 'tuneSpeed': 60.0, 'formant': 0.0, 'gateThreshDb': -52.0,
      'deesser': 25.0, 'eqLowDb': 1.0, 'eqMidDb': 2.0, 'eqMidFreq': 3000.0,
      'eqHighDb': 4.0, 'compThreshDb': -18.0, 'compRatio': 3.0, 'compMakeupDb': 3.0,
      'doubler': 65.0, 'reverbSize': 82.0, 'reverbMix': 48.0, 'delayMs': 360.0,
      'delayFb': 48.0, 'delayMix': 28.0,
    },
  ),
];

class AudioTrackModel {
  AudioTrackModel({
    required this.id,
    required this.name,
    required this.rawPath,
    required this.isVocal,
    required this.totalFrames,
    required this.peaks,
    double? volume,
    this.pan = 0.0,
    this.mute = false,
    this.solo = false,
    this.offsetMs = 0.0,
    bool? fxEnabled,
  })  : volume = volume ?? (isVocal ? 1.10 : 0.68),
        fxEnabled = fxEnabled ?? isVocal;

  final int id;
  final String name;
  final String rawPath;
  final bool isVocal;
  final int totalFrames;
  final List<double> peaks;
  double volume;
  double pan;
  bool mute;
  bool solo;
  double offsetMs;
  bool fxEnabled;

  double get durationSec => totalFrames / 48000.0;
}

class ExportedFileModel {
  const ExportedFileModel({
    required this.path,
    required this.name,
    required this.formatLabel,
    required this.sizeBytes,
    required this.createdAt,
  });

  final String path;
  final String name;
  final String formatLabel;
  final int sizeBytes;
  final DateTime createdAt;
}

String formatTimecode(double sec) {
  final safe = sec < 0 ? 0.0 : sec;
  final m = safe ~/ 60;
  final s = safe.floor() % 60;
  final cs = ((safe - safe.floor()) * 100).floor();
  return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}.${cs.toString().padLeft(2, '0')}';
}
