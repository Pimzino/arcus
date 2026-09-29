#!/usr/bin/env node
// Writes the `latest.json` that installed copies of Arcus read to find an update (src-tauri updater.rs,
// tauri-plugin-updater's "static" format): the version, its notes, and per platform the file to download
// and its minisign signature.
//
//   node scripts/updater-manifest.mjs --tag v1.2.3 --dir <folder with the .sig files> [--notes-file notes.md]
//                                     [--base-url https://github.com/<repo>/releases/download/v1.2.3] > latest.json
//
// Each update file is signed by `tauri build` with bundle.createUpdaterArtifacts on; its signature sits
// next to it as `<file>.sig`, and the file itself is a release asset of the same name (release.yml attaches
// both). The updater looks up `<os>-<arch>-<bundle>` first, the kind of installation it was installed
// from, then `<os>-<arch>`, so each file is listed under its bundle's key and the usual one per platform
// under the plain key as well: the app on macOS, the NSIS installer on Windows, the AppImage on Linux.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Which platform keys an update file serves, by its name. */
export function platformKeys(file) {
  const rules = [
    [/_(aarch64|arm64)\.app\.tar\.gz$/, ["darwin-aarch64-app", "darwin-aarch64"]],
    [/_(x86_64|x64)\.app\.tar\.gz$/, ["darwin-x86_64-app", "darwin-x86_64"]],
    [/_x64-setup\.exe$/, ["windows-x86_64-nsis", "windows-x86_64"]],
    [/_x64_[A-Za-z-]+\.msi$/, ["windows-x86_64-msi"]],
    [/_(amd64|x86_64)\.AppImage$/, ["linux-x86_64-appimage", "linux-x86_64"]],
    [/_(amd64|x86_64)\.deb$/, ["linux-x86_64-deb"]],
    [/\.x86_64\.rpm$/, ["linux-x86_64-rpm"]],
  ];
  return rules.find(([re]) => re.test(file))?.[1] ?? null;
}

export function buildManifest({ tag, files, notes, baseUrl, pubDate }) {
  const version = tag.replace(/^v/, "");
  const platforms = {};
  for (const { name, signature } of files) {
    const keys = platformKeys(name);
    if (!keys) throw new Error(`no platform for update file ${name}`);
    for (const key of keys) {
      if (platforms[key]) throw new Error(`two update files for ${key}: ${platforms[key].file} and ${name}`);
      platforms[key] = { signature: signature.trim(), url: `${baseUrl}/${encodeURIComponent(name)}`, file: name };
    }
  }
  for (const key of Object.values(platforms)) delete key.file;
  return { version, notes: notes.trim(), pub_date: pubDate, platforms };
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = args(process.argv.slice(2));
  if (!a.tag || !a.dir) {
    console.error("usage: updater-manifest.mjs --tag vX.Y.Z --dir <folder> [--notes-file f] [--base-url url] [--repo owner/name]");
    process.exit(2);
  }
  const repo = a.repo ?? process.env.GITHUB_REPOSITORY ?? "Pimzino/arcus";
  const baseUrl = (a["base-url"] ?? `https://github.com/${repo}/releases/download/${a.tag}`).replace(/\/$/, "");
  const files = readdirSync(a.dir)
    .filter((f) => f.endsWith(".sig"))
    .map((sig) => ({ name: sig.slice(0, -4), signature: readFileSync(join(a.dir, sig), "utf8") }));
  if (files.length === 0) throw new Error(`no .sig files in ${a.dir}`);
  const notes = a["notes-file"] ? readFileSync(a["notes-file"], "utf8") : "";
  const manifest = buildManifest({ tag: a.tag, files, notes, baseUrl, pubDate: new Date().toISOString() });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`latest.json for ${manifest.version}: ${Object.keys(manifest.platforms).sort().join(", ")}`);
}
