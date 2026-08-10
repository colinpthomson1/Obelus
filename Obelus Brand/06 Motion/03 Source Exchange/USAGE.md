# Source Exchange

**Recommended size:** 24–48 px  
**Use for:** Multi-source retrieval, web research, and deeper verification.

The animated SVG uses `currentColor` when placed inline. External SVG images use Evidence Blue as their fallback color. The Lottie file is transparent and uses the brand blue directly; replace the fill at runtime if a themed variant is required.

## Accessible wrapper

```html
<div role="status" aria-live="polite" aria-atomic="true">
  <svg aria-hidden="true">…</svg>
  <span class="sr-only">Checking sources…</span>
</div>
```

The graphic is decorative. Announce process start once and completion once; never announce each loop. In reduced-motion mode, present the static canonical mark and retain the status text.
