// Errors in the page, written to the app's log file (arcus.log, through tauri-plugin-log) as well as the console,
// so a crash in a user's window can be read afterwards. Outside Tauri the console is all there is.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri";

/** tauri-plugin-log's LogLevel.Error. */
const LOG_ERROR = 5;

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack && !error.stack.includes(error.message) ? `${error.message}\n${error.stack}` : (error.stack ?? error.message);
  return String(error);
}

export function reportError(where: string, error: unknown, extra?: string) {
  const message = `${where}: ${describeError(error)}${extra ? `\n${extra}` : ""}`;
  console.error(message);
  if (isTauri) void tauriInvoke("plugin:log|log", { level: LOG_ERROR, message, location: "webview" }).catch(() => undefined);
}

/** Errors nothing caught: thrown in an event handler, a timer or a promise nobody awaited. */
export function logUncaughtErrors() {
  window.addEventListener("error", (e) => reportError("uncaught error", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => reportError("unhandled rejection", e.reason));
}
