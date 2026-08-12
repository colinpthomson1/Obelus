import type { IntlShape } from 'react-intl';

function isMac(): boolean {
  return window.electron?.platform === 'darwin';
}

/**
 * Localised message for the "navigate messages with arrow keys" chat input placeholder.
 * Returns the legacy English string if no intl instance is supplied, so call sites that
 * run before the intl provider is available still get a sensible default.
 */
export function getNavigationShortcutText(intl?: IntlShape): string {
  const prefix = isMac() ? '⌘' : 'Ctrl+';
  if (intl) {
    return intl.formatMessage(
      {
        id: 'chatInput.navigationShortcut',
        defaultMessage: 'Ask Obelus anything · {prefix}↑/{prefix}↓ for history',
      },
      { prefix }
    );
  }
  return `Ask Obelus anything · ${prefix}↑/${prefix}↓ for history`;
}

export function getSearchShortcutText(): string {
  return isMac() ? '⌘F' : 'Ctrl+F';
}
