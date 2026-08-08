#!/usr/bin/env python3
"""Erzeugt die BILRESA-Illustrationen als SVG — eine Datei je Gehäusefarbe.

Schematische Darstellung, kein Produktfoto: Gehäuse, Scrollrad, die drei
Kanal-LEDs und die untere Taste. Die LEDs tragen IDs (led-1..3), damit das
Frontend den aktiven Kanal per CSS hervorheben kann, ohne neue Dateien zu
brauchen.

    python3 tools/make_remote_svg.py [zielverzeichnis]
"""
import pathlib
import sys

# Gehäusefarben. Die Namen entsprechen den Gerätekommentaren in Zigbee2MQTT.
VARIANTS = {
    "red":   {"label": "Red",   "base": "#B8352B", "light": "#D6564B", "dark": "#8A231B"},
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
    <radialGradient id="wheel-{key}" cx="0.38" cy="0.32" r="0.85">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.30"/>
      <stop offset="60%" stop-color="#000000" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.28"/>
    </radialGradient>
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
    <rect x="18" y="12" width="164" height="300" rx="34" fill="url(#body-{key})"/>
    <rect x="18" y="12" width="164" height="300" rx="34" fill="none"
          stroke="#000" stroke-opacity="0.16" stroke-width="1.5"/>
    <!-- Glanzkante oben links -->
    <path d="M52 12 h96 a34 34 0 0 1 34 34 v10 a34 34 0 0 0 -34 -34 h-96
             a34 34 0 0 0 -34 34 v-10 a34 34 0 0 1 34 -34 z"
          fill="#FFF" fill-opacity="0.22"/>
  </g>

  <!-- Scrollrad -->
  <g>
    <circle cx="100" cy="112" r="60" fill="#000" fill-opacity="0.10"/>
    <circle cx="100" cy="112" r="55" fill="{dark}"/>
    <circle cx="100" cy="112" r="55" fill="url(#wheel-{key})"/>
    <circle cx="100" cy="112" r="55" fill="none" stroke="#000"
            stroke-opacity="0.25" stroke-width="1.5"/>
    <!-- Rändelung -->
    <g stroke="#000" stroke-opacity="0.20" stroke-width="2" stroke-linecap="round">
{knurl}
    </g>
    <circle cx="100" cy="112" r="21" fill="{base}" fill-opacity="0.92"/>
    <circle cx="100" cy="112" r="21" fill="none" stroke="#000"
            stroke-opacity="0.18" stroke-width="1.2"/>
  </g>

  <!-- Kanal-LEDs -->
  <g>
    <circle id="led-1" class="led" cx="72"  cy="218" r="6"/>
    <circle id="led-2" class="led" cx="100" cy="218" r="6"/>
    <circle id="led-3" class="led" cx="128" cy="218" r="6"/>
    <circle class="led-ring" cx="72"  cy="218" r="8"/>
    <circle class="led-ring" cx="100" cy="218" r="8"/>
    <circle class="led-ring" cx="128" cy="218" r="8"/>
  </g>

  <!-- Untere Taste (Kanalwechsel) -->
  <g>
    <rect x="62" y="248" width="76" height="42" rx="21" fill="{dark}"/>
    <rect x="62" y="248" width="76" height="42" rx="21" fill="none"
          stroke="#000" stroke-opacity="0.22" stroke-width="1.4"/>
    <rect x="62" y="248" width="76" height="21" rx="21" fill="#FFF" fill-opacity="0.10"/>
  </g>
</svg>
"""


def knurling(cx=100.0, cy=112.0, r_out=51.0, r_in=44.0, n=36):
    """Radiale Rändelungsstriche am Rad."""
    import math
    out = []
    for i in range(n):
        a = (2 * math.pi / n) * i
        x1, y1 = cx + r_in * math.cos(a), cy + r_in * math.sin(a)
        x2, y2 = cx + r_out * math.cos(a), cy + r_out * math.sin(a)
        out.append(f'      <line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}"/>')
    return "\n".join(out)


def main():
    target = pathlib.Path(sys.argv[1] if len(sys.argv) > 1
                          else "custom_components/bilresa/www/images")
    target.mkdir(parents=True, exist_ok=True)
    knurl = knurling()
    for key, v in VARIANTS.items():
        svg = TEMPLATE.format(key=key, knurl=knurl, **v)
        path = target / f"bilresa-{key}.svg"
        path.write_text(svg, encoding="utf-8")
        print(f"{path}  ({len(svg)} Bytes)")


if __name__ == "__main__":
    main()
