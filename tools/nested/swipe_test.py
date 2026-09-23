#!/usr/bin/env python3
"""Swipe words across the keyboard in the test session and check what gets typed.

    tools/nested/swipe_test.py [--layout clip|plain] [--fast] DIR [word ...]

Needs the session from tools/nested/restart.sh with the keyboard open on the
letter level and no panel showing. Key centres are for the 1440x960 test
monitor at the default 40% keyboard height.
"""
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from drive import Driver  # noqa: E402

# Key centres per layout: with the clipboard suggestion row showing, or without.
LAYOUTS = {
    "clip": [("qwertyuiop", 407, 60, 729), ("asdfghjkl", 437, 60, 789), ("zxcvbnm", 467, 60, 849)],
    "plain": [("qwertyuiop", 305, 80, 684), ("asdfghjkl", 345, 80, 763), ("zxcvbnm", 385, 80, 842)],
}
KEYS = {}
WORDS = ("hello the and you that keyboard swipe typing world this with have from good thanks "
         "people because would about there time going great today really think know love what").split()


def finger_path(word, rng):
    """Key centres with a human-ish wobble: an offset per swipe plus jitter."""
    ox, oy = rng.gauss(0, 10), rng.gauss(0, 10)
    pts = []
    for c in word:
        x, y = KEYS[c]
        p = (x + ox + rng.gauss(0, 8), y + oy + rng.gauss(0, 8))
        if not pts or abs(p[0] - pts[-1][0]) + abs(p[1] - pts[-1][1]) > 4:
            pts.append(p)
    if len(pts) == 1:  # double letters only: a small loop
        pts.append((pts[0][0] + 12, pts[0][1] + 12))
    return pts


def main():
    args = sys.argv[1:]
    layout, speed = "clip", 0.07
    while args and args[0].startswith("--"):
        opt = args.pop(0)
        if opt == "--layout":
            layout = args.pop(0)
        elif opt == "--fast":
            speed = 0.03
    rows = LAYOUTS[layout]
    KEYS.update({c: (x0 + i * step, y) for letters, x0, step, y in rows for i, c in enumerate(letters)})
    state = Path(args[0])
    words = args[1:] or WORDS
    text_file = state / "text.txt"
    d = Driver(state.joinpath("bus").read_text().strip())
    rng = random.Random(7)
    ok = 0
    for word in words:
        before = text_file.read_text() if text_file.exists() else ""
        d.swipe(finger_path(word, rng), seg_s=speed)
        d.wait(0.6)
        after = text_file.read_text() if text_file.exists() else ""
        typed = after[len(before):] if after.startswith(before) else f"<changed: {after[-30:]!r}>"
        good = typed.strip().lower() == word
        ok += good
        print(f"{'ok ' if good else 'BAD'} {word:10} -> {typed!r}")
    print(f"{ok}/{len(words)} swiped correctly")


if __name__ == "__main__":
    main()
