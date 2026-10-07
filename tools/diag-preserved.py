"""Compare original and translated pixels inside extracted protected regions."""
import argparse
import json
import numpy as np
import pymupdf

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("pdf")
parser.add_argument("structure")
parser.add_argument("--gap", type=float, default=12)
args = parser.parse_args()
pages = json.load(open(args.structure, encoding="utf-8"))
document = pymupdf.open(args.pdf)
checked = 0
differences = []
for page, structure in zip(document, pages, strict=True):
    offset = structure["width"] + args.gap
    for region in structure["protectedRegions"]:
        rect = pymupdf.Rect(region["left"], region["top"], region["right"], region["bottom"])
        rect = rect + (0.75, 0.75, -0.75, -0.75)
        if rect.is_empty:
            continue
        original = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), clip=rect, alpha=False)
        translated = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), clip=rect + (offset, 0, offset, 0), alpha=False)
        a = np.frombuffer(original.samples, dtype=np.uint8).reshape(original.height, original.width, 3)
        b = np.frombuffer(translated.samples, dtype=np.uint8).reshape(translated.height, translated.width, 3)
        changed = float(np.any(a != b, axis=2).mean()) if a.shape == b.shape else 1.0
        checked += 1
        if changed > 0:
            differences.append({"page": page.number + 1, "region": region, "changedPixelShare": changed})
print(json.dumps({"checkedRegions": checked, "differences": differences}, ensure_ascii=False))
raise SystemExit(bool(differences))
