/**
 * Which outlet of a multi-outlet block a line read from a P&ID leaves by.
 *
 * The reader reports lines as plain from → to pairs. A three-phase separator
 * has three outlets (gas, oil, water) and the solver routes each by the role on
 * its line, so without one all three lines would share the water. The role is
 * taken from where the line leads: the label of the block it reaches, or of the
 * first labelled block further down a single-file run (separator → pump →
 * "Oil Outlet"). No match leaves the line plain, and the solver warns.
 */

const MULTI_OUTLET = new Set(['three_phase_separator']);
const MAX_HOPS = 4;

/** gas before water before oil, so "oily water" is water. */
function roleFromLabel(label) {
  const t = String(label || '').toLowerCase();
  if (/\b(gas|vapou?r|flare|vent)\b/.test(t)) return 'gas';
  if (/water/.test(t)) return 'water';
  if (/\b(oil|crude|condensate)\b/.test(t)) return 'oil';
  return null;
}

/**
 * @param {{id:string,type:string,label?:string}[]} units
 * @param {{from:string,to:string}[]} connections
 * @returns {(string|null)[]} a role per connection, or null for a plain line
 */
export function pidEdgeRoles(units, connections) {
  const byId = new Map(units.map((u) => [u.id, u]));
  const outs = new Map();
  for (const c of connections) outs.set(c.from, [...(outs.get(c.from) || []), c.to]);

  return connections.map((c) => {
    if (!MULTI_OUTLET.has(byId.get(c.from)?.type)) return null;
    let id = c.to;
    for (let hop = 0; hop < MAX_HOPS && id; hop++) {
      const role = roleFromLabel(byId.get(id)?.label);
      if (role) return role;
      const next = outs.get(id) || [];
      id = next.length === 1 ? next[0] : null;
    }
    return null;
  });
}
