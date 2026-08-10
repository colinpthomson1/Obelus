import type { CSSProperties, SVGProps } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../utils';
import './ObelusLoader.css';

export type ObelusLoaderVariant =
  'proof-pulse' | 'transcript-scan' | 'source-exchange' | 'obelus-resolve' | 'progress-divide';

type ObelusLoaderProps = Omit<SVGProps<globalThis.SVGSVGElement>, 'children'> & {
  variant?: ObelusLoaderVariant;
  progress?: number;
  label?: string;
  announce?: boolean;
};

const barPath =
  'M17 27H45C47.4 27 49.2 28.2 51.4 30.4C52.3 31.3 52.3 32.7 51.4 33.6C49.2 35.8 47.4 37 45 37H17C14.2 37 12 34.8 12 32C12 29.2 14.2 27 17 27Z';

export function ObelusLoader({
  variant = 'proof-pulse',
  progress = 0,
  label = 'Checking…',
  announce = true,
  className,
  style,
  ...svgProps
}: ObelusLoaderProps) {
  const hostRef = useRef<globalThis.HTMLSpanElement>(null);
  const [isInViewport, setIsInViewport] = useState(true);
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    () => typeof document === 'undefined' || !document.hidden
  );
  const scanId = `ob-scan-${useId().replace(/:/g, '')}`;
  const boundedProgress = Math.max(0, Math.min(1, progress));
  const cssStyle = { ...style, '--ob-progress': boundedProgress } as CSSProperties;
  const isDeterminate = variant === 'progress-divide';
  const progressValue = Math.round(boundedProgress * 100);

  useEffect(() => {
    const host = hostRef.current;
    const handleVisibilityChange = () => setIsDocumentVisible(!document.hidden);
    const observer =
      host && typeof globalThis.IntersectionObserver !== 'undefined'
        ? new globalThis.IntersectionObserver(([entry]) => setIsInViewport(entry.isIntersecting))
        : null;

    if (host && observer) observer.observe(host);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const pieces = (className?: string) => (
    <g className={className} fill="currentColor">
      <circle cx="26" cy="14" r="5.6" />
      <path d={barPath} />
      <circle cx="38" cy="50" r="5.6" />
    </g>
  );

  return (
    <span
      ref={hostRef}
      role={announce ? (isDeterminate ? 'progressbar' : 'status') : undefined}
      aria-label={announce && isDeterminate ? label : undefined}
      aria-live={announce && !isDeterminate ? 'polite' : undefined}
      aria-atomic={announce && !isDeterminate ? true : undefined}
      aria-busy={announce && !isDeterminate ? true : undefined}
      aria-valuemin={announce && isDeterminate ? 0 : undefined}
      aria-valuemax={announce && isDeterminate ? 100 : undefined}
      aria-valuenow={announce && isDeterminate ? progressValue : undefined}
      aria-valuetext={announce && isDeterminate ? `${progressValue}%` : undefined}
      className="obelus-loader-host inline-flex shrink-0"
      data-paused={!isInViewport || !isDocumentVisible ? 'true' : undefined}
    >
      <svg
        {...svgProps}
        aria-hidden="true"
        className={cn('obelus-loader', className)}
        data-complete={boundedProgress === 1}
        data-variant={variant}
        viewBox="0 0 64 64"
        style={cssStyle}
      >
        {variant === 'transcript-scan' && (
          <defs>
            <clipPath id={scanId}>
              <rect className="ob-scan-window" x="-12" y="0" width="12" height="64" rx="6" />
            </clipPath>
          </defs>
        )}
        {pieces('ob-base')}
        {variant === 'source-exchange' ? (
          <g fill="currentColor">
            <path d={barPath} />
            <g className="ob-source-pair">
              <circle cx="26" cy="14" r="5.6" />
              <circle cx="38" cy="50" r="5.6" />
            </g>
          </g>
        ) : variant === 'transcript-scan' ? (
          <g clipPath={`url(#${scanId})`}>{pieces('ob-animated')}</g>
        ) : (
          <g className={`ob-loader-pieces ob-${variant}`} fill="currentColor">
            <circle className="ob-top" cx="26" cy="14" r="5.6" />
            <path className="ob-bar" d={barPath} />
            <circle className="ob-bottom" cx="38" cy="50" r="5.6" />
          </g>
        )}
      </svg>
      {announce && !isDeterminate && <span className="sr-only">{label}</span>}
    </span>
  );
}
