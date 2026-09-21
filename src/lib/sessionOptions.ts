// Global rclone options applied "for this session" (Settings → Global rclone options) only change the
// main daemon's memory. Every transfer runs in an rclone of its own, so what was applied is remembered
// here and given to each of those as it starts. Options persisted as RCLONE_* variables need none of
// this: every daemon the app starts gets them.

import type { RcParams } from "./tauri";

/** Applied since the main daemon started: block → field → value. */
let applied: Record<string, RcParams> = {};

/** Options a transfer's rclone must keep as the app set them: its log is how the app follows the transfer. */
const RESERVED = new Set(["LogLevel", "UseJSONLog"]);

export function rememberSessionOptions(block: string, values: RcParams) {
  applied = { ...applied, [block]: { ...applied[block], ...values } };
}

/** The main daemon (re)started, so its options are back to their defaults and RCLONE_* variables. */
export function forgetSessionOptions() {
  applied = {};
}

/** What to `options/set` on a transfer's rclone, block by block. */
export function sessionOptionsForTransfers(): [block: string, values: RcParams][] {
  return Object.entries(applied)
    .map(([block, values]): [string, RcParams] => [block, Object.fromEntries(Object.entries(values).filter(([field]) => !RESERVED.has(field)))])
    .filter(([, values]) => Object.keys(values).length > 0);
}
