"""Build the bundled CJK subset font.

Noto Sans SC is OFL-1.1, which permits modification and redistribution; the
subset below keeps the license file next to it. The variable font shipped with
Windows is instanced to Regular first, because pdf-lib's fontkit embedder works
with static `glyf` outlines.

Charset: ASCII + Latin-1 + Latin Extended-A, General Punctuation, CJK Symbols
and Punctuation, Kana, the GB2312 hanzi set, Fullwidth Forms, Greek and the
mathematical operator blocks that survive formula extraction.
"""

import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

SRC = r"C:\Windows\Fonts\NotoSansSC-VF.ttf"
OUT_DIR = r"D:\cursor\zotero-pdf-ai-translate\addon\content\fonts"
OUT = os.path.join(OUT_DIR, "NotoSansSC-Regular.subset.ttf")
TMP = os.path.join(OUT_DIR, "_instanced.ttf")


def gb2312_chars() -> set[str]:
    """Every hanzi encodable in GB2312 (6763 characters)."""
    chars: set[str] = set()
    for high in range(0xB0, 0xF8):
        for low in range(0xA1, 0xFF):
            try:
                chars.add(bytes([high, low]).decode("gb2312"))
            except UnicodeDecodeError:
                continue
    return chars


def build_charset() -> set[str]:
    chars: set[str] = set()
    ranges = [
        (0x0020, 0x007E),  # ASCII printable
        (0x00A0, 0x00FF),  # Latin-1 supplement
        (0x0100, 0x017F),  # Latin extended-A
        (0x0180, 0x024F),  # Latin extended-B (phonetics in linguistics papers)
        (0x0370, 0x03FF),  # Greek
        (0x2000, 0x206F),  # general punctuation
        (0x2070, 0x209F),  # super/subscripts
        (0x20A0, 0x20BF),  # currency
        (0x2100, 0x214F),  # letterlike symbols
        (0x2190, 0x21FF),  # arrows
        (0x2200, 0x22FF),  # mathematical operators
        (0x2460, 0x24FF),  # enclosed alphanumerics
        (0x2500, 0x257F),  # box drawing
        (0x25A0, 0x25FF),  # geometric shapes
        (0x2600, 0x26FF),  # miscellaneous symbols
        (0x3000, 0x303F),  # CJK symbols and punctuation
        (0x3040, 0x30FF),  # hiragana + katakana
        (0x4E00, 0x9FFF),  # placeholder; replaced by the GB2312 set below
        (0xFF00, 0xFFEF),  # fullwidth forms
    ]
    for lo, hi in ranges:
        if lo == 0x4E00:
            continue
        for cp in range(lo, hi + 1):
            chars.add(chr(cp))
    chars |= gb2312_chars()
    return chars


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    if not os.path.exists(SRC):
        print(f"source font not found: {SRC}")
        return 1

    print("instancing variable font to wght=400 ...")
    font = TTFont(SRC)
    instance = instancer.instantiateVariableFont(font, {"wght": 400}, inplace=False)
    instance.save(TMP)
    print(f"  instanced -> {os.path.getsize(TMP):,} bytes")

    chars = build_charset()
    print(f"subsetting to {len(chars):,} characters ...")
    options = subset.Options()
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables += ["DSIG"]
    # Keep shaping minimal: the plugin draws one glyph at a time.
    options.layout_features = ["kern", "liga"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text="".join(sorted(chars)))

    instanced = TTFont(TMP)
    subsetter.subset(instanced)
    instanced.save(OUT)
    os.remove(TMP)
    print(f"  subset -> {OUT}  ({os.path.getsize(OUT):,} bytes)")

    check = TTFont(OUT)
    cmap = check.getBestCmap()
    print(f"  glyphs in subset cmap: {len(cmap):,}")
    missing = [c for c in "中文测试公式翻译论文" if ord(c) not in cmap]
    print(f"  sanity check missing: {missing or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
