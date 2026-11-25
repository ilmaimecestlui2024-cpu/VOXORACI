import React, { useEffect, useRef } from 'react';
import { KEYS, getScaleMask, midiToNoteInfo } from '../audio/constants';
import { TelemetryData, VoxoraAudioEngine } from '../audio/VoxoraAudioEngine';

interface PitchMonitorCanvasProps {
  engine: VoxoraAudioEngine;
  live: boolean;
  bypass: boolean;
  isDark: boolean;
  keyIndex: number;
  scaleName: string;
  telemetry: TelemetryData;
}

export const PitchMonitorCanvas: React.FC<PitchMonitorCanvasProps> = ({
  engine,
  live,
  bypass,
  isDark,
  keyIndex,
  scaleName,
  telemetry,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef({ live, bypass, isDark, keyIndex, scaleName });
  propsRef.current = { live, bypass, isDark, keyIndex, scaleName };

  useEffect(() => {
    let rafId = 0;

    const render = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const rect = canvas.getBoundingClientRect();
        const targetW = Math.max(1, Math.floor(rect.width * dpr));
        const targetH = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.scale(dpr, dpr);
          drawPitchPlot(
            ctx,
            rect.width,
            rect.height,
            engine,
            propsRef.current.keyIndex,
            propsRef.current.scaleName,
            propsRef.current.live,
            propsRef.current.bypass,
            propsRef.current.isDark
          );
          ctx.restore();
        }
      }
      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafId);
  }, [engine]);

  const activeMidi = telemetry.cor > 0 ? telemetry.cor : telemetry.det;
  const noteInfo = midiToNoteInfo(activeMidi);
  const rawInfo = midiToNoteInfo(telemetry.det);
  const deltaCents =
    telemetry.voiced && telemetry.det > 0 && telemetry.cor > 0
      ? Math.round((telemetry.cor - telemetry.det) * 100)
      : 0;

  const inPct = Math.min(100, telemetry.inLevel * 220);
  const outPct = Math.min(100, telemetry.outLevel * 100);
  const grPct = Math.min(100, Math.abs(telemetry.grDb) * 5);

  return (
    <div className="relative w-full h-[250px] sm:h-[270px] bg-white dark:bg-[#121829] border border-slate-200 dark:border-white/10 rounded-xl overflow-hidden">
      <canvas
        ref={canvasRef}
        className="w-full h-full block cursor-crosshair"
        aria-label="Moniteur de hauteur et niveaux en direct"
      />

      {/* Legend */}
      <div className="pointer-events-none absolute top-3.5 left-4 flex items-center gap-5 text-xs font-mono text-slate-600 dark:text-slate-400">
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span className="inline-block w-3 h-[2px] bg-[#0284C7] dark:bg-[#5CD0E6]" />
          Voix détectée
        </span>
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span className="inline-block w-3 h-[3px] bg-[#D97706] dark:bg-[#FFB347]" />
          {bypass ? 'Bypass actif' : 'Note corrigée'}
        </span>
      </div>

      {/* Meters & Active Note HUD */}
      <div className="pointer-events-none absolute top-3.5 right-4 flex items-start gap-5">
        <div className="hidden sm:flex items-end gap-2 h-14 pt-1">
          <div className="flex flex-col items-center gap-1">
            <div className="w-2 h-11 bg-slate-200 dark:bg-slate-900 rounded-sm overflow-hidden flex flex-col justify-end">
              <div
                className="w-full bg-[#0284C7] dark:bg-[#5CD0E6] transition-all duration-75"
                style={{ height: `${inPct}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-slate-500">IN</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <div className="w-2 h-11 bg-slate-200 dark:bg-slate-900 rounded-sm overflow-hidden flex flex-col justify-end">
              <div
                className="w-full bg-[#D97706] dark:bg-[#FFB347] transition-all duration-75"
                style={{ height: `${outPct}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-slate-500">OUT</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <div className="w-2 h-11 bg-slate-200 dark:bg-slate-900 rounded-sm overflow-hidden flex flex-col justify-start">
              <div
                className="w-full bg-rose-500 transition-all duration-75"
                style={{ height: `${grPct}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-slate-500">GR</span>
          </div>
        </div>

        <div className="text-right min-w-[110px]">
          <div className="text-[36px] leading-none font-extrabold tracking-tight tabular-nums text-[#D97706] dark:text-[#FFB347]">
            {noteInfo.full}
          </div>
          <div className="mt-1.5 flex items-center justify-end gap-2 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
            <span>{noteInfo.freq > 0 ? `${noteInfo.freq.toFixed(1)} Hz` : '0.0 Hz'}</span>
            <span aria-hidden="true">·</span>
            <span className={deltaCents !== 0 ? 'text-[#0284C7] dark:text-[#5CD0E6]' : ''}>
              {rawInfo.freq > 0 ? `${deltaCents >= 0 ? '+' : ''}${deltaCents} ¢` : '0 ¢'}
            </span>
          </div>
        </div>
      </div>

      {!live && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-100/60 dark:bg-[#0B0F1A]/50">
          <div className="text-center px-6">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              Moteur AudioWorklet en veille
            </p>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
              Clique sur « Démarrer le moteur » ou importe des pistes audio pour lancer le studio.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

function drawPitchPlot(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  engine: VoxoraAudioEngine,
  keyIndex: number,
  scaleName: string,
  live: boolean,
  bypass: boolean,
  isDark: boolean
) {
  ctx.clearRect(0, 0, w, h);

  const det = engine.detHistory;
  const cor = engine.corHistory;
  const len = det.length;
  const writeIdx = engine.historyWriteIdx;
  const mask = getScaleMask(scaleName);

  let minM = Infinity;
  let maxM = -Infinity;
  for (let i = 0; i < len; i++) {
    const v = det[i];
    if (v > 0) {
      if (v < minM) minM = v;
      if (v > maxM) maxM = v;
    }
  }

  let lo = 52;
  let hi = 76;
  if (minM !== Infinity && maxM !== -Infinity) {
    const center = (minM + maxM) * 0.5;
    lo = center - 12;
    hi = center + 12;
  }

  const padTop = 42;
  const padBottom = 16;
  const plotH = Math.max(40, h - padTop - padBottom);
  const yForMidi = (m: number) => padTop + plotH - ((m - lo) / (hi - lo)) * plotH;

  ctx.font = '500 10px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';
  const leftPad = 48;

  for (let n = Math.ceil(lo); n <= Math.floor(hi); n++) {
    const rel = (((n - keyIndex) % 12) + 12) % 12;
    const inScale = ((mask >> rel) & 1) === 1;
    const isRoot = rel === 0;
    const y = yForMidi(n);

    if (inScale) {
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(w - 12, y);
      ctx.strokeStyle = isRoot
        ? isDark
          ? 'rgba(255, 179, 71, 0.28)'
          : 'rgba(217, 119, 6, 0.30)'
        : isDark
        ? 'rgba(255, 255, 255, 0.08)'
        : 'rgba(15, 23, 42, 0.08)';
      ctx.lineWidth = isRoot ? 1.5 : 1;
      ctx.stroke();

      const octave = Math.floor(n / 12) - 1;
      ctx.fillStyle = isRoot
        ? isDark
          ? 'rgba(255, 179, 71, 0.9)'
          : 'rgba(217, 119, 6, 0.95)'
        : isDark
        ? 'rgba(148, 163, 184, 0.55)'
        : 'rgba(71, 85, 105, 0.65)';
      ctx.fillText(`${KEYS[(((n % 12) + 12) % 12)]}${octave}`, 10, y);
    }
  }

  if (!live) return;

  const plotW = w - leftPad - 14;
  const drawCurve = (arr: Float32Array, color: string, lw: number) => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let drawing = false;
    let lx = 0;
    let ly = 0;

    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const idx = (writeIdx + i) % len;
      const m = arr[idx];
      const x = leftPad + (i / (len - 1)) * plotW;
      if (m <= 0) {
        drawing = false;
        continue;
      }
      const y = yForMidi(m);
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        ctx.lineTo(x, y);
      }
      lx = x;
      ly = y;
    }
    ctx.stroke();

    if (drawing && arr[(writeIdx + len - 1) % len] > 0) {
      ctx.beginPath();
      ctx.arc(lx, ly, lw + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.restore();
  };

  drawCurve(det, isDark ? '#5CD0E6' : '#0284C7', 1.8);
  drawCurve(
    cor,
    bypass
      ? isDark
        ? 'rgba(255, 179, 71, 0.35)'
        : 'rgba(217, 119, 6, 0.35)'
      : isDark
      ? '#FFB347'
      : '#D97706',
    2.8
  );
}
