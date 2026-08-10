#!/usr/bin/env python3
"""Generate the Obelus vector identity, exports, tokens, and graphic-system assets."""

from __future__ import annotations

import csv
import json
import math
import shutil
import subprocess
from pathlib import Path

from PIL import Image
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parent
SPEC = json.loads((SOURCE / "brand_spec.json").read_text())
COLORS = SPEC["colors"]

LOGOS = ROOT / "02 Logos"
TYPOGRAPHY = ROOT / "03 Typography"
COLOR_DIR = ROOT / "04 Color"
GRAPHICS = ROOT / "05 Graphic System"
UI = ROOT / "07 UI and Layouts"
PREVIEWS = ROOT / "09 Previews"

FONT_PRIMARY = TYPOGRAPHY / "Fonts/Instrument Sans/InstrumentSans-Variable.ttf"
FONT_PRIMARY_ITALIC = TYPOGRAPHY / "Fonts/Instrument Sans/InstrumentSans-Italic-Variable.ttf"
FONT_MONO_REGULAR = TYPOGRAPHY / "Fonts/IBM Plex Mono/IBMPlexMono-Regular.ttf"
FONT_MONO_MEDIUM = TYPOGRAPHY / "Fonts/IBM Plex Mono/IBMPlexMono-Medium.ttf"

BAR_PATH = SPEC["logo"]["barPath"]
TOP_DOT = SPEC["logo"]["topDot"]
BOTTOM_DOT = SPEC["logo"]["bottomDot"]


def ensure_directories() -> None:
    for directory in [
        LOGOS / "Master/Symbol",
        LOGOS / "Master/Wordmark",
        LOGOS / "Master/Horizontal Lockup",
        LOGOS / "Master/Stacked Lockup",
        LOGOS / "Master/Tagline Lockup",
        LOGOS / "Monochrome",
        LOGOS / "PNG/Symbol",
        LOGOS / "PNG/Wordmark",
        LOGOS / "PNG/Horizontal Lockup",
        LOGOS / "PNG/Stacked Lockup",
        LOGOS / "App Icons",
        LOGOS / "Favicons",
        LOGOS / "Explorations",
        TYPOGRAPHY / "Fonts/Instrument Sans/Static",
        TYPOGRAPHY / "Fonts/IBM Plex Mono/Web",
        TYPOGRAPHY / "Specimens",
        COLOR_DIR / "Swatches",
        GRAPHICS / "Patterns",
        GRAPHICS / "Status Icons",
        UI / "Design Tokens",
        UI / "Social and Marketing",
        UI / "Application Templates",
        PREVIEWS,
    ]:
        directory.mkdir(parents=True, exist_ok=True)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def run(command: list[str]) -> None:
    subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def xml_escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def svg_document(
    content: str,
    viewbox: tuple[float, float, float, float],
    title: str,
    description: str,
    extra: str = "",
) -> str:
    x, y, width, height = viewbox
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x:g} {y:g} {width:g} {height:g}" role="img" aria-labelledby="title desc" {extra}>
  <title id="title">{xml_escape(title)}</title>
  <desc id="desc">{xml_escape(description)}</desc>
{content}
</svg>
'''


def mark_group(color: str, micro: bool = False, class_name: str | None = None) -> str:
    class_attr = f' class="{class_name}"' if class_name else ""
    bar = (
        '<rect x="12" y="27" width="40" height="10" rx="5"/>'
        if micro
        else f'<path d="{BAR_PATH}"/>'
    )
    return f'''  <g fill="{color}"{class_attr}>
    <circle cx="{TOP_DOT['cx']}" cy="{TOP_DOT['cy']}" r="{TOP_DOT['r']}"/>
    {bar}
    <circle cx="{BOTTOM_DOT['cx']}" cy="{BOTTOM_DOT['cy']}" r="{BOTTOM_DOT['r']}"/>
  </g>'''


def mark_svg(color: str, title: str, micro: bool = False) -> str:
    return svg_document(
        mark_group(color, micro=micro),
        (0, 0, 64, 64),
        title,
        "Custom Dialogue Axis obelus symbol with offset dots and a horizontal editorial stroke.",
    )


def instantiate_font(source: Path, axes: dict[str, float]) -> TTFont:
    font = TTFont(source)
    if "fvar" in font:
        font = instantiateVariableFont(font, axes, inplace=False)
    return font


def font_text_paths(
    text: str,
    source: Path = FONT_PRIMARY,
    axes: dict[str, float] | None = None,
    height: float = 32,
    tracking_em: float = -0.012,
) -> tuple[str, float, float]:
    axes = axes or {"wght": 620, "wdth": 100}
    font = instantiate_font(source, axes)
    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    upem = font["head"].unitsPerEm
    tracking = tracking_em * upem

    runs: list[tuple[float, str, tuple[float, float, float, float]]] = []
    cursor = 0.0
    global_xmin = math.inf
    global_ymin = math.inf
    global_xmax = -math.inf
    global_ymax = -math.inf

    for index, char in enumerate(text):
        glyph_name = cmap.get(ord(char), ".notdef")
        glyph = glyph_set[glyph_name]
        bounds_pen = BoundsPen(glyph_set)
        glyph.draw(bounds_pen)
        bounds = bounds_pen.bounds or (0, 0, 0, 0)
        xmin, ymin, xmax, ymax = bounds
        global_xmin = min(global_xmin, cursor + xmin)
        global_ymin = min(global_ymin, ymin)
        global_xmax = max(global_xmax, cursor + xmax)
        global_ymax = max(global_ymax, ymax)
        path_pen = SVGPathPen(glyph_set)
        glyph.draw(path_pen)
        runs.append((cursor, path_pen.getCommands(), bounds))
        advance, _ = hmtx[glyph_name]
        cursor += advance
        if index != len(text) - 1:
            cursor += tracking

    if not runs:
        return "", 0, height

    measured_height = max(global_ymax - global_ymin, 1)
    scale = height / measured_height
    width = (global_xmax - global_xmin) * scale
    paths = []
    for x_pos, commands, _ in runs:
        x_translate = (x_pos - global_xmin) * scale
        y_translate = global_ymax * scale
        paths.append(
            f'<path d="{commands}" transform="translate({x_translate:.4f} {y_translate:.4f}) scale({scale:.6f} {-scale:.6f})"/>'
        )
    return "\n    ".join(paths), width, height


def wordmark_svg(color: str, title: str) -> tuple[str, float, float]:
    paths, width, height = font_text_paths("Obelus", height=32)
    content = f'  <g fill="{color}">\n    {paths}\n  </g>'
    return (
        svg_document(
            content,
            (0, 0, width, height),
            title,
            "Obelus title-case wordmark outlined from Instrument Sans SemiBold.",
        ),
        width,
        height,
    )


def horizontal_lockup_svg(mark_color: str, word_color: str, title: str) -> tuple[str, float, float]:
    paths, word_width, word_height = font_text_paths("Obelus", height=32)
    mark_scale = 0.8
    mark_frame = 64 * mark_scale
    gap = 16
    total_width = mark_frame + gap + word_width
    total_height = 52
    word_y = (total_height - word_height) / 2
    content = f'''  <g transform="scale({mark_scale})">
{mark_group(mark_color)}
  </g>
  <g fill="{word_color}" transform="translate({mark_frame + gap:.4f} {word_y:.4f})">
    {paths}
  </g>'''
    return (
        svg_document(
            content,
            (0, 0, total_width, total_height),
            title,
            "Primary Obelus horizontal lockup with the Dialogue Axis symbol and title-case wordmark.",
        ),
        total_width,
        total_height,
    )


def stacked_lockup_svg(mark_color: str, word_color: str, title: str) -> tuple[str, float, float]:
    paths, word_width, word_height = font_text_paths("Obelus", height=32)
    gap = 14
    total_width = max(64, word_width)
    word_x = (total_width - word_width) / 2
    total_height = 64 + gap + word_height
    mark_x = (total_width - 64) / 2
    content = f'''  <g transform="translate({mark_x:.4f} 0)">
{mark_group(mark_color)}
  </g>
  <g fill="{word_color}" transform="translate({word_x:.4f} {64 + gap:.4f})">
    {paths}
  </g>'''
    return (
        svg_document(
            content,
            (0, 0, total_width, total_height),
            title,
            "Centered Obelus stacked lockup with symbol above the title-case wordmark.",
        ),
        total_width,
        total_height,
    )


def tagline_lockup_svg(mark_color: str, word_color: str, title: str) -> tuple[str, float, float]:
    word_paths, word_width, word_height = font_text_paths("Obelus", height=32)
    tag_paths, tag_width, tag_height = font_text_paths(
        SPEC["brand"]["tagline"], axes={"wght": 450, "wdth": 100}, height=13, tracking_em=0
    )
    mark_scale = 0.8
    mark_frame = 64 * mark_scale
    gap = 16
    inner_width = max(word_width, tag_width)
    total_width = mark_frame + gap + inner_width
    total_height = 58
    content = f'''  <g transform="scale({mark_scale})">
{mark_group(mark_color)}
  </g>
  <g fill="{word_color}" transform="translate({mark_frame + gap:.4f} 4)">
    {word_paths}
  </g>
  <g fill="{word_color}" transform="translate({mark_frame + gap:.4f} 43)">
    {tag_paths}
  </g>'''
    return (
        svg_document(
            content,
            (0, 0, total_width, total_height),
            title,
            "Obelus horizontal logo with the tagline Evidence at conversation speed.",
        ),
        total_width,
        total_height,
    )


def export_svg(svg_path: Path, png_path: Path, width: int) -> None:
    run(["rsvg-convert", "-w", str(width), "-o", str(png_path), str(svg_path)])


def export_pdf(svg_path: Path, pdf_path: Path) -> None:
    run(["rsvg-convert", "-f", "pdf", "-o", str(pdf_path), str(svg_path)])


def save_svg_bundle(
    svg: str,
    svg_path: Path,
    png_dir: Path | None = None,
    png_widths: tuple[int, ...] = (),
    pdf: bool = True,
) -> None:
    write_text(svg_path, svg)
    if pdf:
        export_pdf(svg_path, svg_path.with_suffix(".pdf"))
    if png_dir:
        png_dir.mkdir(parents=True, exist_ok=True)
        for width in png_widths:
            export_svg(svg_path, png_dir / f"{svg_path.stem}_{width}px.png", width)


def generate_fonts() -> None:
    instances = [
        ("Regular", {"wght": 400, "wdth": 100}),
        ("Medium", {"wght": 520, "wdth": 100}),
        ("SemiBold", {"wght": 620, "wdth": 100}),
        ("Bold", {"wght": 700, "wdth": 100}),
        ("Display-SemiBold", {"wght": 620, "wdth": 94}),
    ]
    static_dir = TYPOGRAPHY / "Fonts/Instrument Sans/Static"
    for name, axes in instances:
        font = instantiate_font(FONT_PRIMARY, axes)
        ttf_path = static_dir / f"InstrumentSans-{name}.ttf"
        font.save(ttf_path)
        web_font = TTFont(ttf_path)
        web_font.flavor = "woff2"
        web_font.save(static_dir / f"InstrumentSans-{name}.woff2")

    italic_font = instantiate_font(FONT_PRIMARY_ITALIC, {"wght": 400, "wdth": 100})
    italic_path = static_dir / "InstrumentSans-Italic.ttf"
    italic_font.save(italic_path)
    italic_web = TTFont(italic_path)
    italic_web.flavor = "woff2"
    italic_web.save(static_dir / "InstrumentSans-Italic.woff2")

    for source in [FONT_PRIMARY, FONT_PRIMARY_ITALIC]:
        web = TTFont(source)
        web.flavor = "woff2"
        web.save(source.with_suffix(".woff2"))

    mono_web_dir = TYPOGRAPHY / "Fonts/IBM Plex Mono/Web"
    for source in [FONT_MONO_REGULAR, FONT_MONO_MEDIUM]:
        font = TTFont(source)
        font.flavor = "woff2"
        font.save(mono_web_dir / f"{source.stem}.woff2")


def generate_logos() -> None:
    symbol_variants = {
        "Obelus_Symbol_Evidence_Blue": COLORS["blue-600"],
        "Obelus_Symbol_Ink": COLORS["ink-950"],
        "Obelus_Symbol_Cloud": COLORS["cloud"],
        "Obelus_Symbol_Live_Aqua": COLORS["aqua-500"],
    }
    for stem, color in symbol_variants.items():
        svg = mark_svg(color, stem.replace("_", " "))
        save_svg_bundle(
            svg,
            LOGOS / f"Master/Symbol/{stem}.svg",
            LOGOS / "PNG/Symbol",
            (16, 24, 32, 48, 64, 128, 256, 512, 1024),
        )

    micro = mark_svg(COLORS["blue-600"], "Obelus Micro Symbol", micro=True)
    save_svg_bundle(
        micro,
        LOGOS / "Master/Symbol/Obelus_Symbol_Micro.svg",
        LOGOS / "PNG/Symbol",
        (16, 20, 24, 32),
    )

    wordmark_variants = {
        "Obelus_Wordmark_Ink": COLORS["ink-950"],
        "Obelus_Wordmark_Evidence_Blue": COLORS["blue-600"],
        "Obelus_Wordmark_Cloud": COLORS["cloud"],
    }
    for stem, color in wordmark_variants.items():
        svg, _, _ = wordmark_svg(color, stem.replace("_", " "))
        save_svg_bundle(
            svg,
            LOGOS / f"Master/Wordmark/{stem}.svg",
            LOGOS / "PNG/Wordmark",
            (200, 400, 800, 1200),
        )

    lockups = {
        "Obelus_Lockup_Horizontal_Primary": (COLORS["blue-600"], COLORS["ink-950"]),
        "Obelus_Lockup_Horizontal_Ink": (COLORS["ink-950"], COLORS["ink-950"]),
        "Obelus_Lockup_Horizontal_Reverse": (COLORS["cloud"], COLORS["cloud"]),
        "Obelus_Lockup_Horizontal_Dark_Mode": (COLORS["aqua-300"], COLORS["cloud"]),
    }
    for stem, (mark_color, word_color) in lockups.items():
        svg, _, _ = horizontal_lockup_svg(mark_color, word_color, stem.replace("_", " "))
        save_svg_bundle(
            svg,
            LOGOS / f"Master/Horizontal Lockup/{stem}.svg",
            LOGOS / "PNG/Horizontal Lockup",
            (240, 480, 960, 1440),
        )

    stacked = {
        "Obelus_Lockup_Stacked_Primary": (COLORS["blue-600"], COLORS["ink-950"]),
        "Obelus_Lockup_Stacked_Ink": (COLORS["ink-950"], COLORS["ink-950"]),
        "Obelus_Lockup_Stacked_Reverse": (COLORS["cloud"], COLORS["cloud"]),
    }
    for stem, (mark_color, word_color) in stacked.items():
        svg, _, _ = stacked_lockup_svg(mark_color, word_color, stem.replace("_", " "))
        save_svg_bundle(
            svg,
            LOGOS / f"Master/Stacked Lockup/{stem}.svg",
            LOGOS / "PNG/Stacked Lockup",
            (240, 480, 960),
        )

    tag_svg, _, _ = tagline_lockup_svg(
        COLORS["blue-600"], COLORS["ink-950"], "Obelus Tagline Lockup"
    )
    save_svg_bundle(
        tag_svg,
        LOGOS / "Master/Tagline Lockup/Obelus_Lockup_Tagline_Primary.svg",
        None,
        (),
    )

    mono = {
        "Obelus_Symbol_Pure_Black": "#000000",
        "Obelus_Symbol_Pure_White": "#FFFFFF",
    }
    for stem, color in mono.items():
        save_svg_bundle(mark_svg(color, stem.replace("_", " ")), LOGOS / f"Monochrome/{stem}.svg")

    for stem, color in [("Pure_Black", "#000000"), ("Pure_White", "#FFFFFF")]:
        svg, _, _ = horizontal_lockup_svg(color, color, f"Obelus Horizontal {stem.replace('_', ' ')}")
        save_svg_bundle(svg, LOGOS / f"Monochrome/Obelus_Lockup_Horizontal_{stem}.svg")


def app_icon_svg(background: str, foreground: str, title: str) -> str:
    content = f'''  <rect width="1024" height="1024" rx="224" fill="{background}"/>
  <g transform="translate(192 192) scale(10)" fill="{foreground}">
    <circle cx="{TOP_DOT['cx']}" cy="{TOP_DOT['cy']}" r="{TOP_DOT['r']}"/>
    <path d="{BAR_PATH}"/>
    <circle cx="{BOTTOM_DOT['cx']}" cy="{BOTTOM_DOT['cy']}" r="{BOTTOM_DOT['r']}"/>
  </g>'''
    return svg_document(content, (0, 0, 1024, 1024), title, "Obelus application icon.")


def generate_app_icons() -> None:
    variants = {
        "Obelus_App_Icon_Primary": (COLORS["blue-600"], COLORS["cloud"]),
        "Obelus_App_Icon_Dark": (COLORS["ink-950"], COLORS["aqua-300"]),
        "Obelus_App_Icon_Light": (COLORS["paper"], COLORS["blue-600"]),
    }
    sizes = (16, 32, 48, 64, 128, 180, 192, 256, 512, 1024)
    primary_pngs: list[Image.Image] = []
    for stem, (background, foreground) in variants.items():
        svg_path = LOGOS / f"App Icons/{stem}.svg"
        write_text(svg_path, app_icon_svg(background, foreground, stem.replace("_", " ")))
        export_pdf(svg_path, svg_path.with_suffix(".pdf"))
        for size in sizes:
            png_path = LOGOS / f"App Icons/{stem}_{size}px.png"
            export_svg(svg_path, png_path, size)
            if stem == "Obelus_App_Icon_Primary" and size in (16, 32, 48):
                primary_pngs.append(Image.open(png_path).convert("RGBA"))

    ico_path = LOGOS / "Favicons/favicon.ico"
    primary_pngs[-1].save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    shutil.copy2(LOGOS / "App Icons/Obelus_App_Icon_Primary_180px.png", LOGOS / "Favicons/apple-touch-icon.png")
    shutil.copy2(LOGOS / "App Icons/Obelus_App_Icon_Primary_192px.png", LOGOS / "Favicons/icon-192.png")
    shutil.copy2(LOGOS / "App Icons/Obelus_App_Icon_Primary_512px.png", LOGOS / "Favicons/icon-512.png")
    manifest = {
        "name": "Obelus",
        "short_name": "Obelus",
        "description": SPEC["brand"]["category"],
        "start_url": "/",
        "display": "standalone",
        "background_color": COLORS["paper"],
        "theme_color": COLORS["blue-600"],
        "icons": [
            {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
        ],
    }
    write_text(LOGOS / "Favicons/site.webmanifest", json.dumps(manifest, indent=2) + "\n")


def exploration_art(name: str) -> str:
    blue = COLORS["blue-600"]
    ink = COLORS["ink-950"]
    if name == "Dialogue Axis":
        return mark_group(blue)
    if name == "Critical Stroke":
        return f'''  <g fill="{blue}">
    <circle cx="32" cy="14" r="5.6"/>
    <path d="{BAR_PATH}"/>
    <circle cx="32" cy="50" r="5.6"/>
  </g>'''
    if name == "Listening Obelus":
        return f'''  <g fill="none" stroke="{blue}" stroke-width="4" stroke-linecap="round">
    <path d="M27 8A7 7 0 1 0 31 18"/>
    <path d="M37 46A7 7 0 1 0 41 56" transform="rotate(180 38 50)"/>
  </g>
  <rect x="12" y="27" width="40" height="10" rx="5" fill="{blue}"/>'''
    if name == "Evidence Gate":
        return f'''  <g fill="{blue}">
    <circle cx="32" cy="14" r="5.6"/>
    <rect x="12" y="27" width="18" height="10" rx="5"/>
    <rect x="34" y="27" width="18" height="10" rx="5"/>
    <circle cx="32" cy="50" r="5.6"/>
  </g>'''
    if name == "Claim Source State":
        return f'''  <circle cx="32" cy="14" r="5.6" fill="{blue}"/>
  <rect x="12" y="27" width="40" height="10" rx="5" fill="{blue}"/>
  <circle cx="32" cy="50" r="4" fill="none" stroke="{blue}" stroke-width="3.2"/>'''
    if name == "Transcript Marker":
        return f'''  <g fill="{blue}">
    <rect x="17" y="11" width="6" height="42" rx="3"/>
    <circle cx="20" cy="11" r="5.5"/>
    <circle cx="20" cy="53" r="5.5"/>
    <rect x="20" y="27" width="32" height="10" rx="5"/>
  </g>'''
    if name == "Open O":
        return f'''  <path d="M49.5 14.5A24 24 0 1 0 52 46" fill="none" stroke="{ink}" stroke-width="6" stroke-linecap="round"/>
  <g fill="{blue}" transform="translate(12 12) scale(.625)">
    <circle cx="32" cy="14" r="5.6"/>
    <rect x="12" y="27" width="40" height="10" rx="5"/>
    <circle cx="32" cy="50" r="5.6"/>
  </g>'''
    if name == "Echo Obelus":
        return f'''  <g fill="{blue}">
    <circle cx="26" cy="14" r="4.5"/>
    <rect x="12" y="27" width="40" height="10" rx="5"/>
    <circle cx="38" cy="50" r="4.5"/>
  </g>
  <g fill="none" stroke="{blue}" stroke-width="2.2" stroke-linecap="round">
    <path d="M15 9A13 13 0 0 1 31 1"/>
    <path d="M49 55A13 13 0 0 1 33 63"/>
  </g>'''
    raise ValueError(name)


def generate_explorations() -> None:
    names = [
        "Dialogue Axis",
        "Critical Stroke",
        "Listening Obelus",
        "Evidence Gate",
        "Claim Source State",
        "Transcript Marker",
        "Open O",
        "Echo Obelus",
    ]
    cards = []
    for index, name in enumerate(names, start=1):
        art = exploration_art(name)
        svg = svg_document(art, (0, 0, 64, 64), name, f"Obelus logo exploration: {name}.")
        path = LOGOS / f"Explorations/{index:02d}_{name.replace(' ', '_')}.svg"
        write_text(path, svg)
        export_svg(path, path.with_suffix(".png"), 512)

        x = ((index - 1) % 4) * 280
        y = ((index - 1) // 4) * 320
        cards.append(
            f'''  <g transform="translate({x} {y})">
    <rect width="248" height="280" rx="20" fill="{COLORS['cloud']}" stroke="{COLORS['ink-200']}"/>
    <g transform="translate(60 42) scale(2)">{art}</g>
    <text x="24" y="226" fill="{COLORS['ink-950']}" font-family="Instrument Sans, sans-serif" font-size="20" font-weight="600">{index:02d} {xml_escape(name)}</text>
    <text x="24" y="252" fill="{COLORS['ink-600']}" font-family="Instrument Sans, sans-serif" font-size="13">{'SELECTED MASTER' if index == 1 else 'EXPLORATION'}</text>
  </g>'''
        )
    board = svg_document(
        f'''  <rect width="1120" height="640" fill="{COLORS['paper']}"/>
  <text x="0" y="620" fill="{COLORS['ink-500']}" font-family="Instrument Sans, sans-serif" font-size="13">Eight routes were tested in monochrome, small scale, and motion. Dialogue Axis was selected for its balance of recognition, warmth, and product relevance.</text>
{''.join(cards)}''',
        (0, 0, 1120, 640),
        "Obelus Logo Explorations",
        "Contact sheet of eight Obelus logo directions with Dialogue Axis selected.",
    )
    board_path = LOGOS / "Explorations/Obelus_Logo_Explorations.svg"
    write_text(board_path, board)
    export_svg(board_path, PREVIEWS / "Obelus_Logo_Explorations.png", 2240)
    export_pdf(board_path, LOGOS / "Explorations/Obelus_Logo_Explorations.pdf")


def rgb(hex_color: str) -> tuple[int, int, int]:
    value = hex_color.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def relative_luminance(hex_color: str) -> float:
    channels = []
    for component in rgb(hex_color):
        value = component / 255
        channels.append(value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast_ratio(a: str, b: str) -> float:
    first, second = sorted([relative_luminance(a), relative_luminance(b)], reverse=True)
    return (first + 0.05) / (second + 0.05)


def generate_color_assets() -> None:
    core = [
        ("Obelus Ink", "ink-950"),
        ("Paper", "paper"),
        ("Cloud", "cloud"),
        ("Evidence Blue", "blue-600"),
        ("Live Aqua", "aqua-500"),
        ("Voice Coral", "coral-500"),
        ("Supported", "supported"),
        ("Needs context", "context"),
        ("Disputed", "disputed"),
        ("Unverified", "unverified"),
    ]
    items = []
    for index, (name, token) in enumerate(core):
        col = index % 5
        row = index // 5
        x = col * 210
        y = row * 250
        color = COLORS[token]
        text_color = COLORS["cloud"] if contrast_ratio(color, COLORS["cloud"]) >= 4.5 else COLORS["ink-950"]
        items.append(
            f'''  <g transform="translate({x} {y})">
    <rect width="186" height="216" rx="14" fill="{color}"/>
    <text x="16" y="164" fill="{text_color}" font-family="Instrument Sans, sans-serif" font-size="18" font-weight="600">{xml_escape(name)}</text>
    <text x="16" y="190" fill="{text_color}" font-family="IBM Plex Mono, monospace" font-size="14">{color}</text>
  </g>'''
        )
    swatch_svg = svg_document(
        f'''  <rect width="1050" height="500" fill="{COLORS['paper']}"/>
{''.join(items)}''',
        (0, 0, 1050, 500),
        "Obelus Core Palette",
        "Core and semantic colors for the Obelus identity.",
    )
    swatch_path = COLOR_DIR / "Swatches/Obelus_Core_Palette.svg"
    write_text(swatch_path, swatch_svg)
    export_svg(swatch_path, COLOR_DIR / "Swatches/Obelus_Core_Palette.png", 2100)
    export_pdf(swatch_path, COLOR_DIR / "Swatches/Obelus_Core_Palette.pdf")

    pairs = [
        ("Ink text on Paper", COLORS["ink-950"], COLORS["paper"]),
        ("Ink 700 text on Paper", COLORS["ink-700"], COLORS["paper"]),
        ("Ink 600 text on Paper", COLORS["ink-600"], COLORS["paper"]),
        ("Cloud text on Evidence Blue", COLORS["cloud"], COLORS["blue-600"]),
        ("Ink text on Live Aqua", COLORS["ink-950"], COLORS["aqua-500"]),
        ("Ink text on Voice Coral", COLORS["ink-950"], COLORS["coral-500"]),
        ("Supported on supported background", COLORS["supported"], COLORS["supported-bg"]),
        ("Disputed on disputed background", COLORS["disputed"], COLORS["disputed-bg"]),
        ("Context on context background", COLORS["context"], COLORS["context-bg"]),
        ("Unverified on unverified background", COLORS["unverified"], COLORS["unverified-bg"]),
        ("Cloud text on Ink", COLORS["cloud"], COLORS["ink-950"]),
        ("Ink 300 text on Ink", COLORS["ink-300"], COLORS["ink-950"]),
        ("Blue 400 UI on Ink", COLORS["blue-400"], COLORS["ink-950"]),
        ("Aqua 300 UI on Ink", COLORS["aqua-300"], COLORS["ink-950"]),
    ]
    with (COLOR_DIR / "Contrast Matrix.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["Combination", "Foreground", "Background", "Contrast", "WCAG AA body", "WCAG AA large/UI"])
        for name, foreground, background in pairs:
            ratio = contrast_ratio(foreground, background)
            writer.writerow([name, foreground, background, f"{ratio:.2f}:1", "Pass" if ratio >= 4.5 else "Fail", "Pass" if ratio >= 3 else "Fail"])


def css_variable_name(token: str) -> str:
    return "--ob-color-" + token


def generate_tokens() -> None:
    color_json = {name: {"value": value, "type": "color"} for name, value in COLORS.items()}
    write_text(UI / "Design Tokens/colors.tokens.json", json.dumps({"color": color_json}, indent=2) + "\n")

    tokens = {
        "brand": SPEC["brand"],
        "color": COLORS,
        "typography": SPEC["typography"],
        "spacing": {str(value): f"{value}px" for value in SPEC["spacing"]},
        "radius": {name: f"{value}px" for name, value in SPEC["radii"].items()},
        "motion": SPEC["motion"],
    }
    write_text(UI / "Design Tokens/obelus.tokens.json", json.dumps(tokens, indent=2) + "\n")

    color_lines = [f"  {css_variable_name(name)}: {value};" for name, value in COLORS.items()]
    spacing_lines = [f"  --ob-space-{value}: {value / 16:g}rem;" for value in SPEC["spacing"]]
    radius_lines = [f"  --ob-radius-{name}: {value}px;" for name, value in SPEC["radii"].items()]
    css = f'''@font-face {{
  font-family: "Instrument Sans";
  src: url("../../03 Typography/Fonts/Instrument Sans/InstrumentSans-Variable.woff2") format("woff2");
  font-style: normal;
  font-weight: 100 900;
  font-stretch: 75% 100%;
  font-display: swap;
}}

@font-face {{
  font-family: "IBM Plex Mono";
  src: url("../../03 Typography/Fonts/IBM Plex Mono/Web/IBMPlexMono-Regular.woff2") format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}}

:root {{
{chr(10).join(color_lines)}
{chr(10).join(spacing_lines)}
{chr(10).join(radius_lines)}
  --ob-font-sans: "Instrument Sans", ui-sans-serif, system-ui, sans-serif;
  --ob-font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, monospace;
  --ob-text: var(--ob-color-ink-950);
  --ob-text-secondary: var(--ob-color-ink-600);
  --ob-background: var(--ob-color-paper);
  --ob-surface: var(--ob-color-cloud);
  --ob-border: var(--ob-color-ink-200);
  --ob-action: var(--ob-color-blue-600);
  --ob-live: var(--ob-color-aqua-500);
  --ob-focus-ring: var(--ob-color-blue-600);
}}

[data-theme="dark"] {{
  --ob-text: var(--ob-color-cloud);
  --ob-text-secondary: var(--ob-color-ink-300);
  --ob-background: var(--ob-color-ink-950);
  --ob-surface: var(--ob-color-ink-900);
  --ob-border: var(--ob-color-ink-700);
  --ob-action: var(--ob-color-blue-400);
  --ob-live: var(--ob-color-aqua-300);
  --ob-focus-ring: var(--ob-color-aqua-300);
}}
'''
    write_text(UI / "Design Tokens/obelus.css", css)

    tailwind = f'''/** Obelus Tailwind preset - generated from brand_spec.json */
module.exports = {{
  theme: {{
    extend: {{
      colors: {json.dumps(COLORS, indent=8)},
      fontFamily: {{
        sans: ['"Instrument Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      }},
      borderRadius: {json.dumps({name: f'{value}px' for name, value in SPEC['radii'].items()}, indent=8)},
    }},
  }},
}};
'''
    write_text(UI / "Design Tokens/tailwind.preset.js", tailwind)


def status_icon_svg(name: str, content: str, color: str = "currentColor") -> str:
    return svg_document(
        f'  <g fill="none" stroke="{color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">\n{content}\n  </g>',
        (0, 0, 24, 24),
        f"{name} status icon",
        f"Obelus {name.lower()} status icon.",
    )


def generate_status_icons() -> None:
    icons = {
        "Supported": '    <path d="M5 12.5l4.2 4.2L19 7"/>\n    <circle cx="12" cy="12" r="10" opacity=".35"/>',
        "Disputed": '    <path d="M8 8l8 8M16 8l-8 8"/>\n    <circle cx="12" cy="12" r="10" opacity=".35"/>',
        "Needs_Context": '    <path d="M12 7v6"/>\n    <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>\n    <circle cx="12" cy="12" r="10" opacity=".35"/>',
        "Unverified": '    <circle cx="10" cy="5" r="1.8" fill="currentColor" stroke="none"/>\n    <path d="M5 12h14" stroke-width="3"/>\n    <circle cx="14" cy="19" r="1.8" fill="currentColor" stroke="none"/>',
        "Sources_Conflict": '    <path d="M4 8h13M7 16h13"/>\n    <path d="M14 5l3 3-3 3M10 13l-3 3 3 3"/>',
        "Outdated": '    <path d="M4 12a8 8 0 1 0 2.3-5.7"/>\n    <path d="M4 5v5h5M12 8v5l3 2"/>',
        "Opinion": '    <path d="M5 5h14v10H9l-4 4V5z"/>\n    <path d="M8 9h8M8 12h5"/>',
        "Checking": '    <path d="M5 12h14" stroke-width="3"/>\n    <circle cx="9" cy="5" r="2" fill="currentColor" stroke="none"/>\n    <circle cx="15" cy="19" r="2" fill="currentColor" stroke="none"/>',
    }
    for name, content in icons.items():
        svg_path = GRAPHICS / f"Status Icons/Obelus_Status_{name}.svg"
        write_text(svg_path, status_icon_svg(name.replace("_", " "), content))
        export_svg(svg_path, svg_path.with_suffix(".png"), 128)


def generate_patterns() -> None:
    margin_marks = []
    for row in range(10):
        y = 28 + row * 48
        opacity = 0.12 + (row % 3) * 0.05
        margin_marks.append(
            f'<g transform="translate(24 {y}) scale(.34)" opacity="{opacity:.2f}">{mark_group(COLORS["blue-600"])}</g>'
        )
        margin_marks.append(f'<line x1="88" y1="{y + 11}" x2="720" y2="{y + 11}" stroke="{COLORS["ink-200"]}"/>')
    margin_svg = svg_document(
        f'''  <rect width="768" height="512" fill="{COLORS['paper']}"/>
  <rect x="76" width="1" height="512" fill="{COLORS['coral-300']}"/>
  {''.join(margin_marks)}''',
        (0, 0, 768, 512),
        "Obelus Margin Notes Pattern",
        "Editorial pattern derived from obelus marks beside transcript lines.",
    )
    margin_path = GRAPHICS / "Patterns/Obelus_Pattern_Margin_Notes.svg"
    write_text(margin_path, margin_svg)
    export_svg(margin_path, margin_path.with_suffix(".png"), 1536)

    nodes = []
    for index, x in enumerate([64, 184, 320, 476, 632, 736]):
        y = 120 + [0, 34, -18, 22, -30, 8][index]
        nodes.append(f'<circle cx="{x}" cy="{y}" r="{7 if index in (0, 5) else 5}" fill="{COLORS["blue-600"] if index % 2 == 0 else COLORS["aqua-500"]}"/>')
        if index < 5:
            next_x = [64, 184, 320, 476, 632, 736][index + 1]
            next_y = 120 + [0, 34, -18, 22, -30, 8][index + 1]
            nodes.append(f'<path d="M{x} {y}C{(x+next_x)/2} {y} {(x+next_x)/2} {next_y} {next_x} {next_y}" fill="none" stroke="{COLORS["ink-300"]}" stroke-width="2"/>')
    evidence_svg = svg_document(
        f'''  <rect width="800" height="240" fill="{COLORS['cloud']}"/>
  <path d="M40 120H760" stroke="{COLORS['ink-200']}" stroke-width="10" stroke-linecap="round"/>
  {''.join(nodes)}''',
        (0, 0, 800, 240),
        "Obelus Evidence Thread",
        "A source-node graphic connecting a claim to multiple points of evidence.",
    )
    evidence_path = GRAPHICS / "Patterns/Obelus_Pattern_Evidence_Thread.svg"
    write_text(evidence_path, evidence_svg)
    export_svg(evidence_path, evidence_path.with_suffix(".png"), 1600)

    marks = []
    for row in range(5):
        for col in range(8):
            x = 18 + col * 98 + (row % 2) * 34
            y = 14 + row * 98
            color = [COLORS["blue-600"], COLORS["aqua-500"], COLORS["coral-500"]][(row + col) % 3]
            marks.append(f'<g transform="translate({x} {y}) scale(.42)" opacity=".18">{mark_group(color)}</g>')
    field_svg = svg_document(
        f'''  <rect width="800" height="500" fill="{COLORS['ink-950']}"/>
  {''.join(marks)}''',
        (0, 0, 800, 500),
        "Obelus Dialogue Field Pattern",
        "A low-contrast field of repeated Dialogue Axis marks.",
    )
    field_path = GRAPHICS / "Patterns/Obelus_Pattern_Dialogue_Field.svg"
    write_text(field_path, field_svg)
    export_svg(field_path, field_path.with_suffix(".png"), 1600)


def generate_social_assets() -> None:
    avatar_svg = app_icon_svg(COLORS["blue-600"], COLORS["cloud"], "Obelus Social Avatar")
    avatar_path = UI / "Social and Marketing/Obelus_Social_Avatar.svg"
    write_text(avatar_path, avatar_svg)
    export_svg(avatar_path, avatar_path.with_suffix(".png"), 800)

    headline_paths, headline_width, _ = font_text_paths(
        "Evidence at", axes={"wght": 620, "wdth": 94}, height=72, tracking_em=-0.03
    )
    speed_paths, speed_width, _ = font_text_paths(
        "conversation speed.", axes={"wght": 620, "wdth": 94}, height=72, tracking_em=-0.03
    )
    lockup, _, _ = horizontal_lockup_svg(COLORS["cloud"], COLORS["cloud"], "Obelus")
    # Embed the mark and outlined wordmark directly; the lockup string is not nested to avoid duplicate IDs.
    word_paths, word_width, _ = font_text_paths("Obelus", height=32)
    social = svg_document(
        f'''  <rect width="1200" height="630" fill="{COLORS['ink-950']}"/>
  <circle cx="1080" cy="92" r="220" fill="{COLORS['blue-600']}" opacity=".72"/>
  <circle cx="1110" cy="560" r="180" fill="{COLORS['aqua-500']}" opacity=".20"/>
  <g transform="translate(72 66) scale(.62)">{mark_group(COLORS['aqua-300'])}</g>
  <g fill="{COLORS['cloud']}" transform="translate(130 77)">{word_paths}</g>
  <g fill="{COLORS['cloud']}" transform="translate(72 225)">{headline_paths}</g>
  <g fill="{COLORS['cloud']}" transform="translate(72 315)">{speed_paths}</g>
  <text x="76" y="500" fill="{COLORS['ink-300']}" font-family="Instrument Sans, sans-serif" font-size="25">Live verification for spoken conversations</text>
  <g transform="translate(1010 310) scale(2.25)">{mark_group(COLORS['coral-500'])}</g>''',
        (0, 0, 1200, 630),
        "Obelus Open Graph Card",
        "Social card reading Evidence at conversation speed.",
    )
    social_path = UI / "Social and Marketing/Obelus_Open_Graph_Card.svg"
    write_text(social_path, social)
    export_svg(social_path, social_path.with_suffix(".png"), 1200)


def generate_typography_specimen() -> None:
    title_paths, _, _ = font_text_paths("Instrument Sans", axes={"wght": 620, "wdth": 94}, height=66, tracking_em=-0.03)
    phrase_paths, _, _ = font_text_paths("Question claims. Not people.", axes={"wght": 620, "wdth": 94}, height=46, tracking_em=-0.025)
    weight_rows=[]
    for index,(label,weight) in enumerate([("Regular 400",400),("Medium 520",520),("SemiBold 620",620),("Bold 700",700)]):
        paths,_,_=font_text_paths(label,axes={"wght":weight,"wdth":100},height=24,tracking_em=0)
        weight_rows.append(f'<g fill="{COLORS["ink-950"]}" transform="translate(80 {420+index*58})">{paths}</g>')
    mono_paths,_,_=font_text_paths("18:42:21  /  6 SOURCES  /  71%",source=FONT_MONO_MEDIUM,axes={},height=18,tracking_em=.01)
    specimen=svg_document(
        f'''  <rect width="1200" height="760" fill="{COLORS['paper']}"/>
  <g fill="{COLORS['ink-950']}" transform="translate(72 64)">{title_paths}</g>
  <text x="76" y="164" fill="{COLORS['ink-600']}" font-family="Instrument Sans, sans-serif" font-size="19">A variable neo-grotesque with precision and a small pulse of playfulness.</text>
  <path d="M76 214H1124" stroke="{COLORS['ink-200']}"/>
  <g fill="{COLORS['blue-600']}" transform="translate(76 256)">{phrase_paths}</g>
  <text x="78" y="346" fill="{COLORS['ink-600']}" font-family="Instrument Sans, sans-serif" font-size="17">Display: 620 weight / 94 width / -0.025em tracking</text>
  {''.join(weight_rows)}
  <path d="M550 396V680" stroke="{COLORS['ink-200']}"/>
  <text x="620" y="430" fill="{COLORS['ink-500']}" font-family="Instrument Sans, sans-serif" font-size="13">TRANSCRIPT / 18 PX / 1.55</text>
  <text x="620" y="485" fill="{COLORS['ink-950']}" font-family="Instrument Sans, sans-serif" font-size="22">Every claim deserves context.</text>
  <text x="620" y="525" fill="{COLORS['ink-600']}" font-family="Instrument Sans, sans-serif" font-size="17">Lead with the finding, then reveal the evidence trail.</text>
  <g fill="{COLORS['blue-700']}" transform="translate(620 590)">{mono_paths}</g>
  <text x="620" y="650" fill="{COLORS['ink-500']}" font-family="Instrument Sans, sans-serif" font-size="13">IBM Plex Mono is reserved for time, source IDs, and compact metadata.</text>''',
        (0,0,1200,760),"Obelus Typography Specimen","Instrument Sans and IBM Plex Mono typography specimen."
    )
    specimen_path=TYPOGRAPHY/"Specimens/Obelus_Typography_Specimen.svg"
    write_text(specimen_path,specimen)
    export_svg(specimen_path,specimen_path.with_suffix(".png"),1800)
    export_pdf(specimen_path,specimen_path.with_suffix(".pdf"))


def generate_application_templates() -> None:
    templates=UI/"Application Templates"
    word_paths,_,_=font_text_paths("Obelus",height=34)
    deck_head,_,_=font_text_paths("Evidence at",axes={"wght":620,"wdth":94},height=82,tracking_em=-.03)
    deck_head_2,_,_=font_text_paths("conversation speed.",axes={"wght":620,"wdth":94},height=82,tracking_em=-.03)
    deck=svg_document(
        f'''  <rect width="1920" height="1080" fill="{COLORS['ink-950']}"/>
  <g transform="translate(100 86) scale(.75)">{mark_group(COLORS['aqua-300'])}</g>
  <g fill="{COLORS['cloud']}" transform="translate(164 98)">{word_paths}</g>
  <g fill="{COLORS['cloud']}" transform="translate(100 330)">{deck_head}</g>
  <g fill="{COLORS['cloud']}" transform="translate(100 446)">{deck_head_2}</g>
  <text x="106" y="650" fill="{COLORS['ink-300']}" font-family="Instrument Sans, sans-serif" font-size="30">Live verification for spoken conversations</text>
  <text x="106" y="932" fill="{COLORS['ink-400']}" font-family="IBM Plex Mono, monospace" font-size="20">PRESENTATION TITLE  /  AUGUST 2026</text>
  <circle cx="1490" cy="190" r="82" fill="{COLORS['coral-500']}"/>
  <path d="M1320 540H1780" stroke="{COLORS['blue-400']}" stroke-width="82" stroke-linecap="round"/>
  <circle cx="1600" cy="862" r="82" fill="{COLORS['aqua-500']}"/>''',
        (0,0,1920,1080),"Obelus Presentation Cover","Editable presentation cover template."
    )
    deck_path=templates/"Obelus_Presentation_Cover.svg"
    write_text(deck_path,deck); export_svg(deck_path,deck_path.with_suffix(".png"),1920); export_pdf(deck_path,deck_path.with_suffix(".pdf"))

    doc_head,_,_=font_text_paths("See what",axes={"wght":620,"wdth":94},height=62,tracking_em=-.03)
    doc_head_2,_,_=font_text_paths("stands up.",axes={"wght":620,"wdth":94},height=62,tracking_em=-.03)
    document=svg_document(
        f'''  <rect width="816" height="1056" fill="{COLORS['paper']}"/>
  <rect x="0" width="14" height="1056" fill="{COLORS['blue-600']}"/>
  <g transform="translate(72 68) scale(.62)">{mark_group(COLORS['blue-600'])}</g>
  <g fill="{COLORS['ink-950']}" transform="translate(126 78)">{word_paths}</g>
  <g fill="{COLORS['ink-950']}" transform="translate(72 330)">{doc_head}</g>
  <g fill="{COLORS['ink-950']}" transform="translate(72 415)">{doc_head_2}</g>
  <text x="77" y="568" fill="{COLORS['ink-600']}" font-family="Instrument Sans, sans-serif" font-size="24">Research brief / conversation recap</text>
  <path d="M76 690H700" stroke="{COLORS['ink-200']}"/>
  <text x="77" y="738" fill="{COLORS['ink-500']}" font-family="IBM Plex Mono, monospace" font-size="16">PREPARED 09 AUG 2026</text>
  <circle cx="662" cy="876" r="34" fill="{COLORS['coral-500']}"/>
  <rect x="494" y="860" width="112" height="32" rx="16" fill="{COLORS['blue-600']}"/>
  <circle cx="438" cy="876" r="34" fill="{COLORS['aqua-500']}"/>''',
        (0,0,816,1056),"Obelus Document Cover","Letter-sized research brief and recap cover template."
    )
    document_path=templates/"Obelus_Document_Cover.svg"
    write_text(document_path,document); export_svg(document_path,document_path.with_suffix(".png"),1632); export_pdf(document_path,document_path.with_suffix(".pdf"))

    quote_head,_,_=font_text_paths("Every claim",axes={"wght":620,"wdth":94},height=58,tracking_em=-.03)
    quote_head_2,_,_=font_text_paths("deserves context.",axes={"wght":620,"wdth":94},height=58,tracking_em=-.03)
    square=svg_document(
        f'''  <rect width="1080" height="1080" fill="{COLORS['blue-600']}"/>
  <g transform="translate(72 66) scale(.7)">{mark_group(COLORS['cloud'])}</g>
  <g fill="{COLORS['cloud']}" transform="translate(74 332)">{quote_head}</g>
  <g fill="{COLORS['cloud']}" transform="translate(74 414)">{quote_head_2}</g>
  <text x="80" y="610" fill="{COLORS['blue-200']}" font-family="Instrument Sans, sans-serif" font-size="27">Not a verdict. A reason to look closer.</text>
  <circle cx="164" cy="894" r="48" fill="{COLORS['coral-500']}"/>
  <rect x="248" y="872" width="370" height="44" rx="22" fill="{COLORS['aqua-300']}"/>
  <circle cx="704" cy="894" r="48" fill="{COLORS['cloud']}"/>''',
        (0,0,1080,1080),"Obelus Social Quote Template","Square social template using the Obelus claim line."
    )
    square_path=templates/"Obelus_Social_Quote_Template.svg"
    write_text(square_path,square); export_svg(square_path,square_path.with_suffix(".png"),1080)

    email='''<!doctype html><html><body style="margin:24px;background:#FCFCF8"><table role="presentation" cellspacing="0" cellpadding="0" style="font-family:Arial,sans-serif;color:#111528"><tr><td style="padding-right:18px;border-right:2px solid #3B50E0"><img src="../../02 Logos/PNG/Symbol/Obelus_Symbol_Evidence_Blue_64px.png" width="48" alt="Obelus"></td><td style="padding-left:18px"><strong style="font-size:16px">Name Surname</strong><br><span style="font-size:13px;color:#515B78">Title · Obelus</span><br><a href="mailto:name@example.com" style="font-size:13px;color:#3B50E0;text-decoration:none">name@example.com</a><span style="color:#B5BBCD"> · </span><a href="#" style="font-size:13px;color:#3B50E0;text-decoration:none">obelus.example</a><br><span style="font-size:11px;color:#69708C">Evidence at conversation speed.</span></td></tr></table></body></html>'''
    write_text(templates/"Obelus_Email_Signature.html",email)


def generate_logo_preview() -> None:
    word_paths, _, _ = font_text_paths("Obelus", height=70)
    tagline_paths, _, _ = font_text_paths(
        SPEC["brand"]["tagline"], axes={"wght": 450, "wdth": 100}, height=28, tracking_em=0
    )
    content = f'''  <rect width="1600" height="1000" fill="{COLORS['paper']}"/>
  <rect x="80" y="80" width="900" height="840" rx="32" fill="{COLORS['cloud']}"/>
  <g transform="translate(150 170) scale(3)">{mark_group(COLORS['blue-600'])}</g>
  <g fill="{COLORS['ink-950']}" transform="translate(150 440)">{word_paths}</g>
  <g fill="{COLORS['ink-600']}" transform="translate(150 545)">{tagline_paths}</g>
  <path d="M150 675H860" stroke="{COLORS['ink-200']}"/>
  <text x="150" y="728" fill="{COLORS['ink-950']}" font-family="Instrument Sans, sans-serif" font-size="24" font-weight="600">Constructive skepticism</text>
  <text x="150" y="770" fill="{COLORS['ink-600']}" font-family="Instrument Sans, sans-serif" font-size="20">Not a verdict. A reason to look closer.</text>
  <rect x="1040" width="560" height="1000" fill="{COLORS['ink-950']}"/>
  <g transform="translate(1130 140) scale(5)">{mark_group(COLORS['aqua-300'])}</g>
  <text x="1120" y="560" fill="{COLORS['cloud']}" font-family="Instrument Sans, sans-serif" font-size="42" font-weight="600">Live verification</text>
  <text x="1120" y="615" fill="{COLORS['ink-300']}" font-family="Instrument Sans, sans-serif" font-size="25">for spoken conversations</text>
  <circle cx="1140" cy="790" r="24" fill="{COLORS['coral-500']}"/>
  <rect x="1195" y="778" width="210" height="24" rx="12" fill="{COLORS['blue-400']}"/>
  <circle cx="1460" cy="790" r="24" fill="{COLORS['aqua-500']}"/>'''
    svg = svg_document(content, (0, 0, 1600, 1000), "Obelus Brand Overview", "Overview board of the Obelus logo, palette, and messaging.")
    path = PREVIEWS / "Obelus_Brand_Overview.svg"
    write_text(path, svg)
    export_svg(path, PREVIEWS / "Obelus_Brand_Overview.png", 2400)


def main() -> None:
    ensure_directories()
    generate_fonts()
    generate_logos()
    generate_app_icons()
    generate_explorations()
    generate_color_assets()
    generate_tokens()
    generate_status_icons()
    generate_patterns()
    generate_social_assets()
    generate_typography_specimen()
    generate_application_templates()
    generate_logo_preview()
    print("Generated Obelus identity assets.")


if __name__ == "__main__":
    main()
