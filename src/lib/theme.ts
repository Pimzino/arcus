// Applies the user's theme choice to <html data-theme="light|dark">.

export type ThemeSetting = "system" | "light" | "dark";

const STORAGE_KEY = "rclone-gui:theme";
const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let current: ThemeSetting = "system";

function resolve(setting: ThemeSetting): "light" | "dark" {
  if (setting === "system") return media?.matches ? "dark" : "light";
  return setting;
}

function paint() {
  document.documentElement.dataset.theme = resolve(current);
}

export function applyTheme(setting: ThemeSetting) {
  current = setting;
  try {
    localStorage.setItem(STORAGE_KEY, setting);
  } catch {
    /* ignore */
  }
  paint();
}

/** Call once before first render to avoid a flash of the wrong theme. */
export function initTheme() {
  let saved: ThemeSetting = "system";
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") saved = raw;
  } catch {
    /* ignore */
  }
  current = saved;
  paint();
  media?.addEventListener("change", () => {
    if (current === "system") paint();
  });
}

export function resolvedTheme(): "light" | "dark" {
  return resolve(current);
}
