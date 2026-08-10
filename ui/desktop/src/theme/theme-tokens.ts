/**
 * Theme tokens — the single source of truth for all MCP semantic token values.
 *
 * Every key in McpUiStyleVariableKey must be present in both lightTokens and
 * darkTokens. The TypeScript compiler enforces this: if the SDK adds a new key,
 * the build breaks until both maps are updated.
 *
 * Values are applied to :root via style.setProperty() before first paint
 * (see renderer.tsx). main.css only registers the variable names for Tailwind
 * class generation — it does NOT define values.
 *
 * These tokens serve two purposes:
 *  1. Obelus desktop — applied to :root per resolved theme.
 *  2. MCP apps — encoded as light-dark() in hostContext.styles.variables.
 */
import type {
  McpUiHostStyles,
  McpUiStyleVariableKey,
  McpUiStyles,
} from '@modelcontextprotocol/ext-apps/app-bridge';

type ThemeTokens = Record<McpUiStyleVariableKey, string>;

// Subset of keys that are the same across both themes.
type BaseTokenKey = Extract<
  McpUiStyleVariableKey,
  `--font-${string}` | `--border-radius-${string}` | `--border-width-${string}`
>;

type ColorTokenKey = Exclude<McpUiStyleVariableKey, BaseTokenKey>;

// ---------------------------------------------------------------------------
// Base tokens — shared across light and dark themes
// ---------------------------------------------------------------------------
const baseTokens: Pick<ThemeTokens, BaseTokenKey> = {
  // Typography — families
  '--font-sans': "'Instrument Sans', ui-sans-serif, system-ui, sans-serif",
  '--font-mono': "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",

  // Typography — weights
  '--font-weight-normal': '400',
  '--font-weight-medium': '500',
  '--font-weight-semibold': '600',
  '--font-weight-bold': '700',

  // Typography — text sizes
  '--font-text-xs-size': '0.75rem',
  '--font-text-sm-size': '0.875rem',
  '--font-text-md-size': '1rem',
  '--font-text-lg-size': '1.125rem',

  // Typography — heading sizes
  '--font-heading-xs-size': '1rem',
  '--font-heading-sm-size': '1.125rem',
  '--font-heading-md-size': '1.25rem',
  '--font-heading-lg-size': '1.5rem',
  '--font-heading-xl-size': '1.875rem',
  '--font-heading-2xl-size': '2.25rem',
  '--font-heading-3xl-size': '3rem',

  // Typography — text line heights
  '--font-text-xs-line-height': '1rem',
  '--font-text-sm-line-height': '1.25rem',
  '--font-text-md-line-height': '1.5rem',
  '--font-text-lg-line-height': '1.75rem',

  // Typography — heading line heights
  '--font-heading-xs-line-height': '1.5rem',
  '--font-heading-sm-line-height': '1.75rem',
  '--font-heading-md-line-height': '1.75rem',
  '--font-heading-lg-line-height': '2rem',
  '--font-heading-xl-line-height': '2.25rem',
  '--font-heading-2xl-line-height': '2.5rem',
  '--font-heading-3xl-line-height': '3.5rem',

  // Border radius
  '--border-radius-xs': '4px',
  '--border-radius-sm': '6px',
  '--border-radius-md': '12px',
  '--border-radius-lg': '12px',
  '--border-radius-xl': '20px',
  '--border-radius-full': '9999px',

  // Border width
  '--border-width-regular': '1px',
};

// Theme-specific color/shadow tokens only.
type ColorTokens = Pick<ThemeTokens, ColorTokenKey>;

// ---------------------------------------------------------------------------
// Light theme — colors & shadows
// ---------------------------------------------------------------------------
const lightColorTokens: ColorTokens = {
  // Backgrounds
  '--color-background-primary': '#FCFCF8',
  '--color-background-secondary': '#F7F8FC',
  '--color-background-tertiary': '#EAECFE',
  '--color-background-inverse': '#111528',
  '--color-background-ghost': 'transparent',
  '--color-background-info': '#3B50E0',
  '--color-background-danger': '#B12D47',
  '--color-background-success': '#08705B',
  '--color-background-warning': '#8A4B00',
  '--color-background-disabled': '#ECEFF5',

  // Text
  '--color-text-primary': '#111528',
  '--color-text-secondary': '#515B78',
  '--color-text-tertiary': '#69708C',
  '--color-text-inverse': '#FCFCF8',
  '--color-text-ghost': '#515B78',
  '--color-text-info': '#2F3FB5',
  '--color-text-danger': '#B12D47',
  '--color-text-success': '#08705B',
  '--color-text-warning': '#8A4B00',
  '--color-text-disabled': '#8D95AD',

  // Borders
  '--color-border-primary': '#D9DEEA',
  '--color-border-secondary': '#ECEFF5',
  '--color-border-tertiary': '#B5BBCD',
  '--color-border-inverse': '#111528',
  '--color-border-ghost': 'transparent',
  '--color-border-info': '#3B50E0',
  '--color-border-danger': '#B12D47',
  '--color-border-success': '#08705B',
  '--color-border-warning': '#8A4B00',
  '--color-border-disabled': '#D9DEEA',

  // Rings
  '--color-ring-primary': '#3B50E0',
  '--color-ring-secondary': '#2BC7B9',
  '--color-ring-inverse': '#FCFCF8',
  '--color-ring-info': '#3B50E0',
  '--color-ring-danger': '#B12D47',
  '--color-ring-success': '#08705B',
  '--color-ring-warning': '#8A4B00',

  // Shadows
  '--shadow-hairline': '0 0 0 1px rgba(17, 21, 40, 0.06)',
  '--shadow-sm': '0 1px 3px rgba(17, 21, 40, 0.08)',
  '--shadow-md': '0 8px 24px rgba(17, 21, 40, 0.10)',
  '--shadow-lg': '0 20px 48px rgba(17, 21, 40, 0.14)',
};

// ---------------------------------------------------------------------------
// Dark theme — colors & shadows
// ---------------------------------------------------------------------------
const darkColorTokens: ColorTokens = {
  // Backgrounds
  '--color-background-primary': '#111528',
  '--color-background-secondary': '#181D34',
  '--color-background-tertiary': '#252C49',
  '--color-background-inverse': '#FCFCF8',
  '--color-background-ghost': 'transparent',
  '--color-background-info': '#3B50E0',
  '--color-background-danger': '#B12D47',
  '--color-background-success': '#08705B',
  '--color-background-warning': '#8A4B00',
  '--color-background-disabled': '#252C49',

  // Text
  '--color-text-primary': '#FCFCF8',
  '--color-text-secondary': '#B5BBCD',
  '--color-text-tertiary': '#8D95AD',
  '--color-text-inverse': '#111528',
  '--color-text-ghost': '#B5BBCD',
  '--color-text-info': '#8794F2',
  '--color-text-danger': '#FFB2AA',
  '--color-text-success': '#8BE2D9',
  '--color-text-warning': '#FFC76F',
  '--color-text-disabled': '#69708C',

  // Borders
  '--color-border-primary': '#38415F',
  '--color-border-secondary': '#252C49',
  '--color-border-tertiary': '#515B78',
  '--color-border-inverse': '#FCFCF8',
  '--color-border-ghost': 'transparent',
  '--color-border-info': '#8794F2',
  '--color-border-danger': '#FFB2AA',
  '--color-border-success': '#8BE2D9',
  '--color-border-warning': '#FFC76F',
  '--color-border-disabled': '#38415F',

  // Rings
  '--color-ring-primary': '#8BE2D9',
  '--color-ring-secondary': '#8794F2',
  '--color-ring-inverse': '#111528',
  '--color-ring-info': '#8794F2',
  '--color-ring-danger': '#FFB2AA',
  '--color-ring-success': '#8BE2D9',
  '--color-ring-warning': '#FFC76F',

  // Shadows (darker for dark mode)
  '--shadow-hairline': '0 0 0 1px rgba(0, 0, 0, 0.24)',
  '--shadow-sm': '0 2px 6px rgba(0, 0, 0, 0.22)',
  '--shadow-md': '0 10px 28px rgba(0, 0, 0, 0.30)',
  '--shadow-lg': '0 24px 56px rgba(0, 0, 0, 0.38)',
};

// ---------------------------------------------------------------------------
// Merged token maps — used by applyThemeTokens() and buildMcpHostStyles()
// ---------------------------------------------------------------------------
export const lightTokens: ThemeTokens = { ...baseTokens, ...lightColorTokens };
export const darkTokens: ThemeTokens = { ...baseTokens, ...darkColorTokens };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// @font-face rules passed to MCP apps so sandboxed iframes can load host fonts.
const instrumentSansUrl = new URL(
  '../assets/brand/fonts/InstrumentSans-Variable.woff2',
  import.meta.url
).href;
const ibmPlexMonoUrl = new URL('../assets/brand/fonts/IBMPlexMono-Regular.woff2', import.meta.url)
  .href;

const HOST_FONT_CSS = `
@font-face {
  font-family: 'Instrument Sans';
  src: url('${instrumentSansUrl}') format('woff2');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'IBM Plex Mono';
  src: url('${ibmPlexMonoUrl}') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
`.trim();

/**
 * Build the McpUiHostStyles object for MCP apps.
 * Color keys use light-dark() so a single payload works for both themes.
 * Non-color keys (fonts, radii, shadows) use plain values from baseTokens
 * (or light as the default when values differ, e.g. shadows).
 * css.fonts provides @font-face rules so sandboxed apps can load host fonts.
 */
export function buildMcpHostStyles(): McpUiHostStyles {
  const variables: McpUiStyles = {} as McpUiStyles;
  for (const key of Object.keys(lightTokens) as McpUiStyleVariableKey[]) {
    const light = lightTokens[key];
    const dark = darkTokens[key];
    if (key.startsWith('--color-')) {
      variables[key] = `light-dark(${light}, ${dark})`;
    } else {
      variables[key] = light;
    }
  }
  return { variables, css: { fonts: HOST_FONT_CSS } };
}

/**
 * Resolve the current theme from localStorage / system preference.
 */
export function getResolvedTheme(): 'light' | 'dark' {
  const useSystem = localStorage.getItem('use_system_theme') !== 'false';
  if (useSystem) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';
}

/**
 * Apply theme tokens to the document root as CSS custom properties.
 * When called without an argument, resolves the theme from localStorage.
 */
export function applyThemeTokens(theme?: 'light' | 'dark'): void {
  const resolved = theme ?? getResolvedTheme();
  const tokens = resolved === 'dark' ? darkTokens : lightTokens;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(key, value);
  }
}
