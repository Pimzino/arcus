// Selecting a run of rows with Shift, as Finder does. The selected range runs from its anchor, the row
// where it started, to its cursor, the end that Shift+click and Shift+arrow keys move. Plain arrow keys
// move from the cursor too, and start a new range on the row they select. Rows go by key, not by name:
// a folder can hold several items with the same name (see sameNames.ts).

type Row = { key: string };

/** The ends of the selected range, as row keys. */
export type RangeEnds = { anchor: string; cursor: string };

/** A range holding just the row keyed `key`. */
export const rangeAt = (key: string): RangeEnds => ({ anchor: key, cursor: key });

/** The keys of the rows from the anchor to the cursor, both included; empty when either end is not in `rows`. */
export function rangeKeys(rows: readonly Row[], { anchor, cursor }: RangeEnds): Set<string> {
  const a = rows.findIndex((r) => r.key === anchor);
  const b = rows.findIndex((r) => r.key === cursor);
  if (a < 0 || b < 0) return new Set();
  return new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.key));
}

/** The range after Shift+clicking the row keyed `key`: from the same anchor to that row, or that row alone when the anchor is not in `rows`. */
export function extendTo(rows: readonly Row[], ends: RangeEnds | null, key: string): RangeEnds {
  return ends && rows.some((r) => r.key === ends.anchor) ? { anchor: ends.anchor, cursor: key } : rangeAt(key);
}

/**
 * The range after an arrow key moves the cursor `delta` rows, stopping at the first and last rows: with Shift
 * (`extend`) from the same anchor, otherwise the new cursor's row alone. Without a cursor in `rows` it starts
 * afresh on the first row. `index` is the new cursor's position; null when `rows` is empty.
 */
export function stepCursor(rows: readonly Row[], ends: RangeEnds | null, delta: number, extend: boolean): { ends: RangeEnds; index: number } | null {
  if (!rows.length) return null;
  const from = ends ? rows.findIndex((r) => r.key === ends.cursor) : -1;
  const index = Math.min(rows.length - 1, Math.max(0, from + delta));
  const key = rows[index].key;
  return { ends: extend && from >= 0 ? extendTo(rows, ends, key) : rangeAt(key), index };
}
