import { useSyncExternalStore } from "react";
import { transferSummary, useJobsStore } from "./jobs";

/** How far back the Transfers page draws the combined speed: a sample a second for two minutes. */
export const THROUGHPUT_SAMPLES = 120;

let samples: number[] = [];
const listeners = new Set<() => void>();

// Sampled for as long as the app runs, not only while the page is open, so the chart has its history when the
// page is opened. Once nothing has moved for the whole window the history is dropped, and nothing is drawn.
const timer = setInterval(() => {
  const { running, speed } = transferSummary(useJobsStore.getState().jobs);
  if (!running && samples.every((v) => v === 0)) {
    if (samples.length === 0) return;
    samples = [];
  } else {
    samples = [...samples, speed].slice(-THROUGHPUT_SAMPLES);
  }
  for (const listener of listeners) listener();
}, 1000);
import.meta.hot?.dispose(() => clearInterval(timer));

/** The combined speed of the running transfers, in bytes a second, oldest sample first. */
export function useThroughput(): number[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => samples,
  );
}
