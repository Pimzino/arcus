import { describe, expect, it } from "vitest";
import { driveFileId, sharedNames, withKeys } from "./sameNames";
import type { ListItem } from "./types";

const entry = (name: string, extra: Partial<ListItem> = {}): ListItem => ({
  Path: `Shared/${name}`,
  Name: name,
  Size: 10,
  ModTime: "2026-09-01T10:00:00Z",
  IsDir: false,
  ...extra,
});

const keys = (items: ListItem[]) => withKeys(items).map((i) => i.key);

describe("withKeys", () => {
  it("keys entries with distinct names by their paths", () => {
    expect(keys([entry("a.txt"), entry("b.txt")])).toEqual(["Shared/a.txt", "Shared/b.txt"]);
  });

  it("tells same-named entries apart by their IDs, in whatever order they are listed", () => {
    const older = entry("report.pdf", { ID: "1aaa" });
    const newer = entry("report.pdf", { ID: "1bbb", Size: 20 });
    const [a, b] = keys([older, newer]);
    expect(a).not.toBe(b);
    expect(keys([newer, older])).toEqual([b, a]);
  });

  it("numbers same-named entries without IDs, and a file and a folder sharing a name", () => {
    const listed = keys([entry("IMG_0001.jpg"), entry("IMG_0001.jpg"), entry("IMG_0001.jpg"), entry("Photos", { IsDir: true }), entry("Photos")]);
    expect(new Set(listed).size).toBe(5);
    expect(listed[0]).toBe("Shared/IMG_0001.jpg");
  });

  it("keeps keys unique when IDs repeat as well", () => {
    const listed = keys([entry("link", { ID: "1aaa" }), entry("link", { ID: "1aaa" }), entry("link")]);
    expect(new Set(listed).size).toBe(3);
  });

  it("keeps the rest of each entry", () => {
    const [keyed] = withKeys([entry("a.txt", { ID: "1aaa" })]);
    expect(keyed).toMatchObject({ Name: "a.txt", Path: "Shared/a.txt", ID: "1aaa", Size: 10 });
  });
});

describe("driveFileId", () => {
  it("is a file's ID", () => {
    expect(driveFileId(entry("report.pdf", { ID: "1aaa" }))).toBe("1aaa");
  });

  it("is null for folders, shortcuts and items without an ID", () => {
    expect(driveFileId(entry("Photos", { IsDir: true, ID: "1aaa" }))).toBeNull();
    expect(driveFileId(entry("report.pdf", { ID: "1target\t1shortcut" }))).toBeNull();
    expect(driveFileId(entry("report.pdf"))).toBeNull();
  });
});

describe("sharedNames", () => {
  it("counts the entries of each name that repeats, and only those", () => {
    const listing = [entry("a.txt"), entry("Photos", { IsDir: true }), entry("a.txt"), entry("b.txt"), entry("Photos", { IsDir: true }), entry("a.txt")];
    expect(sharedNames(listing)).toEqual(
      new Map([
        ["a.txt", 3],
        ["Photos", 2],
      ]),
    );
    expect(sharedNames([entry("a.txt"), entry("b.txt")]).size).toBe(0);
  });
});
