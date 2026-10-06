#!/usr/bin/env python3
"""Render the README's indicator example as docs/indicator.svg.

The indicator's symbols (● ○ █ ░ · ↻) are missing from most code fonts, so browsers
borrow them from fallback fonts with other widths and baselines and the lines look
ragged. Here every character sits on a fixed monospace grid: letters are text runs
pinned to their cell width (textLength), and the symbols are drawn as shapes.

Usage: python3 docs/render-indicator.py   (rewrites docs/indicator.svg)
"""
import math
from pathlib import Path
from xml.sax.saxutils import escape

LINES = [
    "cache ● 1h ████░░ 38m left · hit 91% · keepalive 1h42m ↻2",
    "cache ○ cold · next message re-caches ~240k tokens",
]
FONT = 14            # px
CW = FONT * 0.6      # monospace cell width
LH = 24              # line height
PAD_X, PAD_Y = 18, 16
FG = "#d4d4d4"
BG = "#1e1e1e"
SHAPES = set("●○█░·↻")


def cell_x(col: int) -> float:
    return PAD_X + col * CW


def shape(ch: str, col: int, base: float) -> str:
    cx, cy = cell_x(col) + CW / 2, base - FONT * 0.33   # vertical centre of lowercase text
    if ch == "●":
        return f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="3.8" fill="{FG}"/>'
    if ch == "○":
        return f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="3.4" fill="none" stroke="{FG}" stroke-width="1.4"/>'
    if ch == "·":
        return f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="1.4" fill="{FG}"/>'
    if ch == "↻":  # clockwise refresh arrow: a 300° arc with a chevron at its end
        r = 4.8
        pt = lambda t: (cx + r * math.sin(math.radians(t)), cy - r * math.cos(math.radians(t)))
        (x0, y0), (x1, y1) = pt(50), pt(340)
        tx, ty = math.cos(math.radians(340)), math.sin(math.radians(340))   # clockwise tangent
        nx, ny = -ty, tx
        a = 3.0
        c1 = (x1 - a * tx + a * nx, y1 - a * ty + a * ny)
        c2 = (x1 - a * tx - a * nx, y1 - a * ty - a * ny)
        return (f'<path d="M{x0:.2f},{y0:.2f} A{r},{r} 0 1,1 {x1:.2f},{y1:.2f}" fill="none" stroke="{FG}" '
                f'stroke-width="1.4" stroke-linecap="round"/>'
                f'<path d="M{c1[0]:.2f},{c1[1]:.2f} L{x1:.2f},{y1:.2f} L{c2[0]:.2f},{c2[1]:.2f}" fill="none" '
                f'stroke="{FG}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>')
    raise ValueError(ch)


def line(text: str, row: int) -> str:
    """Words become text runs pinned to their cells; spaces are just empty cells; runs
    of the same bar character become one rectangle, so the bar has no seams."""
    base = PAD_Y + FONT + row * LH
    out, col = [], 0
    while col < len(text):
        ch = text[col]
        end = col + 1
        if ch == " ":
            col = end
            continue
        if ch in "█░":
            while end < len(text) and text[end] == ch:
                end += 1
            out.append(bar(ch, col, end, base))
        elif ch in SHAPES:
            out.append(shape(ch, col, base))
        else:
            while end < len(text) and text[end] != " " and text[end] not in SHAPES:
                end += 1
            word = text[col:end]
            out.append(f'<text x="{cell_x(col):.1f}" y="{base:.1f}" textLength="{len(word) * CW:.1f}" '
                       f'lengthAdjust="spacingAndGlyphs">{escape(word)}</text>')
        col = end
    return "\n  ".join(out)


def bar(ch: str, start: int, end: int, base: float) -> str:
    top, h = base - FONT * 0.78, FONT * 0.98
    opacity = "" if ch == "█" else ' fill-opacity="0.28"'
    return (f'<rect x="{cell_x(start):.1f}" y="{top:.1f}" width="{(end - start) * CW:.1f}" '
            f'height="{h:.1f}" fill="{FG}"{opacity}/>')


def main() -> None:
    cols = max(len(t) for t in LINES)
    w, h = PAD_X * 2 + cols * CW, PAD_Y * 2 + FONT + (len(LINES) - 1) * LH + 4
    body = "\n  ".join(line(t, i) for i, t in enumerate(LINES))
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="{h:.0f}" viewBox="0 0 {w:.0f} {h:.0f}" role="img" aria-label="{escape(" / ".join(LINES))}">
  <rect width="100%" height="100%" rx="8" fill="{BG}"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace" font-size="{FONT}" fill="{FG}">
  {body}
  </g>
</svg>
'''
    Path(__file__).with_name("indicator.svg").write_text(svg)


if __name__ == "__main__":
    main()
