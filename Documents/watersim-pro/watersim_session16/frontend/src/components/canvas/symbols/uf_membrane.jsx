/**
 * #24 `uf_membrane` — ultrafiltration element   (spec §3.2 #24, §5.3 #14)
 * ─────────────────────────────────────────────────────────────────────────────
 * The same capsule as #23, specialised: five hollow-fibre lines, NO gauge.
 *
 * The missing gauge is not a styling choice. `PALETTE_TYPE_MAP.uf_membrane =
 * 'screen'` (solver.js:63) — a UF on this canvas is solved by `screen.js`,
 * which returns `screenType`, `TSS_removal_pct` (a STRING), `screenings_kg_d`,
 * `screenings_Q_m3_d` and `headloss_m`. It returns NO `pressure_bar` and NO
 * `recovery_pct`, so there is no needle to swing and no shimmer opacity to
 * encode. Drawing either would be inventing a field the solver never produced,
 * which honesty rule #1 forbids outright.
 *
 * The one static encoder that IS backed by a returned metric is `headloss_m`
 * (an echo, so static only): amber above 0.45 m, the same threshold §5.3 #12
 * applies to this same metric on this same model.
 *
 * Implementation lives in `ro_membrane.jsx` — one drawing, two registrations.
 */

import { registerSymbol } from './index';
import { MembraneSymbol } from './ro_membrane';

export function UfMembraneSymbol(props) {
  return <MembraneSymbol {...props} variant="uf" />;
}

registerSymbol('uf_membrane', UfMembraneSymbol);

export default UfMembraneSymbol;
