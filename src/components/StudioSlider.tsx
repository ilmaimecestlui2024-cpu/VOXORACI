import React from 'react';

interface StudioSliderProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  defaultValue: number;
  accent?: 'amber' | 'cyan';
  hint?: string;
  onChange: (value: number) => void;
}

export const StudioSlider: React.FC<StudioSliderProps> = ({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  defaultValue,
  accent = 'amber',
  hint,
  onChange,
}) => {
  const safeVal = Math.max(min, Math.min(max, value));
  const formatted =
    step < 1
      ? safeVal.toFixed(1)
      : `${safeVal > 0 && min < 0 ? '+' : ''}${Math.round(safeVal)}`;

  return (
    <div className="py-1">
      <div className="flex items-baseline justify-between gap-3 mb-0.5">
        <label
          htmlFor={id}
          className="text-sm font-medium text-slate-800 dark:text-slate-200 select-none cursor-pointer truncate"
          onDoubleClick={() => onChange(defaultValue)}
          title="Double-cliquer pour réinitialiser"
        >
          {label}
          {hint && (
            <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
              {hint}
            </span>
          )}
        </label>
        <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300 shrink-0 whitespace-nowrap">
          {formatted}
          {unit}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={safeVal}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(defaultValue)}
        className={`studio-fader ${accent === 'cyan' ? 'cyan-thumb' : ''}`}
      />
    </div>
  );
};
