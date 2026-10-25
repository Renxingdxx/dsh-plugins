"""
Generate the bundled default assets for the dsh-custom-splash plugin.

No video encoder is available on this machine (ffmpeg ships only as Chromium's
shared library), so the default is an animated GIF for the picture plus a WAV
for the sound.  The plugin treats picture and sound as two independent media
slots, so a real MP4 with its own audio track works too.

Output:
  assets/default.gif   480x270, ~2.6s @ 18fps
  assets/default.wav   44.1 kHz 16-bit mono, ~2.6s
"""

import math
import os

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")

W, H = 480, 270
FPS = 18
SECONDS = 2.6
N_FRAMES = int(round(FPS * SECONDS))

# Accent palette (deep indigo / violet / cyan on near-black).
ACCENT = (111, 134, 255)
ACCENT2 = (150, 110, 255)
CYAN = (96, 220, 255)
BG = (7, 9, 18)


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(3))


def radial_bg(t):
    """A slowly shifting radial gradient so the frame never looks static."""
    phase = t / SECONDS
    cx = W * (0.5 + 0.12 * math.sin(phase * math.tau))
    cy = H * (0.46 + 0.08 * math.cos(phase * math.tau))
    # Max distance from a corner-ish anchor keeps the falloff smooth.
    yy, xx = np.mgrid[0:H, 0:W]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    dist = dist / dist.max()
    # Blend two accent colours by the phase.
    top = mix(ACCENT, ACCENT2, 0.5 + 0.5 * math.sin(phase * math.tau))
    bot = mix((12, 16, 34), (20, 14, 44), 0.5 + 0.5 * math.cos(phase * math.tau))
    img = np.zeros((H, W, 3), dtype=np.float32)
    for i in range(3):
        img[..., i] = lerp(BG[i], top[i], (1.0 - dist) ** 2.2) * 0.85 + bot[i] * 0.15
    # Gentle vignette.
    vig = np.clip(1.0 - 0.35 * dist ** 2.5, 0.55, 1.0)
    return (img * vig[..., None]).clip(0, 255).astype(np.uint8)


def draw_rings(draw, t):
    """Expanding rings from the centre, staggered so they keep arriving."""
    cx, cy = W / 2, H * 0.48
    for i in range(4):
        # Each ring starts at a different point in the loop.
        p = (t / SECONDS + i / 4.0) % 1.0
        radius = p * (W * 0.62)
        alpha = max(0.0, 1.0 - p) ** 1.6
        if alpha <= 0.01:
            continue
        col = mix(ACCENT, CYAN, p * 0.8)
        # Outer faint ring.
        draw.ellipse(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            outline=col,
            width=2,
        )
        # Soft inner glow approximated by a thicker, lower-alpha ring is not
        # possible with ImageDraw alpha, so use a second thinner ring instead.
        if radius > 6:
            draw.ellipse(
                [cx - radius * 0.62, cy - radius * 0.62, cx + radius * 0.62, cy + radius * 0.62],
                outline=mix(col, (255, 255, 255), 0.25),
                width=1,
            )
    # The solid core orb.
    pulse = 0.5 + 0.5 * math.sin(t / SECONDS * math.tau * 1.6)
    r = 10 + pulse * 7
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=CYAN)
    # A faint outer halo ring around the orb.
    draw.ellipse(
        [cx - r - 7, cy - r - 7, cx + r + 7, cy + r + 7],
        outline=(96, 220, 255),
        width=1,
    )


def render_frames():
    frames = []
    for n in range(N_FRAMES):
        t = (n / N_FRAMES) * SECONDS
        base = radial_bg(t)
        img = Image.fromarray(base, "RGB").convert("RGBA")
        # Semi-transparent additive layer for the rings.
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        draw_rings(ImageDraw.Draw(overlay), t)
        # Blend overlay onto base using 'screen'-ish behaviour.
        base_rgba = base.astype(np.float32) / 255.0
        over = np.asarray(overlay, dtype=np.float32) / 255.0
        alpha = over[..., 3:4]
        screen = 1.0 - (1.0 - base_rgba[..., :3]) * (1.0 - over[..., :3] * alpha)
        out = (screen * 255.0).clip(0, 255).astype(np.uint8)
        frames.append(Image.fromarray(out, "RGB"))
    return frames


def write_gif(frames):
    os.makedirs(ASSETS, exist_ok=True)
    path = os.path.join(ASSETS, "default.gif")
    frames[0].save(
        path,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=int(1000 / FPS),
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"wrote {path} ({os.path.getsize(path)} bytes, {len(frames)} frames)")


def write_wav():
    import wave

    rate = 44100
    seconds = SECONDS
    n = int(rate * seconds)
    t = np.arange(n) / rate

    # A soft Cmaj9 pad: C3 E3 G3 B3 C4, slow attack and release.
    chord = [261.63, 329.63, 392.00, 493.88, 523.25]
    gain = [0.16, 0.13, 0.11, 0.08, 0.07]
    phase = t / seconds
    env = np.minimum(1.0, phase / 0.12) * np.minimum(1.0, (1.0 - phase) / 0.30)
    env = np.clip(env, 0.0, 1.0)
    sig = np.zeros(n, dtype=np.float64)
    for f, g in zip(chord, gain):
        # Slight detune for warmth.
        sig += g * np.sin(2 * math.pi * f * t + 0.3) * env
        sig += g * 0.35 * np.sin(2 * math.pi * f * 1.004 * t) * env

    # Sparkle arpeggio in the second half.
    arp = [523.25, 659.25, 783.99, 987.77, 1046.50, 987.77, 783.99, 659.25]
    step = 0.16
    count = int((SECONDS - 1.0) / step)
    for i in range(count):
        start = int((1.0 + i * step) * rate)
        length = int(rate * 0.14)
        if start >= n:
            break
        length = min(length, n - start)
        tt = np.arange(length) / rate
        f = arp[i % len(arp)]
        local = np.sin(2 * math.pi * f * tt)
        local *= np.exp(-tt / 0.055)
        seg = local * 0.055
        sig[start:start + length] += seg

    # Gentle low-pass by a one-pole filter for a softer tone.
    a = 0.35
    out = np.zeros(n)
    acc = 0.0
    for i in range(n):
        acc += a * (sig[i] - acc)
        out[i] = acc

    # Fade the very beginning and end to avoid clicks.
    fade = int(rate * 0.01)
    out[:fade] *= np.linspace(0, 1, fade)
    out[-fade:] *= np.linspace(1, 0, fade)

    peak = np.max(np.abs(out)) or 1.0
    out = out / peak * 0.85
    pcm = (out * 32767).astype("<i2")

    os.makedirs(ASSETS, exist_ok=True)
    path = os.path.join(ASSETS, "default.wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    print(f"wrote {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    frames = render_frames()
    write_gif(frames)
    write_wav()
