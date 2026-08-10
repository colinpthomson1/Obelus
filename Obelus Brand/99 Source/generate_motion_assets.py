#!/usr/bin/env python3
"""Generate five Obelus loader systems in SVG, Lottie, video, and GIF formats."""

from __future__ import annotations

import json
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parent
SPEC = json.loads((SOURCE / "brand_spec.json").read_text())
COLORS = SPEC["colors"]
MOTION = ROOT / "06 Motion"
PREVIEWS = ROOT / "09 Previews"
BAR_PATH = SPEC["logo"]["barPath"]
TOP = SPEC["logo"]["topDot"]
BOTTOM = SPEC["logo"]["bottomDot"]
FONT = ROOT / "03 Typography/Fonts/Instrument Sans/Static/InstrumentSans-SemiBold.ttf"

LOADERS = [
    ("01 Proof Pulse", "proof-pulse", "Proof Pulse", 1.2, "Checking…"),
    ("02 Transcript Scan", "transcript-scan", "Transcript Scan", 1.35, "Scanning speech…"),
    ("03 Source Exchange", "source-exchange", "Source Exchange", 1.6, "Checking sources…"),
    ("04 Obelus Resolve", "obelus-resolve", "Obelus Resolve", 1.84, "Resolving evidence…"),
    ("05 Progress Divide", "progress-divide", "Progress Divide", 1.6, "Building report…"),
]


def run(command: list[str]) -> None:
    subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def mark_pieces(prefix: str = "", base_class: str = "") -> str:
    return f'''    <circle class="{prefix}top {base_class}" cx="{TOP['cx']}" cy="{TOP['cy']}" r="{TOP['r']}"/>
    <path class="{prefix}bar {base_class}" d="{BAR_PATH}"/>
    <circle class="{prefix}bottom {base_class}" cx="{BOTTOM['cx']}" cy="{BOTTOM['cy']}" r="{BOTTOM['r']}"/>'''


def animated_svg(kind: str, title: str) -> str:
    common = '''  <title id="ob-title">%s</title>
  <desc id="ob-desc">Accessible decorative preview of the %s loading animation. Pair with a textual status in production.</desc>
  <style>
    :root { color: #3B50E0; }
    .ob-base { opacity: .24; }
    .ob-art { fill: currentColor; }
    @media (forced-colors: active) {
      :root { color: CanvasText; }
      .ob-base { opacity: 1; }
      .ob-animated { display: none; }
    }
  </style>''' % (title, title)

    if kind == "proof-pulse":
        styles = '''
  <style>
    .ob-proof-top { transform-box: fill-box; transform-origin: center; animation: ob-proof-top 1.2s infinite; }
    .ob-proof-bar { transform-box: fill-box; transform-origin: center; animation: ob-proof-bar 1.2s infinite; }
    .ob-proof-bottom { transform-box: fill-box; transform-origin: center; animation: ob-proof-bottom 1.2s infinite; }
    @keyframes ob-proof-top {
      0% { opacity:0; transform:scale(.82) } 20%,74% { opacity:1; transform:scale(1) } 92%,100% { opacity:0; transform:scale(.88) }
    }
    @keyframes ob-proof-bar {
      0%,12% { opacity:0; transform:scaleX(0) } 38%,74% { opacity:1; transform:scaleX(1) } 92%,100% { opacity:0; transform:scaleX(1) }
    }
    @keyframes ob-proof-bottom {
      0%,30% { opacity:0; transform:scale(.82) } 55%,74% { opacity:1; transform:scale(1) } 92%,100% { opacity:0; transform:scale(.88) }
    }
    @media (prefers-reduced-motion: reduce) {
      .ob-base { opacity:1 }
      .ob-animated { display:none }
    }
  </style>'''
        body = f'''  <g class="ob-art ob-base">{mark_pieces()}</g>
  <g class="ob-art ob-animated">
    <circle class="ob-proof-top" cx="{TOP['cx']}" cy="{TOP['cy']}" r="{TOP['r']}"/>
    <path class="ob-proof-bar" d="{BAR_PATH}"/>
    <circle class="ob-proof-bottom" cx="{BOTTOM['cx']}" cy="{BOTTOM['cy']}" r="{BOTTOM['r']}"/>
  </g>'''
    elif kind == "transcript-scan":
        styles = '''
  <style>
    .ob-scan-window { animation: ob-scan 1.35s linear infinite; }
    @keyframes ob-scan { 0%,10% { transform:translateX(0) } 76%,100% { transform:translateX(88px) } }
    @media (prefers-reduced-motion: reduce) {
      .ob-base { opacity:1 }
      .ob-animated { display:none }
    }
  </style>'''
        body = f'''  <defs><clipPath id="ob-scan-clip"><rect class="ob-scan-window" x="-12" y="0" width="12" height="64" rx="6"/></clipPath></defs>
  <g class="ob-art ob-base">{mark_pieces()}</g>
  <g class="ob-art ob-animated" clip-path="url(#ob-scan-clip)">{mark_pieces()}</g>'''
    elif kind == "source-exchange":
        styles = '''
  <style>
    .ob-source-pair { transform-box:view-box; transform-origin:32px 32px; animation:ob-source 1.6s cubic-bezier(.65,0,.35,1) infinite; }
    @keyframes ob-source { 0%,12% { transform:rotate(0deg) } 88%,100% { transform:rotate(180deg) } }
    @media (prefers-reduced-motion: reduce) { .ob-source-pair { animation:none } }
  </style>'''
        body = f'''  <g class="ob-art"><path d="{BAR_PATH}"/>
    <g class="ob-source-pair"><circle cx="{TOP['cx']}" cy="{TOP['cy']}" r="{TOP['r']}"/><circle cx="{BOTTOM['cx']}" cy="{BOTTOM['cy']}" r="{BOTTOM['r']}"/></g>
  </g>'''
    elif kind == "obelus-resolve":
        styles = '''
  <style>
    .ob-resolve-bar { transform-box:fill-box; transform-origin:center; animation:ob-resolve-bar 1.84s infinite; }
    .ob-resolve-top,.ob-resolve-bottom { transform-box:fill-box; transform-origin:center; }
    .ob-resolve-top { animation:ob-resolve-top 1.84s infinite; }
    .ob-resolve-bottom { animation:ob-resolve-bottom 1.84s infinite; }
    @keyframes ob-resolve-bar { 0%,8%{opacity:0;transform:scaleX(0)}32%,68%{opacity:1;transform:scaleX(1)}90%,100%{opacity:0;transform:scaleX(0)} }
    @keyframes ob-resolve-top { 0%,14%{opacity:0;transform:translateY(-7px) scale(.72)}40%,68%{opacity:1;transform:translateY(0) scale(1)}90%,100%{opacity:0;transform:translateY(-7px) scale(.72)} }
    @keyframes ob-resolve-bottom { 0%,14%{opacity:0;transform:translateY(7px) scale(.72)}40%,68%{opacity:1;transform:translateY(0) scale(1)}90%,100%{opacity:0;transform:translateY(7px) scale(.72)} }
    @media (prefers-reduced-motion: reduce) { .ob-base{opacity:1}.ob-animated{display:none} }
  </style>'''
        body = f'''  <g class="ob-art ob-base" style="opacity:.11">{mark_pieces()}</g>
  <g class="ob-art ob-animated">
    <circle class="ob-resolve-top" cx="{TOP['cx']}" cy="{TOP['cy']}" r="{TOP['r']}"/>
    <path class="ob-resolve-bar" d="{BAR_PATH}"/>
    <circle class="ob-resolve-bottom" cx="{BOTTOM['cx']}" cy="{BOTTOM['cy']}" r="{BOTTOM['r']}"/>
  </g>'''
    elif kind == "progress-divide":
        styles = '''
  <style>
    :root { --ob-progress:.62; }
    .ob-progress-bar { transform-box:fill-box; transform-origin:left center; transform:scaleX(var(--ob-progress)); transition:transform 160ms linear; }
    .ob-progress-bottom { opacity:0; transform-box:fill-box; transform-origin:center; transform:scale(.78); transition:opacity 220ms cubic-bezier(.25,1,.5,1),transform 220ms cubic-bezier(.25,1,.5,1); }
    [data-complete="true"] .ob-progress-bottom { opacity:1; transform:scale(1); }
    @media (prefers-reduced-motion: reduce) { .ob-progress-bar,.ob-progress-bottom { transition:none } }
  </style>'''
        body = f'''  <g class="ob-art ob-base">{mark_pieces()}</g>
  <g class="ob-art ob-animated">
    <circle cx="{TOP['cx']}" cy="{TOP['cy']}" r="{TOP['r']}"/>
    <path class="ob-progress-bar" d="{BAR_PATH}"/>
    <circle class="ob-progress-bottom" cx="{BOTTOM['cx']}" cy="{BOTTOM['cy']}" r="{BOTTOM['r']}"/>
  </g>'''
    else:
        raise ValueError(kind)

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-labelledby="ob-title ob-desc" data-complete="false">
{common}
{styles}
{body}
</svg>
'''


def static_svg(title: str) -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-labelledby="title desc" style="color:#3B50E0">
  <title id="title">{title} static poster</title>
  <desc id="desc">Static Obelus Dialogue Axis symbol.</desc>
  <g fill="currentColor">
{mark_pieces()}
  </g>
</svg>
'''


def css_snippet(kind: str) -> str:
    class_name = "ob-loader-" + kind
    return f'''/* {kind.replace('-', ' ').title()} implementation wrapper */
.{class_name} {{
  inline-size: 1.5rem;
  block-size: 1.5rem;
  color: var(--ob-action, #3B50E0);
  flex: 0 0 auto;
}}

.{class_name}[aria-hidden="true"] {{ pointer-events: none; }}

@media (prefers-reduced-motion: reduce) {{
  .{class_name} {{ animation: none; }}
}}

@media (forced-colors: active) {{
  .{class_name} {{ color: CanvasText; }}
}}
'''


def usage_note(kind: str, title: str, status: str) -> str:
    guidance = {
        "proof-pulse": ("16–24 px", "Buttons, compact claim cards, and generic indeterminate checking."),
        "transcript-scan": ("20–32 px", "The transcript segment currently being analyzed."),
        "source-exchange": ("24–48 px", "Multi-source retrieval, web research, and deeper verification."),
        "obelus-resolve": ("40–96 px", "Signature moments, report generation, sign-in handoff, and landing-page demos."),
        "progress-divide": ("20–48 px", "Only work with a real measurable percentage or known unit count."),
    }
    size, use = guidance[kind]
    return f'''# {title}

**Recommended size:** {size}  
**Use for:** {use}

The animated SVG uses `currentColor` when placed inline. External SVG images use Evidence Blue as their fallback color. The Lottie file is transparent and uses the brand blue directly; replace the fill at runtime if a themed variant is required.

## Accessible wrapper

```html
<div role="status" aria-live="polite" aria-atomic="true">
  <svg aria-hidden="true">…</svg>
  <span class="sr-only">{status}</span>
</div>
```

The graphic is decorative. Announce process start once and completion once; never announce each loop. In reduced-motion mode, present the static canonical mark and retain the status text.
'''


def html_demo(kind: str, title: str, status: str) -> str:
    progress_controls = ""
    script = ""
    if kind == "progress-divide":
        progress_controls = '''<label>Progress <input id="progress" type="range" min="0" max="100" value="62"></label><output id="value">62%</output>'''
        script = '''<script>
const object = document.querySelector('object');
const range = document.querySelector('#progress');
const output = document.querySelector('#value');
function update(){
  const root = object.contentDocument?.documentElement;
  const value = Number(range.value);
  output.value = `${value}%`;
  if(root){ root.style.setProperty('--ob-progress', value / 100); root.dataset.complete = String(value === 100); }
}
range.addEventListener('input', update); object.addEventListener('load', update);
</script>'''
    return f'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Obelus — {title}</title>
  <style>
    @font-face{{font-family:Instrument;src:url('../../03 Typography/Fonts/Instrument Sans/InstrumentSans-Variable.woff2')}}
    *{{box-sizing:border-box}} body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#F7F8FC;color:#111528;font-family:Instrument,system-ui,sans-serif}}
    main{{display:grid;justify-items:center;gap:28px}} object{{width:160px;height:160px;color:#3B50E0}} h1{{font-size:32px;margin:0}} p{{margin:0;color:#515B78}} label{{display:flex;align-items:center;gap:12px}} input{{accent-color:#3B50E0;width:240px}} output{{font-variant-numeric:tabular-nums}}
  </style>
</head>
<body><main role="status" aria-live="polite" aria-atomic="true">
  <object data="obelus-loader-{kind}.animated.svg" type="image/svg+xml" aria-hidden="true"></object>
  <h1>{title}</h1><p>{status}</p>{progress_controls}
</main>{script}</body>
</html>
'''


def motion_tokens() -> None:
    token_json = {
        "motion": {
            "duration": {
                "instant": {"value": "120ms", "type": "duration"},
                "fast": {"value": "200ms", "type": "duration"},
                "standard": {"value": "280ms", "type": "duration"},
                "emphasis": {"value": "480ms", "type": "duration"},
            },
            "loop": {
                "compact": {"value": "1200ms", "type": "duration"},
                "scan": {"value": "1350ms", "type": "duration"},
                "research": {"value": "1600ms", "type": "duration"},
                "signature": {"value": "1840ms", "type": "duration"},
            },
            "easing": {
                "enter": {"value": "cubic-bezier(.16,1,.3,1)", "type": "cubicBezier"},
                "exit": {"value": "cubic-bezier(.7,0,.84,0)", "type": "cubicBezier"},
                "shift": {"value": "cubic-bezier(.65,0,.35,1)", "type": "cubicBezier"},
                "refine": {"value": "cubic-bezier(.25,1,.5,1)", "type": "cubicBezier"},
            },
        }
    }
    write_text(MOTION / "Tokens/obelus-motion.tokens.json", json.dumps(token_json, indent=2) + "\n")
    write_text(
        MOTION / "Tokens/obelus-motion.css",
        ''':root {
  --ob-motion-instant: 120ms;
  --ob-motion-fast: 200ms;
  --ob-motion-standard: 280ms;
  --ob-motion-emphasis: 480ms;
  --ob-loop-compact: 1200ms;
  --ob-loop-scan: 1350ms;
  --ob-loop-research: 1600ms;
  --ob-loop-signature: 1840ms;
  --ob-ease-enter: cubic-bezier(.16,1,.3,1);
  --ob-ease-exit: cubic-bezier(.7,0,.84,0);
  --ob-ease-shift: cubic-bezier(.65,0,.35,1);
  --ob-ease-refine: cubic-bezier(.25,1,.5,1);
}
''',
    )


def lottie_color(hex_color: str) -> list[float]:
    value = hex_color.lstrip("#")
    return [int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)] + [1]


def static(value):
    return {"a": 0, "k": value}


def keyframes(points: list[tuple[int, list[float]]]):
    frames = []
    for index, (time, value) in enumerate(points):
        frame = {"t": time, "s": value}
        if index < len(points) - 1:
            frame.update({"e": points[index + 1][1], "i": {"x": [0.5], "y": [1]}, "o": {"x": [0.5], "y": [0]}})
        frames.append(frame)
    return {"a": 1, "k": frames}


def shape_layer(name: str, shape: dict, ind: int, opacity=None, scale=None, rotation=None, position=None) -> dict:
    transform = {
        "o": opacity or static(100),
        "r": rotation or static(0),
        "p": position or static([0, 0, 0]),
        "a": static([0, 0, 0]),
        "s": scale or static([100, 100, 100]),
    }
    return {
        "ddd": 0,
        "ind": ind,
        "ty": 4,
        "nm": name,
        "sr": 1,
        "ks": transform,
        "ao": 0,
        "shapes": [shape],
        "ip": 0,
        "op": 120,
        "st": 0,
        "bm": 0,
    }


def ellipse_shape(cx: float, cy: float, r: float, color: str, opacity: int = 100) -> dict:
    return {
        "ty": "gr",
        "it": [
            {"ty": "el", "p": static([cx, cy]), "s": static([r * 2, r * 2]), "nm": "Ellipse"},
            {"ty": "fl", "c": static(lottie_color(color)), "o": static(opacity), "r": 1, "nm": "Fill"},
            {"ty": "tr", "p": static([0, 0]), "a": static([0, 0]), "s": static([100, 100]), "r": static(0), "o": static(100), "sk": static(0), "sa": static(0), "nm": "Transform"},
        ],
        "nm": "Dot",
    }


def bar_shape(color: str, opacity: int = 100) -> dict:
    return {
        "ty": "gr",
        "it": [
            {"ty": "rc", "p": static([32, 32]), "s": static([40, 10]), "r": static(5), "nm": "Claim stroke"},
            {"ty": "fl", "c": static(lottie_color(color)), "o": static(opacity), "r": 1, "nm": "Fill"},
            {"ty": "tr", "p": static([0, 0]), "a": static([0, 0]), "s": static([100, 100]), "r": static(0), "o": static(100), "sk": static(0), "sa": static(0), "nm": "Transform"},
        ],
        "nm": "Claim stroke",
    }


def lottie_document(kind: str, title: str, duration: float) -> dict:
    fr = 60
    op = round(duration * fr)
    color = COLORS["blue-600"]
    layers = []
    # faint canonical mark
    layers.extend(
        [
            shape_layer("Base top", ellipse_shape(TOP["cx"], TOP["cy"], TOP["r"], color, 24), 1),
            shape_layer("Base bar", bar_shape(color, 24), 2),
            shape_layer("Base bottom", ellipse_shape(BOTTOM["cx"], BOTTOM["cy"], BOTTOM["r"], color, 24), 3),
        ]
    )
    if kind == "proof-pulse":
        layers.extend(
            [
                shape_layer("Top dot", ellipse_shape(TOP["cx"], TOP["cy"], TOP["r"], color), 4, keyframes([(0,[0]),(12,[100]),(45,[100]),(66,[0]),(72,[0])]), keyframes([(0,[82,82,100]),(12,[100,100,100]),(66,[88,88,100])])),
                shape_layer("Claim stroke", bar_shape(color), 5, keyframes([(7,[0]),(23,[100]),(45,[100]),(66,[0]),(72,[0])]), keyframes([(7,[0,100,100]),(23,[100,100,100])])),
                shape_layer("Lower dot", ellipse_shape(BOTTOM["cx"], BOTTOM["cy"], BOTTOM["r"], color), 6, keyframes([(18,[0]),(33,[100]),(45,[100]),(66,[0]),(72,[0])]), keyframes([(18,[82,82,100]),(33,[100,100,100]),(66,[88,88,100])])),
            ]
        )
    elif kind == "transcript-scan":
        scan = {
            "ty":"gr",
            "it":[
                {"ty":"rc","p":static([0,32]),"s":static([10,56]),"r":static(5),"nm":"Scan band"},
                {"ty":"fl","c":static(lottie_color(COLORS["aqua-500"])),"o":static(38),"r":1,"nm":"Scan fill"},
                {"ty":"tr","p":static([0,0]),"a":static([0,0]),"s":static([100,100]),"r":static(0),"o":static(100),"sk":static(0),"sa":static(0),"nm":"Transform"}
            ],"nm":"Inspection band"
        }
        layers.append(shape_layer("Inspection band", scan, 4, position=keyframes([(0,[-10,0,0]),(8,[-10,0,0]),(62,[84,0,0]),(81,[84,0,0])])))
    elif kind == "source-exchange":
        pair = {
            "ty":"gr","it":[
                ellipse_shape(TOP["cx"],TOP["cy"],TOP["r"],color),
                ellipse_shape(BOTTOM["cx"],BOTTOM["cy"],BOTTOM["r"],color),
                {"ty":"tr","p":static([0,0]),"a":static([32,32]),"s":static([100,100]),"r":keyframes([(0,[0]),(12,[0]),(84,[180]),(96,[180])]),"o":static(100),"sk":static(0),"sa":static(0),"nm":"Rotate pair"}
            ],"nm":"Source pair"
        }
        layers = [shape_layer("Claim stroke", bar_shape(color),1),shape_layer("Source pair",pair,2)]
    elif kind == "obelus-resolve":
        layers.extend(
            [
                shape_layer("Resolve bar",bar_shape(color),4,keyframes([(0,[0]),(8,[0]),(29,[100]),(63,[100]),(83,[0]),(92,[0])]),keyframes([(0,[0,100,100]),(29,[100,100,100]),(83,[0,100,100])])),
                shape_layer("Resolve top",ellipse_shape(TOP["cx"],TOP["cy"],TOP["r"],color),5,keyframes([(0,[0]),(13,[0]),(37,[100]),(63,[100]),(83,[0]),(92,[0])]),keyframes([(13,[72,72,100]),(37,[100,100,100]),(83,[72,72,100])]),position=keyframes([(13,[0,-7,0]),(37,[0,0,0]),(63,[0,0,0]),(83,[0,-7,0])])),
                shape_layer("Resolve bottom",ellipse_shape(BOTTOM["cx"],BOTTOM["cy"],BOTTOM["r"],color),6,keyframes([(0,[0]),(13,[0]),(37,[100]),(63,[100]),(83,[0]),(92,[0])]),keyframes([(13,[72,72,100]),(37,[100,100,100]),(83,[72,72,100])]),position=keyframes([(13,[0,7,0]),(37,[0,0,0]),(63,[0,0,0]),(83,[0,7,0])])),
            ]
        )
    elif kind == "progress-divide":
        layers.extend(
            [
                shape_layer("Progress start",ellipse_shape(TOP["cx"],TOP["cy"],TOP["r"],color),4),
                shape_layer("Progress fill",bar_shape(color),5,scale=keyframes([(0,[0,100,100]),(72,[100,100,100])])),
                shape_layer("Progress complete",ellipse_shape(BOTTOM["cx"],BOTTOM["cy"],BOTTOM["r"],color),6,keyframes([(0,[0]),(72,[0]),(86,[100]),(96,[100])]),keyframes([(72,[78,78,100]),(86,[100,100,100])])),
            ]
        )

    for layer in layers:
        layer["op"] = op
    return {"v":"5.9.6","fr":fr,"ip":0,"op":op,"w":64,"h":64,"nm":title,"ddd":0,"assets":[],"layers":layers,"markers":[]}


def clamp(value: float, low: float = 0, high: float = 1) -> float:
    return max(low, min(high, value))


def segment(t: float, start: float, end: float) -> float:
    return clamp((t - start) / (end - start))


def ease_out_quart(value: float) -> float:
    return 1 - (1 - value) ** 4


def ease_in_out(value: float) -> float:
    return -(math.cos(math.pi * value) - 1) / 2


def color_rgba(hex_color: str, alpha: float = 1) -> tuple[int, int, int, int]:
    value = hex_color.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4)) + (round(255 * alpha),)


def blank(size: int, background: str | None = None) -> Image.Image:
    return Image.new("RGBA", (size, size), color_rgba(background or "#000000", 1 if background else 0))


def draw_dot(image: Image.Image, cx: float, cy: float, radius: float, color: str, alpha: float = 1, dot_scale: float = 1) -> None:
    if alpha <= 0:
        return
    scale = image.width / 64
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    r = radius * dot_scale * scale
    x = cx * scale
    y = cy * scale
    draw.ellipse([x-r,y-r,x+r,y+r],fill=color_rgba(color,alpha))
    image.alpha_composite(layer)


def draw_bar(image: Image.Image, color: str, alpha: float = 1, scale_x: float = 1, clip: tuple[float,float] | None = None) -> None:
    scale = image.width / 64
    layer = Image.new("RGBA", image.size, (0,0,0,0))
    draw = ImageDraw.Draw(layer)
    fill = color_rgba(color,alpha)
    def cubic(start, c1, c2, end, steps=12):
        points=[]
        for index in range(1,steps+1):
            t=index/steps
            mt=1-t
            x=mt**3*start[0]+3*mt**2*t*c1[0]+3*mt*t**2*c2[0]+t**3*end[0]
            y=mt**3*start[1]+3*mt**2*t*c1[1]+3*mt*t**2*c2[1]+t**3*end[1]
            points.append((x,y))
        return points
    points=[(17,27),(45,27)]
    points+=cubic((45,27),(47.4,27),(49.2,28.2),(51.4,30.4))
    points+=cubic((51.4,30.4),(52.3,31.3),(52.3,32.7),(51.4,33.6))
    points+=cubic((51.4,33.6),(49.2,35.8),(47.4,37),(45,37))
    points+=[(17,37)]
    points+=cubic((17,37),(14.2,37),(12,34.8),(12,32))
    points+=cubic((12,32),(12,29.2),(14.2,27),(17,27))
    draw.polygon([(x*scale,y*scale) for x,y in points],fill=fill)
    if scale_x < 1:
        left = round(32*scale-(20*scale*scale_x))
        right = round(32*scale+(20*scale*scale_x))
        mask = Image.new("L", image.size, 0)
        ImageDraw.Draw(mask).rectangle([left,0,right,image.height],fill=255)
        layer.putalpha(Image.composite(layer.getchannel("A"),Image.new("L",image.size,0),mask))
    if clip:
        left,right=clip
        mask=Image.new("L",image.size,0)
        ImageDraw.Draw(mask).rectangle([left*scale,0,right*scale,image.height],fill=255)
        layer.putalpha(Image.composite(layer.getchannel("A"),Image.new("L",image.size,0),mask))
    image.alpha_composite(layer)


def draw_mark(image: Image.Image, color: str, alpha: float = 1, bar_scale: float = 1, clip: tuple[float,float] | None = None) -> None:
    draw_dot(image,TOP["cx"],TOP["cy"],TOP["r"],color,alpha)
    draw_bar(image,color,alpha,bar_scale,clip)
    draw_dot(image,BOTTOM["cx"],BOTTOM["cy"],BOTTOM["r"],color,alpha)


def rotate_point(x: float, y: float, angle_deg: float) -> tuple[float,float]:
    angle=math.radians(angle_deg)
    dx,dy=x-32,y-32
    return 32+dx*math.cos(angle)-dy*math.sin(angle),32+dx*math.sin(angle)+dy*math.cos(angle)


def render_frame(kind: str, t: float, size: int = 512) -> Image.Image:
    super_size=size*2
    image=blank(super_size,COLORS["paper"])
    brand=COLORS["blue-600"]
    if kind == "proof-pulse":
        draw_mark(image,brand,.22)
        fade=1-segment(t,.74,.92)
        top=ease_out_quart(segment(t,0,.2))*fade
        bar=ease_out_quart(segment(t,.12,.38))*fade
        bottom=ease_out_quart(segment(t,.30,.55))*fade
        draw_dot(image,TOP["cx"],TOP["cy"],TOP["r"],brand,top,.82+.18*top)
        draw_bar(image,brand,bar,bar)
        draw_dot(image,BOTTOM["cx"],BOTTOM["cy"],BOTTOM["r"],brand,bottom,.82+.18*bottom)
    elif kind == "transcript-scan":
        draw_mark(image,brand,.30)
        progress=segment(t,.10,.76)
        left=-12+88*progress
        draw_mark(image,brand,1,clip=(left,left+12))
    elif kind == "source-exchange":
        draw_bar(image,brand,1)
        angle=180*ease_in_out(segment(t,.12,.88))
        x1,y1=rotate_point(TOP["cx"],TOP["cy"],angle)
        x2,y2=rotate_point(BOTTOM["cx"],BOTTOM["cy"],angle)
        draw_dot(image,x1,y1,TOP["r"],brand)
        draw_dot(image,x2,y2,BOTTOM["r"],brand)
    elif kind == "obelus-resolve":
        draw_mark(image,brand,.11)
        enter_bar=ease_out_quart(segment(t,.08,.32))
        exit_bar=1-segment(t,.68,.90)
        bar=min(enter_bar,exit_bar)
        enter_dot=ease_out_quart(segment(t,.14,.40))
        exit_dot=1-segment(t,.68,.90)
        dot=min(enter_dot,exit_dot)
        draw_bar(image,brand,bar,bar)
        draw_dot(image,TOP["cx"],TOP["cy"]-7*(1-dot),TOP["r"],brand,dot,.72+.28*dot)
        draw_dot(image,BOTTOM["cx"],BOTTOM["cy"]+7*(1-dot),BOTTOM["r"],brand,dot,.72+.28*dot)
    elif kind == "progress-divide":
        draw_mark(image,brand,.24)
        draw_dot(image,TOP["cx"],TOP["cy"],TOP["r"],brand)
        progress=ease_out_quart(segment(t,.04,.76))
        draw_bar(image,brand,1,progress)
        complete=ease_out_quart(segment(t,.78,.92))
        draw_dot(image,BOTTOM["cx"],BOTTOM["cy"],BOTTOM["r"],brand,complete,.78+.22*complete)
    else:
        raise ValueError(kind)
    return image.resize((size,size),Image.Resampling.LANCZOS).convert("RGB")


def encode_preview(kind: str, duration: float, directory: Path) -> None:
    fps=30
    frames=max(2,round(duration*fps))
    with tempfile.TemporaryDirectory(prefix=f"obelus-{kind}-") as tmp:
        tmp_path=Path(tmp)
        for frame in range(frames):
            t=frame/frames
            render_frame(kind,t,256).save(tmp_path/f"frame_{frame:04d}.png",optimize=True)
        pattern=str(tmp_path/"frame_%04d.png")
        run(["ffmpeg","-y","-loglevel","error","-framerate",str(fps),"-i",pattern,"-vf","format=yuv420p","-c:v","libx264","-crf","20","-movflags","+faststart",str(directory/f"obelus-loader-{kind}.mp4")])
        run(["ffmpeg","-y","-loglevel","error","-framerate",str(fps),"-i",pattern,"-c:v","libvpx-vp9","-crf","32","-b:v","0","-pix_fmt","yuv420p",str(directory/f"obelus-loader-{kind}.webm")])
        run(["ffmpeg","-y","-loglevel","error","-framerate",str(fps),"-i",pattern,"-filter_complex","[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3","-loop","0",str(directory/f"obelus-loader-{kind}.gif")])


def react_component() -> None:
    component = '''import type { CSSProperties, SVGProps } from "react";
import { useId } from "react";
import "../Tokens/obelus-motion.css";
import "./ObelusLoader.css";

export type ObelusLoaderVariant =
  | "proof-pulse"
  | "transcript-scan"
  | "source-exchange"
  | "obelus-resolve"
  | "progress-divide";

type Props = Omit<SVGProps<SVGSVGElement>, "children"> & {
  variant?: ObelusLoaderVariant;
  progress?: number;
  label?: string;
};

const barPath = "M17 27H45C47.4 27 49.2 28.2 51.4 30.4C52.3 31.3 52.3 32.7 51.4 33.6C49.2 35.8 47.4 37 45 37H17C14.2 37 12 34.8 12 32C12 29.2 14.2 27 17 27Z";

export function ObelusLoader({
  variant = "proof-pulse",
  progress = 0,
  label = "Checking…",
  style,
  ...svgProps
}: Props) {
  const scanId = `ob-scan-${useId().replaceAll(":", "")}`;
  const boundedProgress = Math.max(0, Math.min(1, progress));
  const cssStyle = { ...style, "--ob-progress": boundedProgress } as CSSProperties;

  const pieces = (className?: string) => (
    <g className={className} fill="currentColor">
      <circle cx="26" cy="14" r="5.6" />
      <path d={barPath} />
      <circle cx="38" cy="50" r="5.6" />
    </g>
  );

  return (
    <span role="status" aria-live="polite" aria-atomic="true">
      <svg
        {...svgProps}
        aria-hidden="true"
        data-complete={boundedProgress === 1}
        data-variant={variant}
        viewBox="0 0 64 64"
        style={cssStyle}
      >
        {variant === "transcript-scan" && (
          <defs><clipPath id={scanId}><rect className="ob-scan-window" x="-12" y="0" width="12" height="64" rx="6" /></clipPath></defs>
        )}
        {pieces("ob-base")}
        {variant === "source-exchange" ? (
          <g fill="currentColor"><path d={barPath} /><g className="ob-source-pair"><circle cx="26" cy="14" r="5.6" /><circle cx="38" cy="50" r="5.6" /></g></g>
        ) : variant === "transcript-scan" ? (
          <g clipPath={`url(#${scanId})`}>{pieces("ob-animated")}</g>
        ) : (
          <g className={`ob-loader-pieces ob-${variant}`} fill="currentColor"><circle className="ob-top" cx="26" cy="14" r="5.6" /><path className="ob-bar" d={barPath} /><circle className="ob-bottom" cx="38" cy="50" r="5.6" /></g>
        )}
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
'''
    write_text(MOTION / "React/ObelusLoader.tsx", component)
    write_text(MOTION / "React/ObelusLoader.css", '''
[data-variant] { inline-size: 1.5rem; block-size: 1.5rem; color: currentColor; overflow: visible; }
.ob-base { opacity: .24; }
.ob-proof-pulse .ob-top { transform-box: fill-box; transform-origin: center; animation: ob-proof-top var(--ob-loop-compact) infinite; }
.ob-proof-pulse .ob-bar { transform-box: fill-box; transform-origin: center; animation: ob-proof-bar var(--ob-loop-compact) infinite; }
.ob-proof-pulse .ob-bottom { transform-box: fill-box; transform-origin: center; animation: ob-proof-bottom var(--ob-loop-compact) infinite; }
.ob-scan-window { animation: ob-scan var(--ob-loop-scan) linear infinite; }
.ob-source-pair { transform-box: view-box; transform-origin: 32px 32px; animation: ob-source var(--ob-loop-research) var(--ob-ease-shift) infinite; }
.ob-obelus-resolve .ob-bar { transform-box: fill-box; transform-origin: center; animation: ob-resolve-bar var(--ob-loop-signature) infinite; }
.ob-obelus-resolve .ob-top,.ob-obelus-resolve .ob-bottom { transform-box: fill-box; transform-origin: center; }
.ob-obelus-resolve .ob-top { animation: ob-resolve-top var(--ob-loop-signature) infinite; }
.ob-obelus-resolve .ob-bottom { animation: ob-resolve-bottom var(--ob-loop-signature) infinite; }
.ob-progress-divide .ob-bar { transform-box: fill-box; transform-origin: left center; transform: scaleX(var(--ob-progress)); transition: transform 160ms linear; }
.ob-progress-divide .ob-bottom { opacity: 0; transform-box: fill-box; transform-origin: center; transform: scale(.78); transition: opacity 220ms var(--ob-ease-refine), transform 220ms var(--ob-ease-refine); }
[data-complete="true"] .ob-progress-divide .ob-bottom { opacity: 1; transform: scale(1); }
@keyframes ob-proof-top { 0%{opacity:0;transform:scale(.82)}20%,74%{opacity:1;transform:scale(1)}92%,100%{opacity:0;transform:scale(.88)} }
@keyframes ob-proof-bar { 0%,12%{opacity:0;transform:scaleX(0)}38%,74%{opacity:1;transform:scaleX(1)}92%,100%{opacity:0;transform:scaleX(1)} }
@keyframes ob-proof-bottom { 0%,30%{opacity:0;transform:scale(.82)}55%,74%{opacity:1;transform:scale(1)}92%,100%{opacity:0;transform:scale(.88)} }
@keyframes ob-scan { 0%,10%{transform:translateX(0)}76%,100%{transform:translateX(88px)} }
@keyframes ob-source { 0%,12%{transform:rotate(0)}88%,100%{transform:rotate(180deg)} }
@keyframes ob-resolve-bar { 0%,8%{opacity:0;transform:scaleX(0)}32%,68%{opacity:1;transform:scaleX(1)}90%,100%{opacity:0;transform:scaleX(0)} }
@keyframes ob-resolve-top { 0%,14%{opacity:0;transform:translateY(-7px) scale(.72)}40%,68%{opacity:1;transform:translateY(0) scale(1)}90%,100%{opacity:0;transform:translateY(-7px) scale(.72)} }
@keyframes ob-resolve-bottom { 0%,14%{opacity:0;transform:translateY(7px) scale(.72)}40%,68%{opacity:1;transform:translateY(0) scale(1)}90%,100%{opacity:0;transform:translateY(7px) scale(.72)} }
@media (prefers-reduced-motion: reduce) {
  .ob-loader-pieces,.ob-source-pair { animation: none !important; display: none; }
  .ob-base { opacity: 1; }
  .ob-progress-divide { display: block; }
  .ob-progress-divide .ob-bar,.ob-progress-divide .ob-bottom { transition: none; }
}
@media (forced-colors: active) { [data-variant] { color: CanvasText; } .ob-base { opacity: 1; } .ob-loader-pieces { display: none; } }
'''.lstrip())


def all_demo() -> None:
    cards=[]
    for folder,kind,title,_,status in LOADERS:
        cards.append(f'''<article><object data="{folder}/obelus-loader-{kind}.animated.svg" type="image/svg+xml" aria-hidden="true"></object><div><span>{folder[:2]}</span><h2>{title}</h2><p>{status}</p><a href="{folder}/index.html">Open demo</a></div></article>''')
    html=f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Obelus Motion System</title><style>
@font-face{{font-family:Instrument;src:url('../03 Typography/Fonts/Instrument Sans/InstrumentSans-Variable.woff2')}}*{{box-sizing:border-box}}body{{margin:0;background:#111528;color:#FCFCF8;font-family:Instrument,system-ui,sans-serif}}main{{max-width:1180px;margin:auto;padding:72px 24px 96px}}header{{display:grid;grid-template-columns:1.2fr .8fr;gap:40px;align-items:end;margin-bottom:72px}}h1{{font-size:clamp(48px,7vw,88px);line-height:.98;letter-spacing:-.04em;margin:0}}header p{{color:#B5BBCD;font-size:19px;line-height:1.55;margin:0}}section{{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}}article{{min-height:280px;padding:28px;background:#181D34;border:1px solid #38415F;border-radius:20px;display:flex;flex-direction:column;justify-content:space-between}}object{{width:96px;height:96px;filter:brightness(0) saturate(100%) invert(79%) sepia(31%) saturate(617%) hue-rotate(125deg)}}article span{{color:#8794F2;font-family:monospace;font-size:12px}}h2{{font-size:28px;margin:10px 0 6px}}article p{{color:#B5BBCD;margin:0 0 18px}}a{{color:#8BE2D9;text-decoration:none}}@media(max-width:700px){{header{{grid-template-columns:1fr}}}}@media(prefers-reduced-motion:reduce){{object{{display:none}}}}
</style></head><body><main><header><h1>Motion that looks closer.</h1><p>Five loading behaviors built from the Dialogue Axis. Every loop is calm, interruptible, accessible, and tied to a specific kind of work.</p></header><section>{''.join(cards)}</section></main></body></html>'''
    write_text(MOTION/"index.html",html)


def motion_overview() -> None:
    width,height=1800,760
    canvas=Image.new("RGB",(width,height),color_rgba(COLORS["ink-950"])[0:3])
    draw=ImageDraw.Draw(canvas)
    title_font=ImageFont.truetype(FONT,64)
    label_font=ImageFont.truetype(FONT,28)
    small_font=ImageFont.truetype(FONT,18)
    draw.text((72,56),"Five ways to look closer.",font=title_font,fill=color_rgba(COLORS["cloud"])[0:3])
    draw.text((76,140),"A complete loading system for live verification.",font=small_font,fill=color_rgba(COLORS["ink-300"])[0:3])
    for idx,(_,kind,title,_,status) in enumerate(LOADERS):
        x=50+idx*350
        y=220
        draw.rounded_rectangle([x,y,x+320,y+460],radius=28,fill=color_rgba(COLORS["ink-900"])[0:3],outline=color_rgba(COLORS["ink-700"])[0:3],width=2)
        frame=render_frame(kind,.55,220)
        canvas.paste(frame,(x+50,y+30))
        draw.text((x+28,y+282),f"0{idx+1}",font=small_font,fill=color_rgba(COLORS["blue-400"])[0:3])
        draw.text((x+28,y+320),title,font=label_font,fill=color_rgba(COLORS["cloud"])[0:3])
        draw.text((x+28,y+370),status,font=small_font,fill=color_rgba(COLORS["ink-300"])[0:3])
    PREVIEWS.mkdir(parents=True,exist_ok=True)
    canvas.save(PREVIEWS/"Obelus_Motion_Overview.png",optimize=True)


def main() -> None:
    motion_tokens()
    react_component()
    all_demo()
    for folder,kind,title,duration,status in LOADERS:
        directory=MOTION/folder
        directory.mkdir(parents=True,exist_ok=True)
        write_text(directory/f"obelus-loader-{kind}.animated.svg",animated_svg(kind,title))
        poster_path=directory/f"obelus-loader-{kind}.poster.svg"
        write_text(poster_path,static_svg(title))
        run(["rsvg-convert","-w","512","-o",str(directory/f"obelus-loader-{kind}.poster.png"),str(poster_path)])
        write_text(directory/f"obelus-loader-{kind}.css",css_snippet(kind))
        write_text(directory/f"obelus-loader-{kind}.lottie.json",json.dumps(lottie_document(kind,title,duration),separators=(",",":"))+"\n")
        write_text(directory/"USAGE.md",usage_note(kind,title,status))
        write_text(directory/"index.html",html_demo(kind,title,status))
        encode_preview(kind,duration,directory)
    motion_overview()
    print("Generated five Obelus motion systems.")


if __name__ == "__main__":
    main()
