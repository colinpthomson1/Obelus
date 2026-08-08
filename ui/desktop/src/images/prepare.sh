#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick 7 is required (install with: brew install imagemagick)." >&2
  exit 1
fi

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "librsvg is required (install with: brew install librsvg)." >&2
  exit 1
fi

if ! command -v iconutil >/dev/null 2>&1; then
  echo "iconutil is required to generate the macOS icon." >&2
  exit 1
fi

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/goose-icons.XXXXXX")"
iconset_directory="$temporary_directory/icon.iconset"
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
mkdir "$iconset_directory"

render_icon_png() {
  size="$1"
  output="$2"
  rsvg-convert --width "$size" --height "$size" --output "$temporary_directory/icon-render.png" icon.svg
  magick "$temporary_directory/icon-render.png" -strip -depth 8 -define png:color-type=6 "$output"
}

rsvg-convert --width 88 --height 88 --output "$temporary_directory/glyph-render.png" glyph.svg
magick "$temporary_directory/glyph-render.png" -resize 22x22 -colorspace Gray -strip -depth 8 -define png:color-type=4 iconTemplate.png
magick "$temporary_directory/glyph-render.png" -resize 44x44 -colorspace Gray -strip -depth 8 -define png:color-type=4 iconTemplate@2x.png
magick iconTemplate.png -fill '#F26A50' -stroke none -draw 'circle 19.25,2.75 21,2.75' -strip -depth 8 iconTemplateUpdate.png
magick iconTemplate@2x.png -fill '#F26A50' -stroke none -draw 'circle 38.5,5.5 42,5.5' -strip -depth 8 iconTemplateUpdate@2x.png

render_icon_png 512 icon-512.png
render_icon_png 1024 icon.png
render_icon_png 2048 icon@2x.png

magick icon@2x.png -define icon:auto-resize=256,128,64,48,32,16 -strip icon.ico

render_icon_png 16 "$iconset_directory/icon_16x16.png"
render_icon_png 32 "$iconset_directory/icon_16x16@2x.png"
render_icon_png 32 "$iconset_directory/icon_32x32.png"
render_icon_png 64 "$iconset_directory/icon_32x32@2x.png"
render_icon_png 128 "$iconset_directory/icon_128x128.png"
render_icon_png 256 "$iconset_directory/icon_128x128@2x.png"
render_icon_png 256 "$iconset_directory/icon_256x256.png"
render_icon_png 512 "$iconset_directory/icon_256x256@2x.png"
render_icon_png 512 "$iconset_directory/icon_512x512.png"
render_icon_png 1024 "$iconset_directory/icon_512x512@2x.png"
iconutil -c icns "$iconset_directory" -o icon.icns
