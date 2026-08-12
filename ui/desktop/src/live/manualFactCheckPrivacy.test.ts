import { describe, expect, it, vi } from 'vitest';

import {
  LOCAL_MANUAL_FACT_CHECK_DISCLOSURE,
  SUBSCRIPTION_WEB_MANUAL_FACT_CHECK_DISCLOSURE,
  manualFactCheckContextMenuLabel,
  routeManualFactCheckSelection,
} from './manualFactCheckPrivacy';

describe('manual fact-check privacy copy', () => {
  it('names ChatGPT and the web in the subscription fact-check menu', () => {
    expect(manualFactCheckContextMenuLabel(true)).toBe('Fact-check with ChatGPT + web…');
    expect(manualFactCheckContextMenuLabel('subscription_web')).toBe(
      'Fact-check with ChatGPT + web…'
    );
  });

  it('preserves hosted and legacy Wikimedia menu wording', () => {
    expect(manualFactCheckContextMenuLabel(false)).toBe('Fact-check selection');
    expect(manualFactCheckContextMenuLabel('hosted')).toBe('Fact-check selection');
    expect(manualFactCheckContextMenuLabel('local_wikimedia')).toBe(
      'Fact-check with Wikipedia/Wikidata…'
    );
  });

  it('creates no non-Live subscription request when the external-send disclosure is cancelled', () => {
    const onAccepted = vi.fn();
    const confirmExternalSend = vi.fn(() => false);

    expect(
      routeManualFactCheckSelection({
        selection: {
          text: 'Barnes and Noble is bigger than Amazon.',
          source: 'context-menu',
          capturedAtEpochMs: 1_000,
          factCheckMode: 'subscription_web',
        },
        pathname: '/',
        confirmExternalSend,
        onAccepted,
      })
    ).toBe(false);

    expect(confirmExternalSend).toHaveBeenCalledWith(SUBSCRIPTION_WEB_MANUAL_FACT_CHECK_DISCLOSURE);
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('submits a non-Live subscription selection only after naming every data destination', () => {
    const selection = {
      text: 'Barnes and Noble is bigger than Amazon.',
      source: 'context-menu' as const,
      capturedAtEpochMs: 1_000,
      factCheckMode: 'subscription_web' as const,
    };
    const onAccepted = vi.fn();
    const confirmExternalSend = vi.fn(() => true);

    expect(
      routeManualFactCheckSelection({
        selection,
        pathname: '/sessions',
        confirmExternalSend,
        onAccepted,
      })
    ).toBe(true);

    expect(SUBSCRIPTION_WEB_MANUAL_FACT_CHECK_DISCLOSURE).toContain('public-web search query');
    expect(SUBSCRIPTION_WEB_MANUAL_FACT_CHECK_DISCLOSURE).toContain(
      'selected claim and retrieved evidence'
    );
    expect(SUBSCRIPTION_WEB_MANUAL_FACT_CHECK_DISCLOSURE).toContain(
      'retrieved evidence are then sent to ChatGPT'
    );
    expect(SUBSCRIPTION_WEB_MANUAL_FACT_CHECK_DISCLOSURE).toContain(
      'preliminary and limited to the sources retrieved'
    );
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(onAccepted).toHaveBeenCalledWith(selection);
  });

  it('keeps the legacy Wikimedia confirmation for an older routed selection', () => {
    const confirmExternalSend = vi.fn(() => false);

    routeManualFactCheckSelection({
      selection: {
        text: 'Legacy selection',
        source: 'context-menu',
        capturedAtEpochMs: 1_000,
        factCheckMode: 'local_wikimedia',
      },
      pathname: '/',
      confirmExternalSend,
      onAccepted: vi.fn(),
    });

    expect(confirmExternalSend).toHaveBeenCalledWith(LOCAL_MANUAL_FACT_CHECK_DISCLOSURE);
  });

  it('preserves hosted and already-disclosed Live routing without another consent prompt', () => {
    const confirmExternalSend = vi.fn(() => false);
    const onAccepted = vi.fn();

    routeManualFactCheckSelection({
      selection: {
        text: 'Hosted selection',
        source: 'context-menu',
        capturedAtEpochMs: 1_000,
        factCheckMode: 'hosted',
      },
      pathname: '/',
      confirmExternalSend,
      onAccepted,
    });
    routeManualFactCheckSelection({
      selection: {
        text: 'Live selection',
        source: 'context-menu',
        capturedAtEpochMs: 2_000,
        factCheckMode: 'subscription_web',
      },
      pathname: '/live',
      confirmExternalSend,
      onAccepted,
    });

    expect(confirmExternalSend).not.toHaveBeenCalled();
    expect(onAccepted).toHaveBeenCalledTimes(2);
  });
});
