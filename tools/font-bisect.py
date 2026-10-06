"""Bisect the pdf-lib subsetting failure by subset size.

Builds Noto Sans SC subsets of increasing size and lets the JS side report how
many glyphs render, to find the size at which subsetting starts dropping glyphs.
"""

import json
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

SRC = r"C:\Windows\Fonts\NotoSansSC-VF.ttf"
OUT_DIR = r"D:\cursor\zotero-pdf-ai-translate\tools\_bisect"

# The characters the JS test actually draws.
DRAWN = "注意力就是你所需要的一切主流的序列转导模型建立在复杂的循环或卷积神经网络之上包含一个编码器和一个解码器"

SIZES = [int(x) for x in sys.argv[1:]] or [200, 500, 1000, 2000, 4000, 8000]


def filler(count: int) -> str:
    """`count` distinct CJK characters, always including the drawn ones."""
    chars = list(dict.fromkeys(DRAWN))
    cp = 0x4E00
    while len(chars) < count:
        ch = chr(cp)
        cp += 1
        if ch not in chars:
            chars.append(ch)
    return "".join(chars)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    base = TTFont(SRC)
    instanced = instancer.instantiateVariableFont(base, {"wght": 400}, inplace=False)
    template = os.path.join(OUT_DIR, "_template.ttf")
    instanced.save(template)

    manifest = []
    for size in SIZES:
        font = TTFont(template)
        options = subset.Options()
        options.notdef_outline = True
        options.recalc_bounds = True
        options.drop_tables += ["DSIG"]
        options.layout_features = ["kern", "liga"]
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(text=filler(size))
        subsetter.subset(font)
        path = os.path.join(OUT_DIR, f"n{size}.ttf")
        font.save(path)

        probe = TTFont(path, lazy=True)
        glyf_len = probe.reader.tables["glyf"].length
        loc_fmt = probe["head"].indexToLocFormat
        num_glyphs = probe["maxp"].numGlyphs
        probe.close()
        manifest.append(
            {
                "size": size,
                "path": path,
                "bytes": os.path.getsize(path),
                "glyphs": num_glyphs,
                "glyfBytes": glyf_len,
                "indexToLocFormat": loc_fmt,
            }
        )
        print(
            f"n={size:6d}  file={os.path.getsize(path):9,d}  glyphs={num_glyphs:6d}  "
            f"glyf={glyf_len:9,d}  locFmt={loc_fmt}"
        )

    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)


if __name__ == "__main__":
    main()
