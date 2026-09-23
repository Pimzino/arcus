#!/usr/bin/env python3
"""Arcus brand: the mark, the app icon, the wordmark, the lockups and the brand sheet, all drawn from the
geometry and colours defined at the top of this file.

The mark is a Roman arch (Latin: arcus) of five stones on two short piers. The stones step from deep blue on
one side to light blue on the other, the way data crosses from one pane to the other, and the keystone at the
top, the stone that holds the arch together, stands proud of the rest in white (ink on light backgrounds).

Everything it makes lands in this folder, except the React components the app draws its logo with
(src/components/app/Brand.tsx). The platform icons in icons/ come from app-icon.png through `tauri icon`, which
this script runs; tauri.conf.json points the bundle at them.

Requirements: skia-python and fonttools, plus the repo's npm dependencies for `tauri icon`:
    python3 -m venv .venv-brand && .venv-brand/bin/pip install skia-python fonttools
    .venv-brand/bin/python branding/build.py
"""

from __future__ import annotations

import io
import math
import shutil
import subprocess
from pathlib import Path

import skia
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
SVG_DIR = HERE / "svg"

# ---------------------------------------------------------------------------------------------------------
# Colour. Defined in OKLCH so the stones step evenly in perceived lightness; converted to sRGB for output.


def oklch(l: float, c: float, h: float) -> tuple[int, int, int]:
    """OKLCH to 8-bit sRGB, reducing chroma until the colour fits the sRGB gamut."""
    while True:
        a, b = c * math.cos(math.radians(h)), c * math.sin(math.radians(h))
        l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
        m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
        s_ = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3
        lin = (
            4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
            -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
            -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
        )
        if all(-1e-4 <= v <= 1 + 1e-4 for v in lin) or c < 1e-3:
            break
        c -= 0.002

    def enc(v: float) -> int:
        v = min(max(v, 0.0), 1.0)
        v = 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055
        return round(v * 255)

    return tuple(enc(v) for v in lin)  # type: ignore[return-value]


def hexs(rgb: tuple[int, int, int]) -> str:
    return "#%02x%02x%02x" % rgb


def col(rgb: tuple[int, int, int], alpha: float = 1.0) -> int:
    return skia.Color(*rgb, round(alpha * 255))


# Stones, left to right, as OKLCH. The middle one is the keystone and takes the contrast colour instead.
STONE_LCH = [
    (0.38, 0.20, 266),  # deep
    (0.49, 0.243, 264.4),  # the app's primary, #1447e6
    None,  # keystone
    (0.65, 0.19, 258),
    (0.80, 0.11, 248),
]
STONES = [oklch(*lch) if lch else None for lch in STONE_LCH]
WHITE = (255, 255, 255)
MIDNIGHT_TOP = oklch(0.29, 0.07, 266)
MIDNIGHT_BOTTOM = oklch(0.17, 0.045, 266)
INK = MIDNIGHT_BOTTOM  # text, the app icon's tile, and the keystone on light backgrounds
PAPER = oklch(0.985, 0.003, 266)
MUTED = oklch(0.55, 0.02, 266)

# ---------------------------------------------------------------------------------------------------------
# The mark, in units where its bounding box is 80 x 60 with the origin at the top left.

R, T = 40.0, 20.0  # outer radius, stone depth
PIER = 14.0  # how far the piers run below the springing line
GAP = 2.6  # joint width
KEY_SPAN = 28.0  # degrees
KEY_PROUD = 6.0  # how far the keystone stands above the extrados
CX, CY = 40.0, R + KEY_PROUD  # arch centre
MARK_W, MARK_H = 2 * R, R + KEY_PROUD + PIER


def _sector(r0: float, r1: float, a0: float, a1: float) -> skia.Path:
    """Annular sector between radii r0 < r1 and angles a0 < a1 (degrees, 0 = right, counter-clockwise, y up)."""
    p = skia.Path()
    p.arcTo(skia.Rect.MakeLTRB(CX - r1, CY - r1, CX + r1, CY + r1), -a0, -(a1 - a0), True)
    p.arcTo(skia.Rect.MakeLTRB(CX - r0, CY - r0, CX + r0, CY + r0), -a1, a1 - a0, False)
    p.close()
    return p


def _joint(angle: float) -> skia.Path:
    """A constant-width strip along the radius at `angle`: cutting it out leaves a joint of even width."""
    p = skia.Path()
    p.addRect(skia.Rect.MakeLTRB(0, -GAP / 2, R + KEY_PROUD + 10, GAP / 2))
    m = skia.Matrix()
    m.setRotate(-angle)
    m.postTranslate(CX, CY)
    p.transform(m)
    return p


def _op(a: skia.Path, b: skia.Path, op) -> skia.Path:
    return skia.Op(a, b, op)


def mark_stones() -> list[skia.Path]:
    """The five stones, left to right; the outer two carry their piers."""
    r = R - T
    k0, k1 = 90 - KEY_SPAN / 2, 90 + KEY_SPAN / 2
    side = (180 - KEY_SPAN) / 2
    spans = [(180 - side / 2, 180), (k1, 180 - side / 2), (k0, k1), (side / 2, k0), (0, side / 2)]
    stones = []
    for i, (a0, a1) in enumerate(spans):
        p = _sector(r, R + (KEY_PROUD if i == 2 else 0), a0, a1)
        if i in (0, 4):
            pier = skia.Path()
            x0 = CX - R if i == 0 else CX + r
            pier.addRect(skia.Rect.MakeLTRB(x0, CY, x0 + T, CY + PIER))
            p = _op(p, pier, skia.PathOp.kUnion_PathOp)
        for a in (a0, a1):
            p = _op(p, _joint(a), skia.PathOp.kDifference_PathOp)
        stones.append(p)
    return stones


def stone_colours(keystone: tuple[int, int, int]) -> list[tuple[int, int, int]]:
    return [keystone if c is None else c for c in STONES]


# ---------------------------------------------------------------------------------------------------------
# Wordmark: "arcus" in Sora SemiBold, turned into outlines so the brand never depends on the font being
# installed. Sora is under the SIL Open Font License (fonts/OFL.txt).

WORD = "arcus"
WORD_WEIGHT = 600
WORD_TRACKING = -0.012  # of the font size, between letters


def sora(weight: int) -> skia.Typeface:
    font = TTFont(HERE / "fonts" / "Sora[wght].ttf")
    instantiateVariableFont(font, {"wght": weight}, inplace=True)
    buf = io.BytesIO()
    font.save(buf)
    return skia.Typeface.MakeFromData(skia.Data.MakeWithCopy(buf.getvalue()))


SORA_SEMIBOLD = sora(WORD_WEIGHT)
SORA_REGULAR = sora(400)


def wordmark(size: float) -> tuple[skia.Path, skia.FontMetrics]:
    """The wordmark at `size`, baseline at y = 0, starting at x = 0."""
    font = skia.Font(SORA_SEMIBOLD, size)
    font.setSubpixel(True)
    glyphs = font.textToGlyphs(WORD)
    xs = font.getXPos(glyphs)
    out = skia.Path()
    for i, (g, x) in enumerate(zip(glyphs, xs)):
        gp = font.getPath(g)
        gp.offset(x + i * WORD_TRACKING * size, 0)
        out.addPath(gp)
    return out, font.getMetrics()


# ---------------------------------------------------------------------------------------------------------
# Output helpers.


def path_to_svg(path: skia.Path, digits: int = 2) -> str:
    """SVG path data for a skia path; conics (skia's arcs) become quadratic curves."""
    fmt = lambda v: f"{v:.{digits}f}".rstrip("0").rstrip(".")  # noqa: E731
    pt = lambda p: f"{fmt(p.x())} {fmt(p.y())}"  # noqa: E731
    out = []
    it = skia.Path.Iter(path, False)
    while True:
        verb, pts = it.next()
        if verb == skia.Path.Verb.kDone_Verb:
            break
        if verb == skia.Path.Verb.kMove_Verb:
            out.append("M" + pt(pts[0]))
        elif verb == skia.Path.Verb.kLine_Verb:
            out.append("L" + pt(pts[1]))
        elif verb == skia.Path.Verb.kQuad_Verb:
            out.append("Q" + pt(pts[1]) + " " + pt(pts[2]))
        elif verb == skia.Path.Verb.kConic_Verb:
            quads = skia.Path.ConvertConicToQuads(pts[0], pts[1], pts[2], it.conicWeight(), 3)
            for j in range(1, len(quads) - 1, 2):
                out.append("Q" + pt(quads[j]) + " " + pt(quads[j + 1]))
        elif verb == skia.Path.Verb.kCubic_Verb:
            out.append("C" + pt(pts[1]) + " " + pt(pts[2]) + " " + pt(pts[3]))
        elif verb == skia.Path.Verb.kClose_Verb:
            out.append("Z")
    return "".join(out)


def transformed(path: skia.Path, scale: float, dx: float, dy: float) -> skia.Path:
    p = skia.Path(path)
    m = skia.Matrix()
    m.setScale(scale, scale)
    m.postTranslate(dx, dy)
    p.transform(m)
    return p


def write_svg(name: str, width: float, height: float, body: str, comment: str) -> None:
    fmt = lambda v: f"{v:.2f}".rstrip("0").rstrip(".")  # noqa: E731
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(width)} {fmt(height)}">\n'
        f"  <!-- {comment} Generated by branding/build.py. -->\n{body}</svg>\n"
    )
    (SVG_DIR / name).write_text(svg)


def svg_mark(keystone: tuple[int, int, int], scale: float = 1.0, dx: float = 0, dy: float = 0) -> str:
    return "".join(
        f'  <path fill="{hexs(c)}" d="{path_to_svg(transformed(p, scale, dx, dy))}"/>\n'
        for p, c in zip(mark_stones(), stone_colours(keystone))
    )


def squircle(x: float, y: float, size: float, n: float = 5.0, steps: int = 720) -> skia.Path:
    """A superellipse, close to Apple's continuous-corner app icon tile."""
    p = skia.Path()
    h = size / 2
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        px = x + h + h * math.copysign(abs(ct) ** (2 / n), ct)
        py = y + h + h * math.copysign(abs(st) ** (2 / n), st)
        p.moveTo(px, py) if i == 0 else p.lineTo(px, py)
    p.close()
    return p


# ---------------------------------------------------------------------------------------------------------
# The app icon: macOS grid, an 824 px tile on a 1024 canvas with its shadow inside the canvas.

TILE_X, TILE = 100.0, 824.0
GLYPH_W = 468.0  # the mark's width on the tile


def draw_app_icon(canvas: skia.Canvas) -> None:
    tile = squircle(TILE_X, TILE_X, TILE)
    # Shadow under the tile.
    canvas.drawPath(
        tile,
        skia.Paint(AntiAlias=True, Color=col((0, 0, 0), 0.0),
                   ImageFilter=skia.ImageFilters.DropShadowOnly(0, 12, 14, 14, col((0, 0, 0), 0.32))),
    )
    # The tile: midnight, lighter at the top.
    canvas.drawPath(
        tile,
        skia.Paint(AntiAlias=True, Shader=skia.GradientShader.MakeLinear(
            [skia.Point(0, TILE_X), skia.Point(0, TILE_X + TILE)], [col(MIDNIGHT_TOP), col(MIDNIGHT_BOTTOM)])),
    )
    canvas.save()
    canvas.clipPath(tile, doAntiAlias=True)
    # A soft blue glow behind the arch, so the glyph sits in light rather than on a flat field.
    canvas.drawCircle(512, 470, 420, skia.Paint(AntiAlias=True, Shader=skia.GradientShader.MakeRadial(
        skia.Point(512, 470), 420, [col(STONES[1], 0.38), col(STONES[1], 0.0)])))
    # A hairline of light along the top edge.
    rim = skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style, StrokeWidth=3,
                     Shader=skia.GradientShader.MakeLinear(
                         [skia.Point(0, TILE_X), skia.Point(0, TILE_X + 260)],
                         [col(WHITE, 0.22), col(WHITE, 0.0)]))
    canvas.drawPath(tile, rim)
    canvas.restore()

    scale = GLYPH_W / MARK_W
    dx = 512 - GLYPH_W / 2
    dy = 522 - MARK_H * scale / 2  # a touch below centre: the arch's weight is at the top
    stones = [transformed(p, scale, dx, dy) for p in mark_stones()]
    everything = skia.Path()
    for p in stones:
        everything.addPath(p)
    canvas.drawPath(everything, skia.Paint(
        AntiAlias=True, ImageFilter=skia.ImageFilters.DropShadowOnly(0, 14, 16, 16, col((0, 0, 0), 0.45))))
    top, bottom = dy, dy + MARK_H * scale
    for p, lch in zip(stones, STONE_LCH):
        if lch is None:  # keystone: white, cooling slightly towards its foot
            hi, lo = WHITE, oklch(0.92, 0.025, 266)
        else:
            l, ch, h = lch
            hi, lo = oklch(l + 0.035, ch, h), oklch(l - 0.03, ch, h)
        canvas.drawPath(p, skia.Paint(AntiAlias=True, Shader=skia.GradientShader.MakeLinear(
            [skia.Point(0, top), skia.Point(0, bottom)], [col(hi), col(lo)])))


def render_app_icon() -> None:
    surface = skia.Surface(1024, 1024)
    canvas = surface.getCanvas()
    canvas.clear(skia.ColorTRANSPARENT)
    draw_app_icon(canvas)
    surface.makeImageSnapshot().save(str(HERE / "app-icon.png"), skia.kPNG)


# ---------------------------------------------------------------------------------------------------------
# Vector files.


def lockup_geometry(size: float = 100.0):
    """Mark and wordmark side by side: returns (mark scale, mark dy, word path, width, height)."""
    word, metrics = wordmark(size)
    cap = metrics.fCapHeight  # skia reports it as a positive distance above the baseline
    mark_h = cap * 1.16
    s = mark_h / MARK_H
    gap = MARK_W * s * 0.24
    bounds = word.computeTightBounds()
    word = transformed(word, 1, MARK_W * s + gap - bounds.left(), 0)
    top = min(-mark_h, word.computeTightBounds().top())
    width = word.computeTightBounds().right()
    height = max(0, word.computeTightBounds().bottom()) - top
    return s, top, word, width, height


def write_vectors() -> None:
    SVG_DIR.mkdir(exist_ok=True)
    write_svg("mark.svg", MARK_W, MARK_H, svg_mark(INK), "Arcus mark for light backgrounds.")
    write_svg("mark-dark.svg", MARK_W, MARK_H, svg_mark(WHITE), "Arcus mark for dark backgrounds.")
    mono = "".join(f'  <path d="{path_to_svg(p)}"/>\n' for p in mark_stones())
    write_svg("mark-mono.svg", MARK_W, MARK_H, f'  <g fill="currentColor">\n{mono}  </g>\n',
              "Arcus mark in one colour (currentColor).")

    word, _ = wordmark(100)
    b = word.computeTightBounds()
    w = transformed(word, 1, -b.left(), -b.top())
    write_svg("wordmark.svg", b.width(), b.height(), f'  <path fill="{hexs(INK)}" d="{path_to_svg(w)}"/>\n',
              "Arcus wordmark, Sora SemiBold in outlines.")

    s, top, word, width, height = lockup_geometry()
    for name, key, text in (("lockup.svg", INK, INK), ("lockup-dark.svg", WHITE, WHITE)):
        mark = svg_mark(key, s, 0, -top - MARK_H * s)
        body = mark + f'  <path fill="{hexs(text)}" d="{path_to_svg(transformed(word, 1, 0, -top))}"/>\n'
        write_svg(name, width, height, body, f"Arcus lockup ({'dark' if key == WHITE else 'light'} backgrounds).")

    # Favicon: the mark on a small midnight tile, readable in a browser tab at 16 px.
    pad = 10.0
    size = MARK_W + 2 * pad
    fav = (
        f'  <rect width="{size:g}" height="{size:g}" rx="18" fill="{hexs(MIDNIGHT_BOTTOM)}"/>\n'
        + svg_mark(WHITE, 1, pad, (size - MARK_H) / 2)
    )
    write_svg("favicon.svg", size, size, fav, "Arcus favicon.")


def write_web_font() -> None:
    """Sora SemiBold for the app's large headings (page, section and dialog titles), cut down to the Latin
    characters those titles use. Everything else in the app stays in the system font."""
    font = TTFont(HERE / "fonts" / "Sora[wght].ttf")
    instantiateVariableFont(font, {"wght": WORD_WEIGHT}, inplace=True)
    options = subset.Options()
    options.layout_features = ["kern", "liga", "calt", "tnum"]
    options.name_IDs = ["*"]  # keep the copyright and licence records
    sub = subset.Subsetter(options)
    sub.populate(unicodes=[*range(0x20, 0x7F), *range(0xA0, 0x180), 0x2013, 0x2014, 0x2018, 0x2019, 0x201C,
                           0x201D, 0x2026, 0x2022, 0x2192, 0x2190, 0x2212, 0x20AC])
    sub.subset(font)
    font.save(HERE / "fonts" / "Sora-SemiBold-latin.ttf")


def write_platform_icons() -> None:
    """Every size macOS and Windows need, from app-icon.png, into icons/. `tauri icon` also makes Android and iOS
    sets and a 64 px PNG; this app ships neither, so they go."""
    out = HERE / "icons"
    run = subprocess.run(["npx", "tauri", "icon", str(HERE / "app-icon.png"), "--output", str(out)], cwd=REPO,
                         capture_output=True, text=True)
    if run.returncode:
        raise SystemExit(f"tauri icon failed:\n{run.stdout}{run.stderr}")
    shutil.rmtree(out / "android", ignore_errors=True)
    shutil.rmtree(out / "ios", ignore_errors=True)
    (out / "64x64.png").unlink(missing_ok=True)


def write_react() -> None:
    """The mark and the lockup as React components, so the app draws exactly this geometry. The keystone and
    the wordmark take the theme's text colour: white in dark mode, midnight in light mode."""
    fmt = lambda v: f"{v:.2f}".rstrip("0").rstrip(".")  # noqa: E731

    def stones(scale: float = 1, dx: float = 0, dy: float = 0) -> str:
        rows = []
        for p, c in zip(mark_stones(), STONES):
            fill = 'className="fill-current"' if c is None else f'fill="{hexs(c)}"'
            rows.append(f'      <path {fill} d="{path_to_svg(transformed(p, scale, dx, dy))}" />')
        return "\n".join(rows)

    s, top, word, width, height = lockup_geometry()
    tsx = f"""// Generated by branding/build.py; change the brand there and re-run it, not here.

/** The Arcus mark: an arch of five stones stepping from deep to light blue, and a keystone in the text colour. */
export function BrandMark({{ className }}: {{ className?: string }}) {{
  return (
    <svg viewBox="0 0 {fmt(MARK_W)} {fmt(MARK_H)}" aria-hidden className={{className}}>
{stones()}
    </svg>
  );
}}

/** The mark and the wordmark (Sora SemiBold, in outlines) side by side, in the text colour. */
export function BrandLockup({{ className }}: {{ className?: string }}) {{
  return (
    <svg viewBox="0 0 {fmt(width)} {fmt(height)}" role="img" aria-label="Arcus" className={{className}}>
{stones(s, 0, -top - MARK_H * s)}
      <path className="fill-current" d="{path_to_svg(transformed(word, 1, 0, -top))}" />
    </svg>
  );
}}
"""
    (REPO / "src" / "components" / "app" / "Brand.tsx").write_text(tsx)


# ---------------------------------------------------------------------------------------------------------
# Brand sheet.


def text(canvas, s, x, y, size, rgb, weight=400, alpha=1.0):
    tf = SORA_SEMIBOLD if weight >= 600 else SORA_REGULAR
    canvas.drawString(s, x, y, skia.Font(tf, size), skia.Paint(AntiAlias=True, Color=col(rgb, alpha)))


def draw_mark(canvas, x, y, width, keystone):
    s = width / MARK_W
    for p, c in zip(mark_stones(), stone_colours(keystone)):
        canvas.drawPath(transformed(p, s, x, y), skia.Paint(AntiAlias=True, Color=col(c)))


def draw_lockup(canvas, x, y, height, dark):
    s0, top, word, width, h = lockup_geometry()
    k = height / h
    key = WHITE if dark else INK
    draw_mark(canvas, x, y + k * (-top - MARK_H * s0), MARK_W * s0 * k, key)
    canvas.drawPath(transformed(word, k, x, y - top * k), skia.Paint(AntiAlias=True, Color=col(key)))
    return width * k


def render_sheet() -> None:
    W, H = 2400, 1500
    surface = skia.Surface(W, H)
    c = surface.getCanvas()
    c.clear(col(PAPER))

    # Left: the app icon, large, on midnight.
    c.drawRect(skia.Rect(0, 0, 1000, H), skia.Paint(Color=col(MIDNIGHT_BOTTOM)))
    icon = skia.Image.open(str(HERE / "app-icon.png"))
    c.drawImageRect(icon, skia.Rect.MakeXYWH(150, 230, 700, 700), skia.SamplingOptions(skia.FilterMode.kLinear))
    for i, sz in enumerate((128, 64, 32, 16)):
        x = 190 + sum((128, 64, 32, 16)[:i]) + i * 56
        c.drawImageRect(icon, skia.Rect.MakeXYWH(x, 1120 + (128 - sz), sz, sz),
                        skia.SamplingOptions(skia.FilterMode.kLinear, skia.MipmapMode.kLinear))
    text(c, "App icon · 1024 / 128 / 64 / 32 / 16", 190, 1330, 22, WHITE, alpha=0.55)

    # Right: name, meaning, lockups, palette, type.
    x0 = 1110
    text(c, "BRAND", x0, 150, 20, STONES[1], 600)
    draw_lockup(c, x0, 190, 150, dark=False)
    text(c, "arcus (AR-kus) · Latin, noun: an arch.", x0, 420, 30, INK)
    text(c, "A desktop home for rclone: two sides, and the arch between them.", x0, 468, 30, MUTED)

    text(c, "LOCKUPS", x0, 580, 20, MUTED, 600)
    c.drawRect(skia.Rect.MakeXYWH(x0, 610, 520, 190), skia.Paint(Color=col(WHITE)))
    c.drawRect(skia.Rect.MakeXYWH(x0, 610, 520, 190), skia.Paint(AntiAlias=True, Style=skia.Paint.kStroke_Style,
                                                                 StrokeWidth=2, Color=col(INK, 0.08)))
    draw_lockup(c, x0 + 70, 668, 74, dark=False)
    c.drawRect(skia.Rect.MakeXYWH(x0 + 560, 610, 520, 190), skia.Paint(Color=col(MIDNIGHT_BOTTOM)))
    draw_lockup(c, x0 + 630, 668, 74, dark=True)
    draw_mark(c, x0 + 1120, 640, 150, INK)

    text(c, "COLOUR", x0, 900, 20, MUTED, 600)
    swatches = [("Stone 1", STONES[0]), ("Stone 2 · primary", STONES[1]), ("Stone 3", STONES[3]),
                ("Stone 4", STONES[4]), ("Midnight · ink", MIDNIGHT_BOTTOM), ("Paper", PAPER)]
    for i, (name, rgb) in enumerate(swatches):
        x = x0 + i * 196
        c.drawRect(skia.Rect.MakeXYWH(x, 930, 176, 110), skia.Paint(Color=col(rgb)))
        text(c, name, x, 1076, 20, INK, 600)
        text(c, hexs(rgb), x, 1104, 20, MUTED)

    text(c, "TYPE", x0, 1200, 20, MUTED, 600)
    text(c, "Sora SemiBold", x0, 1262, 44, INK, 600)
    text(c, "Wordmark in outlines, lowercase, tracking −1.2%. SIL Open Font License.", x0, 1306, 22, MUTED)
    text(c, "Arcus is built on rclone (rclone.org) and is not affiliated with the rclone project.",
         x0, 1420, 22, MUTED)
    surface.makeImageSnapshot().save(str(HERE / "brand-sheet.png"), skia.kPNG)


if __name__ == "__main__":
    render_app_icon()
    write_vectors()
    write_web_font()
    write_react()
    render_sheet()
    write_platform_icons()
    for p in sorted([*HERE.glob("*.png"), *SVG_DIR.glob("*.svg")]):
        print(p.relative_to(REPO))
