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

# Gehäusefarben. Die Namen entsprechen den Gerätekommentaren in Zigbee2MQTT.
VARIANTS = {
    "red": {"label": "Red", "base": "#C4695E", "light": "#D68C83", "dark": "#A34F45"},
    "beige": {"label": "Beige", "base": "#D9C7AC", "light": "#EBDCC6", "dark": "#B8A488"},
    "green": {"label": "Green", "base": "#4C7A52", "light": "#6B9B71", "dark": "#365939"},
}

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
    <rect x="18" y="12" width="164" height="300" rx="72" fill="url(#body-{key})"/>
    <rect x="18" y="12" width="164" height="300" rx="72" fill="none"
          stroke="#000" stroke-opacity="0.16" stroke-width="1.5"/>
  </g>

  <!-- Scrollrad: einfarbig, ohne Glanz. Nur eine feine Fuge zeigt, dass es ein
       eigenes Bauteil ist. -->
  <g>
    <circle cx="100" cy="112" r="55" fill="{base}"/>
    <circle cx="100" cy="112" r="55" fill="none" stroke="#000"
            stroke-opacity="0.18" stroke-width="2"/>
  </g>

  <!-- Kanal-LEDs. Die untere Taste ist von aussen nicht sichtbar und daher
       bewusst nicht dargestellt. -->
  <g>
    <circle id="led-1" class="led" cx="72"  cy="232" r="6"/>
    <circle id="led-2" class="led" cx="100" cy="232" r="6"/>
    <circle id="led-3" class="led" cx="128" cy="232" r="6"/>
    <circle class="led-ring" cx="72"  cy="232" r="8"/>
    <circle class="led-ring" cx="100" cy="232" r="8"/>
    <circle class="led-ring" cx="128" cy="232" r="8"/>
  </g>
</svg>
"""


def main():
    target = pathlib.Path(
        sys.argv[1] if len(sys.argv) > 1 else "custom_components/bilresa_remote/www/images"
    )
    target.mkdir(parents=True, exist_ok=True)
    for key, v in VARIANTS.items():
        svg = TEMPLATE.format(key=key, **v)
        path = target / f"bilresa-{key}.svg"
        path.write_text(svg, encoding="utf-8")
        print(f"{path}  ({len(svg)} Bytes)")


if __name__ == "__main__":
    main()
