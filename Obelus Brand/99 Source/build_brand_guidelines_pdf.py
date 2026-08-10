#!/usr/bin/env python3
"""Build the screen-first Obelus brand book and two-page quick reference."""

from __future__ import annotations

import json
import math
from pathlib import Path

from reportlab.lib.colors import Color, HexColor
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parent
SPEC = json.loads((SOURCE / "brand_spec.json").read_text())
OUT = ROOT / "08 Brand Guidelines"
TMP = Path("tmp/pdfs")

W, H = 960, 540
M = 56

COLORS = SPEC["colors"]
INK = HexColor(COLORS["ink-950"])
INK_900 = HexColor(COLORS["ink-900"])
INK_800 = HexColor(COLORS["ink-800"])
INK_700 = HexColor(COLORS["ink-700"])
INK_600 = HexColor(COLORS["ink-600"])
INK_500 = HexColor(COLORS["ink-500"])
INK_300 = HexColor(COLORS["ink-300"])
INK_200 = HexColor(COLORS["ink-200"])
PAPER = HexColor(COLORS["paper"])
CLOUD = HexColor(COLORS["cloud"])
BLUE = HexColor(COLORS["blue-600"])
BLUE_400 = HexColor(COLORS["blue-400"])
BLUE_200 = HexColor(COLORS["blue-200"])
BLUE_100 = HexColor(COLORS["blue-100"])
AQUA = HexColor(COLORS["aqua-500"])
AQUA_300 = HexColor(COLORS["aqua-300"])
CORAL = HexColor(COLORS["coral-500"])
SUPPORTED = HexColor(COLORS["supported"])
SUPPORTED_BG = HexColor(COLORS["supported-bg"])
DISPUTED = HexColor(COLORS["disputed"])
DISPUTED_BG = HexColor(COLORS["disputed-bg"])
CONTEXT = HexColor(COLORS["context"])
CONTEXT_BG = HexColor(COLORS["context-bg"])
UNVERIFIED = HexColor(COLORS["unverified"])
UNVERIFIED_BG = HexColor(COLORS["unverified-bg"])

LOGO_PNG = ROOT / "02 Logos/PNG/Symbol/Obelus_Symbol_Evidence_Blue_1024px.png"
LOGO_CLOUD_PNG = ROOT / "02 Logos/PNG/Symbol/Obelus_Symbol_Cloud_1024px.png"
LOCKUP_PRIMARY = ROOT / "02 Logos/PNG/Horizontal Lockup/Obelus_Lockup_Horizontal_Primary_960px.png"
LOCKUP_REVERSE = ROOT / "02 Logos/PNG/Horizontal Lockup/Obelus_Lockup_Horizontal_Reverse_960px.png"
STACKED_PRIMARY = ROOT / "02 Logos/PNG/Stacked Lockup/Obelus_Lockup_Stacked_Primary_960px.png"


def register_fonts() -> None:
    base = ROOT / "03 Typography/Fonts/Instrument Sans/Static"
    pdfmetrics.registerFont(TTFont("Instrument", base / "InstrumentSans-Regular.ttf"))
    pdfmetrics.registerFont(TTFont("InstrumentMedium", base / "InstrumentSans-Medium.ttf"))
    pdfmetrics.registerFont(TTFont("InstrumentSemi", base / "InstrumentSans-SemiBold.ttf"))
    pdfmetrics.registerFont(TTFont("InstrumentBold", base / "InstrumentSans-Bold.ttf"))
    pdfmetrics.registerFont(TTFont("InstrumentItalic", base / "InstrumentSans-Italic.ttf"))
    pdfmetrics.registerFont(TTFont("PlexMono", ROOT / "03 Typography/Fonts/IBM Plex Mono/IBMPlexMono-Regular.ttf"))
    pdfmetrics.registerFont(TTFont("PlexMonoMedium", ROOT / "03 Typography/Fonts/IBM Plex Mono/IBMPlexMono-Medium.ttf"))


def fill_page(c: canvas.Canvas, color: Color) -> None:
    c.setFillColor(color)
    c.rect(0, 0, W, H, stroke=0, fill=1)


def start_page(c: canvas.Canvas, number: int, section: str, dark: bool = False, color: Color | None = None) -> None:
    background = color or (INK if dark else PAPER)
    fill_page(c, background)
    text = CLOUD if dark or color == BLUE else INK
    secondary = INK_300 if dark else INK_500
    if color == BLUE:
        secondary = BLUE_200
    c.setFont("PlexMono", 8)
    c.setFillColor(secondary)
    c.drawString(M, H - 30, f"OBELUS  /  {section.upper()}")
    c.drawRightString(W - M, 24, f"{number:02d}")
    c.setStrokeColor(INK_700 if dark else INK_200)
    if color == BLUE:
        c.setStrokeColor(Color(1, 1, 1, alpha=0.24))
    c.line(M, 38, W - M, 38)
    c.setFillColor(text)


def finish_page(c: canvas.Canvas) -> None:
    c.showPage()


def title(c: canvas.Canvas, text: str, y: float = 454, size: float = 42, color: Color = INK, max_width: float = 820) -> float:
    return paragraph(c, text, M, y, max_width, "InstrumentSemi", size, size * 1.03, color)


def kicker(c: canvas.Canvas, text: str, x: float, y: float, color: Color = BLUE) -> None:
    c.setFillColor(color)
    c.setFont("PlexMonoMedium", 9)
    c.drawString(x, y, text.upper())


def paragraph(
    c: canvas.Canvas,
    text: str,
    x: float,
    y_top: float,
    width: float,
    font: str = "Instrument",
    size: float = 13,
    leading: float = 19,
    color: Color = INK_600,
    align: int = TA_LEFT,
) -> float:
    style = ParagraphStyle(
        "p",
        fontName=font,
        fontSize=size,
        leading=leading,
        textColor=color,
        alignment=align,
        spaceAfter=0,
    )
    p = Paragraph(text, style)
    _, height = p.wrap(width, H)
    p.drawOn(c, x, y_top - height)
    return height


def bullet_list(c: canvas.Canvas, items: list[str], x: float, y: float, width: float, color: Color = INK_600, size: float = 12.5, gap: float = 8) -> float:
    cursor = y
    for item in items:
        h = paragraph(c, f"<bullet color='#{BLUE.hexval()[2:]}'>•</bullet>{item}", x, cursor, width, "Instrument", size, size * 1.45, color)
        cursor -= h + gap
    return cursor


def image_fit(c: canvas.Canvas, path: Path, x: float, y: float, width: float, height: float, contain: bool = True) -> None:
    reader = ImageReader(str(path))
    iw, ih = reader.getSize()
    scale = min(width / iw, height / ih) if contain else max(width / iw, height / ih)
    dw, dh = iw * scale, ih * scale
    c.drawImage(reader, x + (width - dw) / 2, y + (height - dh) / 2, dw, dh, preserveAspectRatio=True, mask="auto")


def round_box(c: canvas.Canvas, x: float, y: float, width: float, height: float, fill: Color, stroke: Color | None = None, radius: float = 12) -> None:
    c.setFillColor(fill)
    c.setStrokeColor(stroke or fill)
    c.roundRect(x, y, width, height, radius, stroke=1 if stroke else 0, fill=1)


def draw_symbol(c: canvas.Canvas, x: float, y: float, scale: float, color: Color) -> None:
    c.saveState()
    c.translate(x, y)
    c.scale(scale, scale)
    c.setFillColor(color)
    c.circle(26, 50, 5.6, stroke=0, fill=1)
    c.circle(38, 14, 5.6, stroke=0, fill=1)
    p = c.beginPath()
    p.moveTo(17, 37)
    p.lineTo(45, 37)
    p.curveTo(47.4, 37, 49.2, 35.8, 51.4, 33.6)
    p.curveTo(52.3, 32.7, 52.3, 31.3, 51.4, 30.4)
    p.curveTo(49.2, 28.2, 47.4, 27, 45, 27)
    p.lineTo(17, 27)
    p.curveTo(14.2, 27, 12, 29.2, 12, 32)
    p.curveTo(12, 34.8, 14.2, 37, 17, 37)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    c.restoreState()


def swatch(c: canvas.Canvas, x: float, y: float, width: float, height: float, color: Color, name: str, hex_value: str, light: bool = False) -> None:
    round_box(c, x, y, width, height, color, radius=12)
    c.setFillColor(CLOUD if light else INK)
    c.setFont("InstrumentSemi", 12)
    c.drawString(x + 14, y + 34, name)
    c.setFont("PlexMono", 9)
    c.drawString(x + 14, y + 17, hex_value)


def badge(c: canvas.Canvas, x: float, y: float, label: str, foreground: Color, background: Color, width: float) -> None:
    round_box(c, x, y, width, 26, background, radius=13)
    c.setFillColor(foreground)
    c.setFont("InstrumentSemi", 10)
    c.drawCentredString(x + width / 2, y + 8, label)


def build_brand_book(path: Path) -> None:
    c = canvas.Canvas(str(path), pagesize=(W, H), pageCompression=1)
    c.setTitle("Obelus Brand Guidelines v1.0")
    c.setAuthor("Obelus")

    # 01 Cover
    fill_page(c, INK)
    image_fit(c, LOCKUP_REVERSE, M, H - 95, 180, 42)
    kicker(c, "Brand guidelines / version 1.0", M, 418, AQUA_300)
    paragraph(c, "Evidence at<br/>conversation speed.", M, 374, 620, "InstrumentSemi", 64, 61, CLOUD)
    paragraph(c, "A complete identity for a calm, transparent live-verification layer.", M, 178, 520, "Instrument", 17, 24, INK_300)
    c.setFont("PlexMono", 9); c.setFillColor(INK_300); c.drawString(M, 70, "AUGUST 2026  /  PRODUCT + LANDING  /  V1.0")
    c.setFillColor(BLUE); c.circle(828, 444, 128, stroke=0, fill=1)
    draw_symbol(c, 690, 128, 3.1, Color(1, 1, 1, alpha=0.12))
    c.setFillColor(CORAL); c.circle(818, 118, 35, stroke=0, fill=1)
    finish_page(c)

    # 02 At a glance
    start_page(c, 2, "Foundation")
    title(c, "The brand at a glance.")
    rows = [
        ("CATEGORY", "Live verification"),
        ("ESSENCE", "Constructive skepticism"),
        ("ROLE", "The calm layer between a claim and a decision"),
        ("PROMISE", "Sourced context while the moment still matters"),
        ("TAGLINE", "Evidence at conversation speed."),
        ("PURPOSE", "Make scrutiny a natural part of conversation."),
    ]
    y = 365
    for idx, (label, value) in enumerate(rows):
        if idx:
            c.setStrokeColor(INK_200); c.line(M, y + 14, W - M, y + 14)
        c.setFillColor(INK_500); c.setFont("PlexMono", 9); c.drawString(M, y - 5, label)
        c.setFillColor(INK); c.setFont("InstrumentSemi", 16); c.drawString(240, y - 7, value)
        y -= 53
    finish_page(c)

    # 03 Mission and tension
    start_page(c, 3, "Foundation", dark=True)
    kicker(c, "Mission", M, 456, AQUA_300)
    paragraph(c, "Make scrutiny a natural, constructive part of conversation.", M, 430, 680, "InstrumentSemi", 42, 44, CLOUD)
    c.setStrokeColor(INK_700); c.line(M, 250, W - M, 250)
    kicker(c, "The balances to protect", M, 216, BLUE_400)
    balances = [("PRECISION", "HUMANITY"), ("SKEPTICISM", "CURIOSITY"), ("SPEED", "RESTRAINT"), ("AUTHORITY", "HUMILITY"), ("MINIMALISM", "PERSONALITY")]
    x = M
    for left, right in balances:
        c.setFillColor(CLOUD); c.setFont("PlexMono", 8); c.drawString(x, 164, left)
        c.setFillColor(AQUA); c.circle(x + 38, 135, 5, stroke=0, fill=1)
        c.setStrokeColor(BLUE_400); c.setLineWidth(7); c.setLineCap(1); c.line(x + 56, 135, x + 110, 135)
        c.setFillColor(CORAL); c.circle(x + 128, 135, 5, stroke=0, fill=1)
        c.setFillColor(INK_300); c.setFont("PlexMono", 8); c.drawString(x, 105, right)
        x += 168
    finish_page(c)

    # 04 Positioning
    start_page(c, 4, "Positioning")
    kicker(c, "Positioning statement", M, 456)
    paragraph(c, "For people who conduct consequential conversations, Obelus is the live verification layer that turns spoken claims into sourced context while the conversation is still happening.", M, 420, 770, "InstrumentSemi", 31, 36, INK)
    round_box(c, M, 92, 848, 126, CLOUD, INK_200, 14)
    kicker(c, "Unlike", M + 24, 185, CORAL)
    paragraph(c, "Transcripts, search tabs, and post-call checks", M + 24, 164, 340, "InstrumentMedium", 15, 20, INK)
    kicker(c, "Obelus keeps", 520, 185, BLUE)
    paragraph(c, "Evidence inside the conversation, fast enough to use now and transparent enough to trust later", 520, 164, 350, "InstrumentMedium", 15, 20, INK)
    finish_page(c)

    # 05 Audiences
    start_page(c, 5, "Audiences")
    title(c, "Start where the next question matters.")
    audiences = [
        ("01", "Journalists, interviewers, hosts", "Ask the next question while it still matters."),
        ("02", "Researchers, analysts, diligence teams", "Turn every conversation into a sourced research session."),
        ("03", "Decision-makers", "Do not let an unchecked claim become a decision."),
        ("04", "Accuracy-accountable institutions", "Make the record easier to trust."),
        ("05", "Curious individuals", "Do not just hear it. Check it."),
    ]
    y = 365
    for index, name, message in audiences:
        c.setStrokeColor(INK_200); c.line(M, y + 18, W - M, y + 18)
        c.setFillColor(BLUE); c.setFont("PlexMonoMedium", 9); c.drawString(M, y - 5, index)
        c.setFillColor(INK); c.setFont("InstrumentSemi", 15); c.drawString(120, y - 8, name)
        c.setFillColor(INK_600); c.setFont("Instrument", 13); c.drawString(505, y - 8, message)
        y -= 58
    finish_page(c)

    # 06 Pillars
    start_page(c, 6, "Strategy")
    title(c, "Five pillars. One visible process.")
    pillars = [
        ("01", "Evidence over verdicts", "Sources stay prominent. Black-box scores do not."),
        ("02", "Fast, never reckless", "Early findings remain visibly provisional."),
        ("03", "Question claims, not people", "Examine statements without assigning motive."),
        ("04", "Make complexity legible", "Finding first. Qualification second. Trail third."),
        ("05", "Trust made visible", "Consent, provenance, freshness, and corrections in view."),
    ]
    positions = [(M, 258), (343, 258), (630, 258), (196, 84), (490, 84)]
    for (num, heading, copy), (x, y) in zip(pillars, positions):
        round_box(c, x, y, 260, 136, CLOUD, INK_200, 12)
        c.setFillColor(BLUE); c.rect(x, y + 129, 260, 7, stroke=0, fill=1)
        c.setFont("PlexMono", 8); c.drawString(x + 16, y + 106, num)
        paragraph(c, heading, x + 16, y + 90, 225, "InstrumentSemi", 16, 18, INK)
        paragraph(c, copy, x + 16, y + 50, 225, "Instrument", 10.5, 14, INK_600)
    finish_page(c)

    # 07 History
    start_page(c, 7, "The name")
    title(c, "An ancient reason to look closer.")
    c.setStrokeColor(BLUE); c.setLineWidth(3); c.line(90, 112, 90, 360)
    c.setFillColor(BLUE); c.circle(90, 360, 9, stroke=0, fill=1); c.circle(90, 112, 9, stroke=0, fill=1)
    paragraph(c, "Long before the obelus became a division sign, ancient editors used a horizontal mark in the margin to flag a line as doubtful or possibly spurious.", 128, 354, 660, "InstrumentSemi", 26, 32, INK)
    paragraph(c, "The familiar dotted division symbol is a later form associated with the same name. Obelus brings the act of examination into live conversation.", 128, 200, 620, "Instrument", 14, 21, INK_600)
    kicker(c, "Accuracy note", 760, 354, CORAL)
    paragraph(c, "Say doubtful, disputed, or requiring scrutiny. Do not say the ancient Greeks used the modern division symbol to mark false text.", 760, 330, 150, "Instrument", 10, 14, INK_600)
    finish_page(c)

    # 08 Story language
    start_page(c, 8, "The name", dark=True)
    kicker(c, "Recommended short story", M, 454, AQUA_300)
    paragraph(c, "Obelus takes its name from an ancient editorial mark: a short horizontal stroke placed beside text whose authenticity was in question.", M, 418, 730, "InstrumentSemi", 34, 38, CLOUD)
    paragraph(c, "The familiar division symbol is a later form associated with the same name. For us, it means one simple thing: look closer.", M, 232, 610, "Instrument", 17, 24, INK_300)
    draw_symbol(c, 740, 110, 2.9, BLUE_400)
    c.setFillColor(CORAL); c.circle(839, 103, 23, stroke=0, fill=1)
    paragraph(c, "Not a verdict. A reason to look closer.", M, 104, 620, "InstrumentSemi", 20, 24, AQUA_300)
    finish_page(c)

    # 09 Messaging hierarchy
    start_page(c, 9, "Messaging")
    title(c, "The message builds in layers.")
    rows = [
        ("01", "CATEGORY", "Live verification for spoken conversations"),
        ("02", "PROPOSITION", "Evidence at conversation speed."),
        ("03", "EXPLANATION", "Obelus follows the live transcript, identifies checkable claims, and surfaces reliable sources while the conversation is happening."),
        ("04", "TRUST PROOF", "Every finding shows its sources, date, status, and uncertainty."),
        ("05", "ACTION", "See Obelus live"),
    ]
    y = 358
    heights = [50, 55, 78, 58, 50]
    for (num, label, copy), row_h in zip(rows, heights):
        c.setStrokeColor(INK_200); c.line(M, y + 15, W - M, y + 15)
        c.setFillColor(BLUE); c.setFont("PlexMono", 8); c.drawString(M, y - 3, num)
        c.setFillColor(INK_500); c.drawString(110, y - 3, label)
        paragraph(c, copy, 280, y + 5, 610, "InstrumentSemi" if num in ("02", "05") else "Instrument", 14 if num != "02" else 20, 19 if num != "02" else 23, INK)
        y -= row_h
    finish_page(c)

    # 10 Tagline system
    start_page(c, 10, "Messaging", color=BLUE)
    kicker(c, "Master tagline", M, 454, AQUA_300)
    paragraph(c, "Evidence at<br/>conversation speed.", M, 418, 650, "InstrumentSemi", 54, 52, CLOUD)
    variants = [("EXPRESSIVE", "See what stands up."), ("PURPOSE", "Keep the conversation honest."), ("PHILOSOPHY", "Every claim deserves context."), ("CATEGORY", "Live verification for spoken conversations.")]
    x = M
    for label, line in variants:
        c.setFillColor(Color(1, 1, 1, alpha=0.12)); c.roundRect(x, 82, 196, 96, 12, stroke=0, fill=1)
        c.setFillColor(AQUA_300); c.setFont("PlexMono", 7.5); c.drawString(x + 14, 152, label)
        paragraph(c, line, x + 14, 136, 168, "InstrumentSemi", 13, 16, CLOUD)
        x += 210
    finish_page(c)

    # 11 Voice principles
    start_page(c, 11, "Voice", dark=True)
    title(c, "Clear. Calibrated. Curious.", color=CLOUD)
    principles = [
        ("01", "Plainspoken intelligence", "Informed without sounding professorial."),
        ("02", "Calibrated certainty", "Say what is known and what remains uncertain."),
        ("03", "Constructive curiosity", "Invite a closer look without accusation."),
        ("04", "Conversation-speed clarity", "Lead with the finding, then reveal depth."),
        ("05", "Warm composure", "Personality without snark or alarm."),
    ]
    y = 358
    for num, heading, copy in principles:
        c.setStrokeColor(INK_700); c.line(M, y + 15, W - M, y + 15)
        c.setFillColor(AQUA_300); c.setFont("PlexMono", 8); c.drawString(M, y - 4, num)
        c.setFillColor(CLOUD); c.setFont("InstrumentSemi", 15); c.drawString(120, y - 8, heading)
        c.setFillColor(INK_300); c.setFont("Instrument", 12); c.drawString(470, y - 7, copy)
        y -= 56
    finish_page(c)

    # 12 Vocabulary
    start_page(c, 12, "Voice")
    title(c, "Name the state, not the person.")
    badge(c, M, 346, "Supported", SUPPORTED, SUPPORTED_BG, 100)
    badge(c, 175, 346, "Disputed", DISPUTED, DISPUTED_BG, 95)
    badge(c, 290, 346, "Needs context", CONTEXT, CONTEXT_BG, 120)
    badge(c, 430, 346, "Unverified", UNVERIFIED, UNVERIFIED_BG, 100)
    badge(c, 550, 346, "Sources conflict", CONTEXT, CONTEXT_BG, 125)
    badge(c, 695, 346, "Outdated", CONTEXT, CONTEXT_BG, 90)
    c.setStrokeColor(INK_200); c.line(M, 306, W - M, 306)
    kicker(c, "Avoid", M, 270, DISPUTED)
    paragraph(c, "Lie · Liar · Obviously false · Debunked · Truth score · Fact-check complete · No evidence", M, 246, 820, "InstrumentSemi", 18, 25, DISPUTED)
    kicker(c, "Rewrite", M, 172, BLUE)
    paragraph(c, "Instead of “False. The speaker is wrong,” write: “This claim conflicts with the latest published data.”", M, 148, 780, "Instrument", 15, 22, INK)
    finish_page(c)

    # 13 Logo reveal
    start_page(c, 13, "Logo")
    title(c, "The Dialogue Axis.")
    image_fit(c, LOCKUP_PRIMARY, 145, 135, 670, 205)
    paragraph(c, "Recognizable as an obelus. Distinct through offset dialogue geometry, a soft editorial stroke, the title-case wordmark, color, and motion.", 250, 118, 470, "Instrument", 12, 17, INK_600)
    finish_page(c)

    # 14 Anatomy
    start_page(c, 14, "Logo anatomy")
    title(c, "A claim placed under examination.")
    draw_symbol(c, 235, 150, 4.5, BLUE)
    c.setStrokeColor(INK_300); c.setLineWidth(1)
    c.line(345, 375, 520, 410); c.line(405, 292, 640, 292); c.line(405, 214, 540, 160)
    kicker(c, "Two voices / two checks", 535, 418, BLUE)
    paragraph(c, "Offset dots create a sense of exchange and independent scrutiny.", 535, 398, 300, "Instrument", 12, 17, INK_600)
    kicker(c, "The claim line", 655, 300, BLUE)
    paragraph(c, "The statement being examined, not a person being judged.", 655, 280, 230, "Instrument", 12, 17, INK_600)
    kicker(c, "Editorial direction", 555, 168, BLUE)
    paragraph(c, "A soft terminal suggests inquiry moving toward context.", 555, 148, 280, "Instrument", 12, 17, INK_600)
    finish_page(c)

    # 15 Lockups
    start_page(c, 15, "Logo suite")
    title(c, "One family. Four everyday configurations.")
    boxes = [(M, 232, 520, 140, CLOUD, LOCKUP_PRIMARY), (596, 232, 308, 140, CLOUD, STACKED_PRIMARY), (M, 72, 520, 140, INK, LOCKUP_REVERSE), (596, 72, 308, 140, INK, LOGO_CLOUD_PNG)]
    for x, y, width, height, fill, asset in boxes:
        round_box(c, x, y, width, height, fill, INK_200 if fill == CLOUD else None, 12)
        image_fit(c, asset, x + 20, y + 20, width - 40, height - 40)
    finish_page(c)

    # 16 Clearspace/minimum
    start_page(c, 16, "Logo use")
    title(c, "Give the mark room to be read.")
    round_box(c, M, 120, 430, 260, BLUE_100, BLUE_400, 14)
    c.setDash(5, 4); c.setStrokeColor(BLUE_400); c.rect(112, 166, 312, 168, stroke=1, fill=0); c.setDash()
    draw_symbol(c, 188, 160, 3.1, BLUE)
    kicker(c, "Minimum clearspace: 1.5 dot diameters", 74, 350, BLUE)
    kicker(c, "Minimum sizes", 540, 360, BLUE)
    sizes = [(16, 0.25, "16 px / micro"), (24, 0.375, "24 px"), (48, 0.75, "48 px"), (96, 1.5, "96 px")]
    x = 540
    for px, scale, label in sizes:
        draw_symbol(c, x, 220, scale, BLUE)
        c.setFillColor(INK_500); c.setFont("PlexMono", 7); c.drawCentredString(x + 32 * scale, 195, label)
        x += 88
    paragraph(c, "Use the fully rounded micro bar below 20 px. The horizontal lockup should not appear below 96 px digital or 25 mm print.", 540, 160, 330, "Instrument", 12, 18, INK_600)
    finish_page(c)

    # 17 Logo color and backgrounds
    start_page(c, 17, "Logo color")
    title(c, "Flat color. Controlled contrast.")
    blocks = [(M, 226, 260, 150, PAPER, LOGO_PNG, "Evidence Blue on Paper"), (350, 226, 260, 150, CLOUD, LOGO_PNG, "Evidence Blue on Cloud"), (634, 226, 270, 150, INK, LOGO_CLOUD_PNG, "Cloud on Ink"), (M, 62, 260, 140, BLUE, LOGO_CLOUD_PNG, "Cloud on Blue"), (350, 62, 260, 140, INK_900, ROOT / "02 Logos/PNG/Symbol/Obelus_Symbol_Live_Aqua_512px.png", "Live Aqua on Ink"), (634, 62, 270, 140, CLOUD, ROOT / "02 Logos/PNG/Symbol/Obelus_Symbol_Ink_512px.png", "Ink monochrome")]
    for x, y, width, height, bg, asset, label in blocks:
        round_box(c, x, y, width, height, bg, INK_200 if bg in (PAPER, CLOUD) else None, 10)
        image_fit(c, asset, x + width / 2 - 42, y + 36, 84, 84)
        c.setFillColor(CLOUD if bg in (INK, INK_900, BLUE) else INK_600); c.setFont("InstrumentMedium", 9); c.drawCentredString(x + width / 2, y + 16, label)
    finish_page(c)

    # 18 Misuse
    start_page(c, 18, "Logo misuse")
    title(c, "Do not dilute the mark.")
    labels = ["Rotate", "Stretch", "Add effects", "Type a division glyph", "Use verdict color", "Add a container"]
    positions = [(M, 238), (348, 238), (640, 238), (M, 74), (348, 74), (640, 74)]
    for idx, ((x, y), label) in enumerate(zip(positions, labels)):
        round_box(c, x, y, 264, 142, CLOUD, INK_200, 10)
        c.setFillColor(DISPUTED); c.setFont("InstrumentBold", 17); c.drawRightString(x + 246, y + 116, "×")
        c.saveState()
        if idx == 0: c.translate(x + 100, y + 26); c.rotate(18); draw_symbol(c, 0, 0, 1.25, BLUE)
        elif idx == 1: c.translate(x + 72, y + 38); c.scale(1.8, .8); draw_symbol(c, 0, 0, 1.15, BLUE)
        elif idx == 2:
            c.setFillColor(CORAL); c.circle(x + 130, y + 74, 48, stroke=0, fill=1); draw_symbol(c, x + 92, y + 34, 1.2, BLUE)
        elif idx == 3:
            c.setFillColor(INK); c.setFont("InstrumentSemi", 70); c.drawCentredString(x + 132, y + 46, "÷")
        elif idx == 4: draw_symbol(c, x + 92, y + 34, 1.2, DISPUTED)
        else:
            c.setStrokeColor(BLUE); c.setLineWidth(3); c.circle(x + 132, y + 76, 48, stroke=1, fill=0); draw_symbol(c, x + 94, y + 37, 1.15, BLUE)
        c.restoreState()
        c.setFillColor(INK_600); c.setFont("InstrumentMedium", 10); c.drawString(x + 16, y + 14, label)
    finish_page(c)

    # 19 Palette
    start_page(c, 19, "Color")
    title(c, "Evidence Cobalt, with a human pulse.")
    swatches = [("Obelus Ink", "#111528", INK, True), ("Paper", "#F7F8FC", PAPER, False), ("Cloud", "#FCFCF8", CLOUD, False), ("Evidence Blue", "#3B50E0", BLUE, True), ("Live Aqua", "#2BC7B9", AQUA, False), ("Voice Coral", "#FF7568", CORAL, False), ("Supported", "#08705B", SUPPORTED, True), ("Needs context", "#8A4B00", CONTEXT, True), ("Disputed", "#B12D47", DISPUTED, True), ("Unverified", "#2F3FB5", UNVERIFIED, True)]
    for idx, (name, value, color, light) in enumerate(swatches):
        row, col = divmod(idx, 5)
        swatch(c, M + col * 170, 224 - row * 142, 154, 124, color, name, value, light)
    finish_page(c)

    # 20 Semantic states
    start_page(c, 20, "Color semantics")
    title(c, "Color supports meaning. It never carries it alone.", size=34, max_width=850)
    states = [("Supported", SUPPORTED, SUPPORTED_BG, "Published evidence aligns with the claim."), ("Disputed", DISPUTED, DISPUTED_BG, "Reliable evidence conflicts with the claim."), ("Needs context", CONTEXT, CONTEXT_BG, "A qualification changes how the claim should be understood."), ("Unverified", UNVERIFIED, UNVERIFIED_BG, "No reliable result has been established yet.")]
    y = 312
    for label, fg, bg, copy in states:
        round_box(c, M, y, 848, 64, bg, radius=10)
        badge(c, M + 18, y + 19, label, fg, Color(1, 1, 1, alpha=0.0), 110)
        c.setFillColor(fg); c.setFont("InstrumentMedium", 13); c.drawString(240, y + 24, copy)
        y -= 76
    paragraph(c, "Every state appears with a written label, a distinct icon, and an evidence trail or next step. Never convert a loading state into red or green.", M, 62, 760, "Instrument", 12, 17, INK_600)
    finish_page(c)

    # 21 Contrast
    start_page(c, 21, "Accessibility")
    title(c, "Contrast is engineered, not assumed.")
    contrast_pairs = [("Cloud / Blue", "5.99:1", BLUE, CLOUD), ("Ink / Aqua", "8.58:1", AQUA, INK), ("Cloud / Ink", "17.58:1", INK, CLOUD), ("Ink 700 / Paper", "9.47:1", PAPER, INK_700)]
    x = M
    for name, ratio, bg, fg in contrast_pairs:
        round_box(c, x, 210, 196, 170, bg, radius=12)
        c.setFillColor(fg); c.setFont("InstrumentBold", 30); c.drawString(x + 18, 322, "Aa")
        c.setFont("InstrumentSemi", 13); c.drawString(x + 18, 254, name)
        c.setFont("PlexMono", 10); c.drawString(x + 18, 229, ratio)
        x += 214
    bullet_list(c, ["Body text targets WCAG AA at 4.5:1 or better.", "UI boundaries and icons target at least 3:1.", "Status is always icon + label + color.", "Dark mode uses lighter surfaces for depth, not heavy shadows."], M, 168, 760, INK_600, 11.5, 5)
    finish_page(c)

    # 22 Typography
    start_page(c, 22, "Typography")
    title(c, "Precise, with a small pulse of playfulness.")
    image_fit(c, ROOT / "03 Typography/Specimens/Obelus_Typography_Specimen.png", M, 74, 848, 326)
    finish_page(c)

    # 23 Type scale
    start_page(c, 23, "Typography")
    title(c, "One family carries the hierarchy.")
    samples = [("DISPLAY XL", "See what stands up.", 36, "64-88 / .98 / 620"), ("SECTION", "Every claim deserves context.", 25, "28-36 / 1.10 / 600"), ("PRODUCT HEADING", "Finding summary", 18, "20-24 / 1.20 / 600"), ("BODY", "Lead with the finding, then reveal the evidence trail.", 14, "16-18 / 1.55 / 420"), ("METADATA", "18:42:21 / 6 SOURCES", 12, "12-13 / 1.45 / 500")]
    y = 362
    for idx, (role, sample, size, specs) in enumerate(samples):
        c.setStrokeColor(INK_200); c.line(M, y + 18, W - M, y + 18)
        c.setFillColor(INK_500); c.setFont("PlexMono", 8); c.drawString(M, y - 3, role)
        c.setFillColor(BLUE if idx == 0 else INK); c.setFont("PlexMonoMedium" if role == "METADATA" else "InstrumentSemi", size); c.drawString(205, y - 8, sample)
        c.setFillColor(INK_500); c.setFont("PlexMono", 8); c.drawRightString(W - M, y - 3, specs)
        y -= [70, 62, 55, 54, 50][idx]
    finish_page(c)

    # 24 Layout
    start_page(c, 24, "Layout")
    title(c, "Software precision. An editorial margin.")
    grid_x, grid_y, grid_w, grid_h = M, 128, 575, 250
    round_box(c, grid_x, grid_y, grid_w, grid_h, CLOUD, INK_200, 12)
    gutter = 7
    col_w = (grid_w - 40 - gutter * 11) / 12
    for i in range(12):
        c.setFillColor(BLUE_100); c.roundRect(grid_x + 20 + i * (col_w + gutter), grid_y + 20, col_w, grid_h - 40, 3, stroke=0, fill=1)
    kicker(c, "12 columns / 1240 max / 24-32 gutter", grid_x + 20, grid_y + grid_h - 18, BLUE)
    round_box(c, 660, 128, 244, 250, CLOUD, INK_200, 12)
    kicker(c, "4 px spacing base", 680, 350, BLUE)
    paragraph(c, "4 · 8 · 12 · 16<br/>24 · 32 · 48<br/>64 · 96 · 128", 680, 310, 195, "InstrumentSemi", 25, 33, INK)
    paragraph(c, "Use tighter gaps inside a relationship and larger gaps between ideas.", 680, 188, 190, "Instrument", 10.5, 14, INK_600)
    finish_page(c)

    # 25 Graphic devices
    start_page(c, 25, "Graphic system")
    title(c, "The mark becomes a visual language.")
    image_fit(c, ROOT / "05 Graphic System/Patterns/Obelus_Pattern_Margin_Notes.png", M, 96, 520, 290)
    image_fit(c, ROOT / "05 Graphic System/Patterns/Obelus_Pattern_Dialogue_Field.png", 600, 96, 304, 290)
    kicker(c, "Margin notes", M, 76, BLUE); c.setFillColor(INK_600); c.setFont("Instrument", 10); c.drawString(160, 76, "Transcript rails, claims, and source anchors")
    finish_page(c)

    # 26 Iconography
    start_page(c, 26, "Iconography")
    title(c, "Simple geometry. Specific meaning.")
    names = ["Supported", "Disputed", "Needs_Context", "Unverified", "Sources_Conflict", "Outdated", "Opinion", "Checking"]
    labels = ["SUPPORTED", "DISPUTED", "CONTEXT", "UNVERIFIED", "CONFLICT", "OUTDATED", "OPINION", "CHECKING"]
    for idx, (name, label) in enumerate(zip(names, labels)):
        row, col = divmod(idx, 4)
        x = M + col * 212; y = 232 - row * 142
        round_box(c, x, y, 194, 124, CLOUD, INK_200, 10)
        image_fit(c, ROOT / f"05 Graphic System/Status Icons/Obelus_Status_{name}.png", x + 65, y + 42, 64, 64)
        c.setFillColor(INK_500); c.setFont("PlexMono", 8); c.drawCentredString(x + 97, y + 18, label)
    paragraph(c, "Icons confirm a written label. They do not replace it. Use a 1.8 px stroke on a 24 px grid and retain round joins and caps.", M, 68, 760, "Instrument", 11, 16, INK_600)
    finish_page(c)

    # 27 Motion principles
    start_page(c, 27, "Motion", dark=True)
    title(c, "Motion that looks closer.", color=CLOUD)
    principles = [("01", "Precise, not robotic", "Geometric movement with clean deceleration."), ("02", "Calm scrutiny", "Inspect, align, and resolve without alarm."), ("03", "Recognition first", "Preserve a base mark or complete-mark hold."), ("04", "Interruptible", "Results can replace a loader immediately."), ("05", "Never a verdict", "Loading stays neutral and source-oriented."), ("06", "Accessible", "Static reduced-motion states and polite text status.")]
    for idx, (num, heading, copy) in enumerate(principles):
        row, col = divmod(idx, 3)
        x = M + col * 280; y = 232 - row * 132
        c.setStrokeColor(INK_700); c.line(x, y + 114, x + 250, y + 114)
        c.setFillColor(AQUA_300); c.setFont("PlexMono", 8); c.drawString(x, y + 92, num)
        c.setFillColor(CLOUD); c.setFont("InstrumentSemi", 16); c.drawString(x, y + 61, heading)
        paragraph(c, copy, x, y + 43, 240, "Instrument", 10.5, 14, INK_300)
    finish_page(c)

    # 28-32 loaders
    loaders = [
        (28, "Proof Pulse", "01 Proof Pulse", "proof-pulse", "1200 ms", "Default compact checking", "16-24 px", "Upper dot, claim line, and lower dot resolve in sequence."),
        (29, "Transcript Scan", "02 Transcript Scan", "transcript-scan", "1350 ms", "Active transcript analysis", "20-32 px", "A narrow inspection band travels across a faint complete mark."),
        (30, "Source Exchange", "03 Source Exchange", "source-exchange", "1600 ms", "Multi-source research", "24 px and larger", "The source dots exchange positions around a stable statement line."),
        (31, "Obelus Resolve", "04 Obelus Resolve", "obelus-resolve", "1840 ms", "Signature handoff", "40-96 px", "The editorial stroke appears first; evidence points settle around it."),
        (32, "Progress Divide", "05 Progress Divide", "progress-divide", "Determinate", "Known progress only", "20-48 px", "Top dot, measurable line fill, and completion dot. Never a truth meter."),
    ]
    for number, heading, folder, stem, timing, best, size, copy in loaders:
        start_page(c, number, "Motion")
        kicker(c, f"Loader {number - 27:02d} / {timing}", M, 454, BLUE)
        paragraph(c, heading, M, 426, 460, "InstrumentSemi", 42, 44, INK)
        round_box(c, 590, 130, 314, 310, CLOUD, INK_200, 18)
        image_fit(c, ROOT / f"06 Motion/{folder}/obelus-loader-{stem}.poster.png", 650, 190, 194, 194)
        kicker(c, "Best for", M, 320, BLUE); paragraph(c, best, M, 298, 430, "InstrumentSemi", 18, 22, INK)
        kicker(c, "Recommended size", M, 244, BLUE); paragraph(c, size, M, 222, 430, "InstrumentSemi", 18, 22, INK)
        paragraph(c, copy, M, 160, 430, "Instrument", 13, 19, INK_600)
        paragraph(c, "Reduced motion: static canonical mark with a concise textual status.", M, 90, 430, "InstrumentMedium", 10.5, 15, BLUE)
        finish_page(c)

    # 33 Product UI
    start_page(c, 33, "Product application")
    title(c, "Evidence stays adjacent to the claim.")
    image_fit(c, ROOT / "07 UI and Layouts/Product UI/Obelus_Product_UI_Desktop.png", M, 74, 848, 330)
    paragraph(c, "Transcript first. Active claim second. Finding, qualification, freshness, and source trail in one visible relationship.", M, 62, 790, "InstrumentMedium", 10.5, 14, INK_600)
    finish_page(c)

    # 34 Landing page
    start_page(c, 34, "Landing application")
    title(c, "Let the product prove the proposition.")
    image_fit(c, ROOT / "07 UI and Layouts/Landing Page/Obelus_Landing_Page_Desktop.png", M, 74, 848, 330)
    paragraph(c, "A plain category, a memorable benefit, and real product UI. Personality lives in the Dialogue Axis, color, editorial margin, and motion.", M, 62, 800, "InstrumentMedium", 10.5, 14, INK_600)
    finish_page(c)

    # 35 Applications
    start_page(c, 35, "Applications")
    title(c, "A system that travels.")
    image_fit(c, ROOT / "07 UI and Layouts/Application Templates/Obelus_Presentation_Cover.png", M, 196, 510, 220)
    image_fit(c, ROOT / "07 UI and Layouts/Application Templates/Obelus_Document_Cover.png", 600, 74, 165, 342)
    image_fit(c, ROOT / "07 UI and Layouts/Application Templates/Obelus_Social_Quote_Template.png", 782, 74, 122, 122)
    kicker(c, "Included templates", M, 150, BLUE)
    paragraph(c, "Presentation cover · Research brief cover · Social avatar · Open Graph card · Social quote · Email signature · App icons", M, 128, 500, "InstrumentSemi", 13, 19, INK)
    finish_page(c)

    # 36 Production handoff
    start_page(c, 36, "Production")
    title(c, "Everything needed to build.")
    columns = [
        (M, "IDENTITY", ["SVG and PDF masters", "PNG size ladders", "App icons and favicons", "Eight concept explorations"]),
        (342, "SYSTEM", ["Open-source fonts", "CSS and JSON tokens", "Tailwind preset", "Contrast matrix", "Status icon family"]),
        (628, "MOTION + UI", ["5 SVG loaders", "5 Lottie files", "GIF, MP4, WebM previews", "React reference", "Product and landing HTML"]),
    ]
    for x, label, items in columns:
        round_box(c, x, 142, 260, 240, CLOUD, INK_200, 12)
        kicker(c, label, x + 18, 350, BLUE)
        bullet_list(c, items, x + 18, 320, 215, INK_600, 11, 5)
    paragraph(c, "The package manifest and checksums identify every delivered file. Source scripts reproduce generated assets.", M, 100, 760, "InstrumentMedium", 11, 16, INK)
    finish_page(c)

    # 37 Legal and references
    start_page(c, 37, "Launch note")
    title(c, "Design-ready. Name clearance pending.")
    round_box(c, M, 284, 848, 110, CONTEXT_BG, radius=12)
    kicker(c, "Material naming collision risk", M + 20, 365, CONTEXT)
    paragraph(c, "Existing software and technology businesses use Obelus, including a paper-review product with closely related semantics. Commission professional word-mark, device-mark, domain, handle, app-store, and relevant class clearance before launch.", M + 20, 342, 800, "InstrumentMedium", 13, 18, CONTEXT)
    kicker(c, "Primary references", M, 250, BLUE)
    refs = [
        "unicode.org/charts/nameslist/n_0080.html - U+00F7",
        "unicode.org/versions/latest/ch06.pdf - Unicode Standard",
        "atlas.perseus.tufts.edu - Middle Liddell entry for obelos",
        "github.com/Instrument/instrument-sans - font source and OFL",
        "stripe.com/blog/accessible-color-systems - accessible palette reference",
        "stripe.com/newsroom/information - official brand-asset reference",
    ]
    bullet_list(c, refs, M, 222, 800, INK_600, 10.5, 4)
    paragraph(c, "This document is design guidance, not legal advice or trademark clearance.", M, 74, 760, "InstrumentItalic", 10, 14, INK_500)
    finish_page(c)

    c.save()


def build_quick_reference(path: Path) -> None:
    c = canvas.Canvas(str(path), pagesize=(W, H), pageCompression=1)
    c.setTitle("Obelus Brand Quick Reference")
    # Page 1
    fill_page(c, PAPER)
    image_fit(c, LOCKUP_PRIMARY, M, 448, 170, 45)
    c.setFillColor(INK); c.setFont("InstrumentSemi", 36); c.drawString(M, 386, "Brand quick reference")
    c.setFillColor(INK_600); c.setFont("Instrument", 14); c.drawString(M, 354, "Evidence at conversation speed.")
    draw_symbol(c, 70, 100, 3.2, BLUE)
    c.setFillColor(INK_500); c.setFont("PlexMono", 8); c.drawString(75, 82, "DIALOGUE AXIS / MIN 16 PX")
    swatches = [("Ink", "#111528", INK, True), ("Paper", "#F7F8FC", PAPER, False), ("Blue", "#3B50E0", BLUE, True), ("Aqua", "#2BC7B9", AQUA, False), ("Coral", "#FF7568", CORAL, False)]
    for idx, (name, value, color, light) in enumerate(swatches):
        swatch(c, 350 + (idx % 3) * 180, 208 - (idx // 3) * 126, 164, 108, color, name, value, light)
    c.setFillColor(INK); c.setFont("InstrumentSemi", 18); c.drawString(350, 348, "Core palette")
    c.setStrokeColor(INK_200); c.line(M, 48, W - M, 48); c.setFillColor(INK_500); c.setFont("PlexMono", 8); c.drawString(M, 24, "OBELUS / QUICK REFERENCE / V1.0")
    c.showPage()
    # Page 2
    fill_page(c, INK)
    c.setFillColor(CLOUD); c.setFont("InstrumentSemi", 34); c.drawString(M, 452, "How the system behaves")
    c.setFillColor(AQUA_300); c.setFont("PlexMono", 8); c.drawString(M, 416, "VOICE")
    paragraph(c, "Clear · Calibrated · Curious · Plainspoken · Composed", M, 394, 760, "InstrumentSemi", 18, 22, CLOUD)
    c.setStrokeColor(INK_700); c.line(M, 350, W - M, 350)
    c.setFillColor(AQUA_300); c.setFont("PlexMono", 8); c.drawString(M, 322, "CLAIM STATES")
    badge(c, M, 270, "Supported", SUPPORTED, SUPPORTED_BG, 100); badge(c, 175, 270, "Disputed", DISPUTED, DISPUTED_BG, 95); badge(c, 290, 270, "Needs context", CONTEXT, CONTEXT_BG, 120); badge(c, 430, 270, "Unverified", UNVERIFIED, UNVERIFIED_BG, 100)
    c.setFillColor(AQUA_300); c.setFont("PlexMono", 8); c.drawString(M, 224, "TYPOGRAPHY")
    c.setFillColor(CLOUD); c.setFont("InstrumentSemi", 25); c.drawString(M, 188, "Instrument Sans")
    c.setFillColor(INK_300); c.setFont("PlexMono", 11); c.drawString(M, 160, "IBM PLEX MONO / TIME + SOURCE METADATA")
    c.setFillColor(AQUA_300); c.setFont("PlexMono", 8); c.drawString(545, 224, "MOTION")
    draw_symbol(c, 560, 118, 1.55, BLUE_400)
    paragraph(c, "Inspect · Align · Resolve<br/>No alarm. No bounce. Reduced motion always.", 680, 190, 220, "InstrumentMedium", 12, 18, CLOUD)
    c.setStrokeColor(INK_700); c.line(M, 48, W - M, 48); c.setFillColor(INK_300); c.setFont("PlexMono", 8); c.drawString(M, 24, "NOT A VERDICT. A REASON TO LOOK CLOSER.")
    c.save()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)
    register_fonts()
    build_brand_book(OUT / "Obelus Brand Guidelines.pdf")
    build_quick_reference(OUT / "Obelus Brand Quick Reference.pdf")
    print("Built Obelus brand book and quick reference PDFs.")


if __name__ == "__main__":
    main()
