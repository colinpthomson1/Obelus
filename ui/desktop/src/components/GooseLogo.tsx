import { Goose } from './icons/Goose';
import { cn } from '../utils';

interface GooseLogoProps {
  className?: string;
  size?: 'default' | 'small';
}

export default function GooseLogo({ className = '', size = 'default' }: GooseLogoProps) {
  const sizes = {
    default: 'size-16',
    small: 'size-8',
  } as const;

  return <Goose className={cn(sizes[size], className)} />;
}
