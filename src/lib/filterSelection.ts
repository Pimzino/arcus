// What the "choose files and folders" tree of a transfer has ticked, and how that becomes rclone filter rules
// in the transfer form's Include and Exclude fields, and back.
//
// A selection is a default for everything (`rootIn`) plus overrides: a path ticked or unticked on its own. An item
// takes the state of its nearest override, or the default. Overrides are kept normalised (none repeats the state
// it would inherit), so a folder with any override below it is partly ticked.
//
// The form's rules mean: included = (matches an include, or there are no includes) and matches no exclude, as
// `orderedFilter` puts excludes first. That can say "this folder but not that subfolder", but not "…except this
// file inside that subfolder" again: a file inside an excluded folder cannot be brought back. Where a selection
// needs that, the excluded folder is spelt out instead: each item listed in it is excluded, apart from the ones
// leading to what was ticked inside. That is exact for what the folder holds now; something added to it later
// is taken in, so such folders are reported (`spelledOut`) for the picker to say so.

import { escapeGlob } from "./paths";

export type Override = { in: boolean; dir: boolean };

export type Selection = {
  /** State of everything without an override of its own or above it. */
  rootIn: boolean;
  /** Keyed by path relative to the source, without leading or trailing slash. */
  overrides: Map<string, Override>;
};

export type TreeItem = { name: string; dir: boolean; size: number };

export type CheckState = "on" | "off" | "mixed";

export const emptySelection = (rootIn = true): Selection => ({ rootIn, overrides: new Map() });

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const isUnder = (path: string, dir: string) => (dir ? path.startsWith(`${dir}/`) : path !== "");

/** The state `path` inherits from its folders. Only folder overrides pass down. */
function inherited(sel: Selection, path: string): boolean {
  for (let p = parentOf(path); ; p = parentOf(p)) {
    if (!p) return sel.rootIn;
    const o = sel.overrides.get(p);
    if (o?.dir) return o.in;
  }
}

/** Whether `path` (a file, or a folder as a whole) is ticked; partly ticked folders give their own state. */
export function isIn(sel: Selection, path: string, dir: boolean): boolean {
  if (!path) return sel.rootIn;
  const o = sel.overrides.get(path);
  return o && o.dir === dir ? o.in : inherited(sel, path);
}

function hasOverrideBelow(sel: Selection, dir: string): boolean {
  for (const k of sel.overrides.keys()) if (isUnder(k, dir)) return true;
  return false;
}

export function checkState(sel: Selection, path: string, dir: boolean): CheckState {
  if (dir && hasOverrideBelow(sel, path)) return "mixed";
  return isIn(sel, path, dir) ? "on" : "off";
}

/** Drop overrides that say what they would inherit anyway, shallowest first so a dropped one can't hide another. */
function normalise(sel: Selection): Selection {
  const keys = [...sel.overrides.keys()].sort((a, b) => a.split("/").length - b.split("/").length);
  const overrides = new Map(sel.overrides);
  const next: Selection = { rootIn: sel.rootIn, overrides };
  for (const k of keys) {
    const o = overrides.get(k)!;
    if (o.in === inherited(next, k)) overrides.delete(k);
  }
  return next;
}

/** Tick or untick an item; a folder takes everything in it along. */
export function setChecked(sel: Selection, path: string, dir: boolean, value: boolean): Selection {
  if (!path) return emptySelection(value);
  const overrides = new Map(sel.overrides);
  if (dir) for (const k of [...overrides.keys()]) if (isUnder(k, path)) overrides.delete(k);
  overrides.set(path, { in: value, dir });
  return normalise({ rootIn: sel.rootIn, overrides });
}

/** Tick a partly ticked or unticked item, untick a ticked one. */
export function toggled(sel: Selection, path: string, dir: boolean): Selection {
  return setChecked(sel, path, dir, checkState(sel, path, dir) !== "on");
}

/** Whether nothing at all is ticked, as far as the overrides tell. */
export function nothingSelected(sel: Selection): boolean {
  return !sel.rootIn && ![...sel.overrides.values()].some((o) => o.in);
}

// ----- rules -----

const GLOB_META = /[\\*?[\]{}]/;

/** `/a/b/**` → { path: "a/b", dir: true }, `/a/b.txt` → a file; null when the rule is a pattern, not one item. */
export function literalRule(rule: string): { path: string; dir: boolean } | null {
  const m = rule.match(/^\/(.+?)(\/\*\*)?$/);
  if (!m) return null;
  let path = "";
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i];
    if (c === "\\") {
      const next = m[1][i + 1];
      if (next === undefined || !GLOB_META.test(next)) return null;
      path += next;
      i++;
    } else if (GLOB_META.test(c)) return null;
    else path += c;
  }
  if (!path || path.split("/").some((s) => !s || s === "." || s === "..")) return null;
  return { path, dir: !!m[2] };
}

export function ruleFor(path: string, dir: boolean): string {
  const escaped = path.split("/").map(escapeGlob).join("/");
  return dir ? `/${escaped}/**` : `/${escaped}`;
}

export type ParsedRules = {
  selection: Selection;
  /** Rules the tree does not stand for (patterns such as `*.tmp`), kept as written. */
  otherIncludes: string[];
  otherExcludes: string[];
};

/**
 * The selection the form's rules describe. Rules naming one item are the tree's; patterns are kept aside. Includes
 * are only the tree's when all of them name items: next to a pattern such as `*.jpg` they would widen it
 * ("jpgs, or this folder"), so the tree then says what to leave out of what the patterns take in.
 */
export function parseRules(include: string[], exclude: string[]): ParsedRules {
  const incl = include.map(literalRule);
  const treeIncludes = incl.every(Boolean) ? (incl as { path: string; dir: boolean }[]) : [];
  const otherIncludes = treeIncludes.length || !include.length ? [] : include;
  const otherExcludes: string[] = [];
  const treeExcludes: { path: string; dir: boolean }[] = [];
  for (const r of exclude) {
    const lit = literalRule(r);
    if (lit) treeExcludes.push(lit);
    else otherExcludes.push(r);
  }
  const overrides = new Map<string, Override>();
  for (const r of treeIncludes) overrides.set(r.path, { in: true, dir: r.dir });
  for (const r of treeExcludes) overrides.set(r.path, { in: false, dir: r.dir });
  // An include inside an excluded folder does nothing (excludes come first): its item stays out.
  for (const [k, o] of [...overrides]) {
    if (!o.in) continue;
    for (let p = parentOf(k); p; p = parentOf(p)) {
      const above = overrides.get(p);
      if (above && above.dir && !above.in) {
        overrides.delete(k);
        break;
      }
    }
  }
  return { selection: normalise({ rootIn: treeIncludes.length === 0, overrides }), otherIncludes, otherExcludes };
}

export type BuiltRules = {
  include: string[];
  exclude: string[];
  /** Folders whose items had to be excluded one by one (see the top of this file). */
  spelledOut: string[];
};

/** A listing the rules need and the picker has not loaded yet; load it and build again. */
export class NeedsListing extends Error {
  constructor(readonly path: string) {
    super(`The folder "${path || "/"}" has to be listed first.`);
  }
}

/**
 * The tree's rules for a selection, in one of two shapes: `covered` (everything is in unless excluded: excludes
 * only) or not (includes for what is ticked, excludes inside them). `childrenOf` gives a folder's listing, needed
 * only where a folder must be spelt out.
 */
function build(sel: Selection, startCovered: boolean, childrenOf: (path: string) => TreeItem[] | undefined): BuiltRules {
  const include: string[] = [];
  const exclude: string[] = [];
  const spelledOut: string[] = [];
  const keys = [...sel.overrides.keys()];
  /** Names one level below `dir` that lead to an override, in name order so the rules read in a stable order. */
  const nextSteps = (dir: string) => {
    const out = new Set<string>();
    for (const k of keys) if (isUnder(k, dir)) out.add(k.slice(dir ? dir.length + 1 : 0).split("/")[0]);
    return new Set([...out].sort());
  };
  const visit = (path: string, dir: boolean, covered: boolean) => {
    const state = isIn(sel, path, dir);
    const mixed = dir && keys.some((k) => isUnder(k, path));
    if (!mixed) {
      if (state && !covered) include.push(path ? ruleFor(path, dir) : "/**");
      if (!state && covered) exclude.push(path ? ruleFor(path, dir) : "/**");
      return;
    }
    if (state && !covered) {
      if (path) include.push(ruleFor(path, true));
      covered = true;
    }
    const steps = nextSteps(path);
    if (!state && covered) {
      // Out, inside something taken in, with something ticked further down: exclude its items one by one.
      const listing = childrenOf(path);
      if (!listing) throw new NeedsListing(path);
      const before = exclude.length;
      for (const c of listing) if (!steps.has(c.name)) exclude.push(ruleFor(joinPath(path, c.name), c.dir));
      if (exclude.length > before) spelledOut.push(path);
    }
    for (const name of steps) {
      const child = joinPath(path, name);
      const own = sel.overrides.get(child);
      visit(child, own ? own.dir || keys.some((k) => isUnder(k, child)) : true, covered);
    }
  };
  visit("", true, startCovered);
  return { include, exclude, spelledOut };
}

/**
 * The fewest rules for a selection. With include patterns kept aside, only excludes will do (see `parseRules`).
 * Otherwise both shapes are tried; on a tie the default decides, which also decides what happens to items added
 * to the source later: with everything ticked by default they are taken in, with nothing ticked they are not.
 */
export function buildRules(sel: Selection, childrenOf: (path: string) => TreeItem[] | undefined, excludesOnly: boolean): BuiltRules {
  const covered = build(sel, true, childrenOf);
  if (excludesOnly) return covered;
  const notCovered = build(sel, false, childrenOf);
  const count = (r: BuiltRules) => r.include.length + r.exclude.length;
  if (count(covered) !== count(notCovered)) return count(covered) < count(notCovered) ? covered : notCovered;
  return sel.rootIn ? covered : notCovered;
}

// ----- what rclone will make of the other rules -----

/** rclone's glob (fs/filter/glob.go, path mode) as a RegExp; null where JavaScript can't read it the same way. */
export function globRegExp(glob: string): RegExp | null {
  let re = "";
  let g = glob;
  if (g.startsWith("/")) {
    g = g.slice(1);
    re = "^";
  } else re = "(^|/)";
  let stars = 0;
  let braces = 0;
  let brackets = 0;
  const flush = () => {
    if (stars === 1) re += "[^/]*";
    else if (stars === 2) re += ".*";
    else if (stars > 2) return false;
    stars = 0;
    return true;
  };
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "{" && g[i + 1] === "{") return null; // {{regexp}}: Go syntax, not worth guessing
    if (c !== "*" && !flush()) return null;
    if (brackets > 0) {
      re += c;
      if (c === "[") brackets++;
      if (c === "]") brackets--;
      continue;
    }
    switch (c) {
      case "\\":
        if (i + 1 >= g.length) return null;
        re += `\\${g[++i]}`;
        break;
      case "*":
        stars++;
        break;
      case "?":
        re += "[^/]";
        break;
      case "[":
        re += c;
        brackets++;
        break;
      case "]":
        return null;
      case "{":
        braces++;
        re += "(";
        break;
      case "}":
        if (!braces) return null;
        braces--;
        re += ")";
        break;
      case ",":
        re += braces ? "|" : ",";
        break;
      case ".":
      case "+":
      case "(":
      case ")":
      case "|":
      case "^":
      case "$":
        re += `\\${c}`;
        break;
      default:
        re += c;
    }
  }
  if (!flush() || braces || brackets) return null;
  try {
    return new RegExp(`${re}$`);
  } catch {
    return null;
  }
}

/**
 * Which kept-aside rule leaves `path` out, if any: an exclude pattern matching it (a folder as `path/`, as rclone
 * checks folders), or include patterns none of which takes a file in.
 */
export function ruledOutBy(path: string, dir: boolean, otherIncludes: string[], otherExcludes: string[]): string | null {
  const subject = dir ? `${path}/` : path;
  for (const r of otherExcludes) if (globRegExp(r)?.test(subject)) return r;
  if (!dir && otherIncludes.length) {
    const res = otherIncludes.map(globRegExp);
    if (res.every(Boolean) && !res.some((re) => re!.test(path))) return otherIncludes.length === 1 ? `not ${otherIncludes[0]}` : "no include pattern";
  }
  return null;
}
