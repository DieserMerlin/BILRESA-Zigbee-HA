#!/usr/bin/env python3
"""Erzeugt die BILRESA-Illustrationen als SVG — eine Datei je Gehäusefarbe.

Schematische Darstellung, kein Produktfoto: Gehäuse, das glatte Scrollrad und
die drei Kanal-LEDs. Das Rad ist einfarbig wie das Gehäuse — nur eine feine Fuge
zeigt es an. Die untere Taste ist von aussen nicht sichtbar und wird deshalb
nicht dargestellt.

Die LEDs tragen IDs (led-1..3), damit das Frontend den aktiven Kanal per CSS
hervorheben kann, ohne neue Dateien zu brauchen.

    python3 tools/make_remote_svg.py [zielverzeichnis]
"""

import pathlib
import sys

# Gehaeusefarben der BILRESA. Hex-Werte aus den IKEA-Studiofotos gemessen.
# Offizielle Namen laut Produktseiten: Beige, Rostrot, Blaugruen, Weiss.
# Die drei Bunten gibt es nur im 3er-Set, Weiss auch einzeln. Kein Schwarz.
# Wichtig: Zigbee2MQTT kennt die Gehaeusefarbe NICHT - sie steht in keiner
# Geraetedefinition und in keinem Payload. Die Zuordnung ist deshalb manuell
# (bei Merlin ueber den freien Geraetekommentar in Z2M).
VARIANTS = {
    "red": {"label": "Rust red", "base": "#A94E41", "light": "#C26C57", "dark": "#8B4238"},
    "beige": {"label": "Beige", "base": "#CCBDAC", "light": "#DED8CE", "dark": "#B0A08F"},
    "green": {"label": "Teal green", "base": "#547D70", "light": "#789F90", "dark": "#496457"},
    "white": {"label": "White", "base": "#E2E2E0", "light": "#EAEAE7", "dark": "#C6C6C2"},
}

# --------------------------------------------------------------------------- #
# Geometrie
#
# Alles folgt aus einer einzigen Breitenangabe. Die vom Nutzer als richtig
# bestaetigten Abstaende - Rad zum Rand, LED-Reihe zum Rad, LED zu LED - sind
# hier als Konstanten festgehalten und bleiben damit bei jeder Breite erhalten.
# --------------------------------------------------------------------------- #

VIEW_W, VIEW_H = 200.0, 330.0
BODY_TOP, BODY_H = 12.0, 300.0
WHEEL_GAP = 7.0  # Rad zum Gehaeuserand
LED_GAP = 27.0  # LED-Mitte unter der Radunterkante
LED_PITCH = 18.0  # Abstand der LED-Mitten
LED_R = 6.0


def geometry(body_w: float) -> dict[str, float]:
    """Leitet die komplette Geometrie aus der Gehaeusebreite ab."""
    x = (VIEW_W - body_w) / 2
    radius = body_w / 2  # Pillenform: oben und unten voll rund
    wheel_cy = BODY_TOP + radius  # konzentrisch im runden Kopf
    wheel_r = radius - WHEEL_GAP
    return {
        "x": x,
        "y": BODY_TOP,
        "w": body_w,
        "h": BODY_H,
        "rx": radius,
        "wheel_cx": VIEW_W / 2,
        "wheel_cy": wheel_cy,
        "wheel_r": wheel_r,
        "led_cy": wheel_cy + wheel_r + LED_GAP,
        "led_r": LED_R,
        "led_1": VIEW_W / 2 - LED_PITCH,
        "led_2": VIEW_W / 2,
        "led_3": VIEW_W / 2 + LED_PITCH,
    }


#: Gehaeusebreite. 164 war die erste Fassung; der Nutzer wollte sie breiter.
BODY_WIDTH = 184.0


TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 330"
     role="img" aria-label="IKEA BILRESA remote, {label}" class="bilresa bilresa--{key}">
  <title>IKEA BILRESA — {label}</title>
  <defs>
    <linearGradient id="body-{key}" x1="0.25" y1="0" x2="0.75" y2="1">
      <stop offset="0%" stop-color="{light}"/>
      <stop offset="55%" stop-color="{base}"/>
      <stop offset="100%" stop-color="{dark}"/>
    </linearGradient>
    <filter id="shadow-{key}" x="-30%" y="-20%" width="160%" height="150%">
      <feDropShadow dx="0" dy="5" stdDeviation="7" flood-color="#000" flood-opacity="0.28"/>
    </filter>
    <filter id="glow-{key}" x="-160%" y="-160%" width="420%" height="420%">
      <feGaussianBlur stdDeviation="3.2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <style>
    .bilresa .led {{ fill: #2A2A2A; fill-opacity: .55; transition: fill .18s ease; }}
    .bilresa .led-ring {{ fill: none; stroke: #000; stroke-opacity: .22; stroke-width: 1.2; }}
    /* Aktiver Kanal: .mode-1 / .mode-2 / .mode-3 auf einem Vorfahren setzen. */
    .bilresa.mode-1 #led-1, .bilresa.mode-2 #led-2, .bilresa.mode-3 #led-3,
    .bilresa .led.is-active {{ fill: #FFF3D0; fill-opacity: 1; filter: url(#glow-{key}); }}
  </style>

  <!-- Gehäuse -->
  <g filter="url(#shadow-{key})">
    <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="url(#body-{key})"/>
    <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="none"
          stroke="#000" stroke-opacity="0.16" stroke-width="1.5"/>
  </g>

  <!-- Scrollrad: einfarbig, ohne Glanz. Nur eine feine Fuge zeigt, dass es ein
       eigenes Bauteil ist. -->
  <g>
    <circle cx="{wheel_cx}" cy="{wheel_cy}" r="{wheel_r}" fill="{base}"/>
    <circle cx="{wheel_cx}" cy="{wheel_cy}" r="{wheel_r}" fill="none" stroke="#000"
            stroke-opacity="0.18" stroke-width="2"/>
  </g>

  <!-- Kanal-LEDs. Die untere Taste ist von aussen nicht sichtbar und daher
       bewusst nicht dargestellt. -->
  <g>
    <circle id="led-1" class="led" cx="{led_1}" cy="{led_cy}" r="{led_r}"/>
    <circle id="led-2" class="led" cx="{led_2}" cy="{led_cy}" r="{led_r}"/>
    <circle id="led-3" class="led" cx="{led_3}" cy="{led_cy}" r="{led_r}"/>
    <circle class="led-ring" cx="{led_1}" cy="{led_cy}" r="8"/>
    <circle class="led-ring" cx="{led_2}" cy="{led_cy}" r="8"/>
    <circle class="led-ring" cx="{led_3}" cy="{led_cy}" r="8"/>
  </g>
</svg>
"""


def main():
    target = pathlib.Path(
        sys.argv[1] if len(sys.argv) > 1 else "custom_components/bilresa_remote/www/images"
    )
    target.mkdir(parents=True, exist_ok=True)
    for key, v in VARIANTS.items():
        svg = TEMPLATE.format(key=key, **geometry(BODY_WIDTH), **v)
        path = target / f"bilresa-{key}.svg"
        path.write_text(svg, encoding="utf-8")
        print(f"{path}  ({len(svg)} Bytes)")


if __name__ == "__main__":
    main()
