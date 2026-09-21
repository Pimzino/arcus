import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDaemonRunning } from "../store/app";
import { rc } from "./rc";
import { api } from "./tauri";

export type RemoteInfo = { name: string; type: string; config: Record<string, string> };

export function useRemotes() {
  const running = useDaemonRunning();
  return useQuery({
    queryKey: ["remotes"],
    enabled: running,
    queryFn: async (): Promise<RemoteInfo[]> => {
      const dump = await rc.dumpConfig();
      return Object.entries(dump ?? {})
        .map(([name, config]) => ({ name, type: config?.type ?? "unknown", config: config ?? {} }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}

export function useLocalRoots() {
  return useQuery({ queryKey: ["localRoots"], queryFn: () => api.localRoots(), staleTime: 60_000 });
}

export function useProviders() {
  const running = useDaemonRunning();
  return useQuery({
    queryKey: ["providers"],
    enabled: running,
    staleTime: Infinity,
    queryFn: async () => (await rc.providers()).filter((p) => !p.Hide).sort((a, b) => a.Description.localeCompare(b.Description)),
  });
}

export function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: string[]) => {
    for (const key of keys) void qc.invalidateQueries({ queryKey: [key] });
  };
}
