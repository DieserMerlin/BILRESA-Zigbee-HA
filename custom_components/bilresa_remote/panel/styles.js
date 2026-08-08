/**
 * Shared design system for the BILRESA panel.
 *
 * Exported as a plain string so every shadow root can drop it into a <style>
 * tag without a build step. Colours come exclusively from Home Assistant theme
 * variables; the only literal colours are the device illustration accents
 * (housing LEDs), which must match the shipped SVGs in both themes.
 */

export const sharedStyles = `
:host {
  /* Local tokens, all derived from HA theme variables. */
  --bil-radius-lg: var(--ha-card-border-radius, 16px);
  --bil-radius-md: 12px;
  --bil-radius-sm: 8px;
  --bil-pill: 999px;
  --bil-gap: 16px;
  --bil-gap-lg: 24px;
  --bil-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.06), 0 2px 8px rgba(0, 0, 0, 0.06);
  --bil-shadow-2: 0 2px 6px rgba(0, 0, 0, 0.08), 0 12px 28px rgba(0, 0, 0, 0.12);
  --bil-border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.28));
  --bil-surface: var(--card-background-color, var(--ha-card-background, #fff));
  --bil-page: var(--primary-background-color, #f4f5f7);
  --bil-text: var(--primary-text-color, #212121);
  --bil-text-dim: var(--secondary-text-color, #6b7280);
  --bil-accent: var(--primary-color, #03a9f4);
  --bil-on-accent: var(--text-primary-color, #fff);
  --bil-error: var(--error-color, #db4437);
  --bil-success: var(--success-color, #43a047);
  --bil-warning: var(--warning-color, #ffa600);
  /* Housing LED colour of the shipped illustrations. */
  --bil-led-on: #fff3d0;

  display: block;
  box-sizing: border-box;
  min-height: 100%;
  background: var(--bil-page);
  color: var(--bil-text);
  font-family: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, Roboto, "Helvetica Neue", system-ui, sans-serif));
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

*, *::before, *::after { box-sizing: inherit; }

/* --------------------------------------------------------------- layout -- */

.app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.content {
  flex: 1 1 auto;
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
  padding: var(--bil-gap-lg) var(--bil-gap-lg) 72px;
}

.stack { display: flex; flex-direction: column; gap: var(--bil-gap); }
.stack.tight { gap: 8px; }
.row { display: flex; align-items: center; gap: 8px; }
.row.wrap { flex-wrap: wrap; }
.row.end { justify-content: flex-end; }
.spacer { flex: 1 1 auto; }

.section { margin-top: var(--bil-gap-lg); }
.section:first-child { margin-top: 0; }

.section-head {
  display: flex;
  align-items: flex-end;
  gap: var(--bil-gap);
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.section-head h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.section-head p {
  margin: 2px 0 0;
  color: var(--bil-text-dim);
  font-size: 13px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--bil-gap);
  align-items: stretch;
}

/* -------------------------------------------------------------- top bar -- */

/* Top bar and live strip stick together as one block, so their heights never
   have to be guessed for a second sticky offset. */
.chrome {
  position: sticky;
  top: 0;
  z-index: 4;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px var(--bil-gap-lg);
  background: var(--app-header-background-color, var(--bil-surface));
  color: var(--app-header-text-color, var(--bil-text));
  border-bottom: var(--bil-border);
  backdrop-filter: saturate(1.4) blur(6px);
}

.topbar .titles { min-width: 0; }

.topbar h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topbar .sub {
  margin: 0;
  font-size: 12px;
  color: var(--bil-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topbar-actions { display: flex; align-items: center; gap: 8px; }

/* --------------------------------------------------------------- livebar -- */

.livebar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px var(--bil-gap-lg);
  background: var(--bil-surface);
  border-bottom: var(--bil-border);
  font-size: 13px;
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

.livebar .live-text {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.livebar .live-meta {
  color: var(--bil-text-dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ----------------------------------------------------------------- card -- */

.card {
  background: var(--bil-surface);
  border-radius: var(--bil-radius-lg);
  box-shadow: var(--bil-shadow-1);
  border: 1px solid transparent;
  padding: var(--bil-gap);
  color: inherit;
}

.card.pad-lg { padding: var(--bil-gap-lg); }
.card.outline { box-shadow: none; border: var(--bil-border); }

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

button.card:focus-visible,
.card.clickable:focus-visible,
.btn:focus-visible,
.icon-btn:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--bil-accent);
  outline-offset: 2px;
}

/* --------------------------------------------------------- remote cards -- */

/* Two classes on purpose: it has to outrank the display:block of button.card. */
.card.remote-card { display: flex; gap: var(--bil-gap); align-items: stretch; }

.remote-visual {
  position: relative;
  flex: none;
  width: 68px;
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
   be reached from here — the active channel is mirrored by these overlay dots,
   positioned on the LED coordinates of the SVG (cx 82/100/118, cy 196). */
.led-overlay { position: absolute; inset: 0; pointer-events: none; }

.led-overlay i {
  position: absolute;
  top: 59.4%;
  width: 6%;
  aspect-ratio: 1;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0, 0, 0, 0.4);
}

.led-overlay i.on {
  background: var(--bil-led-on);
  box-shadow: 0 0 5px 2px rgba(255, 243, 208, 0.7);
}

.remote-body { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 6px; }

.remote-name {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.remote-meta {
  margin: 0;
  font-size: 12px;
  color: var(--bil-text-dim);
  font-family: var(--ha-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.remote-foot { margin-top: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.slotbar {
  position: relative;
  height: 4px;
  border-radius: var(--bil-pill);
  background: var(--divider-color, rgba(127, 127, 127, 0.28));
  overflow: hidden;
}

.slotbar > span {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--bil-accent);
  border-radius: inherit;
}

/* ---------------------------------------------------------------- chips -- */

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: var(--bil-pill);
  background: color-mix(in srgb, var(--bil-accent) 14%, transparent);
  color: var(--bil-accent);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.6;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip.neutral {
  background: color-mix(in srgb, var(--bil-text-dim) 14%, transparent);
  color: var(--bil-text-dim);
}

.chip.error {
  background: color-mix(in srgb, var(--bil-error) 16%, transparent);
  color: var(--bil-error);
}

.chip.warning {
  background: color-mix(in srgb, var(--bil-warning) 20%, transparent);
  color: var(--bil-warning);
}

.chip.success {
  background: color-mix(in srgb, var(--bil-success) 16%, transparent);
  color: var(--bil-success);
}

.chip .icon { width: 14px; height: 14px; }

/* -------------------------------------------------------------- buttons -- */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 18px;
  border: var(--bil-border);
  border-radius: var(--bil-pill);
  background: transparent;
  color: var(--bil-text);
  font: inherit;
  font-weight: 600;
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

.btn.small { min-height: 36px; padding: 0 14px; font-size: 13px; }

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
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

/* ---------------------------------------------------------------- forms -- */

.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }

.field > label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--bil-text-dim);
  text-transform: uppercase;
}

.field .hint { font-size: 12px; color: var(--bil-text-dim); }
.field .hint.error { color: var(--bil-error); }

input[type="text"], input[type="number"], input[type="search"], select, textarea {
  min-height: 44px;
  padding: 10px 12px;
  border: var(--bil-border);
  border-radius: var(--bil-radius-md);
  background: var(--bil-surface);
  color: var(--bil-text);
  font: inherit;
  width: 100%;
  transition: border-color 0.15s ease;
}

input::placeholder, textarea::placeholder { color: var(--bil-text-dim); opacity: 0.8; }
input:focus, select:focus, textarea:focus { border-color: var(--bil-accent); }
input.mono { font-family: var(--ha-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }

.inline-form { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.inline-form .field { flex: 1 1 260px; }

/* --------------------------------------------------------- empty states -- */

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
  padding: 44px var(--bil-gap-lg);
  color: var(--bil-text-dim);
}

.empty .icon.big { color: var(--bil-text-dim); opacity: 0.6; }

.empty h3 {
  margin: 4px 0 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--bil-text);
}

.empty p { margin: 0; max-width: 46ch; }
.empty .row { margin-top: 10px; }

.notice {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 14px var(--bil-gap);
  border-radius: var(--bil-radius-md);
  background: color-mix(in srgb, var(--bil-error) 10%, var(--bil-surface));
  border-left: 3px solid var(--bil-error);
  color: var(--bil-text);
}

.notice.warning {
  background: color-mix(in srgb, var(--bil-warning) 12%, var(--bil-surface));
  border-left-color: var(--bil-warning);
}

.notice .icon { color: var(--bil-error); margin-top: 2px; }
.notice.warning .icon { color: var(--bil-warning); }
.notice strong { display: block; margin-bottom: 2px; }
.notice p { margin: 0; color: var(--bil-text-dim); font-size: 13px; }

/* ------------------------------------------------------------ skeletons -- */

.skeleton {
  position: relative;
  overflow: hidden;
  border-radius: var(--bil-radius-sm);
  background: color-mix(in srgb, var(--bil-text) 12%, transparent);
}

.skeleton::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.22), transparent);
  animation: bil-shimmer 1.4s infinite;
}

.skeleton.line { height: 12px; }
.skeleton.line.short { width: 45%; }
.skeleton.line.mid { width: 70%; }
.skeleton.block { height: 100%; border-radius: var(--bil-radius-md); }

/* --------------------------------------------------------------- toasts -- */

.toasts {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
  width: min(92vw, 460px);
}

.toast {
  pointer-events: auto;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: var(--bil-radius-md);
  background: var(--bil-surface);
  border-left: 3px solid var(--bil-accent);
  box-shadow: var(--bil-shadow-2);
  animation: bil-toast-in 0.22s ease-out;
}

.toast.error { border-left-color: var(--bil-error); }
.toast.error .icon { color: var(--bil-error); }
.toast.success { border-left-color: var(--bil-success); }
.toast.success .icon { color: var(--bil-success); }
.toast.leaving { animation: bil-toast-out 0.22s ease-in forwards; }
.toast span { min-width: 0; overflow-wrap: anywhere; }

/* ------------------------------------------------------------ utilities -- */

.muted { color: var(--bil-text-dim); }
.small { font-size: 12px; }
.mono { font-family: var(--ha-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
.truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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

/* ----------------------------------------------------------- animations -- */

@keyframes bil-spin { to { transform: rotate(360deg); } }
@keyframes bil-shimmer { 100% { transform: translateX(100%); } }
@keyframes bil-ping {
  0% { transform: scale(1); box-shadow: 0 0 0 0 currentColor; }
  70% { transform: scale(1.6); }
  100% { transform: scale(1); }
}
@keyframes bil-toast-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
@keyframes bil-toast-out { to { opacity: 0; transform: translateY(12px); } }

/* ---------------------------------------------------------- responsive -- */

@media (max-width: 700px) {
  .content { padding: var(--bil-gap) var(--bil-gap) 64px; }
  .topbar { padding: 8px 12px; gap: 8px; }
  .livebar { padding: 8px 12px; }
  .grid { grid-template-columns: 1fr; }
  .topbar h1 { font-size: 17px; }
  .inline-form .field { flex: 1 1 100%; }
  .inline-form .btn { width: 100%; }
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
