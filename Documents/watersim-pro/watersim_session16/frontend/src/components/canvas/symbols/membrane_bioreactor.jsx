/**
 * membrane_bioreactor — §3.2 #11: the aeration basin plus a 3-line membrane
 * leaf stack in the right third.
 *
 * The MBR runs the SAME solver model as `activated_sludge` (aerationBasin.js),
 * so it gets the same driver table: bubble columns from
 * `O2_demand_kg_d / volume_m3`, density from the `MLSS_mg_L` setpoint, wave
 * from throughput. The only differences are the leaf stack and the bubble span,
 * which stops short of the leaves so the two internals never overlap.
 */

import { AerationSymbol } from './activated_sludge';
import { registerSymbol } from './index';

export default function MembraneBioreactorSymbol(props) {
  return <AerationSymbol {...props} variant="mbr" />;
}

registerSymbol('membrane_bioreactor', MembraneBioreactorSymbol);
