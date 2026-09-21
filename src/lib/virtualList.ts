// Rendering only the rows of a long list of fixed-height rows that are in view.

/** Where a list of fixed-height rows is scrolled, in px. */
export type ListViewport = {
  /** scrollTop of the scrolling element. */
  scrollTop: number;
  /** Its visible height (clientHeight). */
  height: number;
  /** Offset of the first row from the top of the scrolled content, below whatever precedes the rows. */
  rowsTop: number;
  rowHeight: number;
};

/** The rows worth rendering, from `start` up to but excluding `end`: those in view plus `overscan` more on each side. */
export function visibleRange(view: ListViewport, count: number, overscan: number): { start: number; end: number } {
  const top = view.scrollTop - view.rowsTop;
  const end = Math.max(0, Math.min(count, Math.ceil((top + view.height) / view.rowHeight) + overscan));
  const start = Math.min(end, Math.max(0, Math.floor(top / view.rowHeight) - overscan));
  return { start, end };
}

/**
 * The scrollTop that shows row `index` with the least scrolling, keeping it clear of a sticky header
 * `stickyHeight` px tall at the top of the view; null when the row is fully in view already.
 */
export function scrollTopToReveal(view: ListViewport, index: number, stickyHeight = 0): number | null {
  const top = view.rowsTop + index * view.rowHeight;
  if (top - stickyHeight < view.scrollTop) return top - stickyHeight;
  const bottom = top + view.rowHeight;
  if (bottom > view.scrollTop + view.height) return bottom - view.height;
  return null;
}
