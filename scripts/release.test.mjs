import { describe, expect, it } from "vitest";
import { CHANGELOG_HEADER, VERSION_FILES, addSection, changelogSection, nextVersion, readVersion, recordedVersions, repoWebUrl, sectionFor, writeVersion } from "./release.mjs";

const web = "https://github.com/Pimzino/rclone-gui";
const sha = (prefix) => prefix.padEnd(40, "0");

describe("nextVersion", () => {
  it("bumps the patch, minor or major number", () => {
    expect(nextVersion("0.1.9", "patch")).toBe("0.1.10");
    expect(nextVersion("0.1.9", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.9", "major")).toBe("1.0.0");
  });

  it("takes an explicit version that isn't lower, including the current one before it has been released", () => {
    expect(nextVersion("0.1.0", "0.3.0")).toBe("0.3.0");
    expect(nextVersion("0.1.0", "0.1.0")).toBe("0.1.0");
    expect(() => nextVersion("0.2.0", "0.1.9")).toThrow(/lower/);
  });

  it("rejects anything else", () => {
    expect(() => nextVersion("0.1.0", "next")).toThrow(/patch, minor, major/);
    expect(() => nextVersion("0.1.0", "1.0")).toThrow();
    expect(() => nextVersion("0.1.0", undefined)).toThrow();
  });
});

describe("repoWebUrl", () => {
  it("reads GitHub remotes over HTTPS and SSH", () => {
    expect(repoWebUrl("https://github.com/Pimzino/rclone-gui.git")).toBe(web);
    expect(repoWebUrl("https://github.com/Pimzino/rclone-gui")).toBe(web);
    expect(repoWebUrl("git@github.com:Pimzino/rclone-gui.git")).toBe(web);
    expect(repoWebUrl("ssh://git@github.com/Pimzino/rclone-gui.git\n")).toBe(web);
  });

  it("is null for other hosts", () => {
    expect(repoWebUrl("https://gitlab.com/Pimzino/rclone-gui.git")).toBeNull();
    expect(repoWebUrl("/tmp/origin.git")).toBeNull();
  });
});

describe("changelogSection", () => {
  const commits = [
    { sha: sha("1234abc"), subject: "Status bar: show rclone's state and transfer progress" },
    { sha: sha("5678def"), subject: "Transfers: a bandwidth limit applies only to the transfer that sets it" },
  ];

  it("lists the commits with links to them and to the comparison with the previous release", () => {
    expect(changelogSection({ version: "0.2.0", date: "2026-09-17", commits, web, previousTag: "v0.1.0" })).toBe(
      [
        "## v0.2.0 (2026-09-17)",
        "",
        `- Status bar: show rclone's state and transfer progress ([1234abc](${web}/commit/${sha("1234abc")}))`,
        `- Transfers: a bandwidth limit applies only to the transfer that sets it ([5678def](${web}/commit/${sha("5678def")}))`,
        "",
        `All changes: [v0.1.0...v0.2.0](${web}/compare/v0.1.0...v0.2.0)`,
        "",
      ].join("\n"),
    );
  });

  it("has no comparison for the first release, and plain IDs when the repository isn't on GitHub", () => {
    expect(changelogSection({ version: "0.1.0", date: "2026-09-17", commits: commits.slice(0, 1), web: null, previousTag: null })).toBe(
      "## v0.1.0 (2026-09-17)\n\n- Status bar: show rclone's state and transfer progress (1234abc)\n",
    );
  });
});

describe("CHANGELOG.md", () => {
  const first = "## v0.1.0 (2026-09-17)\n\n- First (1111111)\n";
  const second = "## v0.1.1 (2026-09-20)\n\n- Second (2222222)\n";

  it("starts with a header, and lists newer releases above older ones", () => {
    const one = addSection(null, first);
    expect(one).toBe(`${CHANGELOG_HEADER}\n${first}`);
    const two = addSection(one, second);
    expect(two).toBe(`${CHANGELOG_HEADER}\n${second}\n${first}`);
  });

  it("gives each release its own notes, without the heading", () => {
    const changelog = addSection(addSection(null, first), second);
    expect(sectionFor(changelog, "v0.1.1")).toBe("- Second (2222222)");
    expect(sectionFor(changelog, "v0.1.0")).toBe("- First (1111111)");
    expect(sectionFor(changelog, "v0.1")).toBeNull();
    expect(sectionFor(changelog, "v0.2.0")).toBeNull();
  });
});

describe("version files", () => {
  const samples = {
    "src-tauri/tauri.conf.json": '{\n  "productName": "Rclone GUI",\n  "version": "0.1.0",\n  "plugins": {\n    "x": {\n      "version": "9.9.9"\n    }\n  }\n}\n',
    "src-tauri/Cargo.toml": '[package]\nname = "rclone-gui"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = { version = "1" }\n',
    "src-tauri/Cargo.lock": '[[package]]\nname = "reqwest"\nversion = "0.13.5"\n\n[[package]]\nname = "rclone-gui"\nversion = "0.1.0"\n',
  };

  it("sets the app's version and nothing else in tauri.conf.json, Cargo.toml and Cargo.lock", () => {
    for (const [file, pattern] of Object.entries(VERSION_FILES)) {
      expect(readVersion(samples[file], pattern)).toBe("0.1.0");
      const updated = writeVersion(samples[file], pattern, "0.2.0", file);
      expect(readVersion(updated, pattern)).toBe("0.2.0");
      expect(updated.replace('"0.2.0"', '"0.1.0"')).toBe(samples[file]);
    }
  });

  it("fails when a file records no version", () => {
    expect(() => writeVersion("{}\n", VERSION_FILES["src-tauri/tauri.conf.json"], "0.2.0", "tauri.conf.json")).toThrow(/No version found/);
  });

  it("agree with each other in this repository", () => {
    const versions = recordedVersions();
    expect(Object.keys(versions)).toHaveLength(6);
    expect(new Set(Object.values(versions)).size).toBe(1);
  });
});
