import { describe, expect, it } from "vitest";
import { eventLocalPath, fileManagerLabel, fileManagerName, localPathOf } from "./fileManager";
import type { ActivityEvent, ActivityKind } from "./types";

const event = (kind: ActivityKind, path: string | null = "Mixdowns/Reel 01.wav"): ActivityEvent => ({
  seq: 1,
  time: "2026-09-17T13:28:09.265749+01:00",
  kind,
  path,
  size: null,
  action: null,
  message: kind,
});

const job = (source: string, destination: string, rcPath = "sync/copy") => ({ rcPath, source, destination });

describe("localPathOf", () => {
  it("takes the OS path of a location on this computer", () => {
    expect(localPathOf({ fs: "/", path: "Users/me/Mixdowns" })).toBe("/Users/me/Mixdowns");
    expect(localPathOf({ fs: "C:/", path: "Users/me" })).toBe("C:/Users/me");
    expect(localPathOf({ fs: "//server/share/", path: "dir" })).toBe("//server/share/dir");
    expect(localPathOf({ fs: "/", path: "" })).toBe("/");
  });

  it("has none for a remote or an unset location", () => {
    expect(localPathOf({ fs: "gdrive:", path: "photos" })).toBeNull();
    expect(localPathOf({ fs: ":s3,provider=AWS:", path: "bucket" })).toBeNull();
    expect(localPathOf({ fs: "", path: "" })).toBeNull();
  });

  it("accepts the strings that are visibly absolute paths", () => {
    expect(localPathOf("/Users/me/Mixdowns")).toBe("/Users/me/Mixdowns");
    expect(localPathOf("c:/Users/me")).toBe("C:/Users/me");
    expect(localPathOf("C:\\Users\\me")).toBe("C:/Users/me");
    expect(localPathOf("//server/share/dir")).toBe("//server/share/dir");
    expect(localPathOf("\\\\server\\share\\dir")).toBe("//server/share/dir");
  });

  it("refuses the rest, including the relative paths parseLocation calls local", () => {
    expect(localPathOf("")).toBeNull();
    expect(localPathOf("Mixdowns/Reel 01.wav")).toBeNull();
    expect(localPathOf("gdrive:photos/2024")).toBeNull();
    expect(localPathOf(":s3,provider=AWS:bucket/path")).toBeNull();
    expect(localPathOf("user@example.com:Shared")).toBeNull();
  });
});

describe("fileManagerName", () => {
  it("names what each platform calls it", () => {
    expect(fileManagerName("macos")).toBe("Finder");
    expect(fileManagerName("windows")).toBe("File Explorer");
    expect(fileManagerName("linux")).toBe("file manager");
    expect(fileManagerName(undefined)).toBe("file manager");
  });
});

describe("fileManagerLabel", () => {
  it("only calls it revealing on macOS", () => {
    expect(fileManagerLabel("macos", "reveal")).toBe("Reveal in Finder");
    expect(fileManagerLabel("macos", "open")).toBe("Open in Finder");
    expect(fileManagerLabel("macos", "show")).toBe("Show in Finder");
    expect(fileManagerLabel("windows", "reveal")).toBe("Show in File Explorer");
    expect(fileManagerLabel("windows", "open")).toBe("Open in File Explorer");
    expect(fileManagerLabel("windows", "show")).toBe("Show in File Explorer");
    expect(fileManagerLabel("linux", "reveal")).toBe("Show in file manager");
    expect(fileManagerLabel("linux", "open")).toBe("Open in file manager");
    expect(fileManagerLabel(undefined, "show")).toBe("Show in file manager");
  });
});

describe("eventLocalPath", () => {
  const local = job("/Users/me/src", "/Volumes/Backup/dst");

  it("points at the destination copy of what the transfer made", () => {
    for (const kind of ["folderCreated", "copied", "renamed", "updated", "info"] as ActivityKind[]) {
      expect(eventLocalPath(local, event(kind))).toBe("/Volumes/Backup/dst/Mixdowns/Reel 01.wav");
    }
    expect(eventLocalPath(job("/Users/me/src", "/Users/me/dst", "sync/sync"), event("copied"))).toBe("/Users/me/dst/Mixdowns/Reel 01.wav");
  });

  it("points at the source copy of what failed", () => {
    expect(eventLocalPath(local, event("error"))).toBe("/Users/me/src/Mixdowns/Reel 01.wav");
    expect(eventLocalPath(local, event("notice"))).toBe("/Users/me/src/Mixdowns/Reel 01.wav");
  });

  it("falls back to the other side when one of them is a remote", () => {
    expect(eventLocalPath(job("gdrive:Music", "/Users/me/dst"), event("copied"))).toBe("/Users/me/dst/Mixdowns/Reel 01.wav");
    expect(eventLocalPath(job("/Users/me/src", "box:Backup"), event("copied"))).toBe("/Users/me/src/Mixdowns/Reel 01.wav");
    expect(eventLocalPath(job("gdrive:Music", "/Users/me/dst"), event("error"))).toBe("/Users/me/dst/Mixdowns/Reel 01.wav");
    expect(eventLocalPath(job("gdrive:Music", "box:Backup"), event("copied"))).toBeNull();
  });

  it("knows where a moved file went, never where it was", () => {
    expect(eventLocalPath(job("/Users/me/src", "/Users/me/dst", "sync/move"), event("moved"))).toBe("/Users/me/dst/Mixdowns/Reel 01.wav");
    expect(eventLocalPath(job("/Users/me/src", "box:Backup", "sync/move"), event("moved"))).toBeNull();
  });

  it("never falls back to the source of a move, which rclone logs as a copy before deleting it", () => {
    const toRemote = job("/Users/me/src", "box:Backup", "sync/move");
    for (const kind of ["copied", "folderCreated", "updated"] as ActivityKind[]) {
      expect(eventLocalPath(toRemote, event(kind))).toBeNull();
    }
    expect(eventLocalPath(job("/Users/me/src", "/Users/me/dst", "sync/move"), event("copied"))).toBe("/Users/me/dst/Mixdowns/Reel 01.wav");
    // What failed to move is still at the source.
    expect(eventLocalPath(toRemote, event("error"))).toBe("/Users/me/src/Mixdowns/Reel 01.wav");
  });

  it("has nothing for files that are gone, or that a dry run only considered", () => {
    for (const kind of ["deleted", "folderRemoved", "skipped"] as ActivityKind[]) {
      expect(eventLocalPath(local, event(kind))).toBeNull();
    }
  });

  it("has nothing without a path, or for jobs whose events are not files under both roots", () => {
    expect(eventLocalPath(local, event("copied", null))).toBeNull();
    for (const rcPath of ["sync/bisync", "operations/check", "backend/command", "operations/purge", ""]) {
      expect(eventLocalPath(job("/Users/me/src", "/Users/me/dst", rcPath), event("copied"))).toBeNull();
    }
  });

  it("does not double the slash of a root", () => {
    expect(eventLocalPath(job("gdrive:Music", "/"), event("copied", "Mixdowns"))).toBe("/Mixdowns");
    expect(eventLocalPath(job("gdrive:Music", "C:/"), event("copied", "Mixdowns"))).toBe("C:/Mixdowns");
  });
});
