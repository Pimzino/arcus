// A "location" is how the UI addresses anything rclone can reach:
//   { fs: "gdrive:", path: "photos/2024" }   remote
//   { fs: "/",       path: "Users/me" }      local (Unix)
//   { fs: "C:/",     path: "Users/me" }      local (Windows drive)
// `fs` is passed to rclone as the `fs` parameter and `path` as `remote`.

export type Location = { fs: string; path: string };

const WIN_DRIVE_FS = /^[A-Za-z]:\/$/;
/** rclone's rule for remote names: 0-9 A-Z a-z _ - . + @ and space, not starting with - or space. */
export const REMOTE_NAME = /^[\w.+@][\w.\-+@ ]*$/;
const WIN_DRIVE_INPUT = /^[A-Za-z]:([\\/]|$)/;

export function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function trimPath(p: string): string {
  return normalizeSlashes(p).replace(/\/{2,}/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function isLocalFs(fs: string): boolean {
  return fs === "/" || WIN_DRIVE_FS.test(fs) || fs.startsWith("//");
}

export function isLocal(loc: Location): boolean {
  return isLocalFs(loc.fs);
}

export function remoteName(loc: Location): string | null {
  if (isLocal(loc)) return null;
  return loc.fs.endsWith(":") ? loc.fs.slice(0, -1) : loc.fs;
}

/** Parse user input such as `gdrive:foo/bar`, `/Users/x`, `C:\Users\x`. */
export function parseLocation(input: string): Location {
  const raw = input.trim();
  if (!raw) return { fs: "", path: "" };
  if (WIN_DRIVE_INPUT.test(raw)) {
    return { fs: `${raw.slice(0, 1).toUpperCase()}:/`, path: trimPath(raw.slice(2)) };
  }
  if (raw.startsWith("\\\\") || raw.startsWith("//")) {
    const m = normalizeSlashes(raw).match(/^\/\/([^/]+)\/([^/]+)\/?(.*)$/);
    if (m) return { fs: `//${m[1]}/${m[2]}/`, path: trimPath(m[3]) };
  }
  if (raw.startsWith("/")) return { fs: "/", path: trimPath(raw) };
  if (raw.startsWith(":")) {
    // connection string, e.g. ":s3,provider=AWS:bucket/path"
    const end = raw.indexOf(":", 1);
    if (end > 0) return { fs: raw.slice(0, end + 1), path: trimPath(raw.slice(end + 1)) };
  }
  // rclone remote names may contain letters, digits, _ - . + @ and spaces.
  const colon = raw.indexOf(":");
  if (colon > 0 && REMOTE_NAME.test(raw.slice(0, colon))) {
    return { fs: `${raw.slice(0, colon)}:`, path: trimPath(raw.slice(colon + 1)) };
  }
  // bare relative path: treat as local
  return { fs: "/", path: trimPath(raw) };
}

/** `gdrive:photos/2024`, `/Users/me`, `C:/Users/me`; also valid as an rclone `fs` string. */
export function formatLocation(loc: Location): string {
  if (!loc.fs) return loc.path;
  if (loc.fs === "/") return `/${loc.path}`;
  return `${loc.fs}${loc.path}`;
}

export function fsString(loc: Location): string {
  return formatLocation(loc);
}

export function childLocation(loc: Location, name: string): Location {
  return { fs: loc.fs, path: loc.path ? `${loc.path}/${name}` : name };
}

export function parentLocation(loc: Location): Location {
  const i = loc.path.lastIndexOf("/");
  return { fs: loc.fs, path: i < 0 ? "" : loc.path.slice(0, i) };
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

export function rootLabel(loc: Location): string {
  if (loc.fs === "/") return "/";
  return loc.fs;
}

export function breadcrumbs(loc: Location): { label: string; loc: Location }[] {
  const crumbs = [{ label: rootLabel(loc), loc: { fs: loc.fs, path: "" } }];
  if (!loc.path) return crumbs;
  const parts = loc.path.split("/");
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ label: part, loc: { fs: loc.fs, path: acc } });
  }
  return crumbs;
}

export function sameLocation(a: Location, b: Location): boolean {
  return a.fs === b.fs && a.path === b.path;
}

/** Escape rclone filter-glob metacharacters in a literal file name. */
export function escapeGlob(name: string): string {
  return name.replace(/([\\*?[\]{}])/g, "\\$1");
}
