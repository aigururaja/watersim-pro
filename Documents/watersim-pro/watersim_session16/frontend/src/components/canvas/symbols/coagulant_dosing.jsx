/**
 * coagulant_dosing — #19: the dosing pot with a HEX CRYSTAL mark (Al / Fe).
 *
 * The four dosing types share one solver (`chemicalDosing.js`), so they share
 * one drawing and one driver (`dose_kg_d`, spec §5.3 #16). Everything except
 * the mark lives in `chemical_dosing.jsx`; splitting the geometry per type is
 * how four sibling symbols drift apart.
 */

import { registerSymbol } from './index';
import { DosingSymbol } from './chemical_dosing';

export function CoagulantDosingSymbol(props) {
  return <DosingSymbol {...props} variant="coagulant_dosing" />;
}

registerSymbol('coagulant_dosing', CoagulantDosingSymbol);

export default CoagulantDosingSymbol;
