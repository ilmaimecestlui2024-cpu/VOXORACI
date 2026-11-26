import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Circle,
  Headphones,
  Mic,
  Moon,
  Pause,
  Play,
  Plus,
  Power,
  RotateCcw,
  Save,
  Sliders,
  Square,
  Sun,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  Waves,
} from 'lucide-react';
import {
  BUILTIN_PRESETS,
  DEFAULT_MASTER_SETTINGS,
  DEFAULT_VOCAL_SETTINGS,
  KEYS,
  MasterSettings,
  SCALES,
  VocalPreset,
  VocalSettings,
  formatTimecode,
} from './audio/constants';
import {
  AudioInputDevice,
  ExportedMix,
  StudioTrack,
  TelemetryData,
  VocalSourceMode,
  VoxoraAudioEngine,
} from './audio/VoxoraAudioEngine';
import { ExportsPanel } from './components/ExportsPanel';
import { PitchMonitorCanvas } from './components/PitchMonitorCanvas';
import { StudioSlider } from './components/StudioSlider';
import { WaveformTrackCard } from './components/WaveformTrackCard';

type StudioTab = 'studio' | 'effects' | 'mastering' | 'exports';

const CUSTOM_PRESETS_KEY = 'voxora_studio_custom_presets_v1';
const THEME_STORAGE_KEY = 'voxora_studio_theme_v1';

const INITIAL_TELEMETRY: TelemetryData = {
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

export default function App() {
  const engineRef = useRef<VoxoraAudioEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new VoxoraAudioEngine();
  }
  const engine = engineRef.current;

  const [isDark, setIsDark] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      return saved !== 'light';
    } catch {
      return true;
    }
  });

  const [activeTab, setActiveTab] = useState<StudioTab>('studio');
  const [live, setLive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportFormat, setExportFormat] = useState<'wav16' | 'wav24'>('wav24');

  const [sourceMode, setSourceMode] = useState<VocalSourceMode>('mic');
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [monitor, setMonitor] = useState(false);

  const [vocal, setVocal] = useState<VocalSettings>(DEFAULT_VOCAL_SETTINGS);
  const [master, setMaster] = useState<MasterSettings>(DEFAULT_MASTER_SETTINGS);
  const [activePresetId, setActivePresetId] = useState<string | null>('pop-studio');
  const [customPresets, setCustomPresets] = useState<VocalPreset[]>(() => {
    try {
      const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
      return raw ? (JSON.parse(raw) as VocalPreset[]) : [];
    } catch {
      return [];
    }
  });

  const [showPresetModal, setShowPresetModal] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');

  const [tracks, setTracks] = useState<StudioTrack[]>([]);
  const [exportsList, setExportsList] = useState<ExportedMix[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryData>(INITIAL_TELEMETRY);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const beatInputRef = useRef<HTMLInputElement | null>(null);
  const vocalInputRef = useRef<HTMLInputElement | null>(null);
  const recCounterRef = useRef(1);

  // Sync dark/light class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (isDark) root.classList.add('dark');
    else root.classList.remove('dark');
    try {
      localStorage.setItem(THEME_STORAGE_KEY, isDark ? 'dark' : 'light');
    } catch {
      // ignore
    }
  }, [isDark]);

  useEffect(() => {
    engine.setTelemetryCallback((t) => setTelemetry(t));
    return () => {
      engine.stopEngine();
    };
  }, [engine]);

  // Smooth playhead ticker
  useEffect(() => {
    if (!isPlaying && !isRecording) return;
    const id = window.setInterval(() => {
      const cur = engine.getPlayheadSec();
      setPlayheadSec(cur);
      const total = engine.getTotalDurationSec(tracks);
      if (isPlaying && !isRecording && total > 0 && cur >= total) {
        engine.stopPlayback();
        setIsPlaying(false);
        setPlayheadSec(0);
      }
    }, 50);
    return () => window.clearInterval(id);
  }, [isPlaying, isRecording, engine, tracks]);

  const updateVocal = useCallback(
    (patch: Partial<VocalSettings>, clearPreset = true) => {
      setVocal((prev) => {
        const next = { ...prev, ...patch };
        engine.updateVocalSettings(next);
        return next;
      });
      if (clearPreset) setActivePresetId(null);
    },
    [engine]
  );

  const updateMaster = useCallback(
    (patch: Partial<MasterSettings>) => {
      setMaster((prev) => {
        const next = { ...prev, ...patch };
        engine.updateMasterSettings(next);
        return next;
      });
    },
    [engine]
  );

  const ensureLiveEngine = async (): Promise<boolean> => {
    if (live) return true;
    setErrorMsg(null);
    setStarting(true);
    const res = await engine.ensureReady(sourceMode, selectedDeviceId);
    setStarting(false);
    if (!res.ok) {
      setErrorMsg(res.error ?? 'Impossible de démarrer le moteur audio.');
      return false;
    }
    setLive(true);
    engine.setMonitor(monitor);
    const list = await engine.enumerateInputs();
    if (list.length > 0) {
      setDevices(list);
      if (!selectedDeviceId) setSelectedDeviceId(list[0].deviceId);
    }
    return true;
  };

  const ensurePlaybackEngine = async (): Promise<boolean> => {
    if (live) return true;
    setErrorMsg(null);
    const res = await engine.ensurePlaybackReady();
    if (!res.ok) {
      setErrorMsg(res.error ?? 'Impossible de démarrer la lecture audio.');
      return false;
    }
    return true;
  };

  const toggleLiveEngine = async () => {
    if (live) {
      if (isRecording) await toggleRecord();
      engine.stopEngine();
      setLive(false);
      setIsPlaying(false);
      setPlayheadSec(0);
      return;
    }
    await ensureLiveEngine();
  };

  const handleImportFiles = async (files: FileList | null, asVocal: boolean) => {
    if (!files || files.length === 0) return;
    setErrorMsg(null);
    setIsImporting(true);
    const decoded: StudioTrack[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const track = await engine.decodeAudioFile(f, asVocal);
        decoded.push(track);
      } catch {
        setErrorMsg(`Format non supporté ou fichier endommagé : ${f.name}`);
      }
    }
    if (decoded.length > 0) {
      setTracks((prev) => {
        const next = [...prev, ...decoded];
        engine.syncTracks(next);
        return next;
      });
    }
    setIsImporting(false);
  };

  const handleTrackUpdate = (id: string, patch: Partial<StudioTrack>) => {
    setTracks((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ...patch } : t));
      engine.syncTracks(next);
      return next;
    });
  };

  const handleTrackDelete = (id: string) => {
    setTracks((prev) => {
      const next = prev.filter((t) => t.id !== id);
      engine.syncTracks(next);
      if (isPlaying) {
        if (next.length === 0) {
          engine.stopPlayback();
          setIsPlaying(false);
        } else {
          engine.startPlayback(next, engine.getPlayheadSec());
        }
      }
      return next;
    });
  };

  const togglePlay = async () => {
    if (tracks.length === 0) {
      setErrorMsg('Importe au moins un instrumental ou enregistre une voix.');
      return;
    }
    if (!(await ensurePlaybackEngine())) return;
    if (isPlaying) {
      engine.pausePlayback();
      setIsPlaying(false);
    } else {
      engine.startPlayback(tracks);
      setIsPlaying(true);
    }
  };

  const handleStop = () => {
    if (isRecording) {
      toggleRecord();
      return;
    }
    engine.stopPlayback();
    setIsPlaying(false);
    setPlayheadSec(0);
  };

  const handleSeek = (sec: number) => {
    setPlayheadSec(sec);
    engine.seekTo(sec, tracks);
  };

  const toggleRecord = async () => {
    if (!(await ensureLiveEngine())) return;
    if (!isRecording) {
      if (tracks.length > 0 && !isPlaying) {
        engine.startPlayback(tracks);
        setIsPlaying(true);
      }
      engine.startRecording();
      setIsRecording(true);
    } else {
      const newTrack = await engine.stopRecordingAndBuildTrack(recCounterRef.current++);
      setIsRecording(false);
      if (isPlaying) {
        engine.pausePlayback();
        setIsPlaying(false);
      }
      if (newTrack) {
        setTracks((prev) => {
          const next = [...prev, newTrack];
          engine.syncTracks(next);
          return next;
        });
      }
    }
  };

  const applyPreset = (p: VocalPreset) => {
    setActivePresetId(p.id);
    updateVocal(p.values, false);
  };

  const handleSavePreset = () => {
    const trimmed = newPresetName.trim();
    if (!trimmed) return;
    const item: VocalPreset = {
      id: `custom-${Date.now()}`,
      name: trimmed,
      isCustom: true,
      values: { ...vocal },
    };
    const next = [...customPresets, item];
    setCustomPresets(next);
    setActivePresetId(item.id);
    setNewPresetName('');
    setShowPresetModal(false);
    try {
      localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const handleDeleteCustomPreset = (id: string) => {
    const next = customPresets.filter((p) => p.id !== id);
    setCustomPresets(next);
    if (activePresetId === id) setActivePresetId(null);
    try {
      localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  const runOfflineExport = async () => {
    if (tracks.length === 0) {
      setErrorMsg('Ajoute au moins une piste dans Studio avant de lancer le rendu.');
      return;
    }
    setErrorMsg(null);
    if (isPlaying) handleStop();
    setIsExporting(true);
    setExportProgress(0);
    try {
      const exp = await engine.exportMixOffline(tracks, exportFormat, (p) =>
        setExportProgress(p)
      );
      setExportsList((prev) => [exp, ...prev]);
      setActiveTab('exports');
    } catch {
      setErrorMsg('Erreur lors du rendu hors-ligne.');
    } finally {
      setIsExporting(false);
    }
  };

  const totalDurationSec = engine.getTotalDurationSec(tracks);
  const allPresets = [...BUILTIN_PRESETS, ...customPresets];
  const activeScaleIntervals = SCALES[vocal.scale] ?? SCALES.Chromatique;

  return (
    <div className="min-h-screen bg-[#F4F6FA] dark:bg-[#0B0F1A] text-slate-900 dark:text-slate-100 flex flex-col pb-20">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 bg-white/90 dark:bg-[#0B0F1A]/90 backdrop-blur-md border-b border-slate-200 dark:border-white/8">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <button
            type="button"
            onClick={() => setActiveTab('studio')}
            className="text-lg font-extrabold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            Voxora Studio
          </button>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium">
            {(
              [
                ['studio', 'Studio'],
                ['effects', 'Effets Voix'],
                ['mastering', 'Mastering'],
                ['exports', `Mes Exports (${exportsList.length})`],
              ] as [StudioTab, string][]
            ).map(([tabId, label]) => (
              <button
                key={tabId}
                type="button"
                onClick={() => setActiveTab(tabId)}
                className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === tabId
                    ? 'border-[#D97706] dark:border-[#FFB347] text-slate-900 dark:text-slate-100 font-semibold'
                    : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              disabled={starting}
              onClick={toggleLiveEngine}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                live
                  ? 'bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/40'
                  : 'bg-[#D97706] dark:bg-[#FFB347] text-white dark:text-[#0B0F1A]'
              }`}
            >
              <Power className="w-3.5 h-3.5" />
              {starting
                ? 'Initialisation...'
                : live
                ? 'Arrêter le moteur'
                : 'Démarrer le moteur'}
            </button>
          </div>
        </div>

        {/* Mobile horizontal tabs */}
        <div className="md:hidden grid grid-cols-4 border-t border-slate-200 dark:border-white/8 text-xs font-medium">
          {(
            [
              ['studio', 'Studio'],
              ['effects', 'Effets Voix'],
              ['mastering', 'Mastering'],
              ['exports', 'Exports'],
            ] as [StudioTab, string][]
          ).map(([tabId, label]) => (
            <button
              key={tabId}
              type="button"
              onClick={() => setActiveTab(tabId)}
              className={`py-2.5 text-center border-b-2 whitespace-nowrap truncate px-1 cursor-pointer ${
                activeTab === tabId
                  ? 'border-[#D97706] dark:border-[#FFB347] text-[#D97706] dark:text-[#FFB347] font-bold'
                  : 'border-transparent text-slate-500 dark:text-slate-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-5 space-y-6">
        {/* Global Studio Utility Bar: Headset Warning + Monitor + Theme Toggle */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-white/8">
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
            <Headphones className="w-4 h-4 shrink-0 text-[#0284C7] dark:text-[#5CD0E6]" />
            <span>
              Casque filaire recommandé en mode direct (sans casque : risque de larsen ; Bluetooth : latence élevée).
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                const next = !monitor;
                setMonitor(next);
                engine.setMonitor(next);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap cursor-pointer ${
                monitor
                  ? 'bg-[#0284C7]/10 dark:bg-[#5CD0E6]/15 border-[#0284C7]/35 dark:border-[#5CD0E6]/40 text-[#0284C7] dark:text-[#5CD0E6]'
                  : 'bg-white dark:bg-[#121829] border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400'
              }`}
            >
              {monitor ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              {monitor ? 'Écoute active' : 'Écoute coupée'}
            </button>

            <button
              type="button"
              onClick={() => setIsDark((d) => !d)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors whitespace-nowrap cursor-pointer"
              aria-label="Basculer le thème Clair / Sombre"
            >
              {isDark ? <Sun className="w-3.5 h-3.5 text-[#FFB347]" /> : <Moon className="w-3.5 h-3.5 text-slate-700" />}
              {isDark ? 'Mode Clair' : 'Mode Sombre'}
            </button>
          </div>
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div
            role="alert"
            className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl bg-rose-50 dark:bg-rose-950/60 border border-rose-300 dark:border-rose-500/35 text-sm text-rose-800 dark:text-rose-200"
          >
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="text-xs font-semibold underline shrink-0 cursor-pointer"
            >
              Fermer
            </button>
          </div>
        )}

        {/* TAB 1: STUDIO / MULTI-TRACK */}
        {activeTab === 'studio' && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight">
                  Studio Multi-Piste et Moniteur Vocal
                </h1>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs font-mono text-slate-500 dark:text-slate-400">
                  <span>{(telemetry.sampleRate / 1000).toFixed(1)} kHz</span>
                  <span aria-hidden="true">·</span>
                  <span>{live ? `Latence ~${telemetry.latencyMs} ms` : 'AudioWorklet temps réel'}</span>
                  <span aria-hidden="true">·</span>
                  <span>{tracks.length} piste(s) chargée(s)</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex p-1 rounded-lg bg-slate-200/70 dark:bg-[#121829] border border-slate-300/60 dark:border-white/10">
                  <button
                    type="button"
                    onClick={async () => {
                      setSourceMode('mic');
                      setMonitor(false);
                      engine.setMonitor(false);
                      if (live) {
                        const err = await engine.switchSource('mic', selectedDeviceId);
                        if (err) setErrorMsg(err);
                      }
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap cursor-pointer ${
                      sourceMode === 'mic'
                        ? 'bg-white dark:bg-[#FFB347] text-slate-900 dark:text-[#0B0F1A] shadow-xs'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    <Mic className="w-3.5 h-3.5" />
                    Microphone
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setSourceMode('synth');
                      setMonitor(true);
                      engine.setMonitor(true);
                      if (live) {
                        const err = await engine.switchSource('synth');
                        if (err) setErrorMsg(err);
                      }
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap cursor-pointer ${
                      sourceMode === 'synth'
                        ? 'bg-white dark:bg-[#FFB347] text-slate-900 dark:text-[#0B0F1A] shadow-xs'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    <Waves className="w-3.5 h-3.5" />
                    Synthé test
                  </button>
                </div>

                {sourceMode === 'mic' && devices.length > 0 && (
                  <select
                    aria-label="Sélectionner le microphone"
                    value={selectedDeviceId}
                    onChange={async (e) => {
                      setSelectedDeviceId(e.target.value);
                      if (live) await engine.switchSource('mic', e.target.value);
                    }}
                    className="max-w-[200px] bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/12 rounded-lg px-3 py-2 text-xs text-slate-800 dark:text-slate-200"
                  >
                    {devices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <PitchMonitorCanvas
              engine={engine}
              live={live}
              bypass={vocal.bypass}
              isDark={isDark}
              keyIndex={vocal.key}
              scaleName={vocal.scale}
              telemetry={telemetry}
            />

            {/* Unlimited Audio Import Actions */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <input
                  ref={beatInputRef}
                  type="file"
                  multiple
                  accept="audio/*,.wav,.mp3,.aac,.m4a,.ogg,.flac"
                  className="hidden"
                  onChange={(e) => {
                    handleImportFiles(e.target.files, false);
                    e.target.value = '';
                  }}
                />
                <input
                  ref={vocalInputRef}
                  type="file"
                  multiple
                  accept="audio/*,.wav,.mp3,.aac,.m4a,.ogg,.flac"
                  className="hidden"
                  onChange={(e) => {
                    handleImportFiles(e.target.files, true);
                    e.target.value = '';
                  }}
                />

                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => beatInputRef.current?.click()}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-semibold bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/12 text-slate-800 dark:text-slate-100 hover:border-[#0284C7] dark:hover:border-[#5CD0E6] transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-[#0284C7] dark:text-[#5CD0E6]" />
                  Importer un instrumental
                </button>

                <button
                  type="button"
                  disabled={isImporting}
                  onClick={() => vocalInputRef.current?.click()}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-semibold bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/12 text-slate-800 dark:text-slate-100 hover:border-[#D97706] dark:hover:border-[#FFB347] transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-[#D97706] dark:text-[#FFB347]" />
                  Importer des voix / stems
                </button>
              </div>

              {isImporting && (
                <span className="text-xs font-mono text-[#0284C7] dark:text-[#5CD0E6]">
                  Décodage audio en cours...
                </span>
              )}
            </div>

            {/* Clean Zero-State or Multi-Track Stack */}
            {tracks.length === 0 ? (
              <div className="py-14 px-6 text-center rounded-xl bg-white dark:bg-[#121829] border border-dashed border-slate-300 dark:border-white/15">
                <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  Espace de travail vierge
                </h2>
                <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400 max-w-lg mx-auto">
                  Aucune piste pré-remplie. Importe un nombre illimité d’instrumentaux, voix ou stems (WAV, MP3, AAC/M4A, OGG, FLAC), ou utilise le bouton d’enregistrement ci-dessous.
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => beatInputRef.current?.click()}
                    className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#0284C7] dark:bg-[#5CD0E6] text-white dark:text-[#0B0F1A] cursor-pointer"
                  >
                    Importer un instrumental
                  </button>
                  <button
                    type="button"
                    onClick={toggleRecord}
                    className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#D97706] dark:bg-[#FFB347] text-white dark:text-[#0B0F1A] cursor-pointer"
                  >
                    Enregistrer une voix
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {tracks.map((track) => (
                  <WaveformTrackCard
                    key={track.id}
                    track={track}
                    playheadSec={playheadSec}
                    onSeek={handleSeek}
                    onUpdate={handleTrackUpdate}
                    onDelete={handleTrackDelete}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: VOCAL EFFECTS */}
        {activeTab === 'effects' && (
          <div className="space-y-6">
            {/* Presets Strip */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {allPresets.map((p) => {
                  const active = activePresetId === p.id;
                  return (
                    <div key={p.id} className="inline-flex items-center">
                      <button
                        type="button"
                        onClick={() => applyPreset(p)}
                        className={`px-3.5 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap cursor-pointer ${
                          active
                            ? 'bg-[#D97706] dark:bg-[#FFB347] text-white dark:text-[#0B0F1A] border-transparent'
                            : 'bg-white dark:bg-[#121829] text-slate-700 dark:text-slate-200 border-slate-200 dark:border-white/10'
                        }`}
                      >
                        {p.name}
                      </button>
                      {p.isCustom && (
                        <button
                          type="button"
                          onClick={() => handleDeleteCustomPreset(p.id)}
                          className="ml-1 p-1.5 text-slate-400 hover:text-rose-500 cursor-pointer"
                          aria-label={`Supprimer preset ${p.name}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => updateVocal({ bypass: !vocal.bypass }, false)}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border whitespace-nowrap cursor-pointer ${
                    vocal.bypass
                      ? 'bg-rose-500/15 border-rose-500/40 text-rose-600 dark:text-rose-300'
                      : 'bg-white dark:bg-[#121829] border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-200'
                  }`}
                >
                  <Sliders className="w-3.5 h-3.5" />
                  {vocal.bypass ? 'Bypass actif' : 'Effets actifs'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPresetModal(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-[#0284C7] dark:bg-[#5CD0E6] text-white dark:text-[#0B0F1A] whitespace-nowrap cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  Sauvegarder preset
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setVocal(DEFAULT_VOCAL_SETTINGS);
                    engine.updateVocalSettings(DEFAULT_VOCAL_SETTINGS);
                    setActivePresetId('pop-studio');
                  }}
                  className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white cursor-pointer"
                  aria-label="Réinitialiser les effets"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Auto-Tune & Formant */}
              <div className="p-6 rounded-xl bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/10 space-y-4">
                <div className="flex items-baseline justify-between border-b border-slate-200 dark:border-white/8 pb-3">
                  <h2 className="text-base font-bold">Auto-Tune (YIN) & Timbre</h2>
                  <span className="text-xs font-mono text-[#D97706] dark:text-[#FFB347]">
                    {KEYS[vocal.key]} {vocal.scale}
                  </span>
                </div>

                <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5">
                  {KEYS.map((k, idx) => {
                    const selected = vocal.key === idx;
                    const rel = (((idx - vocal.key) % 12) + 12) % 12;
                    const inScale = activeScaleIntervals.includes(rel);
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => updateVocal({ key: idx }, false)}
                        className={`py-2 rounded-md text-xs font-mono font-semibold border cursor-pointer ${
                          selected
                            ? 'bg-[#D97706] dark:bg-[#FFB347] text-white dark:text-[#0B0F1A] border-transparent'
                            : inScale
                            ? 'bg-slate-100 dark:bg-white/6 text-slate-800 dark:text-slate-200 border-slate-200 dark:border-white/12'
                            : 'bg-slate-50 dark:bg-[#0B0F1A]/70 text-slate-400 dark:text-slate-500 border-slate-200/70 dark:border-white/5'
                        }`}
                      >
                        {k}
                      </button>
                    );
                  })}
                </div>

                <select
                  aria-label="Gamme musicale"
                  value={vocal.scale}
                  onChange={(e) => updateVocal({ scale: e.target.value }, false)}
                  className="w-full bg-slate-50 dark:bg-[#0B0F1A] border border-slate-200 dark:border-white/12 rounded-lg px-3 py-2.5 text-sm"
                >
                  {Object.keys(SCALES).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>

                <StudioSlider
                  id="fx-amt"
                  label="Correction"
                  value={vocal.tuneAmt}
                  min={0}
                  max={100}
                  unit=" %"
                  defaultValue={65}
                  onChange={(v) => updateVocal({ tuneAmt: v })}
                />
                <StudioSlider
                  id="fx-spd"
                  label="Vitesse d’accroche"
                  hint="100 = robot / trap"
                  value={vocal.tuneSpeed}
                  min={0}
                  max={100}
                  unit=" %"
                  defaultValue={50}
                  onChange={(v) => updateVocal({ tuneSpeed: v })}
                />
                <StudioSlider
                  id="fx-trn"
                  label="Transposition"
                  value={vocal.transpose}
                  min={-24}
                  max={24}
                  unit=" ½ ton"
                  defaultValue={0}
                  onChange={(v) => updateVocal({ transpose: v })}
                />
                <StudioSlider
                  id="fx-fmt"
                  label="Formant / Timbre vocal"
                  value={vocal.formant}
                  min={-12}
                  max={12}
                  step={0.5}
                  unit=" st"
                  defaultValue={0}
                  accent="cyan"
                  onChange={(v) => updateVocal({ formant: v })}
                />
              </div>

              {/* Noise Gate & De-Esser */}
              <div className="p-6 rounded-xl bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/10 space-y-4">
                <div className="border-b border-slate-200 dark:border-white/8 pb-3">
                  <h2 className="text-base font-bold">Noise Gate & De-Esser</h2>
                </div>
                <StudioSlider
                  id="fx-gate-thr"
                  label="Seuil Noise Gate"
                  value={vocal.gateThreshDb}
                  min={-70}
                  max={-15}
                  unit=" dB"
                  defaultValue={-52}
                  accent="cyan"
                  onChange={(v) => updateVocal({ gateThreshDb: v })}
                />
                <StudioSlider
                  id="fx-gate-atk"
                  label="Attaque Gate"
                  value={vocal.gateAttackMs}
                  min={1}
                  max={50}
                  unit=" ms"
                  defaultValue={5}
                  accent="cyan"
                  onChange={(v) => updateVocal({ gateAttackMs: v })}
                />
                <StudioSlider
                  id="fx-gate-rel"
                  label="Relâchement Gate"
                  value={vocal.gateReleaseMs}
                  min={20}
                  max={400}
                  unit=" ms"
                  defaultValue={120}
                  accent="cyan"
                  onChange={(v) => updateVocal({ gateReleaseMs: v })}
                />
                <StudioSlider
                  id="fx-deess"
                  label="De-Esser (Sibilances 6.8 kHz)"
                  value={vocal.deesser}
                  min={0}
                  max={100}
                  unit=" %"
                  defaultValue={25}
                  onChange={(v) => updateVocal({ deesser: v })}
                />
              </div>

              {/* 3-Band EQ & Compressor */}
              <div className="p-6 rounded-xl bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/10 space-y-3">
                <div className="flex items-baseline justify-between border-b border-slate-200 dark:border-white/8 pb-3">
                  <h2 className="text-base font-bold">Égaliseur 3 Bandes & Compresseur</h2>
                  <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    GR {telemetry.grDb.toFixed(1)} dB
                  </span>
                </div>
                <StudioSlider
                  id="fx-eq-low"
                  label="Graves (150 Hz)"
                  value={vocal.eqLowDb}
                  min={-12}
                  max={12}
                  step={0.5}
                  unit=" dB"
                  defaultValue={2}
                  onChange={(v) => updateVocal({ eqLowDb: v })}
                />
                <StudioSlider
                  id="fx-eq-mid"
                  label="Présence (Médiums)"
                  value={vocal.eqMidDb}
                  min={-12}
                  max={12}
                  step={0.5}
                  unit=" dB"
                  defaultValue={3}
                  onChange={(v) => updateVocal({ eqMidDb: v })}
                />
                <StudioSlider
                  id="fx-eq-midf"
                  label="Fréquence Présence"
                  value={vocal.eqMidFreq}
                  min={800}
                  max={6000}
                  step={50}
                  unit=" Hz"
                  defaultValue={3200}
                  accent="cyan"
                  onChange={(v) => updateVocal({ eqMidFreq: v })}
                />
                <StudioSlider
                  id="fx-eq-high"
                  label="Air (9.5 kHz)"
                  value={vocal.eqHighDb}
                  min={-12}
                  max={12}
                  step={0.5}
                  unit=" dB"
                  defaultValue={4}
                  onChange={(v) => updateVocal({ eqHighDb: v })}
                />
                <StudioSlider
                  id="fx-comp-thr"
                  label="Seuil Compresseur"
                  value={vocal.compThreshDb}
                  min={-40}
                  max={0}
                  unit=" dB"
                  defaultValue={-18}
                  accent="cyan"
                  onChange={(v) => updateVocal({ compThreshDb: v })}
                />
                <StudioSlider
                  id="fx-comp-rat"
                  label="Ratio Compresseur"
                  value={vocal.compRatio}
                  min={1}
                  max={12}
                  step={0.1}
                  unit=":1"
                  defaultValue={3.5}
                  accent="cyan"
                  onChange={(v) => updateVocal({ compRatio: v })}
                />
                <StudioSlider
                  id="fx-comp-mk"
                  label="Gain de compensation"
                  value={vocal.compMakeupDb}
                  min={0}
                  max={18}
                  step={0.5}
                  unit=" dB"
                  defaultValue={3}
                  onChange={(v) => updateVocal({ compMakeupDb: v })}
                />
              </div>

              {/* Doubler, Reverb & Delay */}
              <div className="p-6 rounded-xl bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/10 space-y-3">
                <div className="border-b border-slate-200 dark:border-white/8 pb-3">
                  <h2 className="text-base font-bold">Doubler, Réverbération & Delay</h2>
                </div>
                <StudioSlider
                  id="fx-dbl"
                  label="Doubler / Chorus Stéréo"
                  value={vocal.doubler}
                  min={0}
                  max={100}
                  unit=" %"
                  defaultValue={15}
                  accent="cyan"
                  onChange={(v) => updateVocal({ doubler: v })}
                />
                <StudioSlider
                  id="fx-rev-sz"
                  label="Taille Réverbération"
                  value={vocal.reverbSize}
                  min={10}
                  max={100}
                  unit=" %"
                  defaultValue={55}
                  accent="cyan"
                  onChange={(v) => updateVocal({ reverbSize: v })}
                />
                <StudioSlider
                  id="fx-rev-mx"
                  label="Mix Réverbération"
                  value={vocal.reverbMix}
                  min={0}
                  max={100}
                  unit=" %"
                  defaultValue={22}
                  onChange={(v) => updateVocal({ reverbMix: v })}
                />
                <StudioSlider
                  id="fx-del-ms"
                  label="Temps Delay / Écho"
                  value={vocal.delayMs}
                  min={60}
                  max={600}
                  step={5}
                  unit=" ms"
                  defaultValue={260}
                  accent="cyan"
                  onChange={(v) => updateVocal({ delayMs: v })}
                />
                <StudioSlider
                  id="fx-del-fb"
                  label="Feedback Delay"
                  value={vocal.delayFb}
                  min={0}
                  max={85}
                  unit=" %"
                  defaultValue={35}
                  accent="cyan"
                  onChange={(v) => updateVocal({ delayFb: v })}
                />
                <StudioSlider
                  id="fx-del-mx"
                  label="Mix Delay / Écho"
                  value={vocal.delayMix}
                  min={0}
                  max={100}
                  unit=" %"
                  defaultValue={0}
                  onChange={(v) => updateVocal({ delayMix: v })}
                />
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: MASTERING & OFFLINE EXPORT */}
        {activeTab === 'mastering' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            <div className="p-6 rounded-xl bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/10 space-y-3">
              <div className="flex items-baseline justify-between border-b border-slate-200 dark:border-white/8 pb-3">
                <div>
                  <h2 className="text-base font-bold">Bus de Masterisation</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    EQ Master, Glue Compressor, Exciter, Largeur Stéréo et Limiteur Brickwall
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => updateMaster({ bypass: !master.bypass })}
                  className="text-xs font-semibold text-[#0284C7] dark:text-[#5CD0E6] cursor-pointer"
                >
                  {master.bypass ? 'Activer Master' : 'Bypass Master'}
                </button>
              </div>

              <StudioSlider
                id="mst-low"
                label="Master EQ Bas (65 Hz)"
                value={master.eqLowDb}
                min={-8}
                max={8}
                step={0.5}
                unit=" dB"
                defaultValue={0}
                onChange={(v) => updateMaster({ eqLowDb: v })}
              />
              <StudioSlider
                id="mst-high"
                label="Master EQ Brillance (12 kHz)"
                value={master.eqHighDb}
                min={-8}
                max={8}
                step={0.5}
                unit=" dB"
                defaultValue={1}
                onChange={(v) => updateMaster({ eqHighDb: v })}
              />
              <StudioSlider
                id="mst-gthr"
                label="Seuil Glue Compressor"
                value={master.glueThreshDb}
                min={-30}
                max={0}
                unit=" dB"
                defaultValue={-14}
                accent="cyan"
                onChange={(v) => updateMaster({ glueThreshDb: v })}
              />
              <StudioSlider
                id="mst-gmix"
                label="Mix Glue Bus"
                value={master.glueMix}
                min={0}
                max={100}
                unit=" %"
                defaultValue={35}
                accent="cyan"
                onChange={(v) => updateMaster({ glueMix: v })}
              />
              <StudioSlider
                id="mst-exc"
                label="Exciter Harmonique (Chaleur)"
                value={master.exciter}
                min={0}
                max={100}
                unit=" %"
                defaultValue={15}
                onChange={(v) => updateMaster({ exciter: v })}
              />
              <StudioSlider
                id="mst-wid"
                label="Imagerie Stéréo (Largeur)"
                value={master.stereoWidth}
                min={0}
                max={180}
                unit=" %"
                defaultValue={108}
                accent="cyan"
                onChange={(v) => updateMaster({ stereoWidth: v })}
              />
              <StudioSlider
                id="mst-drv"
                label="Drive Limiteur"
                value={master.limiterDriveDb}
                min={0}
                max={12}
                step={0.5}
                unit=" dB"
                defaultValue={1.5}
                onChange={(v) => updateMaster({ limiterDriveDb: v })}
              />
              <StudioSlider
                id="mst-ceil"
                label="Plafond Limiteur (Ceiling)"
                value={master.limiterCeilingDb}
                min={-3.0}
                max={-0.1}
                step={0.1}
                unit=" dBTP"
                defaultValue={-1.0}
                accent="cyan"
                onChange={(v) => updateMaster({ limiterCeilingDb: v })}
              />
            </div>

            <div className="p-6 rounded-xl bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/10 space-y-5">
              <div className="border-b border-slate-200 dark:border-white/8 pb-3">
                <h2 className="text-base font-bold">Rendu & Export Hors-Ligne</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Compile toutes les pistes actives avec les effets vocaux et la chaîne de mastering.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#0B0F1A] border border-slate-200 dark:border-white/8">
                  <div className="text-slate-500 dark:text-slate-400">Loudness estimé</div>
                  <div className="mt-1 text-lg font-bold text-[#0284C7] dark:text-[#5CD0E6] tabular-nums">
                    {telemetry.lufs.toFixed(1)} LUFS
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-[#0B0F1A] border border-slate-200 dark:border-white/8">
                  <div className="text-slate-500 dark:text-slate-400">Plafond Brickwall</div>
                  <div className="mt-1 text-lg font-bold text-[#D97706] dark:text-[#FFB347] tabular-nums">
                    {master.limiterCeilingDb.toFixed(1)} dBTP
                  </div>
                </div>
              </div>

              <div>
                <span className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  Format d’exportation
                </span>
                <div className="inline-flex p-1 rounded-lg bg-slate-100 dark:bg-[#0B0F1A] border border-slate-200 dark:border-white/10">
                  {(
                    [
                      ['wav24', 'WAV 24-bit Studio'],
                      ['wav16', 'WAV 16-bit CD'],
                    ] as const
                  ).map(([fmt, label]) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setExportFormat(fmt)}
                      className={`px-3.5 py-2 rounded-md text-xs font-semibold whitespace-nowrap cursor-pointer ${
                        exportFormat === fmt
                          ? 'bg-white dark:bg-[#FFB347] text-slate-900 dark:text-[#0B0F1A] shadow-xs'
                          : 'text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {isExporting && (
                <div className="space-y-1.5">
                  <div className="w-full h-2 rounded-full bg-slate-200 dark:bg-[#0B0F1A] overflow-hidden">
                    <div
                      className="h-full bg-[#D97706] dark:bg-[#FFB347] transition-all duration-75"
                      style={{ width: `${Math.round(exportProgress * 100)}%` }}
                    />
                  </div>
                  <p className="text-xs font-mono text-slate-500 dark:text-slate-400">
                    Rendu hors-ligne : {Math.round(exportProgress * 100)} %
                  </p>
                </div>
              )}

              <button
                type="button"
                disabled={isExporting || tracks.length === 0}
                onClick={runOfflineExport}
                className="w-full py-3 px-4 rounded-xl text-sm font-bold bg-[#D97706] dark:bg-[#FFB347] text-white dark:text-[#0B0F1A] hover:opacity-95 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity cursor-pointer"
              >
                {isExporting ? 'Rendu en cours...' : 'Exporter le Mix / Master'}
              </button>
            </div>
          </div>
        )}

        {/* TAB 4: MES EXPORTS */}
        {activeTab === 'exports' && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-bold">Mes Exports Masterisés</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Écoute, vérifie et télécharge tes fichiers finaux WAV 16/24-bit.
              </p>
            </div>
            <ExportsPanel
              exportsList={exportsList}
              onDelete={(id) => {
                setExportsList((prev) => {
                  const target = prev.find((x) => x.id === id);
                  if (target) URL.revokeObjectURL(target.url);
                  return prev.filter((x) => x.id !== id);
                });
              }}
            />
          </div>
        )}
      </main>

      {/* Preset Save Modal (Synchronized Theme) */}
      {showPresetModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
        >
          <div className="w-full max-w-sm p-5 rounded-xl bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/15 space-y-4 shadow-xl">
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
              Sauvegarder le preset vocal
            </h3>
            <input
              type="text"
              autoFocus
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              placeholder="Nom du preset (ex. Ma Voix Trap)"
              className="w-full px-3 py-2.5 rounded-lg text-sm bg-slate-50 dark:bg-[#0B0F1A] border border-slate-300 dark:border-white/15 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-[#FFB347]"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowPresetModal(false)}
                className="px-3.5 py-2 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={handleSavePreset}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#D97706] dark:bg-[#FFB347] text-white dark:text-[#0B0F1A] cursor-pointer"
              >
                Sauvegarder
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fixed Bottom Studio Transport Bar */}
      <footer className="fixed bottom-0 inset-x-0 z-30 h-16 bg-white/95 dark:bg-[#121829]/95 backdrop-blur-md border-t border-slate-200 dark:border-white/10">
        <div className="max-w-[1280px] mx-auto h-full px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={togglePlay}
              className="w-10 h-10 rounded-lg bg-[#D97706] dark:bg-[#FFB347] text-white dark:text-[#0B0F1A] flex items-center justify-center cursor-pointer"
              aria-label={isPlaying ? 'Pause' : 'Lecture'}
            >
              {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
            </button>

            <button
              type="button"
              onClick={handleStop}
              className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-[#0B0F1A] border border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-200 flex items-center justify-center cursor-pointer"
              aria-label="Stop"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
            </button>

            <button
              type="button"
              onClick={toggleRecord}
              className={`inline-flex items-center gap-2 px-3.5 h-10 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap cursor-pointer ${
                isRecording
                  ? 'bg-rose-500/20 border-rose-500 text-rose-600 dark:text-rose-300'
                  : 'bg-slate-100 dark:bg-[#0B0F1A] border-slate-200 dark:border-white/10 text-slate-800 dark:text-slate-200'
              }`}
            >
              <Circle className="w-3.5 h-3.5 fill-rose-500 text-rose-500" />
              {isRecording ? 'Arrêter prise' : 'Enregistrer'}
            </button>
          </div>

          <div className="flex items-center gap-4 text-xs font-mono tabular-nums">
            <span className="hidden sm:inline text-slate-500 dark:text-slate-400">
              {telemetry.lufs.toFixed(1)} LUFS
            </span>
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
              {formatTimecode(playheadSec)} / {formatTimecode(totalDurationSec)}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
