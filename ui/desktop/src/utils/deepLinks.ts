export const OBELUS_DEEP_LINK_SCHEME = 'obelus:';
export const LEGACY_GOOSE_DEEP_LINK_SCHEME = 'goose:';

const supportedSchemes = new Set([OBELUS_DEEP_LINK_SCHEME, LEGACY_GOOSE_DEEP_LINK_SCHEME]);

export function isSupportedProductDeepLink(
  value: string,
  hostname?: string,
  pathname?: string
): boolean {
  try {
    const parsed = new URL(value);
    return (
      supportedSchemes.has(parsed.protocol) &&
      (!hostname || parsed.hostname === hostname) &&
      (!pathname || parsed.pathname === pathname)
    );
  } catch {
    return false;
  }
}
