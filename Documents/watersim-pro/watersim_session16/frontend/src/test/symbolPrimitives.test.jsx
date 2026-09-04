/**
 * Symbol primitives, the shared <defs> sprite and the SYMBOLS registry.
 *
 * These are the two things that ship a broken symbol if they regress:
 *
 *  1. Every rotor and every level group must carry `transform-box: fill-box`
 *     PLUS an explicit `transform-origin`. Omit `transform-box` and the rotor
 *     orbits the viewBox origin instead of its own centre.
 *  2. Levels, bands and blankets are a `transform` on a group — NEVER the
 *     `height` attribute, which does not transition and forces layout.
 *
 * Plus the registry contract: an unknown or not-yet-implemented opType must
 * fall back to the placeholder, never crash the canvas.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import SymbolDefs, { DEF_IDS } from '../components/canvas/symbols/defs';
import {
  Shell, Fill, Wave, Blanket, Bubbles, Rotor, Nozzle, Hatch,
  PlaceholderSymbol, FRAME, STROKE, GEO, ink,
} from '../components/canvas/symbols/primitives';
import {
  SYMBOLS, TAG, getSymbol, getTag, hasSymbol, registerSymbols, resolveSymbolType,
} from '../components/canvas/symbols';
import { secs } from '../components/canvas/liveStore';
import { PALETTE } from '../components/canvas/UnitOpPalette';

const PALETTE_TYPES = PALETTE.flatMap((g) => g.items.map((i) => i.type));

const sheet = (children) => render(
  <div className="ws-sheet">
    <svg viewBox={`0 0 ${FRAME.w} ${FRAME.h}`}>{children}</svg>
  </div>
);

describe('symbol primitives', () => {
  it('mounts the defs sprite with every id', () => {
    const { container } = render(<SymbolDefs />);
    for (const id of Object.values(DEF_IDS)) {
      expect(container.querySelector(`#${id}`)).toBeTruthy();
    }
  });

  it('renders all four shells with clip paths', () => {
    const { container } = sheet(
      <>
        <Shell.Rect clipId="c1" />
        <Shell.Cyl clipId="c2" />
        <Shell.Cone clipId="c3" />
        <Shell.Pill clipId="c4" />
      </>
    );
    expect(container.querySelectorAll('clipPath').length).toBe(4);
    expect(container.querySelectorAll('.ws-shell').length).toBeGreaterThanOrEqual(4);
    const shell = container.querySelector('.ws-shell');
    expect(shell.getAttribute('stroke-width')).toBe(String(STROKE.shell));
    expect(shell.getAttribute('vector-effect')).toBe('non-scaling-stroke');
  });

  it('Fill / Blanket ship transform-box AND an explicit origin, and use scaleY', () => {
    const { container } = sheet(
      <>
        <Fill level={0.7} clipId="c1" prime primeDelay={120} />
        <Blanket height={0.3} />
      </>
    );
    const fill = container.querySelector('.ws-fill');
    expect(fill.style.transformBox).toBe('fill-box');
    expect(fill.style.transformOrigin).toBe('50% 100%');
    expect(fill.style.transform).toBe('scaleY(0.7)');
    expect(fill.classList.contains('ws-origin-b')).toBe(true);
    expect(container.querySelector('.ws-prime')).toBeTruthy();
    const blanket = container.querySelector('.ws-blanket');
    expect(blanket.style.transform).toBe('scaleY(0.3)');
    // never the height attribute
    expect(fill.getAttribute('height')).toBeNull();
  });

  it('Fill renders nothing for a null level', () => {
    const { container } = sheet(<Fill level={null} />);
    expect(container.querySelector('.ws-fill')).toBeNull();
  });

  it('Wave animates only when given a duration and is flat otherwise', () => {
    const a = sheet(<Wave dur={secs(3.2)} amp={2} />);
    const w = a.container.querySelector('.ws-wave');
    expect(w.classList.contains('ws-anim')).toBe(true);
    expect(w.style.getPropertyValue('--ws-drift')).toBe('3.20s');

    const b = sheet(<Wave dur={null} amp={2} />);
    const flat = b.container.querySelector('.ws-wave');
    expect(flat.classList.contains('ws-anim')).toBe(false);
  });

  it('Bubbles are existence-gated and capped', () => {
    expect(sheet(<Bubbles columns={0} dur="2.00s" />).container.querySelectorAll('.ws-bubble').length).toBe(0);
    expect(sheet(<Bubbles columns={4} dur={null} />).container.querySelectorAll('.ws-bubble').length).toBe(0);
    const c = sheet(<Bubbles columns={6} perColumn={5} dur="2.00s" />);
    const bubbles = c.container.querySelectorAll('.ws-bubble');
    expect(bubbles.length).toBeLessThanOrEqual(18);
    expect(bubbles[0].style.getPropertyValue('--ws-bubble-dur')).toBe('2.00s');
    expect(bubbles[1].style.animationDelay).toContain('-');
  });

  it('Rotor spins when given a duration and parks when not', () => {
    const on = sheet(<Rotor dur="0.72s" anchor={[36, 30, 14]}><circle cx="36" cy="30" r="10" /></Rotor>);
    const g = on.container.querySelector('.ws-rotor');
    expect(g.classList.contains('ws-anim')).toBe(true);
    expect(g.style.getPropertyValue('--ws-spin')).toBe('0.72s');
    expect(g.style.transformBox).toBe('fill-box');
    expect(g.style.transformOrigin).toBe('50% 50%');

    const off = sheet(<Rotor dur={null} parkedAt={12}><circle cx="36" cy="30" r="10" /></Rotor>);
    const p = off.container.querySelector('.ws-rotor');
    expect(p.classList.contains('ws-anim')).toBe(false);
    expect(p.style.transform).toBe('rotate(12deg)');
  });

  it('Rotor supports a user-space pivot and the rake channel', () => {
    const { container } = sheet(<Rotor dur="20.00s" channel="rake" origin={[72, 24]}><line x1="72" y1="24" x2="92" y2="24" /></Rotor>);
    const g = container.querySelector('.ws-rake');
    expect(g.style.transformBox).toBe('view-box');
    expect(g.style.transformOrigin).toBe('72px 24px');
    expect(g.style.getPropertyValue('--ws-rake-dur')).toBe('20.00s');
  });

  it('Nozzle and Hatch render', () => {
    const { container } = sheet(<><Nozzle x={10} y={30} dir="left" /><Hatch x={5} y={5} w={20} h={20} /></>);
    expect(container.querySelector('line')).toBeTruthy();
    expect(container.querySelector('.ws-hatch').getAttribute('fill')).toBe(`url(#${DEF_IDS.hatch})`);
  });

  it('the registry falls back safely and never throws', () => {
    expect(getSymbol('definitely_not_a_type')).toBe(PlaceholderSymbol);
    expect(getSymbol(undefined)).toBe(PlaceholderSymbol);
    expect(hasSymbol('pump')).toBe(false);
    expect(getTag('pump')).toBe('P');
    expect(getTag('thickener')).toBe('THK');
    expect(getTag('nope')).toBe('—');
    const { container } = sheet(<PlaceholderSymbol opType="mystery" />);
    expect(container.querySelector('.ws-shell')).toBeTruthy();
  });

  it('TAG covers every unit type a user can drop on the canvas', () => {
    // Fails the build when a palette entry is added without a drafting tag —
    // the header reserves the slot either way, so an untagged type would
    // silently print the generic mark.
    expect(PALETTE_TYPES.filter((t) => !TAG[t])).toEqual([]);
    for (const t of ['preliminary', 'granular_filter', 'thickener']) expect(TAG[t]).toBeTruthy();
  });

  it('getSymbol resolves for every palette type without throwing', () => {
    for (const t of PALETTE_TYPES) expect(typeof getSymbol(t)).toBe('function');
  });

  it('legacy aliases resolve, and a real entry beats its alias', () => {
    expect(resolveSymbolType('preliminary')).toBe('screening');
    expect(resolveSymbolType('granular_filter')).toBe('sand_filter');
    expect(resolveSymbolType('thickener')).toBe('secondary_clarifier');
    const Thick = () => <g data-x="thickener" />;
    registerSymbols({ thickener: Thick });
    expect(resolveSymbolType('thickener')).toBe('thickener');
    expect(getSymbol('thickener')).toBe(Thick);
    delete SYMBOLS.thickener;
  });

  it('ink() only ever produces the three weights', () => {
    expect(ink('shell').strokeWidth).toBe(1.75);
    expect(ink('detail').strokeWidth).toBe(1.25);
    expect(ink('media').strokeWidth).toBe(0.75);
    expect(ink('bogus').strokeWidth).toBe(1.75);
    expect(GEO.rect.w).toBe(84);
  });
});
