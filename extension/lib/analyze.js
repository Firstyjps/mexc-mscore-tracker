// What the numbers mean, as pure functions the dashboard and the tests share.
import { DIMENSIONS } from './mexc.js';
import { DROP_ALERT, sortedDays } from './store.js';

export const TIERS = [
  { name: 'Standard', min: 350 },
  { name: 'Premier', min: 600 },
  { name: 'Elite', min: 800 },
];
export const SCALE = { min: 350, max: 1000 };

export function tierOf(score) {
  let tier = null;
  for (const t of TIERS) if (score >= t.min) tier = t;
  return tier;
}

export function nextTier(score) {
  return TIERS.find((t) => score < t.min) ?? null;
}

/** Rows oldest first, each with its change against the previous recorded row. */
export function history(rows) {
  let previous = null;
  return sortedDays(rows).map((day) => {
    const row = rows[day];
    const dimensionChange = {};
    for (const name of DIMENSIONS) {
      if (previous && row.dimensions?.[name] != null && previous.dimensions?.[name] != null) dimensionChange[name] = row.dimensions[name] - previous.dimensions[name];
    }
    const item = { day, ...row, change: previous ? row.score - previous.score : null, dimensionChange };
    previous = row;
    return item;
  });
}

/**
 * Why the score fell, as far as the five factors can tell. `hidden` is the case worth flagging: the score fell while no
 * factor did, so the factors shown by MEXC do not explain it.
 */
export function explainDrop(item) {
  if (item?.change == null || -item.change < DROP_ALERT) return null;
  const known = Object.keys(item.dimensionChange);
  if (known.length < DIMENSIONS.length) return { kind: 'unknown', fell: [] };
  const fell = known.filter((name) => item.dimensionChange[name] < 0);
  return { kind: fell.length ? 'factors' : 'hidden', fell };
}
