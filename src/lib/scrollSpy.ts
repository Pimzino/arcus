// Which section of a page of stacked sections a nav should highlight, from where the page is scrolled.

/** Where a page of stacked sections is scrolled, in px. */
export type SpyViewport = {
  /** scrollTop of the scrolling element. */
  scrollTop: number;
  /** Its visible height (clientHeight). */
  height: number;
  /** The height of everything it scrolls over (scrollHeight). */
  scrollHeight: number;
};

/**
 * The section to highlight: the last one whose top has reached the line `offset` px below the top of the
 * view. `tops` are the sections' top edges in ascending order, in px from the top of the scrolled content;
 * -1 when there are none, the first one before any top has reached the line.
 *
 * The sections at the end of a page are usually too short for their tops to ever get to that line. Once the
 * last one that can get there has, the line sweeps on to the end of the content instead, so the rest still
 * take their turn, in order and in proportion to their heights, and the last one is current at the bottom.
 */
export function currentSection(view: SpyViewport, tops: number[], offset: number): number {
  if (tops.length === 0) return -1;
  const maxScroll = Math.max(0, view.scrollHeight - view.height);
  if (maxScroll <= 0) return 0;
  const scrollTop = Math.min(Math.max(view.scrollTop, 0), maxScroll);

  // The last section whose top can reach the line, and the scroll position where it does.
  let reach = 0;
  while (reach + 1 < tops.length && tops[reach + 1] - offset <= maxScroll) reach++;
  const sweepFrom = Math.min(Math.max(tops[reach] - offset, 0), maxScroll);

  if (scrollTop > sweepFrom) {
    // Past there the line covers the rest of the content over what is left to scroll.
    const from = sweepFrom + offset;
    return lastReached(tops, from + ((scrollTop - sweepFrom) * (view.scrollHeight - from)) / (maxScroll - sweepFrom));
  }
  // Nothing left to scroll for the sections out of reach: the bottom is the last one's.
  if (scrollTop >= maxScroll && reach < tops.length - 1) return tops.length - 1;
  return lastReached(tops, scrollTop + offset);
}

/** The last section whose top is at or above `line`, in content px; the first when none is. */
function lastReached(tops: number[], line: number): number {
  let i = 0;
  while (i + 1 < tops.length && tops[i + 1] <= line) i++;
  return i;
}
