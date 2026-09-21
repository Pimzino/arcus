import { describe, expect, it } from "vitest";
import { formatBytes, formatSpeed } from "./format";

describe("formatBytes", () => {
  it("rounds to whole bytes below 1 KiB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(807.802457515556)).toBe("808 B");
    expect(formatBytes(1023.4)).toBe("1023 B");
  });

  it("keeps one decimal in the binary units", () => {
    expect(formatBytes(1023.6)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MiB");
  });

  it("has no number to show for a missing value", () => {
    expect(formatBytes(null)).toBe("–");
    expect(formatBytes(undefined)).toBe("–");
    expect(formatBytes(NaN)).toBe("–");
  });
});

describe("formatSpeed", () => {
  it("reports a slow transfer in whole bytes", () => {
    expect(formatSpeed(807.802457515556)).toBe("808 B/s");
    expect(formatSpeed(0)).toBe("0 B/s");
  });
});
