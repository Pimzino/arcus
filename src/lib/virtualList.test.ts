import { describe, expect, it } from "vitest";
import { scrollTopToReveal, visibleRange, type ListViewport } from "./virtualList";

/** 26px rows below a 28px header, seen through a list 260px tall. */
const view = (scrollTop: number): ListViewport => ({ scrollTop, height: 260, rowsTop: 28, rowHeight: 26 });

describe("visibleRange", () => {
  it("covers the rows in view, including partly visible ones, plus the overscan", () => {
    expect(visibleRange(view(0), 1000, 0)).toEqual({ start: 0, end: 9 });
    // Row 98 spans 2576–2602 and row 108 spans 2836–2862, both partly inside 2600–2860.
    expect(visibleRange(view(2600), 1000, 0)).toEqual({ start: 98, end: 109 });
    expect(visibleRange(view(2600), 1000, 5)).toEqual({ start: 93, end: 114 });
  });

  it("stays within the list", () => {
    expect(visibleRange(view(0), 1000, 5)).toEqual({ start: 0, end: 14 });
    expect(visibleRange(view(2368), 100, 5)).toEqual({ start: 85, end: 100 });
    expect(visibleRange(view(0), 0, 5)).toEqual({ start: 0, end: 0 });
  });

  it("is empty when the scroll position is past a list that got shorter", () => {
    expect(visibleRange(view(5000), 10, 5)).toEqual({ start: 10, end: 10 });
  });
});

describe("scrollTopToReveal", () => {
  it("leaves a row that is in view alone", () => {
    expect(scrollTopToReveal(view(0), 3, 28)).toBeNull();
  });

  it("scrolls down just far enough to show a row below the view", () => {
    // Row 20 spans 548–574.
    expect(scrollTopToReveal(view(0), 20, 28)).toBe(314);
  });

  it("scrolls up to put a row above the view just below the sticky header", () => {
    // Row 50 starts at 1328; the header covers the top 28px of the view.
    expect(scrollTopToReveal(view(2600), 50, 28)).toBe(1300);
    expect(scrollTopToReveal(view(2600), 50)).toBe(1328);
  });

  it("treats a row hidden under the sticky header as out of view", () => {
    // Row 0 spans 28–54, under the header that covers 40–68 at this scroll position.
    expect(scrollTopToReveal(view(40), 0, 28)).toBe(0);
  });
});
