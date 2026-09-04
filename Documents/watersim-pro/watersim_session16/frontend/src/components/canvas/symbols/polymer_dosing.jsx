/**
 * polymer_dosing — #20: the dosing pot with a COILED CHAIN mark.
 *
 * See `chemical_dosing.jsx` for the shared body, the `dose_kg_d` driver and
 * the reason `dose_mg_L` may never touch a duration (spec §5.3 #16).
 */

import { registerSymbol } from './index';
import { DosingSymbol } from './chemical_dosing';

export function PolymerDosingSymbol(props) {
  return <DosingSymbol {...props} variant="polymer_dosing" />;
}

registerSymbol('polymer_dosing', PolymerDosingSymbol);

export default PolymerDosingSymbol;
