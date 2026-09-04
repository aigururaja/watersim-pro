/**
 * Motion-gating invariants for the canvas stylesheet.
 *
 * These are source-level assertions on canvas-motion.css because jsdom does
 * not apply real stylesheets — but the invariants they pin are behavioural,
 * and each one has already been violated once during the redesign:
 *
 *  1. Every LOOP shorthand must be scoped to `.ws-anim` on the SAME element.
 *     A symbol with no rate to show emits the loop class WITHOUT `.ws-anim`
 *     (flat wave, parked rotor, capped dosing stinger). When the shorthand
 *     was unconditional those elements still ran a compositor animation —
 *     forever, on every vessel, outside live view — silently breaking both
 *     the live-only gate and the per-node animation budget.
 *
 *  2. `.ws-anim` must NOT be scoped under `.ws-live`. Declaring the animation
 *     only while live DELETES it on exit, which resets phase; the gate is
 *     `animation-play-state`, so re-entering live resumes where it left off.
 *
 *  3. One-shots must stay OUT of the `.ws-anim` scheme — they are gated by
 *     existence (React mounts them). A paused, completed one-shot can never
 *     re-arm.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Read from disk rather than `?raw`: Vitest intercepts CSS imports, so
// `import css from '...css?raw'` resolves to an empty string and every
// assertion below would pass vacuously. `import.meta.url` is not a file URL
// under Vitest's transform either, so resolve from the working directory —
// which differs depending on whether the suite is run from the repo root or
// the frontend workspace.
const REL = 'src/styles/canvas-motion.css';
const cssPath = [
  path.resolve(process.cwd(), REL),
  path.resolve(process.cwd(), 'frontend', REL),
].find(existsSync);

const css = cssPath ? readFileSync(cssPath, 'utf8') : '';

/** Selector blocks that declare an `animation:` shorthand (not a sub-property). */
function animationRules() {
  const rules = [];
  // Match "<selector> { ... }" blocks, then keep those declaring `animation:`.
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const body = m[2];
    if (!selector || selector.startsWith('@')) continue;
    if (/(^|[\s;])animation\s*:/.test(body)) rules.push({ selector, body: body.trim() });
  }
  return rules;
}

// `animation: none` is a RESET (reduced-motion, far LOD), not a declaration —
// it must be excluded from both buckets or the resets read as one-shots.
const isReset = (r) => /(^|[\s;])animation\s*:\s*none/.test(r.body);
// Loops run forever; one-shots do not. `infinite` is the discriminator.
const isLoop = (r) => !isReset(r) && /\binfinite\b/.test(r.body);
const isOneShot = (r) => !isReset(r) && !/\binfinite\b/.test(r.body);

describe('canvas-motion.css — loop gating', () => {
  const rules = animationRules();

  test('the stylesheet actually declares animations (guard against a vacuous pass)', () => {
    expect(rules.length).toBeGreaterThan(8);
    expect(rules.filter(isLoop).length).toBeGreaterThan(6);
  });

  test('every looping animation is scoped to .ws-anim on the same element', () => {
    const ungated = rules
      .filter(isLoop)
      // `.ws-anim.ws-rotor` — same element, no whitespace between them.
      .filter(r => !/\.ws-anim(?=[.:[\s]|$)[^\s,]*/.test(r.selector.split(/\s+/).pop()))
      .map(r => r.selector);
    expect(ungated).toEqual([]);
  });

  test('a loop class alone (no .ws-anim) matches no animation rule', () => {
    // Simulates the rest-pose element: class="ws-wave ws-detail".
    for (const cls of ['ws-wave', 'ws-rotor', 'ws-bubble', 'ws-droplet', 'ws-pulse', 'ws-rake']) {
      const matches = rules.filter(isLoop).filter(r => {
        const last = r.selector.split(/\s+/).pop();
        // The rest-pose element carries only `cls`; a selector requiring
        // .ws-anim as well cannot match it.
        return last.includes(cls) && !last.includes('.ws-anim');
      });
      expect(matches.map(r => r.selector)).toEqual([]);
    }
  });

  test('the play-state gate pauses by default and runs only inside .ws-live', () => {
    expect(css).toMatch(/\.ws-anim\s*\{\s*animation-play-state:\s*paused/);
    expect(css).toMatch(/\.ws-live\s+\.ws-anim\s*\{\s*animation-play-state:\s*running/);
  });

  test('animation shorthands are not scoped under .ws-live (phase must survive a toggle)', () => {
    const liveScoped = rules
      .filter(r => /\.ws-live\b/.test(r.selector))
      .filter(r => /(^|[\s;])animation\s*:/.test(r.body))
      .map(r => r.selector);
    expect(liveScoped).toEqual([]);
  });

  test('one-shots are existence-gated, never play-state gated', () => {
    const oneShots = rules.filter(isOneShot);
    expect(oneShots.length).toBeGreaterThan(0);
    for (const r of oneShots) {
      const last = r.selector.split(/\s+/).pop();
      expect(last).not.toContain('.ws-anim');
    }
  });
});

describe('canvas-motion.css — forbidden techniques', () => {
  test('no SVG filters, blur or animated box-shadow', () => {
    expect(css).not.toMatch(/filter\s*:/);
    expect(css).not.toMatch(/animation:[^;]*box-shadow/);
    expect(css).not.toMatch(/transition:[^;]*box-shadow/);
  });

  test('reduced motion supplies rest poses rather than merely stopping motion', () => {
    const block = css.slice(css.indexOf('prefers-reduced-motion'));
    expect(block).toMatch(/\.ws-rake\s*\{\s*transform:\s*rotate\(45deg\)/);
    expect(block).toMatch(/\.ws-wave\s*\{\s*transform:\s*none/);
  });

  test("ReactFlow's own edge dash animation is overridden", () => {
    expect(css).toMatch(/\.react-flow__edge\.animated[^{]*\{[^}]*animation:\s*none/);
  });
});
