"""Generate font variants to isolate why pdf-lib's subsetter fails on Noto Sans SC.

Writes several `.ttf` files into tools/_variants/ so the JS side can test each
one against pdf-lib's `subset: true`.
"""

import os

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

SRC = r"C:\Windows\Fonts\NotoSansSC-VF.ttf"
OUT_DIR = r"D:\cursor\zotero-pdf-ai-translate\tools\_variants"

CHARS = (
    "".join(chr(cp) for cp in range(0x20, 0x7F))
    + "注意力就是你所需要的一切主流的序列转导模型建立在复杂的循环或卷积神经网络之上"
    + "包含一个编码器和一个解码器"
)


def instance() -> TTFont:
    font = TTFont(SRC)
    return instancer.instantiateVariableFont(font, {"wght": 400}, inplace=False)


def subset_font(font: TTFont, *, retain_gids=False, glyph_names=False, name: str) -> str:
    options = subset.Options()
    options.retain_gids = retain_gids
    options.glyph_names = glyph_names
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables += ["DSIG"]
    options.layout_features = ["kern", "liga"]
    options.name_IDs = ["*"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=CHARS)
    subsetter.subset(font)
    path = os.path.join(OUT_DIR, f"{name}.ttf")
    font.save(path)
    return path


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)

    # 1. instanced only, never subsetted by fontTools
    path = os.path.join(OUT_DIR, "instanced-only.ttf")
    instance().save(path)
    print(f"{path}  {os.path.getsize(path):,}")

    # 2. instanced + fontTools subset, default options
    print(subset_font(instance(), name="subset-default"))

    # 3. retain original glyph ids
    print(subset_font(instance(), retain_gids=True, name="subset-retaingids"))

    # 4. keep post-table glyph names
    print(subset_font(instance(), glyph_names=True, name="subset-glyphnames"))

    # 5. both
    print(
        subset_font(
            instance(), retain_gids=True, glyph_names=True, name="subset-both"
        )
    )

    # 6. strip the CFF-ish niceties: force short loca by keeping it small is not
    #    controllable, so instead re-save through a round trip to normalize.
    font = instance()
    roundtrip = os.path.join(OUT_DIR, "instanced-roundtrip.ttf")
    font.save(roundtrip)
    print(subset_font(TTFont(roundtrip), name="subset-roundtrip"))

    for name in sorted(os.listdir(OUT_DIR)):
        p = os.path.join(OUT_DIR, name)
        print(f"  {name:32s} {os.path.getsize(p):,}")


if __name__ == "__main__":
    main()
