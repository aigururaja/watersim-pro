/**
 * Numbers read off a P&ID, split into those the block has a setting for and
 * those it has not. Only the first reach the new block; the review dialog lists
 * the second so a value on the drawing never vanishes without a word.
 *
 * @param {Record<string, number>} params  as the reader returned them
 * @param {Set<string>|null} known  the block's setting keys; null = keep all
 * @returns {{ kept: [string, number][], unused: [string, number][] }}
 */
export function splitPidParams(params, known) {
  const kept = [];
  const unused = [];
  for (const entry of Object.entries(params || {})) {
    (!known || known.has(entry[0]) ? kept : unused).push(entry);
  }
  return { kept, unused };
}
