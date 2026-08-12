import { describe, expect, it, vi } from 'vitest';
import { NAV_ITEMS } from './useNavigationItems';
import { createNavigationHandler } from '../utils/navigationUtils';

describe('live fact-check navigation', () => {
  it('exposes the dedicated sidebar destination', () => {
    expect(NAV_ITEMS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'live', path: '/live', label: 'Live Fact Check' }),
      ])
    );
  });

  it('routes the live view directly to /live', () => {
    const navigate = vi.fn();
    createNavigationHandler(navigate)('live');
    expect(navigate).toHaveBeenCalledWith('/live', { state: undefined });
  });
});
