// Dev shim for the email and background commands (browser mode). It keeps just enough state to exercise the
// Background and Email notifications sections of Settings: whether a password is saved, when the last email
// went out and why the last one failed. A test email "fails" when the saved server is empty or is
// `fail.example`, so the error path can be seen without a mail server.

import { UNHANDLED, type CommandShim } from "./devShim";
import { AppError, defaultSettings, type EmailStatus, type JobReport, type Settings } from "./types";

// The same localStorage prefix as devShim's own `loadJson`/`saveJson`, so all shim state is cleared together.
const KEY = "arcus-shim";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${KEY}:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  localStorage.setItem(`${KEY}:${key}`, JSON.stringify(value));
}

/** The settings devShim stored last, with defaults for anything an older stored copy lacks. */
function settings(): Settings {
  const stored = load<Partial<Settings>>("settings", {});
  return { ...defaultSettings, ...stored, email: { ...defaultSettings.email, ...stored.email } };
}

const status = (): EmailStatus => load<EmailStatus>("emailStatus", { passwordSet: false, lastSentAtUnix: null, lastError: null });

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const emailShim: CommandShim = async (cmd, args, emit) => {
  switch (cmd) {
    case "background_status": {
      // What a desktop with a working tray reports: the tray exists while the setting asks for it, and the
      // login entry is in place while that setting is on.
      const s = settings();
      return { launchAtLoginRegistered: s.launchAtLogin, launchedInBackground: false, trayAvailable: s.runInBackground };
    }
    case "email_status":
      return status();
    case "email_set_password": {
      const password = args.password as string | null;
      const next = { ...status(), passwordSet: !!password };
      save("emailStatus", next);
      return next;
    }
    case "email_send_test": {
      const email = settings().email;
      // A real server takes a moment; the button's spinner should be visible.
      await sleep(800);
      const host = email.host.trim();
      if (!host || host === "fail.example") {
        const message = host
          ? `Could not connect to ${host}:${email.port}: failed to lookup address information: nodename nor servname provided, or not known`
          : "No mail server is set in Settings → Email notifications.";
        save("emailStatus", { ...status(), lastError: message });
        throw new AppError({ kind: "email", message });
      }
      save("emailStatus", { ...status(), lastSentAtUnix: now(), lastError: null });
      console.info(`dev shim: test email sent through ${host}:${email.port} to ${email.toAddresses.join(", ")}`);
      return null;
    }
    case "notify_transfer_finished": {
      const report = args.report as JobReport;
      const email = settings().email;
      // As `should_notify` in src-tauri email: a stopped transfer is not a failure.
      const wanted = email.notifyTransfers === "always" || (email.notifyTransfers === "failure" && (report.status === "error" || report.status === "lost"));
      console.info(`dev shim: ${email.enabled && wanted ? "would email" : "would not email"} about “${report.title}” (${report.status})`, report);
      // `fail.example` also shows the failure toast that a real failed notification raises.
      if (email.enabled && wanted && email.host.trim() === "fail.example") {
        const message = "Could not connect to fail.example:587: connection refused";
        save("emailStatus", { ...status(), lastError: message });
        emit("email:failed", { title: report.title, message });
      }
      return null;
    }
    default:
      return UNHANDLED;
  }
};
