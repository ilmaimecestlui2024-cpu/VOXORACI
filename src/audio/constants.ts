export const KEYS = [
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
] as const;

export const SCALES: Record<string, number[]> = {
  Chromatique: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  Majeure: [0, 2, 4, 5, 7, 9, 11],
  Mineure: [0, 2, 3, 5, 7, 8, 10],
  'Pentatonique majeure': [0, 2, 4, 7, 9],
  'Pentatonique mineure': [0, 3, 5, 7, 10],
  'Mineure harmonique': [0, 2, 3, 5, 7, 8, 11],
  Dorienne: [0, 2, 3, 5, 7, 9, 10],
  Mixolydienne: [0, 2, 4, 5, 7, 9, 10],
};

export interface VocalSettings {
  key: number;
  scale: string;
  tuneAmt: number;      // 0..100
  tuneSpeed: number;    // 0..100
  transpose: number;    // -24..24
  formant: number;      // -12..12
  gateThreshDb: number; // -70..-15
  gateAttackMs: number; // 1..50
  gateReleaseMs: number;// 20..400
  deesser: number;      // 0..100
  eqLowDb: number;      // -12..12
  eqMidDb: number;      // -12..12
  eqMidFreq: number;    // 800..6000
  eqHighDb: number;     // -12..12
  compThreshDb: number; // -40..0
  compRatio: number;    // 1..12
  compAttackMs: number; // 1..50
  compReleaseMs: number;// 30..500
  compMakeupDb: number; // 0..18
  doubler: number;      // 0..100
  reverbSize: number;   // 10..100
  reverbMix: number;    // 0..100
  delayMs: number;      // 60..600
  delayFb: number;      // 0..85
  delayMix: number;     // 0..100
  bypass: boolean;
}

export const DEFAULT_VOCAL_SETTINGS: VocalSettings = {
  key: 0,
  scale: 'Chromatique',
  tuneAmt: 65,
  tuneSpeed: 50,
  transpose: 0,
  formant: 0,
  gateThreshDb: -52,
  gateAttackMs: 5,
  gateReleaseMs: 120,
  deesser: 25,
  eqLowDb: 2,
  eqMidDb: 3,
  eqMidFreq: 3200,
  eqHighDb: 4,
  compThreshDb: -18,
  compRatio: 3.5,
  compAttackMs: 5,
  compReleaseMs: 140,
  compMakeupDb: 3,
  doubler: 15,
  reverbSize: 55,
  reverbMix: 22,
  delayMs: 260,
  delayFb: 35,
  delayMix: 0,
  bypass: false,
};

export interface MasterSettings {
  eqLowDb: number;
  eqHighDb: number;
  glueThreshDb: number;
  glueRatio: number;
  glueMix: number;
  exciter: number;
  stereoWidth: number;
  limiterCeilingDb: number;
  limiterDriveDb: number;
  bypass: boolean;
}

export const DEFAULT_MASTER_SETTINGS: MasterSettings = {
  eqLowDb: 0,
  eqHighDb: 1,
  glueThreshDb: -14,
  glueRatio: 2.5,
  glueMix: 35,
  exciter: 15,
  stereoWidth: 108,
  limiterCeilingDb: -1.0,
  limiterDriveDb: 1.5,
  bypass: false,
};

export interface VocalPreset {
  id: string;
  name: string;
  isCustom: boolean;
  values: Partial<VocalSettings>;
}

export const BUILTIN_PRESETS: VocalPreset[] = [
  {
    id: 'naturel',
    name: 'Naturel',
    isCustom: false,
    values: {
      tuneAmt: 0, tuneSpeed: 50, formant: 0, gateThreshDb: -54, deesser: 15,
      eqLowDb: 0, eqMidDb: 1.5, eqMidFreq: 3000, eqHighDb: 2,
      compThreshDb: -14, compRatio: 2.2, compMakeupDb: 1.5,
      doubler: 0, reverbSize: 35, reverbMix: 10, delayMs: 250, delayFb: 25, delayMix: 0,
    },
  },
  {
    id: 'pop-studio',
    name: 'Pop Studio',
    isCustom: false,
    values: {
      tuneAmt: 65, tuneSpeed: 50, formant: 0, gateThreshDb: -52, deesser: 30,
      eqLowDb: 2, eqMidDb: 3, eqMidFreq: 3200, eqHighDb: 4.5,
      compThreshDb: -18, compRatio: 3.5, compMakeupDb: 3.5,
      doubler: 18, reverbSize: 55, reverbMix: 22, delayMs: 260, delayFb: 32, delayMix: 8,
    },
  },
  {
    id: 'trap-modern',
    name: 'Trap/Modern Vocal',
    isCustom: false,
    values: {
      tuneAmt: 100, tuneSpeed: 100, formant: 0.5, gateThreshDb: -48, deesser: 35,
      eqLowDb: -1, eqMidDb: 3.5, eqMidFreq: 3500, eqHighDb: 5,
      compThreshDb: -22, compRatio: 5.0, compMakeupDb: 5,
      doubler: 24, reverbSize: 65, reverbMix: 26, delayMs: 280, delayFb: 42, delayMix: 22,
    },
  },
  {
    id: 'rap-boombap',
    name: 'Rap/BoomBap',
    isCustom: false,
    values: {
      tuneAmt: 15, tuneSpeed: 35, formant: -1, gateThreshDb: -50, deesser: 28,
      eqLowDb: 3, eqMidDb: 4, eqMidFreq: 2400, eqHighDb: 2.5,
      compThreshDb: -20, compRatio: 4.5, compMakeupDb: 4,
      doubler: 8, reverbSize: 30, reverbMix: 10, delayMs: 220, delayFb: 25, delayMix: 6,
    },
  },
  {
    id: 'radio-podcast',
    name: 'Radio/Podcast',
    isCustom: false,
    values: {
      tuneAmt: 0, tuneSpeed: 40, formant: -1.5, gateThreshDb: -46, deesser: 32,
      eqLowDb: 4, eqMidDb: 4.5, eqMidFreq: 2800, eqHighDb: -2,
      compThreshDb: -24, compRatio: 6.0, compMakeupDb: 6,
      doubler: 0, reverbSize: 20, reverbMix: 0, delayMs: 200, delayFb: 20, delayMix: 0,
    },
  },
  {
    id: 'doubler-atmo',
    name: 'Doubler/Atmosphère',
    isCustom: false,
    values: {
      tuneAmt: 75, tuneSpeed: 60, formant: 0, gateThreshDb: -52, deesser: 25,
      eqLowDb: 1, eqMidDb: 2, eqMidFreq: 3000, eqHighDb: 4,
      compThreshDb: -18, compRatio: 3.0, compMakeupDb: 3,
      doubler: 65, reverbSize: 82, reverbMix: 48, delayMs: 360, delayFb: 48, delayMix: 28,
    },
  },
];

export function getScaleMask(scaleName: string): number {
  const degrees = SCALES[scaleName] ?? SCALES.Chromatique;
  return degrees.reduce((mask, degree) => mask | (1 << degree), 0);
}

export function midiToFreq(midi: number): number {
  if (midi <= 0) return 0;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToNoteInfo(midi: number): {
  name: string;
  octave: number;
  full: string;
  cents: number;
  freq: number;
} {
  if (midi <= 0) {
    return { name: '–', octave: 0, full: '–', cents: 0, freq: 0 };
  }
  const rounded = Math.round(midi);
  const noteIndex = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  const cents = Math.round((midi - rounded) * 100);
  const name = KEYS[noteIndex];
  return { name, octave, full: `${name}${octave}`, cents, freq: midiToFreq(midi) };
}

export function formatTimecode(seconds: number): string {
  const total = Math.max(0, seconds);
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  const cs = Math.floor((total % 1) * 100);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export function encodeStereoWav(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  bitsPerSample: 16 | 24
): Blob {
  const numFrames = left.length;
  const bytesPerSample = bitsPerSample / 8;
  const align = 2 * bytesPerSample;
  const dataLen = numFrames * align;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); // Stereo
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * align, true);
  view.setUint16(32, align, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);

  let off = 44;
  if (bitsPerSample === 16) {
    for (let i = 0; i < numFrames; i++) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i]));
      view.setInt16(off, l < 0 ? l * 32768 : l * 32767, true);
      view.setInt16(off + 2, r < 0 ? r * 32768 : r * 32767, true);
      off += 4;
    }
  } else {
    for (let i = 0; i < numFrames; i++) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i]));
      const vl = Math.round(l * 8388607);
      const vr = Math.round(r * 8388607);
      view.setUint8(off + 0, vl & 0xff);
      view.setUint8(off + 1, (vl >> 8) & 0xff);
      view.setUint8(off + 2, (vl >> 16) & 0xff);
      view.setUint8(off + 3, vr & 0xff);
      view.setUint8(off + 4, (vr >> 8) & 0xff);
      view.setUint8(off + 5, (vr >> 16) & 0xff);
      off += 6;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
