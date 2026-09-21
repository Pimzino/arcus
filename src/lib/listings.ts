// Keeping explorer listings current after a job changes files.

import type { QueryClient } from "@tanstack/react-query";
import { parseLocation } from "./paths";

/**
 * Refresh the explorer listings on the remotes a finished job touched (`locations` are its source
 * and destination). A listing already under way is left to finish and is then fetched once more,
 * because it may have started before the job's last changes.
 */
export async function refreshListings(qc: QueryClient, locations: string[]): Promise<void> {
  const remotes = new Set(locations.filter(Boolean).map((l) => parseLocation(l).fs));
  const touched = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] === "list" && remotes.has(q.queryKey[1] as string);
  const busy = qc.getQueryCache().findAll({ predicate: touched, fetchStatus: "fetching" });
  await qc.invalidateQueries({ predicate: touched }, { cancelRefetch: false });
  if (busy.length) await qc.invalidateQueries({ predicate: (q) => busy.includes(q) }, { cancelRefetch: false });
}
