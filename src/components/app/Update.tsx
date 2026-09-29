import { ArrowUpCircle, Download, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatBytes, percent, pluralize } from "../../lib/format";
import { openExternal } from "../../lib/native";
import { errorMessage, type UpdateStatus } from "../../lib/types";
import { selectRunningCount, useJobsStore } from "../../store/jobs";
import { selectUpdateAvailable, useUpdatesStore } from "../../store/updates";
import { Button, Callout, cn, Dialog, ErrorMessage, ProgressBar, toast } from "../ui";

/**
 * Release notes are the version's CHANGELOG section: "- subject ([abc1234](commit url))" lines and an
 * "All changes: [compare](url)" line. The dialog lists the subjects; the commit links are for GitHub.
 */
export function releaseNoteItems(notes: string | null): { kind: "heading" | "item" | "text"; text: string }[] {
  if (!notes) return [];
  const plain = (line: string) =>
    line
      .replace(/\s*\(\[[0-9a-f]{7,40}\]\([^)]*\)\)\s*$/i, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__|`/g, "")
      .trim();
  return notes
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter((line) => line && !/^all changes:/i.test(line))
    .map((line) => {
      if (/^#{1,6}\s/.test(line)) return { kind: "heading" as const, text: plain(line.replace(/^#+\s*/, "")) };
      if (/^[-*]\s/.test(line)) return { kind: "item" as const, text: plain(line.slice(2)) };
      return { kind: "text" as const, text: plain(line) };
    })
    .filter((item) => item.text);
}

function progressText(s: UpdateStatus): string {
  if (s.state === "installing") return "Installing…";
  if (!s.total) return `${formatBytes(s.downloaded)} downloaded`;
  return `${formatBytes(s.downloaded)} of ${formatBytes(s.total)}`;
}

/**
 * Announces a newer Arcus once per version and session (a toast), and holds the update dialog, which the
 * toast, the sidebar's button, Settings and the tray all open.
 */
export function UpdatePrompt() {
  const load = useUpdatesStore((s) => s.load);
  const available = useUpdatesStore(selectUpdateAvailable);
  const openDialog = useUpdatesStore((s) => s.openDialog);
  const announced = useRef<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!available || announced.current === available) return;
    announced.current = available;
    toast({
      tone: "info",
      title: `Arcus ${available} is available`,
      description: "See what's new and update when it suits you.",
      duration: 12000,
      action: { label: "View", onClick: openDialog },
    });
  }, [available, openDialog]);

  return <UpdateDialog />;
}

function UpdateDialog() {
  const open = useUpdatesStore((s) => s.dialogOpen);
  const close = useUpdatesStore((s) => s.closeDialog);
  const status = useUpdatesStore((s) => s.status);
  const install = useUpdatesStore((s) => s.install);
  const check = useUpdatesStore((s) => s.check);
  const running = useJobsStore(selectRunningCount);
  const [error, setError] = useState<unknown>(null);

  const busy = status?.state === "downloading" || status?.state === "installing";
  const checking = status?.state === "checking";
  const version = status?.version;
  const notes = releaseNoteItems(status?.notes ?? null);

  const onInstall = async () => {
    setError(null);
    try {
      await install();
    } catch (e) {
      setError(e);
    }
  };

  const onCheck = async () => {
    setError(null);
    try {
      await check();
    } catch (e) {
      setError(e);
    }
  };

  const releasePage = version ? `https://github.com/Pimzino/arcus/releases/tag/v${version}` : status?.releasesUrl;

  return (
    <Dialog
      open={open}
      // Closing while it downloads only hides the dialog; the update carries on and restarts Arcus.
      onClose={close}
      closeOnBackdrop={!busy}
      title={version ? `Update to Arcus ${version}` : "Arcus updates"}
      description={
        version
          ? `You have Arcus ${status?.currentVersion}.${status?.date ? ` Released ${new Date(status.date).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}.` : ""}`
          : status?.state === "upToDate"
            ? `Arcus ${status.currentVersion} is the latest version.`
            : `You have Arcus ${status?.currentVersion ?? ""}.`
      }
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          {releasePage && (
            <Button variant="ghost" className="mr-auto" icon={<ExternalLink />} onClick={() => void openExternal(releasePage)}>
              Release on GitHub
            </Button>
          )}
          <Button onClick={close}>{busy ? "Hide" : "Later"}</Button>
          {!version ? (
            <Button variant="default" icon={<RefreshCw />} loading={checking} onClick={() => void onCheck()}>
              Check again
            </Button>
          ) : status?.canInstall ? (
            <Button variant="default" icon={<Download />} loading={busy} disabled={busy} onClick={() => void onInstall()}>
              {status?.state === "error" ? "Try again" : "Install and restart"}
            </Button>
          ) : (
            <Button variant="default" icon={<ExternalLink />} onClick={() => void openExternal(status.releasesUrl)}>
              Download from GitHub
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {notes.length > 0 && (
          <div className="selectable mac:overscroll-none max-h-64 overflow-y-auto rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
            <p className="mb-2 font-medium">What's new</p>
            <ul className="flex flex-col gap-1.5">
              {notes.map((n, i) =>
                n.kind === "heading" ? (
                  <li key={i} className={cn("font-medium", i > 0 && "pt-2")}>
                    {n.text}
                  </li>
                ) : (
                  <li key={i} className={cn("text-muted-foreground", n.kind === "item" && "relative pl-4 before:absolute before:left-1 before:content-['•']")}>
                    {n.text}
                  </li>
                ),
              )}
            </ul>
          </div>
        )}
        {version && !status?.canInstall && (
          <Callout tone="info" title="Install it from GitHub">
            This copy of Arcus was not installed from one of its release downloads, so it cannot update itself. Download the new
            version from the release page.
          </Callout>
        )}
        {version && status?.canInstall && running > 0 && !busy && (
          <Callout tone="warning" title={`${pluralize(running, "transfer")} running`}>
            Updating stops {running === 1 ? "it" : "them"}; you can run {running === 1 ? "it" : "them"} again from Transfers once Arcus is back.
          </Callout>
        )}
        {busy && status && (
          <div className="flex flex-col gap-2">
            <ProgressBar value={status.total ? percent(status.downloaded, status.total) : 0} indeterminate={!status.total || status.state === "installing"} />
            <p className="tnum text-sm text-muted-foreground">{progressText(status)}</p>
          </div>
        )}
        {status?.state === "error" && status.error && <ErrorMessage error={status.error} />}
        {error !== null && status?.state !== "error" && <ErrorMessage error={errorMessage(error)} />}
      </div>
    </Dialog>
  );
}

/** The sidebar's reminder while a newer version waits. */
export function SidebarUpdateButton() {
  const available = useUpdatesStore(selectUpdateAvailable);
  const openDialog = useUpdatesStore((s) => s.openDialog);
  if (!available) return null;
  return (
    <div className="shrink-0 px-2 pb-2">
      <button
        type="button"
        onClick={openDialog}
        className="no-ring flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-primary transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowUpCircle className="size-4 shrink-0" />
        <span className="flex-1 truncate">Update to {available}</span>
      </button>
    </div>
  );
}
