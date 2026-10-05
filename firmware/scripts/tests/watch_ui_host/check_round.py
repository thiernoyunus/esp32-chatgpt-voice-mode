#!/usr/bin/env python3
"""Check a WatchUi screenshot against the round panel it is drawn for.

The device has a round screen inside a square 360x360 panel. Anything the UI
paints outside the circle is invisible on the watch, so it would be a bug that
only shows up as "why is nothing there?" once the thing is on the board. This
looks at the corners of each screenshot (the part outside the circle) and
expects to find nothing but the page's own background.

Usage: check_round.py shot.png [more.png ...]
"""

import sys
from pathlib import Path

from PIL import Image


def outside_colours(path: Path):
    with Image.open(path) as image:
        rgb = image.convert("RGB")
    width, height = rgb.size
    if width != height:
        raise ValueError(f"{path}: {width}x{height} is not square")
    centre = (width - 1) / 2.0
    # The UI keeps its content inside a circle a few pixels smaller than the
    # panel, so anything further out than that is the screen's own background.
    radius = width / 2.0 - 4.0
    radius_sq = (radius + 2.0) ** 2
    pixels = rgb.load()
    seen = {}
    for y in range(height):
        for x in range(width):
            dx = x - centre
            dy = y - centre
            if dx * dx + dy * dy > radius_sq:
                colour = pixels[x, y]
                seen[colour] = seen.get(colour, 0) + 1
    return seen


def main(argv):
    if len(argv) < 2:
        print("usage: check_round.py shot.png [more.png ...]", file=sys.stderr)
        return 2
    failures = 0
    for name in argv[1:]:
        path = Path(name)
        try:
            seen = outside_colours(path)
        except Exception as error:  # noqa: BLE001 - report and keep checking the rest
            print(f"FAIL {path}: {error}")
            failures += 1
            continue
        if not seen:
            print(f"FAIL {path}: no pixels outside the circle to check")
            failures += 1
            continue
        if len(seen) > 1:
            common = max(seen.items(), key=lambda item: item[1])
            share = common[1] * 100.0 / sum(seen.values())
            print(f"FAIL {path}: {len(seen)} colours outside the round screen "
                  f"(most common {common[0]} at {share:.1f}%)")
            failures += 1
            continue
        print(f"ok   {path}: outside the round screen is {next(iter(seen))}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
