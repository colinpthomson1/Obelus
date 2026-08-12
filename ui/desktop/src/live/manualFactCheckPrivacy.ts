import type { LiveSelectionRequest } from './ipcTypes';

export const SUBSCRIPTION_WEB_MANUAL_FACT_CHECK_DISCLOSURE =
  "Fact-check this selection with ChatGPT and the public web?\n\nObelus sends the selected text as a public-web search query. The selected claim and retrieved evidence are then sent to ChatGPT under the signed-in account's workspace data policy. The finding is preliminary and limited to the sources retrieved.";

export const LOCAL_MANUAL_FACT_CHECK_DISCLOSURE =
  'Send this selection to Wikimedia?\n\nThe selected text will be sent to Wikipedia and Wikidata as search terms. Evidence synthesis stays on this Mac.';

export function manualFactCheckContextMenuLabel(
  factCheckMode: LiveSelectionRequest['factCheckMode'] | boolean
): string {
  if (factCheckMode === true || factCheckMode === 'subscription_web') {
    return 'Fact-check with ChatGPT + web…';
  }
  return factCheckMode === 'local_wikimedia'
    ? 'Fact-check with Wikipedia/Wikidata…'
    : 'Fact-check selection';
}

interface RouteManualFactCheckSelectionOptions {
  selection: LiveSelectionRequest;
  pathname: string;
  confirmExternalSend: (message: string) => boolean;
  onAccepted: (selection: LiveSelectionRequest) => void;
}

export function routeManualFactCheckSelection({
  selection,
  pathname,
  confirmExternalSend,
  onAccepted,
}: RouteManualFactCheckSelectionOptions): boolean {
  const disclosure =
    selection.factCheckMode === 'subscription_web'
      ? SUBSCRIPTION_WEB_MANUAL_FACT_CHECK_DISCLOSURE
      : selection.factCheckMode === 'local_wikimedia'
        ? LOCAL_MANUAL_FACT_CHECK_DISCLOSURE
        : undefined;
  if (disclosure && pathname !== '/live' && !confirmExternalSend(disclosure)) {
    return false;
  }
  onAccepted(selection);
  return true;
}
