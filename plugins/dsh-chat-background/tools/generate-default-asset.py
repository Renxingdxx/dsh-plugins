"""
Generate the bundled default background for the dsh-chat-background plugin.

No video encoder is available on this machine (ffmpeg ships only as Chromium's
shared library), so the default is an ANIMATED GIF. A GIF loops by construction,
which is exactly what a background needs, and the plugin treats it exactly like
a video file: it plays it in a looping media element.

The animation is a sum of moving radial glows on a near-black field. The phase
advances uniformly across the frame count, so the last frame differs from the
first by exactly one step -- the loop is visually seamless.

Output:
  assets/default.gif   480x270, 48 frames, ~2.0 s loop, loops forever
"""

import math
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")

W, H = 480, 270
FPS = 24
SECONDS = 2.0
N_FRAMES = int(round(FPS * SECONDS))

# Accent palette for the moving glows.
BLOBS = [
    (120, 90, 255),   # violet
    (60, 200, 255),   # cyan
    (230, 90, 190),   # magenta
    (70, 255, 190),   # teal
]

# (amplitude_x, amplitude_y, freq_x, freq_y, phase_x, phase_y, radius)
TRAJECTORY = [
    (0.42, 0.30, 1.0, 1.0, 0.0, 0.0, 0.55),
    (0.36, 0.42, 1.0, -1.0, 1.7, 0.6, 0.48),
    (0.30, 0.34, -1.0, 1.0, 3.1, 2.4, 0.44),
    (0.28, 0.26, -1.0, -1.0, 4.4, 4.0, 0.40),
]


def render_frame(phase):
    """Render one frame at the given phase in [0, 2*pi)."""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    # Normalised coordinates centred on the frame.
    nx = (xx - W / 2.0) / (W / 2.0)
    ny = (yy - H / 2.0) / (H / 2.0)

    img = np.zeros((H, W, 3), dtype=np.float32)
    img[..., 0] = 6.0   # near-black base
    img[..., 1] = 7.0
    img[..., 2] = 12.0

    for color, (ax, ay, fx, fy, px, py, radius) in zip(BLOBS, TRAJECTORY):
        cx = ax * math.cos(fx * phase + px)
        cy = ay * math.sin(fy * phase + py)
        dx = nx - cx
        dy = ny - cy
        dist = np.sqrt(dx * dx + dy * dy)
        # Smooth falloff: 1 at the centre, 0 at `radius`.
        falloff = np.clip(1.0 - dist / radius, 0.0, 1.0) ** 2.0
        # A slow brightness pulse keeps the field alive without flicker. Its
        # frequency is an integer so the field is exactly periodic over one loop.
        pulse = 0.78 + 0.22 * math.sin(phase + px)
        img[..., 0] += color[0] * falloff * pulse
        img[..., 1] += color[1] * falloff * pulse
        img[..., 2] += color[2] * falloff * pulse

    # 'screen' blend so overlapping glows add up instead of saturating.
    out = 255.0 * (1.0 - (1.0 - img / 255.0) * (1.0 - img / 255.0))

    # Gentle vignette so the edges stay dark and the centre reads as the subject.
    cx0 = W / 2.0
    cy0 = H / 2.0
    d = np.sqrt(((xx - cx0) / (W / 2.0)) ** 2 + ((yy - cy0) / (H / 2.0)) ** 2)
    vig = np.clip(1.0 - 0.30 * d ** 2.2, 0.62, 1.0)
    out = out * vig[..., None]

    return np.clip(out, 0, 255).astype(np.uint8)


def main():
    os.makedirs(ASSETS, exist_ok=True)
    frames = []
    # Sample the phase across the WHOLE circle including both endpoints, so the
    # last frame equals the first exactly and the loop is byte-for-byte seamless.
    for n in range(N_FRAMES):
        phase = (2.0 * math.pi * n) / (N_FRAMES - 1)
        frames.append(Image.fromarray(render_frame(phase), "RGB"))

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


if __name__ == "__main__":
    main()
