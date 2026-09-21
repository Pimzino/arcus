// Native dialogs and OS integration (Tauri plugins), with browser fallbacks.

import { api, isTauri } from "./tauri";

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (!isTauri) return window.prompt("Folder path", defaultPath ?? "") || null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ directory: true, multiple: false, defaultPath });
  return typeof result === "string" ? result : null;
}

export async function pickFile(
  defaultPath?: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<string | null> {
  if (!isTauri) return window.prompt("File path", defaultPath ?? "") || null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ directory: false, multiple: false, defaultPath, filters });
  return typeof result === "string" ? result : null;
}

/** Select one or more local items in their folder. Rejects if they are gone; callers show that. */
export async function revealInFileManager(path: string | string[]): Promise<void> {
  await api.showInFileManager(typeof path === "string" ? [path] : path, "reveal");
}

/** Open a local folder so its contents show; a path that turns out to be a file is revealed instead. */
export async function openInFileManager(path: string): Promise<void> {
  await api.showInFileManager([path], "open");
}

export async function openExternal(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

/**
 * Props that make an element a window drag handle on macOS, where the app hides the
 * native title bar. "deep" makes the whole subtree draggable except interactive
 * controls; "false" opts a subtree out (e.g. something with its own double-click).
 */
export function dragRegion(mode: "deep" | "self" | "false" = "deep"): Record<string, string> {
  if (!isTauri || !isMac) return {};
  return { "data-tauri-drag-region": mode === "self" ? "true" : mode };
}

/**
 * Keep drops that no component accepted inert.
 *
 * The window runs with Tauri's native drag-drop handler switched off (`dragDropEnabled: false`
 * in tauri.conf.json): that handler claims every native drag before WebKit/WebView2 can turn it
 * into HTML5 dragover/drop events, which the explorer's pane-to-pane drag depends on. With it
 * off, the webview's default action for a file dropped from the desktop is to navigate to that
 * file; cancelling unhandled dragover/drop events prevents that and shows a "not allowed" cursor.
 * Dropping files from the desktop into the app would need its own handler on top of this.
 */
export function blockStrayDrops(): void {
  const guard = (e: globalThis.DragEvent) => {
    if (e.defaultPrevented) return; // a component accepted the drop
    e.preventDefault();
    if (e.type === "dragover" && e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  window.addEventListener("dragover", guard);
  window.addEventListener("drop", guard);
}
