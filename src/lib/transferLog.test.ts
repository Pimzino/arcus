import { describe, expect, it } from "vitest";
import { defaultLogChoice, jobLog, logRetentionDays, missingLogMessage, rerunLogChoice } from "./transferLog";
import { defaultSettings, type Settings } from "./types";

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...defaultSettings, ...patch });

describe("defaultLogChoice", () => {
  it("follows defaultSettings when settings have not loaded yet", () => {
    expect(defaultLogChoice(null)).toEqual({ log: true, logLevel: "INFO" });
    expect(defaultLogChoice(undefined)).toEqual({ log: true, logLevel: "INFO" });
  });

  it("follows a loaded settings object", () => {
    expect(defaultLogChoice(settings({ logTransfersByDefault: false, transferLogLevel: "DEBUG" }))).toEqual({ log: false, logLevel: "DEBUG" });
  });
});

describe("jobLog", () => {
  it("asks for a log at the choice's level when the choice is on", () => {
    expect(jobLog({ log: true, logLevel: "DEBUG" })).toEqual({ level: "DEBUG" });
  });

  it("asks for no log when the choice is off", () => {
    expect(jobLog({ log: false, logLevel: "DEBUG" })).toBeNull();
  });
});

describe("rerunLogChoice", () => {
  it("keeps a job's own level even once the default has been turned off", () => {
    expect(rerunLogChoice("DEBUG", settings({ logTransfersByDefault: false }))).toEqual({ log: true, logLevel: "DEBUG" });
  });

  it("falls back to the default, on, for a job that kept no log", () => {
    expect(rerunLogChoice(null, settings({ logTransfersByDefault: true, transferLogLevel: "NOTICE" }))).toEqual({ log: true, logLevel: "NOTICE" });
  });

  it("treats undefined the same as null", () => {
    expect(rerunLogChoice(undefined, settings({ logTransfersByDefault: true, transferLogLevel: "NOTICE" }))).toEqual({ log: true, logLevel: "NOTICE" });
  });

  it("falls back to the default, off, for a job that kept no log", () => {
    expect(rerunLogChoice(null, settings({ logTransfersByDefault: false, transferLogLevel: "DEBUG" }))).toEqual({ log: false, logLevel: "DEBUG" });
  });
});

describe("logRetentionDays", () => {
  it("follows defaultSettings when settings have not loaded yet", () => {
    expect(logRetentionDays(null)).toBe(30);
    expect(logRetentionDays(undefined)).toBe(30);
  });

  it("is null when deleting old logs is switched off", () => {
    expect(logRetentionDays(settings({ deleteOldTransferLogs: false }))).toBeNull();
  });

  it("follows a chosen retention period", () => {
    expect(logRetentionDays(settings({ transferLogRetentionDays: 90 }))).toBe(90);
  });
});

describe("missingLogMessage", () => {
  it("says only that the file is gone when the retention period is not known", () => {
    expect(missingLogMessage(null)).toBe("This log file is no longer there.");
    expect(missingLogMessage(undefined)).toBe("This log file is no longer there.");
  });

  it("adds how long logs are kept when the retention period is known", () => {
    expect(missingLogMessage(30)).toBe("This log file is no longer there. Transfer logs are deleted 30 days after their transfer ended.");
  });

  it("uses the singular for a retention period of exactly one day", () => {
    expect(missingLogMessage(1)).toBe("This log file is no longer there. Transfer logs are deleted 1 day after their transfer ended.");
  });
});
