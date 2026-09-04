/**
 * register — the ONE import point that fills the SYMBOLS registry
 * ─────────────────────────────────────────────────────────────────────────────
 * Every `symbols/<opType>.jsx` module registers itself with `registerSymbol()`
 * as a SIDE EFFECT of being imported. Nothing else imports those modules, so
 * without this file `SYMBOLS` is empty at runtime and `getSymbol()` returns the
 * placeholder for all 26 types — the canvas draws 26 identical grey hatched
 * boxes and nobody can tell why.
 *
 * ── WHY AN EXPLICIT LIST AND NOT `import.meta.glob` ──────────────────────────
 * `SymbolSheet.jsx` proves the glob works, but it is a dev harness. An explicit
 * list is deterministic for the production bundler: the modules land in the
 * main chunk in a fixed order, a typo is a build error rather than a silently
 * missing symbol, and tree-shaking can never decide a "side-effect only" glob
 * entry is unused. The registry is `Object.keys`-ordered by insertion, so this
 * order is also the contact sheet's order.
 *
 * ── WHERE THIS IS IMPORTED ───────────────────────────────────────────────────
 * EXACTLY ONCE, from `UnitOpNode.jsx`. That is deliberate and load-bearing:
 *
 *   · CanvasPage imports UnitOpNode, so the canvas and the palette rail (which
 *     reads the same registry at RENDER time, not at module-eval time) are both
 *     populated in the app.
 *   · It is NOT imported from `UnitOpPalette.jsx`. `src/test/symbolPrimitives.
 *     test.jsx` imports `PALETTE` from that module and asserts
 *     `hasSymbol('pump') === false` and `resolveSymbolType('thickener') ===
 *     'secondary_clarifier'` — both of which are statements about an EMPTY
 *     registry. Pulling the registrations in through the palette would flip
 *     them and fail a suite this phase is required to keep green.
 *
 * Adding a 27th symbol is two lines: the file, and one line here.
 */

// ── Lane C — inline family (10) ─────────────────────────────────────────────
import './inlet';
import './outlet';
import './pump';
import './valve';
import './blower';
import './screening';
import './chemical_dosing';
import './coagulant_dosing';
import './polymer_dosing';
import './ph_adjustment';

// ── Lane D — vessels (9) ────────────────────────────────────────────────────
import './primary_clarifier';
import './secondary_clarifier';
import './grit_removal';
import './thickener';
import './activated_sludge';
import './uct_reactor';
import './jhb_reactor';
import './membrane_bioreactor';
import './anaerobic_digester';

// ── Lane E — treatment (8) ──────────────────────────────────────────────────
import './sand_filter';        // also registers the `granular_filter` alias
import './chlorination';
import './coagulation';
import './uv_disinfection';
import './ro_membrane';
import './uf_membrane';
import './gac_adsorption';
import './tank';

import { SYMBOLS } from './index';

/**
 * Every opType this build can draw. Read AFTER importing this module.
 * @returns {string[]}
 */
export const registeredTypes = () => Object.keys(SYMBOLS);

/** True once the registry has been filled — a cheap runtime self-check. */
export const REGISTERED = true;

export default REGISTERED;
