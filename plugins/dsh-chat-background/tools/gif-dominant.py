"""Extract dominant colours from the bundled default.gif using the EXACT
filter the plugin's sampleDominantColor applies (32x32 resample, drop
luminance <14 or >245, average the rest)."""
import json
import sys
from PIL import Image

def dominant(frame_rgba):
    img = frame_rgba.convert("RGBA").resize((32, 32), Image.LANCZOS)
    px = list(img.getdata())
    r = g = b = 0
    n = 0
    for (pr, pg, pb, pa) in px:
        if pa < 128:
            continue
        lum = pr * 0.299 + pg * 0.587 + pb * 0.114
        if lum < 14 or lum > 245:
            continue
        r += pr
        g += pg
        b += pb
        n += 1
    if n == 0:
        return None
    return "#%02x%02x%02x" % (round(r / n), round(g / n), round(b / n))

path = sys.argv[1]
im = Image.open(path)
out = []
try:
    frames = getattr(im, "n_frames", 1)
except Exception:
    frames = 1
for i in range(frames):
    im.seek(i)
    out.append(dominant(im.convert("RGBA")))
print(json.dumps(out))
