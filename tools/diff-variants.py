"""Diff the table directories of the working and failing font variants."""

import glob
import os

from fontTools.ttLib import TTFont

PATHS = [
    ("simhei-control", r"C:\Windows\Fonts\simhei.ttf"),
    ("bundled-subset", r"D:\cursor\zotero-pdf-ai-translate\addon\content\fonts\NotoSansSC-Regular.subset.ttf"),
    ("noto-vf-original", r"C:\Windows\Fonts\NotoSansSC-VF.ttf"),
]
for f in sorted(glob.glob(r"D:\cursor\zotero-pdf-ai-translate\tools\_variants\*.ttf")):
    PATHS.append((os.path.basename(f)[:-4], f))

WORKING = {
    "simhei-control",
    "subset-default",
    "subset-glyphnames",
    "subset-retaingids",
    "subset-both",
    "subset-roundtrip",
}

tables: dict[str, set[str]] = {}
for name, path in PATHS:
    try:
        font = TTFont(path, lazy=True)
        tables[name] = set(font.reader.tables.keys())
        font.close()
    except Exception as exc:  # noqa: BLE001
        print(f"{name}: ERROR {exc}")

# Union of all tags, sorted, as a matrix.
all_tags = sorted(set().union(*tables.values()))
names = [n for n, _ in PATHS]
short = {t.replace(" ", "_"): t for t in all_tags}

print(f"{'tag':8s} " + " ".join(f"{n[:11]:>11s}" for n in names))
for tag in all_tags:
    row = "".join(
        f"{('Y' if tag in tables[n] else '.'):>11s}" if n in tables else f"{'?':>11s}"
        for n in names
    )
    print(f"{tag:8s} {row}")

print("\nlegend: " + ", ".join(f"{n}={ 'works' if n in WORKING else 'fails'}" for n in names))

working_tags = set().intersection(*(tables[n] for n in names if n in WORKING and n in tables))
failing_only = set().intersection(*(tables[n] for n in names if n not in WORKING and n in tables))
print(f"\ncommon to ALL working: {sorted(working_tags)}")
print(f"common to ALL failing: {sorted(failing_only)}")
print(f"present in every failing but NO working font: {sorted(failing_only - set().union(*(tables[n] for n in names if n in WORKING and n in tables)))}")
