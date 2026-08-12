import { describe, expect, it } from 'vitest';
import { isSupportedProductDeepLink } from './deepLinks';

describe('isSupportedProductDeepLink', () => {
  it('accepts the Obelus protocol', () => {
    expect(isSupportedProductDeepLink('obelus://recipe?config=abc', 'recipe')).toBe(true);
  });

  it('retains parsing compatibility for legacy Goose links', () => {
    expect(
      isSupportedProductDeepLink('goose://sessions/nostr?nevent=abc', 'sessions', '/nostr')
    ).toBe(true);
  });

  it('rejects unrelated protocols and routes', () => {
    expect(isSupportedProductDeepLink('https://example.com/recipe', 'recipe')).toBe(false);
    expect(isSupportedProductDeepLink('obelus://extension?name=test', 'recipe')).toBe(false);
  });
});
