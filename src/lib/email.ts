// Small helpers for the email notification settings, shared by Settings, the email failure toasts and the
// watch folder editor (which links to the email settings when email is off).

import { useAppStore } from "../store/app";
import type { EmailSettings } from "./types";

export type EmailSecurity = EmailSettings["security"];

/** The port each kind of connection conventionally uses, so switching the security can move the port along. */
export const EMAIL_DEFAULT_PORTS: Record<EmailSecurity, number> = { starttls: 587, tls: 465, none: 25 };

/**
 * The port to show after the security changed from `from` to `to`. A port the user chose themselves is left
 * alone; only the previous kind's conventional port follows the change, since leaving 587 in place when
 * someone picks SSL/TLS is almost always a mistake that ends in a confusing handshake error.
 */
export function portAfterSecurityChange(port: string, from: EmailSecurity, to: EmailSecurity): string {
  const current = Number(port.trim());
  if (port.trim() === "" || current === EMAIL_DEFAULT_PORTS[from]) return String(EMAIL_DEFAULT_PORTS[to]);
  return port;
}

/** Recipients as typed: separated by commas, semicolons (Outlook's habit) or new lines. */
export function parseAddressList(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * A deliberately loose check that catches typos before the server does: `name@domain`, optionally written
 * as `Display Name <name@domain>`. The backend parses addresses properly and explains what it rejects.
 */
export function looksLikeEmail(address: string): boolean {
  const angle = /<([^<>]*)>\s*$/.exec(address);
  const bare = (angle ? angle[1] : address).trim();
  return /^[^\s@<>,;]+@[^\s@<>,;]+$/.test(bare) && !bare.endsWith(".") && !bare.includes("@.");
}

/** A port as typed, or null when it is not a whole number in 1–65535. */
export function parsePort(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const port = Number(text.trim());
  return port >= 1 && port <= 65535 ? port : null;
}

// Opening a Settings section from elsewhere (a toast, the watch folder editor). The Settings page may not be
// mounted yet when this is called, so the request is kept until the page picks it up; the event covers the
// case where the page is already showing and so will not mount again.

let pendingSection: string | null = null;
export const SETTINGS_SECTION_EVENT = "arcus:settings-section";

export function openSettingsSection(id: string) {
  pendingSection = id;
  useAppStore.getState().setPage("settings");
  window.dispatchEvent(new Event(SETTINGS_SECTION_EVENT));
}

/** The section someone asked Settings to show, once. */
export function takePendingSettingsSection(): string | null {
  const id = pendingSection;
  pendingSection = null;
  return id;
}

export const openEmailSettings = () => openSettingsSection("email");
