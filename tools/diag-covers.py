"""Diagnose why the white cover rectangles do not hide the original text.

For the translated half of each output page, list the text spans and report
whether each one falls inside a pure-white filled rectangle. A span that is
English (i.e. original text) and uncovered is a cover that was misplaced or not
emitted at all.
"""

import io
import sys

import pymupdf

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PDF = sys.argv[1] if len(sys.argv) > 1 else "tools/_out/bilingual.pdf"

doc = pymupdf.open(PDF)
page = doc[int(sys.argv[2]) if len(sys.argv) > 2 else 1]
half = page.rect.width / 2

covers = []
for drawing in page.get_drawings():
    fill = drawing.get("fill")
    if fill and all(abs(c - 1.0) < 0.02 for c in fill):
        covers.append(drawing["rect"])
print(f"page {page.number}: {len(covers)} white cover rect(s)")

def covered(rect: pymupdf.Rect) -> bool:
    """True when some cover overlaps the rect's centre band."""
    probe = pymupdf.Rect(rect.x0 + 1, (rect.y0 + rect.y1) / 2 - 1,
                         rect.x1 - 1, (rect.y0 + rect.y1) / 2 + 1)
    return any(c.intersects(probe) and c.get_area() > probe.get_area() * 0.5
               for c in covers)

english = 0
hidden = 0
samples = []
for block in page.get_text("dict")["blocks"]:
    if block.get("type") != 0:
        continue
    for line in block["lines"]:
        for span in line["spans"]:
            text = span["text"].strip()
            if not text:
                continue
            if (span["bbox"][0] + span["bbox"][2]) / 2 < half:
                continue  # left half is the untouched original
            if not any("a" <= c.lower() <= "z" for c in text):
                continue  # CJK only: that is our own translation
            if len(text) < 4:
                continue
            english += 1
            rect = pymupdf.Rect(span["bbox"])
            if covered(rect):
                hidden += 1
            elif len(samples) < 10:
                samples.append(([round(v) for v in span["bbox"]], span["font"], text[:52]))

print(f"english spans in translated half: {english}")
print(f"  covered by a white rect       : {hidden}")
print(f"  still visible                 : {english - hidden}")
print()
print("first visible english spans:")
for bbox, font, text in samples:
    print(f"  bbox={bbox} font={font[:22]:22s} {text!r}")

print()
print("first 8 cover rects:")
for rect in covers[:8]:
    print(f"  {[round(v) for v in rect]}  w={rect.width:.1f} h={rect.height:.1f}")
