"""Generate the launcher icon PNGs.

The APK is assembled without Gradle, so adaptive-icon XML is avoided and plain
PNGs are written per density. The artwork mirrors the gateway's own icon: a
monitor and a phone sharing one blue field.

Run:  python make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
SIZES = {
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
}

BLUE = (76, 141, 255)
WHITE = (255, 255, 255)


def draw_icon(size: int) -> Image.Image:
    """Render one square icon at `size` pixels."""
    # Draw at 4x and downsample: PIL has no antialiased primitives.
    scale = 4
    big = size * scale
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    radius = int(big * 0.22)
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=BLUE)

    # Monitor: an outlined rectangle with a stand.
    left = int(big * 0.20)
    top = int(big * 0.28)
    right = int(big * 0.62)
    bottom = int(big * 0.57)
    stroke = max(2, int(big * 0.037))
    draw.rounded_rectangle(
        [left, top, right, bottom],
        radius=int(big * 0.035),
        outline=WHITE,
        width=stroke,
    )
    stand_y = int(big * 0.68)
    draw.line([int(big * 0.31), stand_y, int(big * 0.51), stand_y], fill=WHITE, width=stroke)
    draw.line(
        [int(big * 0.41), bottom, int(big * 0.41), stand_y],
        fill=WHITE,
        width=stroke,
    )

    # Phone: a filled rounded rectangle, overlapping the monitor's right edge.
    phone_left = int(big * 0.57)
    phone_top = int(big * 0.50)
    phone_right = int(big * 0.80)
    phone_bottom = int(big * 0.80)
    draw.rounded_rectangle(
        [phone_left, phone_top, phone_right, phone_bottom],
        radius=int(big * 0.045),
        fill=WHITE,
    )
    # Home indicator, so the shape reads as a phone rather than a card.
    draw.rounded_rectangle(
        [
            int(big * 0.655),
            int(big * 0.745),
            int(big * 0.715),
            int(big * 0.762),
        ],
        radius=int(big * 0.012),
        fill=BLUE,
    )

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    for folder, size in SIZES.items():
        target = ROOT / "res" / folder
        target.mkdir(parents=True, exist_ok=True)
        icon = draw_icon(size)
        path = target / "ic_launcher.png"
        icon.save(path, "PNG", optimize=True)
        print(f"wrote {path.relative_to(ROOT)} ({size}x{size}, {path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
