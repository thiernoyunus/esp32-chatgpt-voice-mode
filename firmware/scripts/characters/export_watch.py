"""Turn the captured mascot frames into watch-ready flipbooks.

Run: python3 export_watch.py   (needs: pip install pillow)
Run it after capturing frames/<mascot>/ from the preview at 15 fps.
Writes watch/mascots.pack (every picture as a JPEG, back to back, which the
watch unpacks with Espressif's esp_new_jpeg) and watch/mascot_frames.h (where
each picture sits and the play order), plus a preview GIF per movement. JPEG
because the speckled fur defeats lossless squeezing (LZ4, palettes and frame
differences all measured at 5.6-7 MB for Felipe; JPEG 70 is ~1.4 MB).
"""
from pathlib import Path
import io
from PIL import Image, ImageChops, ImageStat

HERE = Path(__file__).resolve().parent
CAPTURE_FPS = 15
WATCH_FPS = 10                # calibration knob: lower = less storage, choppier
JPEG_QUALITY = 70             # calibration knob: 80 was indistinguishable on the Mac; 70 is smaller
# Watch menu order; the first is the default. Names are the Codex preset titles.
MASCOTS = ['Felipe', 'Alfred', 'Iggy', 'Todd']
# Record these with extra preview options. Alfred's own eyes are sleepy lids
# that also turn his face aside; plain dots keep him awake and facing forward.
RECORD_OPTIONS = {'Alfred': 'eyes=dots'}
# (first, last, loops) captured frame of each movement, recorded at ?size=330
# with the same timing script for every mascot. Loop points were found on
# Felipe by comparing frames for a clean repeat; the export re-checks the seam
# for every mascot.
MOVES = {
    'idle': (26, 72, True),             # resting, breathing; 3.1 s
    'paused_intro': (0, 27, False),     # dozes off
    'paused': (28, 57, True),           # asleep with Zzz; 2 s
    'creating_intro': (0, 21, False),   # wakes, easel slides in (connecting)
    'creating': (22, 84, True),         # paints a stroke, then starts again; 4.2 s
    'thinking_intro': (0, 37, False),   # lightbulb switches on
    'thinking': (38, 121, True),        # sway + glowing bulb; 5.6 s (no clean shorter repeat)
    'working_intro': (0, 51, False),    # keyboard appears, starts typing
    'working': (52, 92, True),          # typing; 2.7 s
    'error_intro': (0, 21, False),      # turns red
    'error': (22, 55, True),            # unhappy; 2.3 s
}
# Where a mascot's own motion repeats somewhere else (found the same way).
OWN_LOOPS = {
    'Alfred': {'idle': (19, 72, True),
               'working_intro': (0, 68, False), 'working': (69, 110, True),
               'error_intro': (0, 18, False), 'error': (19, 42, True)},
    'Iggy': {'idle': (32, 81, True),  # bops along to his headphones
             'error_intro': (0, 19, False), 'error': (20, 43, True)},
    'Todd': {'idle': (41, 117, True),
             'error_intro': (0, 26, False), 'error': (27, 59, True)},
}
# Loops that are meant to jump: the canvas clears and a new stroke starts.
RESTARTS = {'creating'}
CANVAS = 256                  # the watch's character area (voice_geometry.h kOrbSize)
PACK_MAGIC = b'MASCOTS1'


def moves(mascot):
    return {**MOVES, **OWN_LOOPS.get(mascot, {})}


def family(name):
    return name.split('_')[0]


def frame(mascot, name, n):
    return Image.open(HERE / 'frames' / mascot.lower() / f'{family(name)}-{n:03d}.png').convert('RGBA')


def used_box(mascot, names):
    """Smallest area every picture of these movements fits in."""
    box = None
    for name in names:
        first, last, _ = moves(mascot)[name]
        for n in range(first, last + 1):
            b = frame(mascot, name, n).getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
            if b:
                box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]),
                                             max(box[2], b[2]), max(box[3], b[3]))
    return box


def pad16(box, within):
    """Grow a box to multiples of 16 (the JPEG decoder's block size), staying inside `within`."""
    x0, y0, x1, y1 = box
    w, h = -(-(x1 - x0) // 16) * 16, -(-(y1 - y0) // 16) * 16
    x0 = max(within[0], min(x0, within[2] - w))
    y0 = max(within[1], min(y0, within[3] - h))
    return (x0, y0, x0 + w, y0 + h)


def jpeg(img):
    """One picture as a baseline JPEG, the kind esp_new_jpeg decodes."""
    out = io.BytesIO()
    img.save(out, 'JPEG', quality=JPEG_QUALITY)
    return out.getvalue()


def seam(mascot, name):
    """How much a loop jumps where it repeats, relative to its usual motion (1 = invisible)."""
    first, last, _ = moves(mascot)[name]
    small = [frame(mascot, name, n).resize((110, 110)) for n in (first, first + 1, last, last + 1)]
    d = lambda a, b: sum(ImageStat.Stat(ImageChops.difference(a, b)).mean)
    return d(small[2], small[0]) / max(d(small[0], small[1]), d(small[2], small[3]), 0.05)


def export(mascot, name, box, whole):
    """One movement: its pictures as JPEGs (each stored once) and the play order."""
    first, last, loops = moves(mascot)[name]
    picked, i = [], 0.0
    while first + round(i) <= last:
        f = frame(mascot, name, first + round(i)).crop(box)
        bg = Image.new('RGBA', f.size, 'black')
        bg.alpha_composite(f)
        picked.append(bg.convert('RGB'))
        i += CAPTURE_FPS / WATCH_FPS
    picked[0].save(HERE / 'watch' / f'{mascot.lower()}-{name}.gif', save_all=True,
                   append_images=picked[1:], duration=1000 // WATCH_FPS, loop=0)
    # Store each picture once; a still pose just stays up longer.
    seen, pictures, order = {}, [], []
    for im in picked:
        raw = im.tobytes()
        if order and seen.get(raw) == order[-1][0]:
            order[-1][1] += 1
            continue
        if raw not in seen:
            seen[raw] = len(pictures)
            pictures.append(jpeg(im))
        order.append([seen[raw], 1])
    return {'loops': loops, 'x': box[0] - whole[0], 'y': box[1] - whole[1],
            'w': box[2] - box[0], 'h': box[3] - box[1], 'pictures': pictures,
            'steps': [(p, n * 1000 // WATCH_FPS) for p, n in order]}


def export_mascot(mascot):
    # Each movement is cropped to its own area (a start and its loop share one,
    # so they line up); `whole` is the area the mascot needs on the watch.
    whole = used_box(mascot, list(MOVES))
    whole = pad16(whole, (0, 0, 10_000, 10_000))
    assert whole[2] - whole[0] <= CANVAS and whole[3] - whole[1] <= CANVAS, f'{mascot} is too big: {whole}'
    boxes = {f: pad16(used_box(mascot, [n for n in MOVES if family(n) == f]), whole)
             for f in {family(n) for n in MOVES}}
    for name, (_, _, loops) in moves(mascot).items():
        if loops and name not in RESTARTS and seam(mascot, name) > 3:
            print(f'warning: {mascot} {name} jumps where it repeats ({seam(mascot, name):.1f}x its usual motion)')
    return {'w': whole[2] - whole[0], 'h': whole[3] - whole[1],
            'moves': {name: export(mascot, name, boxes[family(name)], whole) for name in MOVES}}


def write_header(mascots, at):
    """watch/mascot_frames.h: where each picture sits in mascots.pack, and the play order."""
    every = [m for one in mascots.values() for m in one['moves'].values()]
    lines = ['// Generated by firmware/scripts/characters/export_watch.py - do not edit.',
             '#pragma once', '#include <cstdint>', '',
             'namespace mascot {', '',
             f'inline constexpr uint32_t kBiggestPicture = {max(len(p) for m in every for p in m["pictures"])};',
             f'inline constexpr uint32_t kLargestArea = {max(m["w"] * m["h"] for m in every)};',
             f'inline constexpr char kPackMagic[] = "{PACK_MAGIC.decode()}";', '',
             'struct Picture { uint32_t start, length; };',
             'struct Step { uint16_t picture, ms; };',
             '// x, y: where this movement sits inside its mascot\'s w x h area.',
             'struct Movement { uint32_t offset; bool loops; uint16_t x, y, w, h; const Picture* pictures; '
             'const Step* steps; uint16_t step_count; };',
             'struct Mascot { const char* name; uint16_t w, h; const Movement* movements; };', '',
             'enum class Move { ' + ', '.join(n.title().replace('_', '') for n in MOVES) + ', Count };', '']
    for mascot, one in mascots.items():
        key = mascot.lower()
        for name, m in one['moves'].items():
            offset, pictures = at[mascot][name]
            pics = ', '.join(f'{{{a}, {b}}}' for a, b in pictures)
            steps = ', '.join(f'{{{p}, {ms}}}' for p, ms in m['steps'])
            lines += [f'inline constexpr Picture k_{key}_{name}_pictures[] = {{{pics}}};',
                      f'inline constexpr Step k_{key}_{name}_steps[] = {{{steps}}};']
        lines.append(f'inline constexpr Movement k_{key}_movements[] = {{')
        for name, m in one['moves'].items():
            lines.append(f'    {{{at[mascot][name][0]}, {str(m["loops"]).lower()}, {m["x"]}, {m["y"]}, {m["w"]}, '
                         f'{m["h"]}, k_{key}_{name}_pictures, k_{key}_{name}_steps, {len(m["steps"])}}},')
        lines += ['};', '']
    lines.append('inline constexpr Mascot kMascots[] = {')
    lines += [f'    {{"{mascot}", {one["w"]}, {one["h"]}, k_{mascot.lower()}_movements}},'
              for mascot, one in mascots.items()]
    lines += ['};', 'inline constexpr int kMascotCount = sizeof(kMascots) / sizeof(kMascots[0]);', '',
              '}  // namespace mascot', '']
    (HERE / 'watch' / 'mascot_frames.h').write_text('\n'.join(lines))


if __name__ == '__main__':
    (HERE / 'watch').mkdir(exist_ok=True)
    mascots = {mascot: export_mascot(mascot) for mascot in MASCOTS}
    # mascots.pack: an 8-byte marker, then every movement's JPEGs back to back.
    # The watch reads it a picture at a time from the top 16 MB of flash.
    pack, at = bytearray(PACK_MAGIC), {}
    for mascot, one in mascots.items():
        at[mascot] = {}
        for name, m in one['moves'].items():
            offset, pictures = len(pack), []
            for jpg in m['pictures']:
                pictures.append((len(pack) - offset, len(jpg)))
                pack += jpg
            at[mascot][name] = (offset, pictures)
            # self-check: every picture is a JPEG of this movement's own size
            assert m['w'] % 16 == 0 and m['h'] % 16 == 0
            assert m['x'] + m['w'] <= one['w'] and m['y'] + m['h'] <= one['h']
            assert all(Image.open(io.BytesIO(j)).size == (m['w'], m['h']) for j in m['pictures'])
        size = sum(len(p) for m in one['moves'].values() for p in m['pictures'])
        print(f"{mascot:8} {one['w']}x{one['h']}  {size / 1e6:.2f} MB")
    (HERE / 'watch' / 'mascots.pack').write_bytes(bytes(pack))
    write_header(mascots, at)
    print(f'total {len(pack) / 1e6:.2f} MB')
