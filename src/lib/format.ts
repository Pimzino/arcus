export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return "–";
  /* rclone's byte counts are fractional (a slow transfer reports 807.802457515556 B/s) and
     below 1 KiB there is no division to shorten them, so round to whole bytes here. */
  const whole = Math.round(n);
  if (Math.abs(whole) < 1024) return `${whole} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = n / 1024;
  let i = 0;
  while (Math.abs(value) >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(Math.abs(value) >= 100 ? 0 : digits)} ${units[i]}`;
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond) return "0 B/s";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds)) return "–";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatEta(eta: number | null | undefined): string {
  return eta == null ? "–" : formatDuration(eta);
}

export function formatDateTime(input: string | number | null | undefined): string {
  if (!input) return "–";
  const date =
    typeof input === "number" ? new Date(input < 1e12 ? input * 1000 : input) : new Date(input);
  if (isNaN(date.getTime())) return String(input);
  const day = date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

export function percent(done: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.max(0, (done / total) * 100));
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
