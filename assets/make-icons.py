"""
The mark, drawn rather than exported.

One creature, two jobs: the app icon is the jelly on its red ground, and the
menu-bar icon is the same silhouette in black with the ground taken away —
macOS tints a template image itself, so a coloured tray icon would be wrong in
dark mode and wrong again in light.

Everything here is geometry, so the icon is regenerated rather than kept as a
binary nobody can edit: run `python3 assets/make-icons.py`.
"""
import math
import os
import subprocess

from PIL import Image, ImageDraw

RED = (245, 61, 61)
INK = (14, 14, 16)
WHITE = (255, 255, 255)
SS = 4                      # supersample, then down


def squircle_mask(size, n=5.0):
    m = Image.new("L", (size, size), 0)
    a = size / 2
    pts = []
    for i in range(1441):
        t = i / 1440 * 2 * math.pi
        ct, st = math.cos(t), math.sin(t)
        pts.append((a + a * math.copysign(abs(ct) ** (2 / n), ct),
                    a + a * math.copysign(abs(st) ** (2 / n), st)))
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m


def blob(d, cx, cy, r, wobble=0.07, phase=0.6, fill=INK):
    """
    A body, not a circle.

    The creature is a pressurised ring that never sits still, so the icon takes
    one frame of that: the radius breathes around the ring on two harmonics,
    which is enough to read as soft without looking like a splat.
    """
    pts = []
    for i in range(720):
        t = i / 720 * 2 * math.pi
        rr = r * (1 + wobble * math.sin(t * 3 + phase) + wobble * 0.55 * math.sin(t * 5 - phase))
        pts.append((cx + rr * math.cos(t), cy + rr * math.sin(t)))
    d.polygon(pts, fill=fill)


def eyes(d, cx, cy, r, look=(0.16, 0.10), white=WHITE, pupil=INK):
    """Two eyes, looking slightly off — it tracks the cursor with inertia, so
       it is always a beat behind wherever you are."""
    gap, eye_r, pupil_r = r * 0.38, r * 0.235, r * 0.105
    for s in (-1, 1):
        ex, ey = cx + s * gap, cy - r * 0.06
        d.ellipse([ex - eye_r, ey - eye_r, ex + eye_r, ey + eye_r], fill=white)
        px, py = ex + eye_r * look[0], ey + eye_r * look[1]
        d.ellipse([px - pupil_r, py - pupil_r, px + pupil_r, py + pupil_r], fill=pupil)


def app_icon(size=1024):
    W = size * SS
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ground = Image.new("RGBA", (W, W), RED + (255,))
    img.paste(ground, (0, 0), squircle_mask(W))
    d = ImageDraw.Draw(img)
    r = W * 0.30
    blob(d, W / 2, W * 0.52, r)
    eyes(d, W / 2, W * 0.50, r)
    return img.resize((size, size), Image.LANCZOS)


def tray_icon(size=32):
    """Black on transparent: a template image, which macOS inverts for dark
       mode on its own."""
    W = size * SS
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = W * 0.40
    blob(d, W / 2, W * 0.54, r, fill=(0, 0, 0, 255))
    # The eyes are holes at this size, not white discs — 16px of white inside
    # black turns to grey mush.
    gap, eye_r = r * 0.38, r * 0.20
    for s in (-1, 1):
        ex, ey = W / 2 + s * gap, W * 0.50
        d.ellipse([ex - eye_r, ey - eye_r, ex + eye_r, ey + eye_r], fill=(0, 0, 0, 0))
    return img.resize((size, size), Image.LANCZOS)


here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)

icon = app_icon(1024)
icon.save(os.path.join(here, "icon.png"))

# The iconset macOS wants, then .icns
iconset = os.path.join(here, "icon.iconset")
os.makedirs(iconset, exist_ok=True)
for px in (16, 32, 64, 128, 256, 512, 1024):
    icon.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, f"icon_{px}x{px}.png"))
    if px <= 512:
        icon.resize((px * 2, px * 2), Image.LANCZOS).save(
            os.path.join(iconset, f"icon_{px}x{px}@2x.png"))
subprocess.run(["iconutil", "-c", "icns", iconset, "-o",
                os.path.join(root, "build", "icon.icns")], check=True)

tray_icon(16).save(os.path.join(root, "desktop", "tray.png"))
tray_icon(32).save(os.path.join(root, "desktop", "tray@2x.png"))
print("icon.png, build/icon.icns, desktop/tray.png, desktop/tray@2x.png")
