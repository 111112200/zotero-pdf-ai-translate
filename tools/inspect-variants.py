"""Compare the table layout of the font variants against pdf-lib's subsetter behaviour."""

import glob
import os

from fontTools.ttLib import TTFont

PATHS = [
    ("simhei-control", r"C:\Windows\Fonts\simhei.ttf"),
    (
        "bundled-subset",
        r"D:\cursor\zotero-pdf-ai-translate\addon\content\fonts\NotoSansSC-Regular.subset.ttf",
    ),
]
for f in sorted(glob.glob(r"D:\cursor\zotero-pdf-ai-translate\tools\_variants\*.ttf")):
    PATHS.append((os.path.basename(f)[:-4], f))

# Which variants rendered 51/51 with pdf-lib subset: true (from variants.mjs).
WORKING = {
    "simhei-control",
    "subset-default",
    "subset-glyphnames",
    "subset-retaingids",
    "subset-both",
    "subset-roundtrip",
}

header = (
    f"{'font':22s} {'works':>5s} {'glyphs':>7s} {'locFmt':>6s} "
    f"{'glyfKB':>8s} {'hmtxN':>6s} {'comp':>5s} {'tables':>6s}"
)
print(header)
print("-" * len(header))
for name, path in PATHS:
    try:
        font = TTFont(path, lazy=True)
        maxp = font["maxp"]
        head = font["head"]
        hhea = font["hhea"]
        glyf_len = font.reader.tables["glyf"].length if "glyf" in font.reader.tables else 0
        hmtx_n = getattr(hhea, "numberOfMetrics", None) or len(font["hmtx"].metrics)

        composites = 0
        glyf = font["glyf"]
        for gname in glyf.keys():
            try:
                g = glyf[gname]
                if getattr(g, "numberOfContours", 0) is not None and g.numberOfContours < 0:
                    composites += 1
            except Exception:  # noqa: BLE001 - lazy table probing
                pass
        print(
            f"{name:22s} {str(name in WORKING):>5s} {maxp.numGlyphs:7d} "
            f"{head.indexToLocFormat:6d} {glyf_len / 1024:8.0f} "
            f"{hmtx_n:6d} {composites:5d} {len(font.keys()):6d}"
        )
        font.close()
    except Exception as exc:  # noqa: BLE001 - report per font
        print(f"{name:22s} ERROR {exc}")


working = [n for n, _ in PATHS if n in WORKING]
failing = [n for n, _ in PATHS if n not in WORKING]
print(f"\nworking: {working}")
print(f"failing: {failing}")
