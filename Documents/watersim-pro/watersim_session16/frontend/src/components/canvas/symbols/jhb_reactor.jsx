/**
 * jhb_reactor — §3.2 #13, §5.3 #2b.
 *
 * The zoned basin again, but the recycle arc comes off the RAS line at the
 * frame edge and lands on ZONE 1: in JHB the RAS is denitrified in a pre-anoxic
 * cell BEFORE it reaches the anaerobic zone. Arc origin and landing zone are the
 * whole difference from UCT, and they are exactly the process difference.
 *
 * The solver returns FOUR volumes for JHB (pre_anoxic | anaerobic |
 * main_anoxic | aerobic, aerationBasin.js:300). §3.2 draws three zones at this
 * size — 84px across four cells is illegible — so the pre-anoxic cell is folded
 * into the head-end unaerated zone. Neither is aerated and both carry the same
 * mixer wash, so nothing is lost but a baffle.
 */

import { AerationSymbol } from './activated_sludge';
import { registerSymbol } from './index';

export default function JhbReactorSymbol(props) {
  return <AerationSymbol {...props} variant="jhb" />;
}

registerSymbol('jhb_reactor', JhbReactorSymbol);
