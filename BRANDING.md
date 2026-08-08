# Cadyn logo assets

This fork uses the Cadyn Kinetic C from the standalone mark kit v1.0 and the Cadyn 2.1 / Flow brand system. The official UI colors are Ink `#1F171F`, Paper `#FFFFEB`, and Tempo `#F26A50`.

Use the Ink + Tempo master on light surfaces and the Paper + Tempo master on dark surfaces. The black master is reserved for monochrome system surfaces such as the desktop menu bar. The `currentColor` master is available for interfaces that must inherit a single foreground color.

The four SVG files in `ui/desktop/src/images/cadyn/` are unmodified source masters from the kit. `ui/desktop/src/images/icon.svg` and `glyph.svg` are repository-owned Electron app-icon and menu-bar masters. The PNG, ICO, and ICNS files beside them are generated assets; regenerate the complete desktop set with:

```bash
cd ui/desktop/src/images
./prepare.sh
```

The script requires ImageMagick 7, `librsvg`, and macOS `iconutil`. It generates the 512, 1024, and 2048 px app PNGs, the Windows ICO, the macOS ICNS, and the 22/44 px normal and update menu-bar icons.

For a future browser/PWA package, use the corresponding files from the same v1.0 kit:

- `android-chrome-192x192.png` for the 192 px installed-web icon
- `android-chrome-512x512.png` for the 512 px installed-web icon
- `maskable-icon-512x512.png` for the maskable PWA icon
- `apple-touch-icon-180x180.png` for Apple touch icons
- `favicon.svg` and `favicon.ico` as the starting favicon assets
- `site.webmanifest` as the manifest source that coordinates those installed-web assets

The supplied transparent favicon is the light-surface mark, so its Ink beats can disappear against a dark browser tab. A future web implementation must either use an adaptive SVG that changes the four primary beats from Ink to Paper in dark mode, or place the Paper + Tempo mark on a stable Ink background. Do not substitute the Electron package icon or menu-bar assets for the web-specific files, and do not use the Tempo-only, pure-black, pure-white, Paper-avatar, or Proof-avatar treatments as the primary application identity.

The Kinetic C geometry is fixed. Do not redraw, rotate, stretch, skew, outline, shadow, bevel, texture, or otherwise reinterpret its five beats. Preserve at least one smallest-beat width of clear space and use it at 20 px or larger except where a system surface requires 16 px.
