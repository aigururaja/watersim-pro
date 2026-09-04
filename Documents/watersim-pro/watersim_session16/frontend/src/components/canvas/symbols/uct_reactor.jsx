/**
 * uct_reactor — §3.2 #12, §5.3 #2b.
 *
 * The basin split by 2 baffles (8px floor gaps) into anaerobic | anoxic |
 * aerobic, with the mixed-liquor recycle arc landing on ZONE 2 — the anoxic
 * cell. That is the UCT innovation (MLR anoxic → anaerobic keeps NO₃ out of the
 * anaerobic zone) and it is the one mark that separates this drawing from JHB.
 *
 * Zone widths come from `metrics.zone_volumes_m3`, which the solver returns
 * ONLY on the UCT / JHB paths (aerationBasin.js:192). A `uct_reactor` node whose
 * params never set `ebpr_config: 'uct'` runs the generic path, and the zones
 * then come from `denitrification` / `anoxic_fraction`.
 *
 * The anaerobic and anoxic zones get NO bubbles — a slow horizontal mixer wash
 * instead. Bubbles are confined to the aerobic zone.
 */

import { AerationSymbol } from './activated_sludge';
import { registerSymbol } from './index';

export default function UctReactorSymbol(props) {
  return <AerationSymbol {...props} variant="uct" />;
}

registerSymbol('uct_reactor', UctReactorSymbol);
