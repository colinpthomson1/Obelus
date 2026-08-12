import { cn } from '../../utils';

interface AudioLevelMeterProps {
  value: number;
  active?: boolean;
  label: string;
  compact?: boolean;
}

export function AudioLevelMeter({ value, active = true, label, compact }: AudioLevelMeterProps) {
  const bounded = Math.max(0, Math.min(1, value));
  return (
    <div
      className={cn('flex items-center gap-2', compact ? 'min-w-20' : 'w-full')}
      aria-label={`${label} level`}
    >
      <span
        className={cn(
          'relative block overflow-hidden rounded-full bg-neutral-200 dark:bg-brand-ink-muted',
          compact ? 'h-1.5 w-14' : 'h-2 w-full'
        )}
      >
        <span
          className={cn(
            'absolute inset-y-0 left-0 origin-left rounded-full transition-transform duration-120 motion-reduce:transition-none',
            active ? 'bg-brand-aqua' : 'bg-neutral-400'
          )}
          style={{ transform: `scaleX(${bounded})`, width: '100%' }}
        />
      </span>
      {!compact && (
        <span className="w-8 text-right font-mono text-[11px] tabular-nums text-text-tertiary">
          {Math.round(bounded * 100)}
        </span>
      )}
    </div>
  );
}
