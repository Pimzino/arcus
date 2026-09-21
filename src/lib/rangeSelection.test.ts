import { describe, expect, it } from "vitest";
import { extendTo, rangeAt, rangeKeys, stepCursor, type RangeEnds } from "./rangeSelection";

/** Rows 0–7, keyed a–h. */
const rows = [..."abcdefgh"].map((key) => ({ key }));

/** Press arrow keys ("↓", "⇧↑", …) in turn from `start`; the resulting range, and its rows' keys joined up. */
function press(start: RangeEnds | null, ...keys: string[]) {
  let ends = start;
  for (const key of keys) ends = stepCursor(rows, ends, key.endsWith("↓") ? 1 : -1, key.startsWith("⇧"))!.ends;
  return { ends, selected: [...rangeKeys(rows, ends!)].join("") };
}

describe("stepCursor", () => {
  it("grows the range by a row with each Shift+arrow, keeping the anchor", () => {
    expect(press(rangeAt("a"), "⇧↓")).toEqual({ ends: { anchor: "a", cursor: "b" }, selected: "ab" });
    expect(press(rangeAt("a"), "⇧↓", "⇧↓", "⇧↓")).toEqual({ ends: { anchor: "a", cursor: "d" }, selected: "abcd" });
  });

  it("shrinks the range from the cursor end when Shift+arrow goes back", () => {
    expect(press(rangeAt("a"), "⇧↓", "⇧↓", "⇧↓", "⇧↑").selected).toBe("abc");
  });

  it("extends upwards from the bottom of a range, and through the anchor to its other side", () => {
    expect(press(rangeAt("f"), "⇧↑", "⇧↑")).toEqual({ ends: { anchor: "f", cursor: "d" }, selected: "def" });
    expect(press(rangeAt("c"), "⇧↓", "⇧↑", "⇧↑").selected).toBe("bc");
  });

  it("moves a plain arrow from the cursor, starting a new range on the row it selects", () => {
    expect(press(rangeAt("f"), "⇧↑", "⇧↑", "↓")).toEqual({ ends: rangeAt("e"), selected: "e" });
    expect(press(rangeAt("f"), "⇧↑", "⇧↑", "↓", "⇧↓").selected).toBe("ef");
    expect(press({ anchor: "a", cursor: "d" }, "↑").selected).toBe("c");
  });

  it("stops at the first and last rows", () => {
    expect(press(rangeAt("g"), "⇧↓", "⇧↓", "⇧↓")).toEqual({ ends: { anchor: "g", cursor: "h" }, selected: "gh" });
    expect(stepCursor(rows, rangeAt("h"), 1, false)).toEqual({ ends: rangeAt("h"), index: 7 });
    expect(press(rangeAt("b"), "↑", "↑").selected).toBe("a");
  });

  it("returns the new cursor's index, to scroll to", () => {
    expect(stepCursor(rows, { anchor: "a", cursor: "c" }, 1, true)?.index).toBe(3);
    expect(stepCursor(rows, { anchor: "a", cursor: "c" }, -1, false)?.index).toBe(1);
  });

  it("starts afresh on the first row without a cursor, or when the cursor's row is gone", () => {
    expect(stepCursor(rows, null, 1, true)).toEqual({ ends: rangeAt("a"), index: 0 });
    expect(stepCursor(rows, null, -1, false)).toEqual({ ends: rangeAt("a"), index: 0 });
    expect(stepCursor(rows, { anchor: "e", cursor: "gone" }, 1, true)).toEqual({ ends: rangeAt("a"), index: 0 });
  });

  it("starts a new range when the anchor's row is gone", () => {
    expect(stepCursor(rows, { anchor: "gone", cursor: "c" }, 1, true)).toEqual({ ends: rangeAt("d"), index: 3 });
  });

  it("has nowhere to go in an empty list", () => {
    expect(stepCursor([], rangeAt("a"), 1, true)).toBeNull();
  });
});

describe("extendTo", () => {
  it("keeps the anchor and moves the cursor to the clicked row, on either side", () => {
    expect(extendTo(rows, { anchor: "c", cursor: "e" }, "g")).toEqual({ anchor: "c", cursor: "g" });
    expect(extendTo(rows, { anchor: "c", cursor: "e" }, "a")).toEqual({ anchor: "c", cursor: "a" });
  });

  it("selects just the clicked row without an anchor in the list", () => {
    expect(extendTo(rows, null, "d")).toEqual(rangeAt("d"));
    expect(extendTo(rows, { anchor: "gone", cursor: "b" }, "d")).toEqual(rangeAt("d"));
  });
});

describe("rangeKeys", () => {
  it("lists the rows between the ends in list order, whichever end comes first", () => {
    expect([...rangeKeys(rows, { anchor: "b", cursor: "e" })]).toEqual(["b", "c", "d", "e"]);
    expect([...rangeKeys(rows, { anchor: "e", cursor: "b" })]).toEqual(["b", "c", "d", "e"]);
    expect([...rangeKeys(rows, rangeAt("h"))]).toEqual(["h"]);
  });

  it("is empty when an end is not in the list", () => {
    expect(rangeKeys(rows, { anchor: "b", cursor: "gone" }).size).toBe(0);
  });
});
