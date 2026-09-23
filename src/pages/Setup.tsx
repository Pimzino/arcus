import { Download, Play, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { LogViewerDialog } from "../components/app/LogViewer";
import { ProvisionProgress, useProvisionEvents } from "../components/app/Provision";
import { Button, Callout, Card, ErrorMessage, KeyValue, PageBody, PageHeader, Spinner } from "../components/ui";
import { api } from "../lib/tauri";
import { errorMessage, type LatestVersion } from "../lib/types";
import { useAppStore } from "../store/app";

const TRUSTED_KEY = "FBF7 37EC E9F8 AB18 604B D2AC 9393 5E02 FF3B 54FA";

export function SetupPage() {
  const daemon = useAppStore((s) => s.daemon);
  const status = useAppStore((s) => s.status);
  const info = useAppStore((s) => s.info);
  const settings = useAppStore((s) => s.settings);
  const refreshStatus = useAppStore((s) => s.refreshStatus);
  const setPage = useAppStore((s) => s.setPage);
  const { events, reset } = useProvisionEvents();
  const [installing, setInstalling] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<LatestVersion | null>(null);
  const [latestError, setLatestError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    api
      .rcloneLatestVersion()
      .then(setLatest)
      .catch((e) => setLatestError(errorMessage(e)));
  }, []);

  const install = async () => {
    setInstalling(true);
    setError(null);
    reset();
    try {
      await api.rcloneInstall(settings?.pinnedRcloneVersion || undefined);
      await refreshStatus();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setInstalling(false);
    }
  };

  const startDaemon = async () => {
    setStarting(true);
    setError(null);
    try {
      await api.daemonStart();
      await refreshStatus();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const target = info?.target;
  const version = settings?.pinnedRcloneVersion || latest?.latest;
  const asset = target && version ? `rclone-${version}-${target.os}-${target.arch}.zip` : null;
  const installed = (status?.installed.length ?? 0) > 0 || !!status?.customBinary;

  return (
    <>
      <PageHeader title="Setup" description="Arcus runs the official rclone engine, which it downloads and verifies itself." />
      <PageBody>
        <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
          {daemon.state === "running" && (
            <Callout
              tone="success"
              title={`rclone ${daemon.info?.version} is running`}
              action={
                <Button variant="default" onClick={() => setPage("explorer")}>
                  Open the explorer
                </Button>
              }
            >
              Serving the remote-control API on port {daemon.info?.port}.
            </Callout>
          )}
          {daemon.state === "starting" && (
            <Callout tone="info" title="Starting rclone">
              <span className="flex items-center gap-2">
                <Spinner /> This only takes a moment.
              </span>
            </Callout>
          )}
          {(daemon.state === "failed" || daemon.state === "exited" || daemon.state === "stopped") && installed && (
            <Card
              title={daemon.state === "stopped" ? "rclone is stopped" : "rclone could not run"}
              bodyClassName="flex flex-col gap-3"
              footer={
                <div className="flex w-full justify-end gap-2">
                  <Button onClick={() => setShowLog(true)}>Show daemon log</Button>
                  <Button variant="default" icon={<Play />} loading={starting} onClick={startDaemon}>
                    Start rclone
                  </Button>
                </div>
              }
            >
              {daemon.message && <ErrorMessage error={daemon.message} />}
              {daemon.stderrTail && daemon.stderrTail.length > 0 && (
                <pre className="selectable max-h-48 overflow-auto mac:overscroll-none rounded-lg bg-terminal p-3 font-mono text-xs text-terminal-fg">
                  {daemon.stderrTail.join("\n")}
                </pre>
              )}
            </Card>
          )}

          {(daemon.state === "notInstalled" || !installed || daemon.state === "failed") && (
            <Card
              title={installed ? "Reinstall rclone" : "Install rclone"}
              description="The official build for your platform is downloaded into this app's own data folder. Nothing is installed system-wide and any rclone you already have is left alone."
              bodyClassName="flex flex-col gap-5"
              footer={
                <div className="flex w-full items-center justify-end gap-3">
                  {installing && <span className="mr-auto text-sm text-muted-foreground">Usually under a minute.</span>}
                  <Button variant="default" size="lg" icon={<Download />} loading={installing} disabled={!target} onClick={install}>
                    {installing ? "Installing…" : `Download & verify rclone ${version ?? ""}`}
                  </Button>
                </div>
              }
            >
              <KeyValue
                items={[
                  { label: "Version", value: version ?? (latestError ? `unknown (${latestError})` : "resolving…") },
                  { label: "Platform", value: target ? `${target.os}/${target.arch}` : "unsupported" },
                  { label: "Archive", value: asset ?? "–" },
                  { label: "Source", value: "https://downloads.rclone.org" },
                  { label: "Install to", value: info?.binDir ?? "–" },
                  {
                    label: "Trusted signer",
                    value: (
                      <span className="flex items-center gap-1.5">
                        <ShieldCheck className="size-3.5 shrink-0 text-success" /> Nick Craig-Wood · {TRUSTED_KEY}
                      </span>
                    ),
                  },
                ]}
              />
              <ProvisionProgress events={events} running={installing} />
              {error && <ErrorMessage error={error} onDismiss={() => setError(null)} />}
            </Card>
          )}
        </div>
      </PageBody>
      <LogViewerDialog open={showLog} onClose={() => setShowLog(false)} title="rclone daemon log" path="daemon" />
    </>
  );
}
