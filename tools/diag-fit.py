"""Measure how well the translated text fits the original layout.

For each output page, compare the ink of the original half with the translated
half and report overlapping text, uncovered original text, and the geometry of
paragraphs that had to shrink or truncate.
"""

import io
import sys

import pymupdf

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PDF = sys.argv[1] if len(sys.argv) > 1 else "tools/_out/bilingual.pdf"
doc = pymupdf.open(PDF)

total_spans = 0
uncovered = 0
cjk_spans = 0
collisions = 0
samples: list[str] = []

for page in doc:
    half = page.rect.width / 2
    covers = [
        d["rect"]
        for d in page.get_drawings()
        if d.get("fill") and all(abs(c - 1.0) < 0.02 for c in d["fill"])
    ]

    def covered(rect: pymupdf.Rect) -> bool:
        probe = pymupdf.Rect(rect.x0 + 1, (rect.y0 + rect.y1) / 2 - 1,
                             rect.x1 - 1, (rect.y0 + rect.y1) / 2 + 1)
        return any(c.intersects(probe) and c.get_area() > probe.get_area() * 0.5
                   for c in covers)

    boxes = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                text = span["text"].strip()
                if not text:
                    continue
                rect = pymupdf.Rect(span["bbox"])
                right = (rect.x0 + rect.x1) / 2 >= half
                is_cjk = any("\u4e00" <= c <= "\u9fff" for c in text)
                if right and is_cjk:
                    cjk_spans += 1
                    boxes.append(rect)
                elif right:
                    total_spans += 1
                    if not covered(rect):
                        uncovered += 1
                        if len(samples) < 12:
                            samples.append(
                                f"page {page.number + 1} {[round(v) for v in span['bbox']]} "
                                f"{span['font'][:20]:20s} {text[:46]!r}"
                            )

    # Translated spans that overlap each other indicate a paragraph overrun.
    boxes.sort(key=lambda r: (round(r.y0), r.x0))
    for i in range(1, len(boxes)):
        a, b = boxes[i - 1], boxes[i]
        if abs(a.y0 - b.y0) < 2 and b.x0 < a.x1 - 1.5 and b.x1 > a.x0 + 1.5:
            collisions += 1

print(f"translated (CJK) spans                : {cjk_spans}")
print(f"original spans left visible           : {uncovered} / {total_spans}")
print(f"overlapping translated span pairs     : {collisions}")
if samples:
    print("\noriginal text still visible:")
    for s in samples:
        print("  " + s)
