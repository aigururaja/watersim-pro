/**
 * ph_adjustment — #21: the dosing pot with a HALF-FILLED pH BAR + up/down arrow.
 *
 * The only dosing variant with a second encoder: the RECEIVING liquid (the
 * process line downstream of the quill) is tinted from the COMPUTED `pH_out`
 * on a litmus ramp, and the symbol flags watch when |pH_out − pH_in| > 1.5
 * (spec §5.3 #16). Both live in `chemical_dosing.jsx` behind `variant`.
 *
 * `pH_out` is genuinely computed (`chemicalDosing.js:124` — the influent pH
 * plus the dose times the reagent's buffer coefficient), which is why it is
 * allowed to colour anything at all.
 */

import { registerSymbol } from './index';
import { DosingSymbol } from './chemical_dosing';

export function PhAdjustmentSymbol(props) {
  return <DosingSymbol {...props} variant="ph_adjustment" />;
}

registerSymbol('ph_adjustment', PhAdjustmentSymbol);

export default PhAdjustmentSymbol;
