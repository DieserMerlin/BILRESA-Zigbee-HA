#!/usr/bin/env python3
"""Rendert die Integrations-Icons als PNG — nur Standardbibliothek.

Home Assistant liefert seit 2024.11 Icons direkt aus dem Integrationsordner aus
(``icon.png``, ``icon@2x.png``, ``dark_icon.png``); ein PR ins brands-Repo ist
dann nicht mehr noetig.

Gezeichnet wird dieselbe Form wie in den SVGs: abgerundetes Gehaeuse, glattes
Scrollrad, drei Kanal-LEDs. Kantenglaettung ueber vorzeichenbehaftete
Abstandsfunktionen, damit ein Sample je Pixel reicht.

    python3 tools/make_brand_png.py [zielverzeichnis]
"""

from __future__ import annotations

import binascii
import pathlib
import struct
import sys
import zlib

# Ausgangskoordinaten sind die viewBox der SVGs (200 x 330).
VB_W, VB_H = 200.0, 330.0
BODY = (8.0, 12.0, 184.0, 300.0, 92.0)  # x, y, w, h, radius (voll rund)
WHEEL = (100.0, 104.0, 85.0)  # cx, cy, r — fast randbuendig im runden Kopf
LEDS = ((82.0, 216.0), (100.0, 216.0), (118.0, 216.0))
LED_R = 6.0

LIGHT = (0xC2, 0x6C, 0x57)
BASE = (0xA9, 0x4E, 0x41)
DARK = (0x8B, 0x42, 0x38)
SEAM = (0x00, 0x00, 0x00, 0.18)
LED_OFF = (0x2A, 0x2A, 0x2A)
LED_ON = (0xFF, 0xF3, 0xD0)


def _rounded_rect_sdf(px: float, py: float) -> float:
    """Signed distance to the body outline; negative means inside."""
    x, y, w, h, r = BODY
    cx, cy = x + w / 2, y + h / 2
    dx = abs(px - cx) - (w / 2 - r)
    dy = abs(py - cy) - (h / 2 - r)
    ax, ay = max(dx, 0.0), max(dy, 0.0)
    return (ax * ax + ay * ay) ** 0.5 + min(max(dx, dy), 0.0) - r


def _circle_sdf(px: float, py: float, cx: float, cy: float, r: float) -> float:
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5 - r


def _coverage(sdf: float, aa: float) -> float:
    """Map a signed distance to 0..1 coverage across one pixel."""
    return min(max(0.5 - sdf / aa, 0.0), 1.0)


def _blend(dst: list[float], src: tuple[float, float, float], alpha: float) -> None:
    if alpha <= 0:
        return
    for i in range(3):
        dst[i] = dst[i] * (1 - alpha) + src[i] * alpha
    dst[3] = dst[3] + (1 - dst[3]) * alpha


def render(size: int, *, dark_theme: bool = False) -> bytes:
    """Render one icon and return raw RGBA rows joined with PNG filter bytes."""
    margin = size * 0.05
    scale = (size - 2 * margin) / VB_H
    off_x = (size - VB_W * scale) / 2
    off_y = margin
    aa = 1.0 / scale  # one pixel expressed in viewBox units

    led_on = LED_ON if not dark_theme else (0xFF, 0xF8, 0xE4)
    rows = bytearray()

    for py in range(size):
        vy = (py + 0.5 - off_y) / scale
        row = bytearray(b"\x00")
        for px in range(size):
            vx = (px + 0.5 - off_x) / scale
            pixel = [0.0, 0.0, 0.0, 0.0]

            body = _coverage(_rounded_rect_sdf(vx, vy), aa)
            if body > 0:
                # Vertikaler Verlauf wie im SVG.
                t = min(max((vy - BODY[1]) / BODY[3], 0.0), 1.0)
                if t < 0.55:
                    k = t / 0.55
                    col = tuple(LIGHT[i] + (BASE[i] - LIGHT[i]) * k for i in range(3))
                else:
                    k = (t - 0.55) / 0.45
                    col = tuple(BASE[i] + (DARK[i] - BASE[i]) * k for i in range(3))
                _blend(pixel, col, body)

                wheel = _coverage(_circle_sdf(vx, vy, *WHEEL), aa)
                if wheel > 0:
                    _blend(pixel, BASE, wheel)
                    ring = abs(_circle_sdf(vx, vy, *WHEEL))
                    seam = _coverage(ring - 1.0, aa)
                    if seam > 0:
                        _blend(pixel, SEAM[:3], seam * SEAM[3])

                for index, (lx, ly) in enumerate(LEDS):
                    led = _coverage(_circle_sdf(vx, vy, lx, ly, LED_R), aa)
                    if led > 0:
                        _blend(pixel, led_on if index == 0 else LED_OFF, led)

            row += bytes(round(min(max(c, 0.0), 255.0)) for c in pixel[:3])
            row += bytes((round(min(max(pixel[3], 0.0), 1.0) * 255),))
        rows += row
    return bytes(rows)


def write_png(path: pathlib.Path, size: int, raw: bytes) -> None:
    """Write a minimal 8-bit RGBA PNG."""

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", binascii.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    data = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(data)
    print(f"{path}  {size}x{size}  ({len(data)} Bytes)")


def main() -> None:
    target = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "custom_components/bilresa_remote")
    target.mkdir(parents=True, exist_ok=True)
    write_png(target / "icon.png", 256, render(256))
    write_png(target / "icon@2x.png", 512, render(512))
    write_png(target / "dark_icon.png", 256, render(256, dark_theme=True))
    write_png(target / "logo.png", 256, render(256))


if __name__ == "__main__":
    main()
