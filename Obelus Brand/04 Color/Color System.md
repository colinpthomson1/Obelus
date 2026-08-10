# Obelus Color System

## Direction: Evidence Cobalt

The palette combines a disciplined cobalt with warm, lightly tinted neutrals. Aqua communicates live activity. Coral adds human energy in editorial and marketing moments. Status colors remain separate from the primary brand color so that the logo never becomes a verdict.

## Core colors

| Name | Hex | Role |
| --- | --- | --- |
| Obelus Ink | `#111528` | Primary text, dark background, single-color logo |
| Paper | `#F7F8FC` | Default light background |
| Cloud | `#FCFCF8` | Elevated light surface and reverse artwork |
| Evidence Blue | `#3B50E0` | Primary brand color and key actions |
| Live Aqua | `#2BC7B9` | Listening, streaming, and live activity |
| Voice Coral | `#FF7568` | Human warmth, campaigns, and illustration |

## Claim-state colors

| State | Foreground | Background | Required companion |
| --- | --- | --- | --- |
| Supported | `#08705B` | `#E0F5EF` | Label + supported icon |
| Disputed | `#B12D47` | `#FCE8ED` | Label + disputed icon |
| Needs context | `#8A4B00` | `#FFF0CF` | Label + context icon |
| Unverified | `#2F3FB5` | `#EAECFE` | Label + obelus icon |

Color never carries a finding alone. Every state needs an icon, a written label, and an evidence trail.

## Distribution

- 60% Paper, Cloud, and open space
- 30% Ink and neutral structure
- 10% Evidence Blue, Live Aqua, and occasional Voice Coral

Reserve saturated color for interaction, live state, and focused editorial moments. A cobalt-to-aqua transition may communicate live data movement, but it is not the default logo treatment and should never become a decorative mesh cloud.

## Dark mode

- Base: Obelus Ink `#111528`
- Elevated surface: Ink 900 `#181D34`
- Primary text: Cloud `#FCFCF8`
- Secondary text: Ink 300 `#B5BBCD`
- Border: Ink 700 `#38415F`
- Primary action: Blue 400 `#8794F2`
- Live state: Aqua 300 `#8BE2D9`

Dark mode uses lighter surfaces for depth rather than heavy shadows. Reduce large-text weight slightly to preserve optical balance.

## Accessibility

Use the included `Contrast Matrix.csv` for tested combinations. Body text targets WCAG AA at 4.5:1 or better; UI components target at least 3:1. Never use Slate or gray text on saturated blue, aqua, coral, or status backgrounds.
