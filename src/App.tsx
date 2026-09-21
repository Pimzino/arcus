import { useEffect, type ReactNode } from "react";
import { Sidebar } from "./components/app/Sidebar";
import { StatusBar } from "./components/app/StatusBar";
import { Button, EmptyState, ErrorMessage, Spinner, ToastViewport } from "./components/ui";
import { ConsolePage } from "./pages/Console";
import { ExplorerPage } from "./pages/Explorer";
import { MountsPage } from "./pages/Mounts";
import { PermissionsPage } from "./pages/Permissions";
import { RemotesPage } from "./pages/Remotes";
import { SettingsPage } from "./pages/Settings";
import { SetupPage } from "./pages/Setup";
import { TransfersPage } from "./pages/Transfers";
import { useAppStore, type Page } from "./store/app";
import { useJobsStore } from "./store/jobs";

const SHORTCUTS: Record<string, Page> = { "1": "explorer", "2": "remotes", "3": "transfers", "4": "mounts", "5": "console", ",": "settings" };

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

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (daemonState === "running") void hydrateJobs().then(() => reconcileJobs());
  }, [daemonState, hydrateJobs, reconcileJobs]);

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
      <ToastViewport />
    </div>
  );
}
