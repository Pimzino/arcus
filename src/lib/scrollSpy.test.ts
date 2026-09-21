import { describe, expect, it } from "vitest";
import { currentSection, type SpyViewport } from "./scrollSpy";

/** The settings page in an ordinary window: the first section starts below the page's 24px padding. */
const TOPS = [24, 524, 1024, 1524, 2084, 2408, 2562];
const OFFSET = 40;
/** 2316px to scroll, so only the tops up to 2084 can reach the line: the last two sections are too short. */
const view = (scrollTop: number): SpyViewport => ({ scrollTop, height: 600, scrollHeight: 2916 });

describe("currentSection", () => {
  it("starts on the first section, whose top has not reached the line yet", () => {
    expect(currentSection(view(0), TOPS, OFFSET)).toBe(0);
    expect(currentSection(view(0), [100, 700, 1300], OFFSET)).toBe(0);
  });

  it("changes section as the line passes each top, in both directions", () => {
    // Section 1 takes over at 524 − 40 and holds it until section 2's top arrives at 1024 − 40.
    expect(currentSection(view(483), TOPS, OFFSET)).toBe(0);
    expect(currentSection(view(484), TOPS, OFFSET)).toBe(1);
    expect(currentSection(view(983), TOPS, OFFSET)).toBe(1);
    expect(currentSection(view(984), TOPS, OFFSET)).toBe(2);
    expect(currentSection(view(983), TOPS, OFFSET)).toBe(1);
    expect(currentSection(view(483), TOPS, OFFSET)).toBe(0);
  });

  it("holds the section a click scrolled to, which lands 16px below the top", () => {
    expect(currentSection(view(TOPS[1] - 16), TOPS, OFFSET)).toBe(1);
    expect(currentSection(view(TOPS[2] - 16), TOPS, OFFSET)).toBe(2);
    // Smooth scrolling can stop a hair short of it.
    expect(currentSection(view(TOPS[2] - 17), TOPS, OFFSET)).toBe(2);
    expect(currentSection(view(TOPS[3] - 16.5), TOPS, OFFSET)).toBe(3);
  });

  it("gives each section that cannot reach the line a turn at the end of the page", () => {
    // Section 4 arrives at 2044; the line then covers 2084–2916 over the remaining 272px of scrolling.
    expect(currentSection(view(2044), TOPS, OFFSET)).toBe(4);
    expect(currentSection(view(2149), TOPS, OFFSET)).toBe(4);
    expect(currentSection(view(2150), TOPS, OFFSET)).toBe(5);
    expect(currentSection(view(2200), TOPS, OFFSET)).toBe(5);
    expect(currentSection(view(2201), TOPS, OFFSET)).toBe(6);
    expect(currentSection(view(2316), TOPS, OFFSET)).toBe(6);
    // A fractional scrollTop that stops just short of the bottom is still the bottom.
    expect(currentSection(view(2315.5), TOPS, OFFSET)).toBe(6);
  });

  it("never goes backwards, and skips nothing, on the way down", () => {
    const seen: number[] = [];
    let previous = 0;
    for (let scrollTop = 0; scrollTop <= 2316; scrollTop++) {
      const i = currentSection(view(scrollTop), TOPS, OFFSET);
      expect(i).toBeGreaterThanOrEqual(previous);
      if (i !== previous) seen.push(i);
      previous = i;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("shares the little scrolling of a very tall window between every section", () => {
    // 16px to scroll: no top but the first one's can reach the line.
    const tall = (scrollTop: number): SpyViewport => ({ scrollTop, height: 2900, scrollHeight: 2916 });
    expect(currentSection(tall(0), TOPS, OFFSET)).toBe(0);
    expect(currentSection(tall(8), TOPS, OFFSET)).toBe(2);
    expect(currentSection(tall(16), TOPS, OFFSET)).toBe(6);
  });

  it("stays on the first section when the page does not scroll", () => {
    expect(currentSection({ scrollTop: 0, height: 600, scrollHeight: 500 }, TOPS, OFFSET)).toBe(0);
  });

  it("has nothing to highlight without sections", () => {
    expect(currentSection(view(0), [], OFFSET)).toBe(-1);
  });

  it("clamps a scroll position outside the page", () => {
    expect(currentSection(view(-50), TOPS, OFFSET)).toBe(0);
    expect(currentSection(view(99_999), TOPS, OFFSET)).toBe(6);
  });

  it("gives the bottom to the last section when the ones out of reach have no room at all", () => {
    // Section 1's top reaches the line exactly at the bottom, leaving section 2 nothing to scroll over.
    const tops = [24, 440, 500];
    const short = (scrollTop: number): SpyViewport => ({ scrollTop, height: 600, scrollHeight: 1000 });
    expect(currentSection(short(399), tops, OFFSET)).toBe(0);
    expect(currentSection(short(400), tops, OFFSET)).toBe(2);
  });
});
