import React, { useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { formatTimecode } from '../audio/constants';
import { StudioTrack } from '../audio/VoxoraAudioEngine';
import { StudioSlider } from './StudioSlider';

interface WaveformTrackCardProps {
  track: StudioTrack;
  playheadSec: number;
  onSeek: (sec: number) => void;
  onUpdate: (id: string, patch: Partial<StudioTrack>) => void;
  onDelete: (id: string) => void;
}

export const WaveformTrackCard: React.FC<WaveformTrackCardProps> = ({
  track,
  playheadSec,
  onSeek,
  onUpdate,
  onDelete,
}) => {
  const waveRef = useRef<HTMLDivElement | null>(null);
  const effectivePlayhead = Math.max(0, playheadSec - track.offsetMs / 1000);
  const progress =
    track.durationSec > 0 ? Math.min(1, effectivePlayhead / track.durationSec) : 0;

  const handleScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = waveRef.current;
    if (!el || track.durationSec <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(ratio * track.durationSec + track.offsetMs / 1000);
  };

  return (
    <div className="p-4 rounded-xl bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/10 space-y-3">
      {/* Track Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2.5">
          <span
            className={`text-[11px] font-mono font-bold uppercase tracking-wider shrink-0 ${
              track.isVocal
                ? 'text-[#D97706] dark:text-[#FFB347]'
                : 'text-[#0284C7] dark:text-[#5CD0E6]'
            }`}
          >
            {track.isVocal ? 'Voix' : 'Beat'}
          </span>
          <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
            ·
          </span>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
            {track.name}
          </h3>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
            {formatTimecode(track.durationSec)}
          </span>
          <button
            type="button"
            onClick={() => onDelete(track.id)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors cursor-pointer"
            aria-label={`Supprimer ${track.name}`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Interactive Scrubbing Waveform */}
      <div
        ref={waveRef}
        onClick={handleScrub}
        role="slider"
        aria-label={`Timeline de ${track.name}`}
        aria-valuemin={0}
        aria-valuemax={Math.round(track.durationSec)}
        aria-valuenow={Math.round(effectivePlayhead)}
        tabIndex={0}
        className="relative h-14 w-full bg-slate-100 dark:bg-[#0B0F1A] border border-slate-200 dark:border-white/8 rounded-lg px-2 flex items-center gap-[2px] cursor-pointer overflow-hidden"
      >
        {track.peaks.map((pk, idx) => {
          const passed = idx / track.peaks.length <= progress;
          const heightPct = Math.max(8, Math.min(92, pk * 92));
          return (
            <div
              key={idx}
              className={`flex-1 rounded-full transition-colors duration-75 ${
                track.isVocal
                  ? passed
                    ? 'bg-[#D97706] dark:bg-[#FFB347]'
                    : 'bg-[#D97706]/30 dark:bg-[#FFB347]/25'
                  : passed
                  ? 'bg-[#0284C7] dark:bg-[#5CD0E6]'
                  : 'bg-[#0284C7]/30 dark:bg-[#5CD0E6]/25'
              }`}
              style={{ height: `${heightPct}%` }}
            />
          );
        })}
        <div
          className="pointer-events-none absolute top-0 bottom-0 w-[2px] bg-slate-900 dark:bg-white"
          style={{ left: `${progress * 100}%` }}
        />
      </div>

      {/* Controls: M, S, FX, Volume, Pan, Offset */}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <button
          type="button"
          onClick={() => onUpdate(track.id, { mute: !track.mute })}
          className={`px-3 py-1.5 rounded-md text-xs font-mono font-bold border transition-colors whitespace-nowrap cursor-pointer ${
            track.mute
              ? 'bg-rose-500/15 border-rose-500 text-rose-600 dark:text-rose-400'
              : 'bg-slate-100 dark:bg-[#0B0F1A] border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300'
          }`}
        >
          Mute
        </button>
        <button
          type="button"
          onClick={() => onUpdate(track.id, { solo: !track.solo })}
          className={`px-3 py-1.5 rounded-md text-xs font-mono font-bold border transition-colors whitespace-nowrap cursor-pointer ${
            track.solo
              ? 'bg-[#D97706]/15 border-[#D97706] text-[#D97706] dark:border-[#FFB347] dark:text-[#FFB347]'
              : 'bg-slate-100 dark:bg-[#0B0F1A] border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300'
          }`}
        >
          Solo
        </button>
        {track.isVocal && (
          <button
            type="button"
            onClick={() => onUpdate(track.id, { fxEnabled: !track.fxEnabled })}
            className={`px-3 py-1.5 rounded-md text-xs font-mono font-bold border transition-colors whitespace-nowrap cursor-pointer ${
              track.fxEnabled
                ? 'bg-[#0284C7]/15 border-[#0284C7] text-[#0284C7] dark:border-[#5CD0E6] dark:text-[#5CD0E6]'
                : 'bg-slate-100 dark:bg-[#0B0F1A] border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300'
            }`}
          >
            Effets Voix
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-1">
        <StudioSlider
          id={`vol-${track.id}`}
          label="Volume"
          value={Math.round(track.volume * 100)}
          min={0}
          max={150}
          unit=" %"
          defaultValue={100}
          accent={track.isVocal ? 'amber' : 'cyan'}
          onChange={(v) => onUpdate(track.id, { volume: v / 100 })}
        />
        <StudioSlider
          id={`pan-${track.id}`}
          label="Panoramique"
          value={Math.round(track.pan * 100)}
          min={-100}
          max={100}
          unit=""
          defaultValue={0}
          accent={track.isVocal ? 'amber' : 'cyan'}
          onChange={(v) => onUpdate(track.id, { pan: v / 100 })}
        />
        <StudioSlider
          id={`off-${track.id}`}
          label="Calage temporel"
          value={track.offsetMs}
          min={-500}
          max={500}
          unit=" ms"
          defaultValue={0}
          accent={track.isVocal ? 'amber' : 'cyan'}
          onChange={(v) => onUpdate(track.id, { offsetMs: v })}
        />
      </div>
    </div>
  );
};
