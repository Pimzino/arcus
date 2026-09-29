import { useEffect, type ReactNode } from "react";
import { EmailFailureToasts } from "./components/app/EmailFailureToasts";
import { LegacyAppNotice } from "./components/app/LegacyApp";
import { Sidebar } from "./components/app/Sidebar";
import { StatusBar } from "./components/app/StatusBar";
import { UpdatePrompt } from "./components/app/Update";
import { runE2eSteps } from "./lib/e2eDriver";
import { listen } from "./lib/tauri";
import { Button, EmptyState, ErrorMessage, Spinner, ToastViewport } from "./components/ui";
import { ConsolePage } from "./pages/Console";
import { ExplorerPage } from "./pages/Explorer";
import { MountsPage } from "./pages/Mounts";
import { PermissionsPage } from "./pages/Permissions";
import { RemotesPage } from "./pages/Remotes";
import { SettingsPage } from "./pages/Settings";
import { SetupPage } from "./pages/Setup";
import { TransfersPage } from "./pages/Transfers";
import { WatchPage } from "./pages/Watch";
import { useAppStore, type Page } from "./store/app";
import { useJobsStore } from "./store/jobs";
import { useWatchStore } from "./store/watch";

const SHORTCUTS: Record<string, Page> = { "1": "explorer", "2": "remotes", "3": "transfers", "4": "watch", "5": "mounts", "6": "console", ",": "settings" };

function NeedsDaemon({ children }: { children: ReactNode }) {
  const state = useAppStore((s) => s.daemon.state);
  const setPage = useAppStore((s) => s.setPage);
  if (state === "running") return <>{children}</>;
  return (
    <EmptyState
      icon={state === "starting" ? <Spinner /> : undefined}
      title={state === "starting" ? "Starting rclone…" : "rclone is not running"}
      description={state === "starting" ? "This only takes a moment." : "Install or start the rclone engine to use this page."}
      action={
        state !== "starting" && (
          <Button variant="default" onClick={() => setPage("setup")}>
            Open Setup
          </Button>
        )
      }
    />
  );
}

function renderPage(page: Page) {
  switch (page) {
    case "setup":
      return <SetupPage />;
    case "permissions":
      return <PermissionsPage />;
    case "explorer":
      return (
        <NeedsDaemon>
          <ExplorerPage />
        </NeedsDaemon>
      );
    case "remotes":
      return (
        <NeedsDaemon>
          <RemotesPage />
        </NeedsDaemon>
      );
    case "transfers":
      return <TransfersPage />;
    // Watch folders run in the backend on rclones of their own: the list needs no main daemon (its
    // editor's remote pickers do, and say so).
    case "watch":
      return <WatchPage />;
    case "mounts":
      return (
        <NeedsDaemon>
          <MountsPage />
        </NeedsDaemon>
      );
    case "console":
      return <ConsolePage />;
    case "settings":
      return <SettingsPage />;
  }
}

export default function App() {
  const init = useAppStore((s) => s.init);
  const ready = useAppStore((s) => s.ready);
  const initError = useAppStore((s) => s.initError);
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const daemonState = useAppStore((s) => s.daemon.state);
  const hydrateJobs = useJobsStore((s) => s.hydrate);
  const reconcileJobs = useJobsStore((s) => s.reconcile);
  const loadWatches = useWatchStore((s) => s.load);

  useEffect(() => {
    void init();
  }, [init]);

  // The job list loads as soon as the app is up: watch folders run their transfers without the main
  // daemon, so they have to show even when it is not running. Checking which of its own jobs survived
  // needs the daemon, so that waits for it.
  useEffect(() => {
    if (ready && !initError) {
      void hydrateJobs();
      // The sidebar's badge counts rules in trouble, so the list is followed from the start.
      void loadWatches();
    }
  }, [ready, initError, hydrateJobs, loadWatches]);

  // An end-to-end test's own steps (debug builds only; see e2eDriver.ts).
  useEffect(() => {
    if (ready && !initError) void runE2eSteps();
  }, [ready, initError]);

  useEffect(() => {
    if (daemonState === "running") void hydrateJobs().then(() => reconcileJobs());
  }, [daemonState, hydrateJobs, reconcileJobs]);

  // The tray's "Show in Arcus" on a running transfer: its details, found by the transfer's rclone.
  useEffect(() => {
    const unlisten = listen<string>("tray:show-transfer", (daemonId) => {
      const job = useJobsStore.getState().jobs.find((j) => j.daemonId === daemonId);
      if (job) useAppStore.getState().showJobDetails(job.id);
      else setPage("transfers");
    });
    return () => void unlisten.then((fn) => fn());
  }, [setPage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const target = SHORTCUTS[e.key];
      if (target) {
        e.preventDefault();
        setPage(target);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPage]);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
        <Spinner /> Loading…
      </div>
    );
  }
  if (initError) {
    return (
      <div className="p-8">
        <ErrorMessage error={initError} />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">{renderPage(page)}</main>
      </div>
      <StatusBar />
      <LegacyAppNotice />
      <EmailFailureToasts />
      <UpdatePrompt />
      <ToastViewport />
    </div>
  );
}
