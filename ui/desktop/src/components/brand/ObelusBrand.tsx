import primaryLockup from '../../assets/brand/logos/obelus-lockup-horizontal-primary.svg';
import darkLockup from '../../assets/brand/logos/obelus-lockup-horizontal-dark.svg';
import reverseLockup from '../../assets/brand/logos/obelus-lockup-horizontal-reverse.svg';
import taglineLockup from '../../assets/brand/logos/obelus-lockup-tagline-primary.svg';
import blueSymbol from '../../assets/brand/logos/obelus-symbol-evidence-blue.svg';
import cloudSymbol from '../../assets/brand/logos/obelus-symbol-cloud.svg';
import microSymbol from '../../assets/brand/logos/obelus-symbol-micro.svg';
import { cn } from '../../utils';

interface BrandImageProps {
  className?: string;
  decorative?: boolean;
}

export function ObelusLockup({ className, decorative = false }: BrandImageProps) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center', className)}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : 'Obelus'}
      aria-hidden={decorative || undefined}
    >
      <img
        src={primaryLockup}
        alt=""
        aria-hidden="true"
        className="block h-full w-auto dark:hidden"
      />
      <img src={darkLockup} alt="" aria-hidden="true" className="hidden h-full w-auto dark:block" />
    </span>
  );
}

export function ObelusTaglineLockup({ className, decorative = false }: BrandImageProps) {
  return (
    <img
      src={taglineLockup}
      alt={decorative ? '' : 'Obelus — Evidence at conversation speed.'}
      aria-hidden={decorative || undefined}
      className={className}
    />
  );
}

export function ObelusReverseLockup({ className, decorative = false }: BrandImageProps) {
  return (
    <img
      src={reverseLockup}
      alt={decorative ? '' : 'Obelus'}
      aria-hidden={decorative || undefined}
      className={className}
    />
  );
}

interface ObelusMarkProps extends BrandImageProps {
  tone?: 'adaptive' | 'blue' | 'cloud' | 'micro';
}

export function ObelusMark({ className, decorative = false, tone = 'adaptive' }: ObelusMarkProps) {
  const accessibilityProps = decorative
    ? { alt: '', 'aria-hidden': true as const }
    : { alt: 'Obelus' };

  if (tone !== 'adaptive') {
    const source = tone === 'cloud' ? cloudSymbol : tone === 'micro' ? microSymbol : blueSymbol;
    return <img src={source} {...accessibilityProps} className={className} />;
  }

  return (
    <span
      className={cn('inline-flex shrink-0', className)}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : 'Obelus'}
      aria-hidden={decorative || undefined}
    >
      <img src={blueSymbol} alt="" aria-hidden="true" className="block h-full w-full dark:hidden" />
      <img
        src={cloudSymbol}
        alt=""
        aria-hidden="true"
        className="hidden h-full w-full dark:block"
      />
    </span>
  );
}
