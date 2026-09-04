/**
 * SymbolDefs — the ONE shared <defs> sprite for the whole canvas (spec §3.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Shared <defs> (hatch pattern, media stipples, UV radial gradient,
 *  bubble/flight/droplet <symbol>s) live in ONE hidden
 *  <svg aria-hidden="true" width="0" height="0"> mounted once at the canvas
 *  root and referenced by url(#…). Thirty nodes must not each carry their own
 *  defs."
 *
 * Mount it exactly once, INSIDE the `.ws-sheet` wrapper, so the paint servers
 * below inherit the design tokens. Every `var()` here also carries the literal
 * fallback from canvas-tokens.css, so the sprite is still correct if it is
 * ever mounted outside the sheet (a contact sheet, a test renderer).
 *
 * FORBIDDEN here and everywhere on this canvas: <filter>, blur, drop-shadow.
 * The UV glow is a <radialGradient>, not a filter — a filter forces a full
 * offscreen render per element per frame and is the one thing that would break
 * the §7 performance budget.
 */

/** Stable ids. Import these instead of hard-coding strings in a symbol. */
export const DEF_IDS = Object.freeze({
  hatch: 'wsHatch',
  stippleSand: 'wsStippleSand',
  stippleCarbon: 'wsStippleCarbon',
  stippleFloc: 'wsStippleFloc',
  uvGlow: 'wsUvGlow',
  bubble: 'wsBubble',
  flight: 'wsFlight',
  droplet: 'wsDroplet',
});

/** `url(#…)` for a paint server, `#…` for a <use href>. */
export const paint = (id) => `url(#${id})`;
export const href = (id) => `#${id}`;

const INK_400 = 'var(--ws-ink-400, #94A3B8)';
const SAND = 'var(--ws-media-sand, #C9B79A)';
const CARBON = 'var(--ws-media-carbon, #3A3A3C)';
const UV = 'var(--ws-svc-chem, #7C3AED)';

export default function SymbolDefs() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
      className="ws-defs"
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
    >
      <defs>
        {/* ── De-energised hatch (spec §2.4, §3.2 #26) ────────────────────────
            The canvas-wide "this device is stopped / this vessel is not
            simulated" fill. 45°, 6px pitch, media weight (0.75). */}
        <pattern
          id={DEF_IDS.hatch}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="6" stroke={INK_400} strokeWidth="0.75" />
        </pattern>

        {/* ── Media stipples ──────────────────────────────────────────────────
            Sand / dual media (sand_filter #17) and carbon (gac_adsorption
            #25). Drawn as dots, not strokes, so the bed reads as granular at
            1x and as a flat tone at 0.5x. */}
        <pattern id={DEF_IDS.stippleSand} width="5" height="5" patternUnits="userSpaceOnUse">
          <circle cx="1.2" cy="1.2" r="0.7" fill={SAND} />
          <circle cx="3.7" cy="3.4" r="0.6" fill={SAND} />
        </pattern>
        <pattern id={DEF_IDS.stippleCarbon} width="4" height="4" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.85" fill={CARBON} />
          <circle cx="3" cy="2.8" r="0.75" fill={CARBON} />
        </pattern>
        {/* Floc particles for the coagulation basin (#22). */}
        <pattern id={DEF_IDS.stippleFloc} width="8" height="8" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2.5" r="0.9" fill={INK_400} fillOpacity="0.55" />
          <circle cx="6" cy="5.5" r="0.7" fill={INK_400} fillOpacity="0.45" />
        </pattern>

        {/* ── UV glow (spec §5.3 #13) ─────────────────────────────────────────
            A radial gradient, NOT an SVG filter and NOT a blur. Glow strength
            is a STATIC encoder (fluence / required fluence, which reduces to
            sqrt(UVT/65) — a setpoint), so the ⓘ says "dose adequacy from your
            UV transmittance setpoint. It does not change with flow; the number
            of lamp sleeves does." */}
        <radialGradient id={DEF_IDS.uvGlow} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={UV} stopOpacity="0.95" />
          <stop offset="55%" stopColor={UV} stopOpacity="0.40" />
          <stop offset="100%" stopColor={UV} stopOpacity="0" />
        </radialGradient>

        {/* ── Reusable marks ──────────────────────────────────────────────────
            Referenced with <use href="#…">; fill/stroke are deliberately left
            unset so the referencing element supplies them. */}
        <symbol id={DEF_IDS.bubble} viewBox="0 0 4 4">
          <circle cx="2" cy="2" r="1.6" />
        </symbol>

        {/* Rake flight / scraper tooth — screening #6, clarifiers #8/#9. */}
        <symbol id={DEF_IDS.flight} viewBox="0 0 8 6">
          <path d="M0 6 L4 0 L8 6 Z" />
        </symbol>

        {/* Dosing droplet — the dosing family #16. */}
        <symbol id={DEF_IDS.droplet} viewBox="0 0 6 8">
          <path d="M3 0 C4.6 2.6 6 4.1 6 5.3 A3 3 0 0 1 0 5.3 C0 4.1 1.4 2.6 3 0 Z" />
        </symbol>
      </defs>
    </svg>
  );
}
