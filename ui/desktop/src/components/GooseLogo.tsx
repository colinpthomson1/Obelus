import { cn } from '../utils';
import { ObelusMark } from './brand/ObelusBrand';

interface GooseLogoProps {
  className?: string;
  size?: 'default' | 'small';
  hover?: boolean;
}

export default function GooseLogo({
  className = '',
  size = 'default',
  hover: _hover = true,
}: GooseLogoProps) {
  const sizes = {
    default: 'w-16 h-16',
    small: 'w-8 h-8',
  } as const;

  return <ObelusMark className={cn(sizes[size], className)} decorative />;
}
