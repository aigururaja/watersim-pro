/**
 * Symbol primitives — the shared drawing vocabulary for all 26 glyphs
 * (spec §2, §3, §5)
 * ─────────────────────────────────────────────────────────────────────────────
 * Every symbol is SHELL + FILL + INTERNALS + ROTOR + PORTS, drawn on
 * `viewBox="0 0 144 60"` in EXACTLY THREE stroke weights:
 *
 *     shell 1.75   ·   detail 1.25   ·   media 0.75
 *
 * That, plus round caps and joins throughout, `vector-effect:
 * non-scaling-stroke` on every stroked element and
 * `shape-rendering: geometricPrecision`, is what makes 26 separate drawings
 * read as one set.
 *
 * ── HOW THESE COMPONENTS ARE USED ────────────────────────────────────────────
 * A symbol renders SVG CHILDREN ONLY — no <svg> wrapper. The host supplies
 * `<svg viewBox="0 0 144 60">`, which is what lets the same registry entry
 * render at 144x60 in a node frame and at 24x18 in the palette rail legend.
 *
 * ── THE TWO RULES THAT SHIP A BROKEN SYMBOL IF IGNORED ───────────────────────
 * 1. Every rotor and every level group carries `transform-box: fill-box` PLUS
 *    an explicit `transform-origin`. Omit `transform-box` and the rotor orbits
 *    the viewBox origin. These primitives set both INLINE (so a symbol is
 *    correct even in a renderer that never loads canvas-motion.css) and via
 *    the `.ws-origin-*` classes (which carry the keyword form first and the
 *    explicit form second).
 * 2. Components take VALUES as props and emit CSS CUSTOM PROPERTIES inline —
 *    `style={{ '--ws-spin': secs(p) }}`. The `animation` shorthand lives in
 *    canvas-motion.css. Animation strings are never built in JS: React
 *    rewrites one variable and the compositor retimes in place.
 *
 * ── AND THE ONE RULE THAT SHIPS A LIE ────────────────────────────────────────
 * "Any level, surface, interface or boundary that the engine does not compute
 *  is drawn as a DASHED hairline, never as a solid surface, and is never
 *  animated. A solid surface line is a promise that a number backs it."
 * Pass `dashed` to `Fill` / `Level` for those.
 */

import { DEF_IDS, paint } from './defs';

// ═══════════════════════════════════════════════════════════════════════════
// Geometry & ink
// ═══════════════════════════════════════════════════════════════════════════

/** The symbol frame. All 26 glyphs are drawn in these coordinates. */
export const FRAME = Object.freeze({ w: 144, h: 60, cx: 72, cy: 30 });

/** The only three stroke weights on this canvas. */
export const STROKE = Object.freeze({ shell: 1.75, detail: 1.25, media: 0.75 });

/** Default shell geometry per shell kind, so 26 drawings line up with each
 *  other and with the 4px service band above them. */
export const GEO = Object.freeze({
  rect: Object.freeze({ x: 30, y: 6, w: 84, h: 48 }),
  cyl: Object.freeze({ x: 50, w: 44, top: 5, bottom: 55, ry: 5 }),
  cone: Object.freeze({ cx: 72, cy: 24, r: 20, hopper: 12 }),
  pill: Object.freeze({ x: 28, y: 12, w: 88, h: 36 }),
});

const INK = 'var(--ws-ink-700, #1E293B)';
const INK_SOFT = 'var(--ws-ink-400, #94A3B8)';

/**
 * Stroke props for a given weight. Spread onto any stroked element.
 * @param {'shell'|'detail'|'media'} weight
 * @param {string} [color] any token, e.g. 'var(--ws-ink-400)'
 */
export function ink(weight = 'shell', color = INK) {
  return {
    fill: 'none',
    stroke: color,
    strokeWidth: STROKE[weight] ?? STROKE.shell,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    vectorEffect: 'non-scaling-stroke',
    shapeRendering: 'geometricPrecision',
  };
}

/** `transform-box: fill-box` + the explicit origin fallback, inline. */
const ORIGIN_CENTER = { transformBox: 'fill-box', transformOrigin: '50% 50%' };
const ORIGIN_BOTTOM = { transformBox: 'fill-box', transformOrigin: '50% 100%' };

const cx = (...parts) => parts.filter(Boolean).join(' ');

/** Clamp helper — every encoder in the catalogue is clamped. */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ═══════════════════════════════════════════════════════════════════════════
// SHELL — one of five (spec §3.1)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A `<clipPath>` wrapper. `Fill` and `Wave` are clipped to the shell interior
 * so liquid can never escape the vessel, which is also what confines all
 * animation to the bounded symbol frame.
 */
function Clip({ id, children }) {
  if (!id) return null;
  return <clipPath id={id}>{children}</clipPath>;
}

function ShellRect({
  x = GEO.rect.x, y = GEO.rect.y, w = GEO.rect.w, h = GEO.rect.h,
  rx = 1, clipId, color = INK, weight = 'shell', className, style,
}) {
  return (
    <>
      <Clip id={clipId}><rect x={x} y={y} width={w} height={h} rx={rx} /></Clip>
      <rect
        className={cx('ws-shell', className)} style={style}
        x={x} y={y} width={w} height={h} rx={rx} {...ink(weight, color)}
      />
    </>
  );
}

/**
 * Vertical column with an elliptical cap (digester, GAC, storage tank).
 * The visible cap rim is drawn at DETAIL weight so it reads as a lid, not as
 * a second shell.
 */
function ShellCyl({
  x = GEO.cyl.x, w = GEO.cyl.w, top = GEO.cyl.top, bottom = GEO.cyl.bottom,
  ry = GEO.cyl.ry, cap = true, clipId, color = INK, weight = 'shell', className, style,
}) {
  const rx = w / 2;
  const d = `M ${x} ${top + ry}`
    + ` A ${rx} ${ry} 0 0 0 ${x + w} ${top + ry}`
    + ` L ${x + w} ${bottom - ry}`
    + ` A ${rx} ${ry} 0 0 0 ${x} ${bottom - ry} Z`;
  return (
    <>
      <Clip id={clipId}><path d={d} /></Clip>
      <path className={cx('ws-shell', className)} style={style} d={d} {...ink(weight, color)} />
      {cap && (
        <ellipse
          className="ws-detail"
          cx={x + rx} cy={top + ry} rx={rx} ry={ry}
          {...ink('detail', color)}
        />
      )}
    </>
  );
}

/**
 * Circle with a hopper V (clarifiers, grit, thickener). The V springs from the
 * circle at ±45° so the hopper always meets the shell tangentially, whatever
 * radius a symbol picks.
 */
function ShellCone({
  cx: ccx = GEO.cone.cx, cy = GEO.cone.cy, r = GEO.cone.r, hopper = GEO.cone.hopper,
  clipId, color = INK, weight = 'shell', className, style,
}) {
  const k = r / Math.SQRT2;
  const lx = ccx - k, rx2 = ccx + k, sy = cy + k;
  const apex = sy + hopper;
  const d = `M ${lx} ${sy} L ${ccx} ${apex} L ${rx2} ${sy}`;
  return (
    <>
      <Clip id={clipId}>
        <path d={`M ${lx} ${sy} A ${r} ${r} 0 1 1 ${rx2} ${sy} L ${ccx} ${apex} Z`} />
      </Clip>
      <circle className={cx('ws-shell', className)} style={style} cx={ccx} cy={cy} r={r} {...ink(weight, color)} />
      <path className="ws-shell" d={d} {...ink(weight, color)} />
    </>
  );
}

/** Horizontal capsule = pressure vessel (UV channel, RO / UF elements). */
function ShellPill({
  x = GEO.pill.x, y = GEO.pill.y, w = GEO.pill.w, h = GEO.pill.h,
  clipId, color = INK, weight = 'shell', className, style,
}) {
  const r = h / 2;
  return (
    <>
      <Clip id={clipId}><rect x={x} y={y} width={w} height={h} rx={r} /></Clip>
      <rect
        className={cx('ws-shell', className)} style={style}
        x={x} y={y} width={w} height={h} rx={r} {...ink(weight, color)}
      />
    </>
  );
}

export const Shell = Object.freeze({
  Rect: ShellRect,
  Cyl: ShellCyl,
  Cone: ShellCone,
  Pill: ShellPill,
});

// ═══════════════════════════════════════════════════════════════════════════
// FILL — the process medium (spec §3.1, §5.3 #9, #10)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bottom-anchored liquid body, clipped to the shell interior.
 *
 * `level` is a FRACTION (0..1) applied as `scaleY` on a group — NEVER the
 * `height` attribute, which does not transition and forces layout. The
 * transition (420ms) lives in canvas-motion.css.
 *
 * The one-shot vessel prime is a SEPARATE INNER GROUP so the two transforms
 * never fight, and it is gated by EXISTENCE (`prime`), not by play-state — a
 * paused completed one-shot could never re-arm. Mount it only in live view.
 *
 * The invisible bbox anchor keeps `transform-box: fill-box` honest: without
 * it, the group's object bounding box would shrink while the inner prime is
 * mid-animation and the bottom origin would drift.
 *
 * `dashed` draws the surface as a dashed hairline — the canvas-wide
 * "the engine does not compute this level" convention. A dashed surface is
 * never animated.
 *
 * @param {number|null} level  0..1; null → nothing is drawn (no results yet)
 */
export function Fill({
  x = GEO.rect.x, y = GEO.rect.y, w = GEO.rect.w, h = GEO.rect.h,
  level = 1, clipId,
  color = 'var(--ws-svc-water, #2E75B6)',
  opacity = 0.35,
  surface = true,
  dashed = false,
  prime = false,
  primeDelay = 0,
  className,
}) {
  if (level == null) return null;
  const lv = clamp(level, 0, 1);
  const body = (
    <>
      <rect x={x} y={y} width={w} height={h} fill={color} opacity={opacity} />
      {surface && (
        <line
          className="ws-surface"
          x1={x} y1={y} x2={x + w} y2={y}
          {...ink('detail', color)}
          strokeDasharray={dashed ? '3 3' : undefined}
          opacity={dashed ? 0.8 : 1}
        />
      )}
    </>
  );
  return (
    <g clipPath={clipId ? `url(#${clipId})` : undefined}>
      <g
        className={cx('ws-fill', 'ws-origin-b', className)}
        style={{ ...ORIGIN_BOTTOM, transform: `scaleY(${lv})` }}
      >
        {/* bbox anchor — paints nothing, pins the object bounding box */}
        <rect x={x} y={y} width={w} height={h} fill="none" stroke="none" pointerEvents="none" />
        {prime && !dashed ? (
          <g
            className="ws-prime ws-origin-b"
            style={{ ...ORIGIN_BOTTOM, '--ws-x': primeDelay }}
          >
            {body}
          </g>
        ) : body}
      </g>
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// WAVE — surface ripple (spec §5.3 #9)
// ═══════════════════════════════════════════════════════════════════════════

const WAVE_PERIOD = 40;   // must match the -40px in @keyframes ws-drift

function wavePath(x0, y, amp, periods) {
  const half = WAVE_PERIOD / 2;
  const ctrl = amp * 1.3;
  let d = `M ${x0} ${y}`;
  for (let i = 0; i < periods * 2; i++) {
    const up = i % 2 === 0;
    d += ` q ${half / 2} ${up ? -ctrl : ctrl} ${half} 0`;
  }
  return d;
}

/**
 * A ripple on the liquid surface. The path is authored TWO periods wider than
 * the vessel and translates exactly ONE period (40px), so the loop is seamless
 * and frame 100% is identical to frame 0% — which is what stops the
 * reduced-motion snap-to-end-frame from stranding it mid-wave.
 *
 * Wave rate is Class A (it comes from inlet Q, a computed flow). With no inlet
 * flow the correct picture is a FLAT surface line and no motion: pass
 * `dur = null` and the wave renders flat and unanimated.
 *
 * @param {string|null} dur `secs()` output, or null for a flat still surface
 */
export function Wave({
  x = GEO.rect.x, w = GEO.rect.w, y = 20,
  amp = 1.5, dur = null, clipId,
  color = 'var(--ws-svc-water, #2E75B6)', opacity = 0.9, className,
}) {
  const periods = Math.ceil(w / WAVE_PERIOD) + 2;
  const moving = !!dur && amp > 0;
  return (
    <g clipPath={clipId ? `url(#${clipId})` : undefined}>
      <path
        className={cx(moving && 'ws-anim', 'ws-wave', 'ws-detail', className)}
        style={moving ? { '--ws-drift': dur } : undefined}
        d={wavePath(x - WAVE_PERIOD, y, moving ? amp : 0, periods)}
        {...ink('detail', color)}
        opacity={opacity}
      />
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BLANKET — sludge band at the floor (spec §5.3 #7, #8)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A bottom-anchored solids band. `height` is a FRACTION of `maxDepth`, applied
 * as `scaleY` on a group with a 420ms transition — never the `height`
 * attribute.
 *
 * On a secondary clarifier this is a STATIC encoder: SLR = MLSS x SOR / 1000,
 * in which flow cancels exactly, so it is a design-loading indicator and the
 * ⓘ must say so. It never loops.
 */
export function Blanket({
  x = GEO.rect.x, w = GEO.rect.w, floorY = GEO.rect.y + GEO.rect.h,
  maxDepth = 20, height = 0.1, clipId,
  color = 'var(--ws-svc-sludge, #78350F)', opacity = 0.45, className,
}) {
  if (height == null) return null;
  const f = clamp(height, 0, 1);
  const top = floorY - maxDepth;
  return (
    <g clipPath={clipId ? `url(#${clipId})` : undefined}>
      <g
        className={cx('ws-blanket', 'ws-origin-b', 'ws-detail', className)}
        style={{ ...ORIGIN_BOTTOM, transform: `scaleY(${f})` }}
      >
        <rect x={x} y={top} width={w} height={maxDepth} fill={color} opacity={opacity} />
        <line x1={x} y1={top} x2={x + w} y2={top} {...ink('media', color)} />
      </g>
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BUBBLES — aeration and digester gas (spec §5.3 #2, #15)
// ═══════════════════════════════════════════════════════════════════════════

/** Hard cap from the §7 budget: at most 18 circles in one clipped group. */
export const MAX_BUBBLES = 18;

/** Static stagger, in seconds. Negative delays offset the phase with ZERO JS
 *  timing — no rAF, no setInterval, nothing per node. */
const STAGGER = [0, -0.7, -1.4];

/**
 * Rising bubble columns.
 *
 * Existence-gated: when there is no oxygen demand the correct picture is NO
 * BUBBLES AT ALL and a grey diffuser header, so pass `columns = 0` (or a null
 * `dur`) rather than a slow animation. That is the difference between
 * "not aerating" and "aerating very slowly".
 *
 * @param {number} columns  0..6
 * @param {string|null} dur `secs()` output; null → nothing mounts
 */
export function Bubbles({
  columns = 0, dur = null,
  x0 = 44, gap = 18, floorY = 50, perColumn = 3, r = 1.6,
  opacity = 0.55, color = 'var(--ws-svc-air, #0891B2)', clipId, className,
}) {
  const n = clamp(Math.floor(columns) || 0, 0, 6);
  if (!n || !dur) return null;
  const per = clamp(Math.floor(perColumn) || 1, 1, Math.floor(MAX_BUBBLES / n));

  const circles = [];
  for (let c = 0; c < n; c++) {
    for (let k = 0; k < per; k++) {
      circles.push(
        <circle
          key={`${c}-${k}`}
          className="ws-anim ws-bubble"
          cx={x0 + c * gap}
          cy={floorY}
          r={r}
          fill={color}
          style={{
            '--ws-bubble-dur': dur,
            '--ws-bubble-o': opacity,
            animationDelay: `${STAGGER[k % STAGGER.length] - c * 0.23}s`,
          }}
        />
      );
    }
  }
  return (
    <g className={cx('ws-detail', className)} clipPath={clipId ? `url(#${clipId})` : undefined}>
      {circles}
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ROTOR — the single movable member (spec §3.1, §5.3 #3, #4, #6, #15)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The one rotating group in a symbol. Always its own `<g>`.
 *
 * `dur = null` means REST POSE, and rest is PARKED, not paused mid-frame:
 * `parkedAt` degrees (12° for a stopped pump/blower, 45° for a clarifier rake)
 * so the machine is legible as stopped in a still frame with zero motion.
 *
 * Two ways to pin the pivot, both spec-legal:
 *   · default — `transform-box: fill-box` + explicit `transform-origin`, with
 *     an optional invisible `anchor` circle that makes the group's bounding
 *     box symmetric about the true pivot (use this when the vanes are not
 *     centred on their own bbox);
 *   · `origin={[cx, cy]}` — user-space pivot via `transform-box: view-box`,
 *     for a rotor whose bbox can never be made symmetric.
 *
 * @param {string|null} dur  `secs()` output; null → parked
 * @param {'rake'|'spin'} channel which custom property to write
 */
export function Rotor({
  dur = null, parkedAt = 12, reverse = false, origin = null, anchor = null,
  channel = 'spin', className, children,
}) {
  const running = !!dur;
  const varName = channel === 'rake' ? '--ws-rake-dur' : '--ws-spin';
  const style = origin
    ? { transformBox: 'view-box', transformOrigin: `${origin[0]}px ${origin[1]}px` }
    : { ...ORIGIN_CENTER };
  if (running) style[varName] = dur;
  else style.transform = `rotate(${parkedAt}deg)`;

  return (
    <g
      className={cx(
        running && 'ws-anim',
        channel === 'rake' ? 'ws-rake' : 'ws-rotor',
        origin ? 'ws-origin-v' : 'ws-origin-c',
        reverse && 'ws-rotor--rev',
        className,
      )}
      style={style}
    >
      {anchor && (
        <circle
          cx={anchor[0]} cy={anchor[1]} r={anchor[2]}
          fill="none" stroke="none" pointerEvents="none"
        />
      )}
      {children}
    </g>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PORTS & FILLS
// ═══════════════════════════════════════════════════════════════════════════

/** A 6px nozzle stub — one per REAL output port of the model, never more. */
export function Nozzle({ x, y, dir = 'right', len = 6, color = INK, weight = 'detail', className }) {
  const d = { right: [len, 0], left: [-len, 0], up: [0, -len], down: [0, len] }[dir] || [len, 0];
  return (
    <line
      className={cx('ws-detail', className)}
      x1={x} y1={y} x2={x + d[0]} y2={y + d[1]}
      {...ink(weight, color)}
    />
  );
}

/**
 * The shared 45° de-energised hatch: an OFF/CLOSED device interior, an
 * unlinked blower, or a vessel the engine does not simulate at all (`tank`).
 * Paired with 45% ink and, for OFF/CLOSED, a red border — legible as stopped
 * with zero motion.
 */
export function Hatch({ x, y, w, h, rx = 1, clipId, opacity = 1, className }) {
  const rect = (
    <rect
      className={cx('ws-media', 'ws-hatch', className)}
      x={x} y={y} width={w} height={h} rx={rx}
      fill={paint(DEF_IDS.hatch)} opacity={opacity}
    />
  );
  return clipId ? <g clipPath={`url(#${clipId})`}>{rect}</g> : rect;
}

// ═══════════════════════════════════════════════════════════════════════════
// FALLBACK
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Rendered for any opType with no registry entry — an imported sheet from a
 * future version, or a symbol lane that has not landed yet. Slate + dashed +
 * hatched is the canvas's existing "NO MODEL / UNLINKED" language, so an
 * unknown unit reads as unknown rather than as a working one.
 *
 * It must never throw: the registry falls back to this so the app cannot crash
 * on a missing entry.
 */
export function PlaceholderSymbol({ opType }) {
  const g = GEO.rect;
  return (
    <g aria-hidden="true">
      <Hatch x={g.x + 2} y={g.y + 2} w={g.w - 4} h={g.h - 4} opacity={0.5} />
      <rect
        className="ws-shell"
        x={g.x} y={g.y} width={g.w} height={g.h} rx={2}
        {...ink('shell', 'var(--ws-nomodel, #64748B)')}
        strokeDasharray="5 3"
      />
      <line
        className="ws-detail"
        x1={g.x + 10} y1={g.y + g.h - 10} x2={g.x + g.w - 10} y2={g.y + 10}
        {...ink('detail', 'var(--ws-nomodel, #64748B)')}
      />
      <Nozzle x={g.x - 6} y={g.y + g.h / 2} dir="right" color={INK_SOFT} />
      <Nozzle x={g.x + g.w} y={g.y + g.h / 2} dir="right" color={INK_SOFT} />
      {opType ? <title>{`No symbol for ${opType}`}</title> : null}
    </g>
  );
}
