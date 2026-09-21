import { describe, expect, it } from "vitest";
import { formatLocation, parseLocation } from "./paths";

describe("parseLocation", () => {
  it("accepts remote names with @ + . and spaces, like rclone", () => {
    expect(parseLocation("user@example.com:Team Brand Assets")).toEqual({ fs: "user@example.com:", path: "Team Brand Assets" });
    expect(parseLocation("my+drive.v2:")).toEqual({ fs: "my+drive.v2:", path: "" });
    expect(parseLocation("Work Drive:photos/2024/")).toEqual({ fs: "Work Drive:", path: "photos/2024" });
  });

  it("parses local paths", () => {
    expect(parseLocation("/Users/me/Downloads")).toEqual({ fs: "/", path: "Users/me/Downloads" });
    expect(parseLocation("/")).toEqual({ fs: "/", path: "" });
    expect(parseLocation("C:\\Users\\me")).toEqual({ fs: "C:/", path: "Users/me" });
    expect(parseLocation("d:")).toEqual({ fs: "D:/", path: "" });
  });

  it("parses connection strings", () => {
    expect(parseLocation(":s3,provider=AWS:bucket/path")).toEqual({ fs: ":s3,provider=AWS:", path: "bucket/path" });
  });

  it("round-trips through formatLocation", () => {
    for (const input of ["user@example.com:Team Brand Assets", "gdrive:a/b", "/Users/me", "C:/Users/me", ":memory:bucket/x"]) {
      expect(formatLocation(parseLocation(input))).toBe(input);
    }
  });
});
