import type { CSSProperties, SVGProps } from "react";
import { useId } from "react";
import "../Tokens/obelus-motion.css";
import "./ObelusLoader.css";

export type ObelusLoaderVariant =
  | "proof-pulse"
  | "transcript-scan"
  | "source-exchange"
  | "obelus-resolve"
  | "progress-divide";

type Props = Omit<SVGProps<SVGSVGElement>, "children"> & {
  variant?: ObelusLoaderVariant;
  progress?: number;
  label?: string;
};

const barPath = "M17 27H45C47.4 27 49.2 28.2 51.4 30.4C52.3 31.3 52.3 32.7 51.4 33.6C49.2 35.8 47.4 37 45 37H17C14.2 37 12 34.8 12 32C12 29.2 14.2 27 17 27Z";

export function ObelusLoader({
  variant = "proof-pulse",
  progress = 0,
  label = "Checking…",
  style,
  ...svgProps
}: Props) {
  const scanId = `ob-scan-${useId().replaceAll(":", "")}`;
  const boundedProgress = Math.max(0, Math.min(1, progress));
  const cssStyle = { ...style, "--ob-progress": boundedProgress } as CSSProperties;

  const pieces = (className?: string) => (
    <g className={className} fill="currentColor">
      <circle cx="26" cy="14" r="5.6" />
      <path d={barPath} />
      <circle cx="38" cy="50" r="5.6" />
    </g>
  );

  return (
    <span role="status" aria-live="polite" aria-atomic="true">
      <svg
        {...svgProps}
        aria-hidden="true"
        data-complete={boundedProgress === 1}
        data-variant={variant}
        viewBox="0 0 64 64"
        style={cssStyle}
      >
        {variant === "transcript-scan" && (
          <defs><clipPath id={scanId}><rect className="ob-scan-window" x="-12" y="0" width="12" height="64" rx="6" /></clipPath></defs>
        )}
        {pieces("ob-base")}
        {variant === "source-exchange" ? (
          <g fill="currentColor"><path d={barPath} /><g className="ob-source-pair"><circle cx="26" cy="14" r="5.6" /><circle cx="38" cy="50" r="5.6" /></g></g>
        ) : variant === "transcript-scan" ? (
          <g clipPath={`url(#${scanId})`}>{pieces("ob-animated")}</g>
        ) : (
          <g className={`ob-loader-pieces ob-${variant}`} fill="currentColor"><circle className="ob-top" cx="26" cy="14" r="5.6" /><path className="ob-bar" d={barPath} /><circle className="ob-bottom" cx="38" cy="50" r="5.6" /></g>
        )}
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
