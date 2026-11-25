import React, { useEffect, useRef, useState } from 'react';
import { Download, Play, Square, Trash2 } from 'lucide-react';
import { formatTimecode } from '../audio/constants';
import { ExportedMix } from '../audio/VoxoraAudioEngine';

interface ExportsPanelProps {
  exportsList: ExportedMix[];
  onDelete: (id: string) => void;
}

export const ExportsPanel: React.FC<ExportsPanelProps> = ({ exportsList, onDelete }) => {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const togglePlay = (item: ExportedMix) => {
    if (playingId === item.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(item.url);
    audio.onended = () => setPlayingId(null);
    audio.play().catch(() => setPlayingId(null));
    audioRef.current = audio;
    setPlayingId(item.id);
  };

  const formatSize = (bytes: number) =>
    bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(0)} Ko`
      : `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;

  if (exportsList.length === 0) {
    return (
      <div className="py-14 text-center rounded-xl bg-white dark:bg-[#121829] border border-dashed border-slate-300 dark:border-white/15">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
          Aucun export audio finalisé
        </p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
          Importe ou enregistre tes pistes dans Studio, ajuste le Mastering puis lance le rendu hors-ligne pour générer ton master WAV.
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-slate-200 dark:divide-white/8 rounded-xl bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/10">
      {exportsList.map((item) => {
        const isPlaying = playingId === item.id;
        return (
          <div
            key={item.id}
            className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-4 px-4 py-3.5"
          >
            <div className="flex items-center gap-3.5 min-w-0">
              <button
                type="button"
                onClick={() => togglePlay(item)}
                className="w-10 h-10 shrink-0 rounded-lg bg-slate-100 dark:bg-[#0B0F1A] border border-slate-200 dark:border-white/10 flex items-center justify-center text-[#D97706] dark:text-[#FFB347] cursor-pointer"
                aria-label={isPlaying ? `Arrêter ${item.name}` : `Écouter ${item.name}`}
              >
                {isPlaying ? (
                  <Square className="w-4 h-4 fill-current" />
                ) : (
                  <Play className="w-4 h-4 fill-current ml-0.5" />
                )}
              </button>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                  {item.name}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                  <span>{item.formatLabel}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatTimecode(item.durationSec)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatSize(item.sizeBytes)}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <a
                href={item.url}
                download={item.name}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-[#D97706] dark:bg-[#FFB347] text-white dark:text-[#0B0F1A] hover:opacity-90 transition-opacity whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                Télécharger
              </a>
              <button
                type="button"
                onClick={() => {
                  if (isPlaying) {
                    audioRef.current?.pause();
                    setPlayingId(null);
                  }
                  onDelete(item.id);
                }}
                className="p-2 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors cursor-pointer"
                aria-label={`Supprimer ${item.name}`}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
