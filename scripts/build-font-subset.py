"""Builds resources/fonts/NotoSansSC-Bold-subset.woff from a Noto Sans SC variable font.

Not part of the normal build; the generated file is committed. Needs Python 3 with fontTools.

    python scripts/build-font-subset.py "C:/Windows/Fonts/NotoSansSC-VF.ttf"

Steps: instantiate the variable font at wght=700, keep ASCII, punctuation, the CJK/fullwidth
punctuation blocks and every GB2312 hanzi (6763), write a WOFF (zlib). Noto Sans SC is licensed
under the SIL Open Font License 1.1 (see resources/fonts/OFL.txt). The font keeps its original
name table, so the copyright and licence strings stay inside the file.
"""

import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer


def gb2312_hanzi() -> set[int]:
    out: set[int] = set()
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes([hi, lo]).decode("gb2312")
            except UnicodeDecodeError:
                continue
            out.add(ord(ch))
    return out


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    source = Path(sys.argv[1])
    out_path = Path(__file__).resolve().parent.parent / "resources" / "fonts" / "NotoSansSC-Bold-subset.woff"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    font = TTFont(source)
    font = instancer.instantiateVariableFont(font, {"wght": 700})

    unicodes = set(range(0x20, 0x7F))
    unicodes |= set(range(0xA0, 0x100))  # Latin-1
    unicodes |= set(range(0x2000, 0x2070))  # general punctuation
    unicodes |= set(range(0x3000, 0x3040))  # CJK symbols and punctuation
    unicodes |= set(range(0xFF00, 0xFFF0))  # fullwidth forms
    unicodes |= set(range(0x2190, 0x21A0)) | set(range(0x2460, 0x2470)) | set(range(0x25A0, 0x25C0))
    unicodes |= gb2312_hanzi()

    options = subset.Options()
    options.layout_features = ["kern", "vert", "vrt2", "liga", "ccmp", "locl"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.hinting = False
    options.flavor = "woff"
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=sorted(unicodes))
    subsetter.subset(font)
    font.flavor = "woff"
    font.save(out_path)
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes, {len(font.getGlyphOrder())} glyphs)")


if __name__ == "__main__":
    main()
