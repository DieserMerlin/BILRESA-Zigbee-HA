/**
 * Shared design system for the BILRESA panel.
 *
 * Exported as a plain string so every shadow root can drop it into a <style>
 * tag without a build step. Colours come exclusively from Home Assistant theme
 * variables; the only literal colours are the three housing colours of the
 * remote, which must match the shipped SVG illustrations in both themes.
 *
 * ---------------------------------------------------------------------------
 * TOKENS  (declared on :host, so every component sees them)
 * ---------------------------------------------------------------------------
 *   Spacing, strict 4px raster — use these instead of literal pixels:
 *     --bil-space-1 .. --bil-space-8   4 8 12 16 20 24 32 40
 *     --bil-gap      = --bil-space-4   (legacy alias, still supported)
 *     --bil-gap-lg   = --bil-space-6   (legacy alias, still supported)
 *   Radii:    --bil-radius-xs|sm|md|lg, --bil-pill
 *   Type:     --bil-font-2xs|xs|sm|md|lg|xl|2xl|3xl  (11 12 13 14 16 18 22 27)
 *   Leading:  --bil-line-tight|snug|normal|relaxed   (1.25 1.35 1.5 1.65)
 *   Controls: --bil-control (44px touch target), --bil-control-sm
 *   Focus:    --bil-focus-width, --bil-focus-offset, --bil-focus-color
 *   Colour roles: --bil-text (primary), --bil-text-dim (secondary),
 *                 --bil-text-soft (muted/tertiary), --bil-accent,
 *                 --bil-error|success|warning, --bil-surface, --bil-page
 *   Housing:  --bil-housing-red|beige|green, --bil-led-on
 *
 * ---------------------------------------------------------------------------
 * CLASSES ADDED IN THIS REVISION (other components may use them)
 * ---------------------------------------------------------------------------
 *   .empty-state        replaces the old bare `.empty` block. `.empty` alone
 *                       is no longer a full empty-state box, because
 *                       `.slot-summary.empty` in remote-editor.js collided
 *                       with it and inherited 44px of centring padding.
 *   .card.flush         card without padding, for .card-head/-body/-foot
 *   .card-head          card header row  (same horizontal raster as the body)
 *   .card-body          card content area
 *   .card-foot          card footer, separated by a divider
 *   .form-grid          responsive grid of .field boxes, top aligned
 *   .form-actions       right aligned action row under a .form-grid
 *   .placeholder        reserved-height slot for "loading" / "nothing here"
 *                       text so the two states never shift the layout
 *   .hint               now works standalone, not only inside .field
 *   .eyebrow            small uppercase label above a block
 *   .live-text .live-hint .live-time   parts of the live strip
 *   .btn-label          button text that may be hidden on narrow screens
 *   .row.start .row.between .row.baseline   row alignment variants
 *   .stack.loose        stack with the large gap
 *   .soft               tertiary text colour
 *   .break              overflow-wrap: anywhere (IEEE addresses, errors)
 *
 * ---------------------------------------------------------------------------
 * TWO RULES EVERY COMPONENT INHERITS
 * ---------------------------------------------------------------------------
 *   `[hidden] { display: none !important }` — without it a .btn or .icon-btn
 *   toggled through `el.hidden` stays visible, because an author display rule
 *   outranks the user-agent [hidden] rule.
 *   Headings, paragraphs and <pre> start at `margin: 0`. Spacing comes from a
 *   flex/grid gap or an explicit rule, never from a user-agent margin that
 *   would collapse into its neighbour.
 */

export const sharedStyles = `
:host {
  /* ---------------------------------------------------------- spacing -- */
  /* One 4px raster for every gap, padding and margin in the panel. */
  --bil-space-1: 4px;
  --bil-space-2: 8px;
  --bil-space-3: 12px;
  --bil-space-4: 16px;
  --bil-space-5: 20px;
  --bil-space-6: 24px;
  --bil-space-7: 32px;
  --bil-space-8: 40px;

  /* Aliases: remote-editor.js, action-editor.js and guide.js reference these
     names, so they stay as thin wrappers over the scale above. */
  --bil-gap: var(--bil-space-4);
  --bil-gap-lg: var(--bil-space-6);

  /* ------------------------------------------------------------ radii -- */
  --bil-radius-xs: 6px;
  --bil-radius-sm: 8px;
  --bil-radius-md: 12px;
  --bil-radius-lg: var(--ha-card-border-radius, 16px);
  --bil-pill: 999px;

  /* ------------------------------------------------------------- type -- */
  --bil-font-2xs: 11px;
  --bil-font-xs: 12px;
  --bil-font-sm: 13px;
  --bil-font-md: 14px;
  --bil-font-lg: 16px;
  --bil-font-xl: 18px;
  --bil-font-2xl: 22px;
  --bil-font-3xl: 27px;

  --bil-line-tight: 1.25;
  --bil-line-snug: 1.35;
  --bil-line-normal: 1.5;
  --bil-line-relaxed: 1.65;

  /* --------------------------------------------------------- controls -- */
  --bil-control: 44px;
  --bil-control-sm: 36px;

  /* ------------------------------------------------------------ focus -- */
  --bil-focus-width: 2px;
  --bil-focus-offset: 2px;
  --bil-focus-color: var(--primary-color, #03a9f4);

  /* -------------------------------------------------- colours & lines -- */
  --bil-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.06), 0 2px 8px rgba(0, 0, 0, 0.06);
  --bil-shadow-2: 0 2px 6px rgba(0, 0, 0, 0.08), 0 12px 28px rgba(0, 0, 0, 0.12);
  --bil-line: var(--divider-color, rgba(127, 127, 127, 0.28));
  --bil-border: 1px solid var(--bil-line);
  --bil-surface: var(--card-background-color, var(--ha-card-background, #fff));
  --bil-page: var(--primary-background-color, #f4f5f7);
  --bil-text: var(--primary-text-color, #212121);
  --bil-text-dim: var(--secondary-text-color, #6b7280);
  --bil-text-soft: var(--secondary-text-color, #727272);
  --bil-text-soft: color-mix(in srgb, var(--bil-text-dim) 72%, transparent);
  --bil-accent: var(--primary-color, #03a9f4);
  --bil-on-accent: var(--text-primary-color, #fff);
  --bil-error: var(--error-color, #db4437);
  --bil-success: var(--success-color, #43a047);
  --bil-warning: var(--warning-color, #ffa600);

  /* Housing colours of the shipped illustrations — the documented exception
     to "colours only from HA variables". */
  --bil-housing-red: #c4695e;
  --bil-housing-beige: #d9c7ac;
  --bil-housing-green: #4c7a52;
  --bil-led-on: #fff3d0;

  /* Width of the small remote illustration on the overview cards. Its aspect
     ratio (200/330) drives the minimum card height further down. */
  --bil-remote-visual: 72px;

  display: block;
  box-sizing: border-box;
  min-height: 100%;
  background: var(--bil-page);
  color: var(--bil-text);
  font-family: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, Roboto, "Helvetica Neue", system-ui, sans-serif));
  font-size: var(--bil-font-md);
  line-height: var(--bil-line-normal);
  -webkit-font-smoothing: antialiased;
}

/* ----------------------------------------------------------------- reset -- */

*, *::before, *::after { box-sizing: inherit; }

/* User-agent margins on headings and paragraphs are the single biggest source
   of "the spacing is off": they stack on top of flex gaps and collapse into
   each other. Every block gets its spacing from a gap or an explicit rule. */
h1, h2, h3, h4, h5, h6,
p, figure, figcaption, blockquote, dl, dd, pre {
  margin: 0;
}

/* The author styles below set display on .btn, .icon-btn and friends, which
   beats the user-agent [hidden] rule no matter the specificity — without this
   line every element toggled via .hidden stays on screen. */
[hidden] { display: none !important; }

img, svg, video { max-width: 100%; }

/* ---------------------------------------------------------------- layout -- */

.app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  min-height: 100dvh;
  min-width: 0;
}

.content {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: var(--bil-space-6);
  width: 100%;
  min-width: 0;
  max-width: 1180px;
  margin: 0 auto;
  /* Bottom padding keeps the last row clear of the toast stack. */
  padding: var(--bil-space-6) var(--bil-space-6) calc(var(--bil-space-8) + var(--bil-space-7));
}

.stack { display: flex; flex-direction: column; gap: var(--bil-space-4); min-width: 0; }
.stack.tight { gap: var(--bil-space-2); }
.stack.loose { gap: var(--bil-space-6); }

.row { display: flex; align-items: center; gap: var(--bil-space-2); min-width: 0; }
.row.wrap { flex-wrap: wrap; }
.row.end { justify-content: flex-end; }
.row.start { justify-content: flex-start; }
.row.between { justify-content: space-between; }
.row.baseline { align-items: baseline; }
.spacer { flex: 1 1 auto; min-width: 0; }

.section {
  display: flex;
  flex-direction: column;
  gap: var(--bil-space-4);
  min-width: 0;
}

.section-head {
  display: flex;
  align-items: center;
  gap: var(--bil-space-4);
  flex-wrap: wrap;
  min-width: 0;
  margin-bottom: var(--bil-space-3);
}

/* Inside a .section the column gap already provides the rhythm. */
.section > .section-head { margin-bottom: 0; }

/* The title block has to be allowed to shrink, otherwise a long subtitle
   pushes the trailing button out of the row. */
.section-head > div { min-width: 0; }

.section-head h2 {
  font-size: var(--bil-font-xl);
  line-height: var(--bil-line-snug);
  font-weight: 600;
  letter-spacing: 0.01em;
}

.section-head p {
  margin-top: var(--bil-space-1);
  max-width: 68ch;
  color: var(--bil-text-dim);
  font-size: var(--bil-font-sm);
  line-height: var(--bil-line-normal);
}

/* min() keeps the track from being wider than a narrow viewport, which would
   produce a horizontal scrollbar. */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
  gap: var(--bil-space-4);
  align-items: stretch;
}

/* --------------------------------------------------------------- top bar -- */

/* Top bar and live strip stick together as one block, so their heights never
   have to be guessed for a second sticky offset. The background belongs on
   the sticky element itself, not only on its children. */
.chrome {
  position: sticky;
  top: 0;
  z-index: 4;
  background: var(--bil-surface);
}

.topbar {
  display: flex;
  align-items: center;
  gap: var(--bil-space-3);
  min-width: 0;
  padding: var(--bil-space-3) var(--bil-space-6);
  background: var(--app-header-background-color, var(--bil-surface));
  color: var(--app-header-text-color, var(--bil-text));
  border-bottom: var(--bil-border);
}

.topbar .titles { min-width: 0; flex: 1 1 auto; }

.topbar h1 {
  font-size: var(--bil-font-xl);
  line-height: var(--bil-line-snug);
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topbar .sub {
  font-size: var(--bil-font-xs);
  line-height: var(--bil-line-snug);
  color: var(--bil-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: var(--bil-space-2);
  flex: none;
}

/* -------------------------------------------------------------- livebar -- */

/* The reserved height is what the tallest state (the one with a chip) needs,
   so the sticky chrome keeps the same height whether an action came in or
   not — otherwise the whole page shifts on the first button press. */
.livebar {
  display: flex;
  align-items: center;
  gap: var(--bil-space-3);
  min-width: 0;
  min-height: 44px;
  padding: var(--bil-space-2) var(--bil-space-6);
  background: var(--bil-surface);
  border-bottom: var(--bil-border);
  font-size: var(--bil-font-sm);
  transition: background-color 0.4s ease;
}

.livebar .pulse {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--bil-text-dim);
  opacity: 0.45;
}

.livebar.is-live .pulse { background: var(--bil-success); opacity: 1; }
.livebar.is-hot { background: color-mix(in srgb, var(--bil-accent) 12%, var(--bil-surface)); }
.livebar.is-hot .pulse { animation: bil-ping 0.9s ease-out 1; }

/* The headline takes the free space and truncates; everything after it is
   flex: none, so nothing can be pushed out of the strip. */
.live-text {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  line-height: var(--bil-line-normal);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.live-hint {
  flex: 0 1 auto;
  min-width: 0;
  color: var(--bil-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.live-time {
  flex: none;
  color: var(--bil-text-dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ------------------------------------------------------------------ card -- */

.card {
  background: var(--bil-surface);
  border-radius: var(--bil-radius-lg);
  box-shadow: var(--bil-shadow-1);
  border: 1px solid transparent;
  padding: var(--bil-space-4);
  min-width: 0;
  color: inherit;
}

.card.pad-lg { padding: var(--bil-space-6); }
.card.flush { padding: 0; }
.card.outline { box-shadow: none; border: var(--bil-border); }

/* Head, body and foot share one horizontal raster so their content lines up
   vertically across the whole card. */
.card-head,
.card-body,
.card-foot {
  padding: var(--bil-space-4) var(--bil-space-5);
  min-width: 0;
}

.card-head {
  display: flex;
  align-items: center;
  gap: var(--bil-space-3);
  border-bottom: var(--bil-border);
}

.card-head h3 {
  font-size: var(--bil-font-lg);
  line-height: var(--bil-line-snug);
  font-weight: 600;
}

.card-foot { border-top: var(--bil-border); }

button.card,
.card.clickable {
  display: block;
  width: 100%;
  text-align: left;
  font: inherit;
  appearance: none;
  -webkit-appearance: none;
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}

button.card:hover,
.card.clickable:hover {
  transform: translateY(-2px);
  box-shadow: var(--bil-shadow-2);
}

button.card:active,
.card.clickable:active { transform: translateY(0); }

/* ----------------------------------------------------------------- focus -- */

/* One ring for the whole panel. :focus-visible only, so a mouse click never
   leaves a ring behind. */
:where(a[href], button, input, select, textarea, summary):focus-visible,
.card.clickable:focus-visible {
  outline: var(--bil-focus-width) solid var(--bil-focus-color);
  outline-offset: var(--bil-focus-offset);
}

/* ----------------------------------------------------------- remote cards -- */

/* Two classes on purpose: it has to outrank the display:block of button.card. */
.card.remote-card {
  display: flex;
  gap: var(--bil-space-4);
  align-items: stretch;
  /* Illustration height (72 * 330/200 = 119) plus the card padding. Keeps the
     loading skeleton and the finished card exactly the same size. */
  min-height: 152px;
}

/* The LED overlay is positioned in percent of this box, so the box has to keep
   the aspect ratio of the illustration — never stretch it. */
.remote-visual {
  position: relative;
  flex: none;
  width: var(--bil-remote-visual);
  aspect-ratio: 200 / 330;
  align-self: center;
}

.remote-visual img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  -webkit-user-drag: none;
  user-select: none;
}

/* The illustration is loaded via <img>, so its internal .mode-N styling cannot
   be reached from here — the active channel is mirrored by these overlay dots.
   The coordinates come straight from the generated SVG (viewBox 200x330,
   cx 82/100/118, cy 216, r 6), so: 216/330 = 65.45%, 12/200 = 6%. Whenever
   tools/make_remote_svg.py moves the LED row, these two numbers move with it. */
.led-overlay { position: absolute; inset: 0; pointer-events: none; }

.led-overlay i {
  position: absolute;
  top: 65.45%;
  width: 6%;
  aspect-ratio: 1;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  /* Same value the SVG uses for an inactive LED. */
  background: rgba(42, 42, 42, 0.55);
}

.led-overlay i.on {
  background: var(--bil-led-on);
  box-shadow: 0 0 5px 2px rgba(255, 243, 208, 0.7);
}

.remote-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--bil-space-2);
}

.remote-name {
  font-size: var(--bil-font-lg);
  line-height: var(--bil-line-snug);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.remote-meta {
  font-size: var(--bil-font-xs);
  line-height: var(--bil-line-snug);
  color: var(--bil-text-dim);
  font-family: var(--ha-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.remote-foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: var(--bil-space-2);
  flex-wrap: wrap;
  font-size: var(--bil-font-xs);
  line-height: var(--bil-line-snug);
  color: var(--bil-text-dim);
}

.slotbar {
  position: relative;
  height: 4px;
  flex: none;
  border-radius: var(--bil-pill);
  background: var(--bil-line);
  overflow: hidden;
}

.slotbar > span {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--bil-accent);
  border-radius: inherit;
}

/* -------------------------------------------------------- housing colours -- */

/* The housing colours live on --bil-housing-red|beige|green above. The only
   component that paints them is remote-editor.js, and it does so on a real
   .swatch-dot child with an inline background — no pseudo element and no
   --swatch custom property is involved any more. Nothing is anchored here on
   purpose: a .swatch[data-color]::before rule in this file would outrank the
   component's own ".swatch::before { content: none }" on specificity and paint
   a second colour block behind the dot the moment anyone touched that reset. */

/* ----------------------------------------------------------------- chips -- */

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--bil-space-1);
  min-width: 0;
  max-width: 100%;
  padding: var(--bil-space-1) var(--bil-space-3);
  border-radius: var(--bil-pill);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-accent) 14%, transparent);
  color: var(--bil-accent);
  font-size: var(--bil-font-xs);
  font-weight: 600;
  /* Never below 1: a line-height under the font size clips descenders. */
  line-height: var(--bil-line-snug);
  white-space: nowrap;
  overflow: hidden;
}

/* text-overflow does not work on a flex container, so the label truncates. */
.chip > span:not(.icon) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip.neutral {
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-text-dim) 14%, transparent);
  color: var(--bil-text-dim);
}

.chip.error {
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-error) 16%, transparent);
  color: var(--bil-error);
}

.chip.warning {
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-warning) 20%, transparent);
  color: var(--bil-warning);
}

.chip.success {
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-success) 16%, transparent);
  color: var(--bil-success);
}

.chip .icon { width: 14px; height: 14px; }

/* --------------------------------------------------------------- buttons -- */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--bil-space-2);
  min-height: var(--bil-control);
  padding: 0 var(--bil-space-5);
  border: var(--bil-border);
  border-radius: var(--bil-pill);
  background: transparent;
  color: var(--bil-text);
  font: inherit;
  font-weight: 600;
  line-height: var(--bil-line-snug);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
}

.btn:hover { background: color-mix(in srgb, var(--bil-text) 7%, transparent); }

.btn.primary {
  background: var(--bil-accent);
  border-color: transparent;
  color: var(--bil-on-accent);
}

.btn.primary:hover { background: color-mix(in srgb, var(--bil-accent) 86%, #000); }

.btn.ghost { border-color: transparent; }
.btn.ghost:hover { background: color-mix(in srgb, var(--bil-text) 7%, transparent); }

.btn.danger { color: var(--bil-error); border-color: color-mix(in srgb, var(--bil-error) 45%, transparent); }
.btn.danger:hover { background: color-mix(in srgb, var(--bil-error) 12%, transparent); }

.btn[disabled], .icon-btn[disabled] { opacity: 0.45; cursor: default; pointer-events: none; }

.btn.small {
  min-height: var(--bil-control-sm);
  padding: 0 var(--bil-space-4);
  font-size: var(--bil-font-sm);
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--bil-control);
  height: var(--bil-control);
  flex: none;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.icon-btn:hover { background: color-mix(in srgb, var(--bil-text) 10%, transparent); }

.icon { display: inline-flex; width: 20px; height: 20px; flex: none; }
.icon svg { width: 100%; height: 100%; fill: currentColor; display: block; }
.icon.big { width: 40px; height: 40px; }

.spin { animation: bil-spin 1s linear infinite; }

/* ----------------------------------------------------------------- forms -- */

.field {
  display: flex;
  flex-direction: column;
  gap: var(--bil-space-2);
  min-width: 0;
}

.field > label {
  font-size: var(--bil-font-xs);
  line-height: var(--bil-line-snug);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--bil-text-dim);
  text-transform: uppercase;
}

/* Standalone as well as inside a .field — remote-editor.js uses both. */
.hint {
  display: block;
  font-size: var(--bil-font-xs);
  line-height: var(--bil-line-normal);
  color: var(--bil-text-dim);
  overflow-wrap: anywhere;
}

.hint.error { color: var(--bil-error); }

input[type="text"], input[type="number"], input[type="search"], select, textarea {
  min-height: var(--bil-control);
  padding: var(--bil-space-2) var(--bil-space-3);
  border: var(--bil-border);
  border-radius: var(--bil-radius-md);
  background: var(--bil-surface);
  color: var(--bil-text);
  font: inherit;
  line-height: var(--bil-line-normal);
  width: 100%;
  min-width: 0;
  transition: border-color 0.15s ease;
}

input::placeholder, textarea::placeholder { color: var(--bil-text-dim); opacity: 0.8; }
input:focus, select:focus, textarea:focus { border-color: var(--bil-accent); }
input.mono { font-family: var(--ha-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }

/* Fields sit in a grid and are top aligned, so labels and inputs share one
   baseline even when a single field carries a hint underneath. */
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
  gap: var(--bil-space-4);
  align-items: start;
}

/* Sits inside a .stack, so the column gap provides the distance above it. */
.form-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--bil-space-2);
}

/* Legacy inline row, kept for compatibility. Top alignment on purpose: with
   flex-end a field with a hint pushes its input above all the others. */
.inline-form { display: flex; gap: var(--bil-space-3); align-items: flex-start; flex-wrap: wrap; }
.inline-form .field { flex: 1 1 260px; }

/* ------------------------------------------------- empty & filler states -- */

/* .empty on its own is deliberately NOT this box any more: remote-editor.js
   marks an unbound slot with .slot-summary.empty, which used to inherit the
   whole centred layout. New code uses .empty-state. */
.empty-state,
.empty:not(p):not(span) {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--bil-space-3);
  min-height: 220px;
  padding: var(--bil-space-8) var(--bil-space-6);
  color: var(--bil-text-dim);
}

.empty-state .icon.big { color: var(--bil-text-dim); opacity: 0.6; }

.empty-state h3 {
  font-size: var(--bil-font-xl);
  line-height: var(--bil-line-snug);
  font-weight: 600;
  color: var(--bil-text);
}

.empty-state p {
  max-width: 52ch;
  line-height: var(--bil-line-relaxed);
  overflow-wrap: anywhere;
}

.empty-state .row { justify-content: center; margin-top: var(--bil-space-2); }

/* Loading and "nothing found" render into the same reserved height, so the
   block below never jumps while a search runs. */
.placeholder {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--bil-space-2);
  min-height: 72px;
  min-width: 0;
  color: var(--bil-text-dim);
  font-size: var(--bil-font-sm);
  line-height: var(--bil-line-normal);
}

.notice {
  display: flex;
  gap: var(--bil-space-3);
  align-items: flex-start;
  flex-wrap: wrap;
  padding: var(--bil-space-3) var(--bil-space-4);
  border-radius: var(--bil-radius-md);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-error) 10%, var(--bil-surface));
  border-left: 3px solid var(--bil-error);
  color: var(--bil-text);
}

.notice.warning {
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-warning) 12%, var(--bil-surface));
  border-left-color: var(--bil-warning);
}

.notice > div { flex: 1 1 260px; min-width: 0; }
.notice > .btn { flex: none; align-self: center; }
.notice .icon { color: var(--bil-error); flex: none; margin-top: 2px; }
.notice.warning .icon { color: var(--bil-warning); }
.notice strong { display: block; margin-bottom: var(--bil-space-1); }

.notice p {
  color: var(--bil-text-dim);
  font-size: var(--bil-font-sm);
  line-height: var(--bil-line-normal);
  overflow-wrap: anywhere;
}

/* ------------------------------------------------------------- skeletons -- */

.skeleton {
  position: relative;
  overflow: hidden;
  border-radius: var(--bil-radius-sm);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: color-mix(in srgb, var(--bil-text) 12%, transparent);
}

/* Sheen mixed from the surface colour so it reads in light and dark themes. */
.skeleton::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: var(--secondary-background-color, rgba(127,127,127,.12));
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--bil-surface) 65%, transparent),
    transparent
  );
  animation: bil-shimmer 1.4s infinite;
}

.skeleton.line { height: 12px; }
.skeleton.line.short { width: 45%; }
.skeleton.line.mid { width: 70%; }
.skeleton.block { height: 100%; border-radius: var(--bil-radius-md); }

/* ---------------------------------------------------------------- toasts -- */

.toasts {
  position: fixed;
  left: 50%;
  bottom: calc(var(--bil-space-6) + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--bil-space-2);
  pointer-events: none;
  width: min(92vw, 460px);
}

.toast {
  pointer-events: auto;
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: var(--bil-space-3);
  padding: var(--bil-space-3) var(--bil-space-4);
  border-radius: var(--bil-radius-md);
  background: var(--bil-surface);
  border-left: 3px solid var(--bil-accent);
  box-shadow: var(--bil-shadow-2);
  animation: bil-toast-in 0.22s ease-out;
}

.toast .icon { flex: none; margin-top: 1px; }
.toast.error { border-left-color: var(--bil-error); }
.toast.error .icon { color: var(--bil-error); }
.toast.success { border-left-color: var(--bil-success); }
.toast.success .icon { color: var(--bil-success); }
.toast.leaving { animation: bil-toast-out 0.22s ease-in forwards; }
.toast span { min-width: 0; overflow-wrap: anywhere; }

/* ------------------------------------------------------------- utilities -- */

.muted { color: var(--bil-text-dim); }
.soft { color: var(--bil-text-soft); }

/* Small uppercase label above a block. */
.eyebrow {
  font-size: var(--bil-font-xs);
  line-height: var(--bil-line-snug);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--bil-text-dim);
}

.small { font-size: var(--bil-font-xs); line-height: var(--bil-line-snug); }
.mono { font-family: var(--ha-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
.truncate { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.break { overflow-wrap: anywhere; word-break: break-word; }

.link {
  color: var(--bil-accent);
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}

.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* ------------------------------------------------------------ animations -- */

@keyframes bil-spin { to { transform: rotate(360deg); } }
@keyframes bil-shimmer { 100% { transform: translateX(100%); } }
@keyframes bil-ping {
  0% { transform: scale(1); box-shadow: 0 0 0 0 currentColor; }
  70% { transform: scale(1.6); }
  100% { transform: scale(1); }
}
@keyframes bil-toast-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
@keyframes bil-toast-out { to { opacity: 0; transform: translateY(12px); } }

/* ------------------------------------------------------------ responsive -- */

/* Below 700px everything is one column and no touch target drops under 44px. */
@media (max-width: 700px) {
  .content {
    gap: var(--bil-space-5);
    padding: var(--bil-space-4) var(--bil-space-4) calc(var(--bil-space-8) + var(--bil-space-6));
  }

  /* Chrome stays below 104px, the scroll-margin the guide reserves for its
     section headings on small screens. */
  .topbar { padding: var(--bil-space-2) var(--bil-space-3); gap: var(--bil-space-2); }
  .topbar h1 { font-size: var(--bil-font-lg); }
  .livebar {
    min-height: 40px;
    padding: var(--bil-space-1) var(--bil-space-3);
    gap: var(--bil-space-2);
  }

  .grid { grid-template-columns: 1fr; }
  .form-grid { grid-template-columns: 1fr; }
  .form-actions .btn { flex: 1 1 auto; }

  .card.pad-lg { padding: var(--bil-space-5); }
  .card-head, .card-body, .card-foot { padding: var(--bil-space-4); }

  .btn.small { min-height: var(--bil-control); }

  .empty-state,
  .empty:not(p):not(span) { min-height: 200px; padding: var(--bil-space-6) var(--bil-space-4); }

  .inline-form .field { flex: 1 1 100%; }
  .inline-form .btn { width: 100%; }

  .toasts { width: min(94vw, 460px); bottom: calc(var(--bil-space-3) + env(safe-area-inset-bottom, 0px)); }
}

/* The live strip drops its optional parts before it would ever wrap. */
@media (max-width: 640px) {
  .live-hint { display: none; }
}

@media (max-width: 480px) {
  .live-time { display: none; }
  .topbar .btn .btn-label { display: none; }
  .topbar .btn { padding: 0 var(--bil-space-3); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
`;

export default sharedStyles;
