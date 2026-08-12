import { ObelusLockup } from './components/brand/ObelusBrand';
import { ObelusLoader } from './components/brand/ObelusLoader';

export default function SuspenseLoader() {
  return (
    <div className="flex h-screen w-screen items-center justify-center overflow-hidden bg-background-primary p-6 page-transition">
      <div className="flex flex-col items-center gap-5">
        <ObelusLockup className="h-9" />
        <div className="flex items-center gap-2 font-mono text-xs text-text-secondary">
          <ObelusLoader
            variant="obelus-resolve"
            label="Opening Obelus…"
            className="!h-7 !w-7 text-brand-blue dark:text-brand-aqua"
          />
          <span>Opening your workspace…</span>
        </div>
      </div>
    </div>
  );
}
