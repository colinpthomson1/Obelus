# Layout System

Obelus layouts combine software precision with an editorial margin. Information should feel adjacent to the claim it supports, not scattered across a generic dashboard.

## Grid

### Marketing

- 12 columns
- Maximum content width: 1240 px
- Desktop gutter: 24–32 px
- Mobile gutter: 16–20 px
- Breakpoints are content-driven; 640, 768, and 1040 px are the starting set
- Use asymmetry intentionally: 7/5 and 8/4 column splits are preferred over default centered symmetry

### Product

- Left navigation rail: 64–80 px compact or 224–256 px expanded
- Transcript and finding split: 7/5 at wide sizes
- Evidence detail panel: minimum 360 px
- Collapse into a single prioritized flow below 900 px; transcript stays primary and findings follow the active claim
- Do not hide recording, privacy, or claim-check controls on mobile

## Spacing

The system uses a 4 px base:

`4, 8, 12, 16, 24, 32, 48, 64, 96, 128`

Use smaller gaps inside a relationship and larger gaps between ideas. Avoid applying the same padding to every section.

## Vertical rhythm

Body text uses a 24 px line-height. Major vertical spacing should generally land on 24 px multiples. Data-dense controls may use the 4 px base directly.

## Shape

- Small radius: 6 px for tags, fields, and compact controls
- Medium radius: 12 px for product panels and buttons
- Large radius: 20 px for major editorial surfaces
- Full pill: status tags and live state only
- Avoid nesting rounded cards inside rounded cards

## Evidence adjacency

The active claim and its finding should remain visibly connected through alignment, an evidence line, or shared motion. Sources belong immediately beneath the finding. Do not send users to a detached research dashboard to understand a result.

## Transcript hierarchy

1. Speaker and timestamp
2. Spoken text
3. Active claim highlight
4. Finding status
5. Brief evidence summary
6. Source trail and methodology

Use the horizontal logo stroke as a claim underline or active marker. Dots can become speaker nodes, source anchors, or timeline points.

## Responsive behavior

- Adapt rather than shrink. The desktop split becomes an ordered single flow.
- Maintain 44 px touch targets on coarse pointers.
- Avoid hover-only evidence previews.
- Let transcript type remain 16–18 px on all devices.
- Use safe-area insets on mobile software shells.
- Preserve source dates and status labels even when cards collapse.

## Motion in layout

Page entrances may use one composed reveal. Product state changes use 120–280 ms transitions. Animate transform and opacity, not layout dimensions. Respect reduced motion and never animate all transcript rows at once.
