# Obelus Motion System

Motion turns the static mark into a product language. The horizontal stroke is treated as a claim under review; the two dots act as independent checks or sources. This is a contemporary motion metaphor, not a claim about the ancient symbol.

## Principles

### Precise, not robotic

Use short geometric movements and clean deceleration. Nothing bounces, shakes, or overshoots.

### Calm scrutiny

Scanning, aligning, and resolving express examination without alarm. Loading is always neutral; verdict color appears only after a finding and with text.

### Recognition first

Every looping animation preserves a faint base mark or holds the complete mark long enough to remain recognizable.

### Interruptible

A result can replace any loader immediately. Never make the interface wait for a loop to finish.

### Motion is not a verdict

A loader never implies true, false, or confidence. It communicates process only.

### Sparse by default

Animate only active, visible checks. Keep no more than three detailed loaders active in a transcript view; completed and offscreen rows should be static.

## Shared tokens

| Token | Value | Use |
| --- | ---: | --- |
| Instant | 120 ms | Press and immediate feedback |
| Fast | 200 ms | Small state changes |
| Standard | 280 ms | Controls and panels |
| Emphasis | 480 ms | Larger reveals |
| Compact loop | 1200 ms | Proof Pulse |
| Scan loop | 1350 ms | Transcript Scan |
| Research loop | 1600 ms | Source Exchange |
| Signature loop | 1840 ms | Obelus Resolve |

Easing curves are included in `Tokens/obelus-motion.css` and `Tokens/obelus-motion.tokens.json`.

## The five loaders

### 1. Proof Pulse

The default compact indeterminate loader. The upper dot, claim stroke, and lower dot resolve in sequence.

- Best for: buttons, inline status, small claim cards, generic checking
- Recommended size: 16–24 px
- Loop: 1200 ms
- Reduced motion: static complete mark plus a textual “Checking…” status

### 2. Transcript Scan

A narrow inspection band travels across a faint full mark, lighting the claim and evidence points as it passes.

- Best for: active transcript segments and automatic claim detection
- Recommended size: 20–32 px
- Loop: 1350 ms
- Reduced motion: static complete mark plus “Scanning speech…”

### 3. Source Exchange

The two source dots rotate around a stable statement bar and exchange positions.

- Best for: multi-source research, source retrieval, and cross-checking
- Recommended size: 24 px and larger
- Loop: 1600 ms
- Reduced motion: static complete mark plus “Checking sources…”

### 4. Obelus Resolve

The editorial stroke appears first; two points of scrutiny settle around it and complete the mark. This is the signature brand motion.

- Best for: sign-in handoff, report generation, landing-page demos, and empty states
- Recommended size: 40–96 px
- Loop: 1840 ms
- One-shot mode: 760 ms, freezing on the complete mark
- Reduced motion: 180 ms crossfade to a static mark

### 5. Progress Divide

A determinate loader for work with real measurable progress. The upper dot is present at the start, the stroke fills left-to-right, and the lower dot appears at completion.

- Best for: known source counts, model initialization, downloads, and report assembly
- Not for: unknown waits or “truth confidence”
- Reduced motion: progress updates jump without interpolation

## Accessibility

- Treat each SVG as decorative with `aria-hidden="true"`.
- Put `role="status"`, `aria-live="polite"`, and one concise label on the wrapper.
- Use `aria-busy="true"` on the host region while an indeterminate process is active.
- For determinate work, use `role="progressbar"` with min, max, current value, and useful value text.
- Never announce every animation loop or transcript token.
- For waits beyond 3 seconds, show stage text such as “Checking 4 sources…”
- Around 10 seconds, acknowledge the delay and offer cancel or retry where appropriate.
- In reduced-motion mode, all indeterminate loaders become a static mark. Do not merely slow the rotation.
- In forced-colors mode, use `CanvasText` or `currentColor` and remove reliance on low-opacity ghost layers.

## Implementation

Inline SVG is the preferred web format because it inherits `currentColor`, responds to media queries, and stays crisp. Lottie files are provided for product environments that already use a Lottie renderer. GIF, MP4, and WebM are preview assets, not recommended production loaders.

Every implementation must pause when offscreen or when `document.hidden` is true, and must destroy Lottie instances when unmounted.
