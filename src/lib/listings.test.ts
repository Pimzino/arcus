import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { refreshListings } from "./listings";

/** A listing that is on screen (it has an observer) and whose fetches finish when told to. */
function listing(qc: QueryClient, fs: string, path: string) {
  const pending: (() => void)[] = [];
  let fetches = 0;
  new QueryObserver(qc, {
    queryKey: ["list", fs, path],
    queryFn: () => {
      const n = ++fetches;
      return new Promise<number>((resolve) => pending.push(() => resolve(n)));
    },
  }).subscribe(() => undefined);
  return {
    fetches: () => fetches,
    data: () => qc.getQueryData<number>(["list", fs, path]),
    finish: () => pending.splice(0).forEach((resolve) => resolve()),
  };
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("refreshListings", () => {
  it("refreshes only listings on the remotes the job touched", async () => {
    const qc = client();
    const drive = listing(qc, "gdrive:", "Shows");
    const local = listing(qc, "/", "Users/me");
    drive.finish();
    local.finish();
    await vi.waitFor(() => expect([drive.data(), local.data()]).toEqual([1, 1]));

    const done = refreshListings(qc, ["/Users/me/Movies/clip.mov", ""]);
    await vi.waitFor(() => expect(local.fetches()).toBe(2));
    local.finish();
    await done;
    expect(drive.fetches()).toBe(1);
  });

  it("lets a listing under way finish, then lists again", async () => {
    const qc = client();
    const drive = listing(qc, "gdrive:", "Shows");
    drive.finish();
    await vi.waitFor(() => expect(drive.data()).toBe(1));
    void qc.refetchQueries({ queryKey: ["list"] }); // e.g. the user pressed refresh
    await vi.waitFor(() => expect(drive.fetches()).toBe(2));

    const done = refreshListings(qc, ["gdrive:Shows/Episode 1"]);
    await settle();
    expect(drive.fetches()).toBe(2); // the listing under way is not restarted
    drive.finish();
    await vi.waitFor(() => expect(drive.fetches()).toBe(3)); // a fresh one follows it
    expect(drive.data()).toBe(2); // and its result was kept meanwhile
    drive.finish();
    await done;
    expect(drive.data()).toBe(3);
  });
});
