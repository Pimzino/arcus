// The rule for whether a transfer keeps its own rclone log file, and at what level: the one
// place every job-starting call site defers to, so "should this transfer log" is decided once.

import { pluralize } from "./format";
import { defaultSettings, type Settings } from "./types";

/** The Logging choice of a transfer, shaped like the two fields of the transfer dialog's form. */
export type LogChoice = { log: boolean; logLevel: string };

/** What Settings → Transfers & logs says. Settings that have not loaded yet count as the defaults. */
export const defaultLogChoice = (settings: Settings | null | undefined): LogChoice => {
  const s = settings ?? defaultSettings;
  return { log: s.logTransfersByDefault, logLevel: s.transferLogLevel };
};

/**
 * The choice for a job that is run again: its own level when it kept a log, otherwise the default, so
 * that a job from before logging was the default gets a log too.
 */
export const rerunLogChoice = (previousLevel: string | null | undefined, settings: Settings | null | undefined): LogChoice =>
  previousLevel ? { log: true, logLevel: previousLevel } : defaultLogChoice(settings);

/** The `log` of a job request for a choice. */
export const jobLog = (choice: LogChoice): { level: string } | null => (choice.log ? { level: choice.logLevel } : null);

/** How many days a transfer's log is kept, or null when old logs are not deleted. Settings that have not loaded yet count as the defaults. */
export const logRetentionDays = (settings: Settings | null | undefined): number | null => {
  const s = settings ?? defaultSettings;
  return s.deleteOldTransferLogs ? s.transferLogRetentionDays : null;
};

/** What the log viewer says in place of a log file that is gone; `days` is how long logs are kept, when known. */
export const missingLogMessage = (days: number | null | undefined): string =>
  days && days > 0
    ? `This log file is no longer there. Transfer logs are deleted ${pluralize(days, "day")} after their transfer ended.`
    : "This log file is no longer there.";
