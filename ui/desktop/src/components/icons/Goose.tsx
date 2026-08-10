import { ObelusMark } from '../brand/ObelusBrand';
import { cn } from '../../utils';

export function Goose({ className = '' }) {
  return <ObelusMark decorative className={cn('h-6 w-6', className)} />;
}
