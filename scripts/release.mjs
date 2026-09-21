#!/usr/bin/env node
// Cutting a release:
//
//   npm run release -- <patch|minor|major|x.y.z> [--dry-run] [--trailer "Key: value"]…
//
// On an up-to-date main with nothing uncommitted, this sets the new version in every file that records
// it, adds a section to CHANGELOG.md listing each commit since the previous release with its commit ID,
// commits that as "Release vX.Y.Z", tags the commit and pushes the commit and the tag together. The
// tag's CI run (.github/workflows/build.yml) builds the bundles and publishes them as a GitHub release
// whose notes come from `node scripts/release.mjs notes vX.Y.Z`, which fails when the tag and the
// version in the files disagree.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CHANGELOG_HEADER = "# Changelog\n\nEvery release of Rclone GUI, newest first, with the commits it added since the release before it.\n";

/** Subjects of release commits, which the changelog leaves out. */
const RELEASE_SUBJECT = /^Release v\d+\.\d+\.\d+$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Files that record the app version, other than package.json and package-lock.json (which `npm version`
 * updates). In each pattern the second group is the version.
 */
export const VERSION_FILES = {
  "src-tauri/tauri.conf.json": /^( {2}"version": ")([^"]*)(")/m,
  "src-tauri/Cargo.toml": /^(\[package\]\n(?:(?!\[)[^\n]*\n)*?version = ")([^"]*)(")/m,
  "src-tauri/Cargo.lock": /^(\[\[package\]\]\nname = "rclone-gui"\nversion = ")([^"]*)(")/m,
};

/** -1, 0 or 1 as version `a` is lower than, equal to or higher than `b`. */
export function compareVersions(a, b) {
  const [pa, pb] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/**
 * The version that follows `current` for `bump`: "patch", "minor", "major", or an explicit x.y.z that is
 * not lower (it may equal `current`, to release a version that was never tagged).
 */
export function nextVersion(current, bump) {
  const parts = SEMVER.exec(current);
  if (!parts) throw new Error(`The current version "${current}" is not x.y.z.`);
  const [major, minor, patch] = parts.slice(1).map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  if (!SEMVER.test(bump ?? "")) throw new Error(`Give patch, minor, major or a version such as 1.2.3, not "${bump ?? ""}".`);
  if (compareVersions(bump, current) < 0) throw new Error(`${bump} is lower than the current version, ${current}.`);
  return bump;
}

/** The web address of a GitHub repository from its remote URL (HTTPS or SSH); null for other hosts. */
export function repoWebUrl(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

/**
 * A release's CHANGELOG.md section: a heading with the version and date, one line per commit (oldest
 * first) ending in its short ID, linked to the commit on GitHub, and a link comparing the release with
 * the one before.
 */
export function changelogSection({ version, date, commits, web, previousTag }) {
  const id = (sha) => (web ? `[${sha.slice(0, 7)}](${web}/commit/${sha})` : sha.slice(0, 7));
  const lines = [`## v${version} (${date})`, "", ...commits.map((c) => `- ${c.subject} (${id(c.sha)})`)];
  if (previousTag && web) lines.push("", `All changes: [${previousTag}...v${version}](${web}/compare/${previousTag}...v${version})`);
  return `${lines.join("\n")}\n`;
}

/** CHANGELOG.md with `section` above the older releases; `changelog` is null before the first release. */
export function addSection(changelog, section) {
  if (!changelog) return `${CHANGELOG_HEADER}\n${section}`;
  const at = changelog.search(/^## /m);
  return at < 0 ? `${changelog.trimEnd()}\n\n${section}` : `${changelog.slice(0, at)}${section}\n${changelog.slice(at)}`;
}

/** The notes for release `tag` in CHANGELOG.md: its section without the heading; null when it has none. */
export function sectionFor(changelog, tag) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line === `## ${tag}` || line.startsWith(`## ${tag} `));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

/** The version that `pattern` (from VERSION_FILES) finds in `text`; null when there is none. */
export function readVersion(text, pattern) {
  return pattern.exec(text)?.[2] ?? null;
}

/** `text` with the version that `pattern` finds set to `version`; throws when `file` records none. */
export function writeVersion(text, pattern, version, file) {
  if (readVersion(text, pattern) === null) throw new Error(`No version found in ${file}.`);
  return text.replace(pattern, `$1${version}$3`);
}

const readRepoFile = (file) => readFileSync(path.join(ROOT, file), "utf8");

/** Every version the repository records, by where it is recorded. */
export function recordedVersions(read = readRepoFile) {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const versions = { "package.json": pkg.version, "package-lock.json": lock.version, 'package-lock.json packages[""]': lock.packages?.[""]?.version };
  for (const [file, pattern] of Object.entries(VERSION_FILES)) versions[file] = readVersion(read(file), pattern);
  return versions;
}

class ReleaseError extends Error {}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function today() {
  const d = new Date();
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
}

/** The newest release tag that HEAD contains; null before the first release. */
function previousReleaseTag() {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*", "HEAD");
  } catch {
    return null;
  }
}

/** The commits since `tag` (all of them when null), oldest first, without merges and release commits. */
function commitsSince(tag) {
  const log = git("log", "--reverse", "--no-merges", "--format=%H%x09%s", tag ? `${tag}..HEAD` : "HEAD");
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ sha: line.slice(0, line.indexOf("\t")), subject: line.slice(line.indexOf("\t") + 1) }))
    .filter((commit) => !RELEASE_SUBJECT.test(commit.subject));
}

function release(bump, { dryRun, trailers }) {
  const current = JSON.parse(readRepoFile("package.json")).version;
  const version = nextVersion(current, bump);
  const tag = `v${version}`;

  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") throw new ReleaseError(`Releases are cut from main, and this is ${branch}.`);
  if (!dryRun && git("status", "--porcelain")) throw new ReleaseError("Commit or stash your changes first: the release commit holds only the version and the changelog.");
  git("fetch", "--quiet", "--tags", "origin");
  const behind = Number(git("rev-list", "--count", "HEAD..origin/main"));
  if (behind) throw new ReleaseError(`main is ${behind} commit(s) behind origin/main; pull first.`);
  if (git("tag", "--list", tag)) throw new ReleaseError(`${tag} already exists.`);

  const previousTag = previousReleaseTag();
  const commits = commitsSince(previousTag);
  if (!commits.length) throw new ReleaseError(`Nothing to release: there are no commits since ${previousTag}.`);
  const web = repoWebUrl(git("remote", "get-url", "origin"));
  const section = changelogSection({ version, date: today(), commits, web, previousTag });

  if (dryRun) {
    console.log(`Would release ${tag} (from ${current}), with ${commits.length} commit(s) since ${previousTag ?? "the start"}:\n\n${section}`);
    return;
  }

  const win = process.platform === "win32";
  execFileSync(win ? "npm.cmd" : "npm", ["version", version, "--no-git-tag-version", "--allow-same-version"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], shell: win });
  for (const [file, pattern] of Object.entries(VERSION_FILES)) {
    writeFileSync(path.join(ROOT, file), writeVersion(readRepoFile(file), pattern, version, file));
  }
  const changelogPath = path.join(ROOT, "CHANGELOG.md");
  writeFileSync(changelogPath, addSection(existsSync(changelogPath) ? readRepoFile("CHANGELOG.md") : null, section));
  const stale = Object.entries(recordedVersions()).filter(([, v]) => v !== version);
  if (stale.length) {
    throw new ReleaseError(`The version is still not ${version} in ${stale.map(([where, v]) => `${where} (${v})`).join(", ")}; nothing was committed.`);
  }

  git("add", "package.json", "package-lock.json", ...Object.keys(VERSION_FILES), "CHANGELOG.md");
  git("commit", "--quiet", "-m", `Release ${tag}`, ...trailers.flatMap((trailer) => ["--trailer", trailer]));
  git("tag", "--annotate", tag, "-m", `Rclone GUI ${tag}`);
  try {
    git("push", "--atomic", "--quiet", "origin", "main", `refs/tags/${tag}`);
  } catch (e) {
    throw new ReleaseError(`${tag} is committed and tagged here but the push failed, so retry it with \`git push --atomic origin main ${tag}\`.\n${String(e.stderr ?? e.message).trim()}`);
  }
  console.log(`Released ${tag}. CI builds the bundles and publishes the release${web ? `: ${web}/actions` : "."}`);
}

/** CI: print the release notes for `tag`, after checking that every recorded version matches it. */
function notes(tag) {
  const version = /^v(\d+\.\d+\.\d+)$/.exec(tag ?? "")?.[1];
  if (!version) throw new ReleaseError(`"${tag ?? ""}" is not a release tag such as v1.2.3.`);
  const stale = Object.entries(recordedVersions()).filter(([, v]) => v !== version);
  if (stale.length) throw new ReleaseError(`${tag} doesn't match the version in ${stale.map(([where, v]) => `${where} (${v})`).join(", ")}.`);
  const changelogPath = path.join(ROOT, "CHANGELOG.md");
  const body = existsSync(changelogPath) ? sectionFor(readRepoFile("CHANGELOG.md"), tag) : null;
  if (!body) throw new ReleaseError(`CHANGELOG.md has no section for ${tag}.`);
  process.stdout.write(`${body}\n`);
}

function main(args) {
  const [command, ...rest] = args;
  if (command === "notes") return notes(rest[0]);
  const options = { dryRun: false, trailers: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--dry-run") options.dryRun = true;
    else if (rest[i] === "--trailer" && rest[i + 1]) options.trailers.push(rest[++i]);
    else throw new ReleaseError(`Unknown option "${rest[i]}".`);
  }
  return release(command, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`release: ${e instanceof ReleaseError || !e.stderr ? e.message : String(e.stderr).trim()}`);
    process.exit(1);
  }
}
