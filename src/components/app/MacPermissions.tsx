import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderLock, HardDrive, Network, RefreshCw, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import { openExternal } from "../../lib/native";
import { api } from "../../lib/tauri";
import { errorMessage, type MacFolderAccess, type MacPrivacyPane } from "../../lib/types";
import { useAppStore } from "../../store/app";
import { Badge, Button, Callout, ErrorMessage, Spinner, StatusBadge, cn, toast, type Tone } from "../ui";
import { useFileManager } from "./FileManager";

const FOLDER_STATUS: Record<MacFolderAccess["status"], { tone: Tone; label: string }> = {
  granted: { tone: "success", label: "granted" },
  denied: { tone: "danger", label: "denied" },
  missing: { tone: "neutral", label: "not found" },
  unknown: { tone: "neutral", label: "unknown" },
};

/**
 * The macOS permissions checklist: what the app needs, whether it has it, and the button
 * that gets it. Shown once on first run and always under Settings → macOS permissions.
 */
export function MacPermissionsList() {
  const foldersRequested = useAppStore((s) => !!s.macPermissions.foldersRequestedAtUnix);
  const markFoldersRequested = useAppStore((s) => s.markMacFoldersRequested);
  const arch = useAppStore((s) => s.info?.arch);
  const fm = useFileManager();
  const queryClient = useQueryClient();
  const [requesting, setRequesting] = useState(false);
  // Listing the protected folders prompts the first time only; once they have been
  // requested, later loads can probe them straight away.
  const status = useQuery({
    queryKey: ["macPermissions", foldersRequested],
    queryFn: () => api.macPermissions(foldersRequested),
    refetchOnWindowFocus: true, // the user comes back from System Settings
  });

  const requestFolders = async () => {
    setRequesting(true);
    try {
      const result = await api.macPermissions(true);
      queryClient.setQueryData(["macPermissions", true], result);
      await markFoldersRequested();
    } catch (e) {
      toast({ tone: "danger", title: "Could not request access", description: errorMessage(e) });
    } finally {
      setRequesting(false);
    }
  };
  const openPane = (pane: MacPrivacyPane) =>
    api.macOpenPrivacySettings(pane).catch((e) => toast({ tone: "danger", title: "Could not open System Settings", description: errorMessage(e) }));

  const data = status.data;
  const loading = status.isLoading;
  const fda = data?.fullDiskAccess;
  const folders = data?.folders ?? null;
  const anyDenied = folders?.some((f) => f.status === "denied") ?? false;
  const allGranted = !!folders && folders.every((f) => f.status === "granted" || f.status === "missing");
  const fuse = data?.fuse ?? [];
  const kernelFuse = fuse.find((f) => f.name !== "FUSE-T");
  const appPath = data?.appPath ?? null;
  const pending = <Spinner className="size-3.5" />;

  return (
    <div className="flex flex-col gap-4">
      <Callout
        tone="info"
        action={
          <Button size="sm" icon={<RefreshCw className={cn(status.isFetching && "animate-spin")} />} onClick={() => status.refetch()}>
            Check again
          </Button>
        }
      >
        rclone runs inside this app, so a permission granted to Rclone GUI covers rclone too.
      </Callout>
      {status.error && <ErrorMessage error={status.error} />}

      <div className="divide-y">
        <Row
          icon={<ShieldCheck />}
          title="Full Disk Access"
          tag="Recommended"
          status={
            loading ? pending : fda === "granted" ? <StatusBadge tone="success">Granted</StatusBadge> : fda === "notGranted" ? <StatusBadge tone="warning">Not granted</StatusBadge> : <StatusBadge>Unknown</StatusBadge>
          }
          description="Lets rclone read and write anywhere on this Mac without a prompt for each folder, including protected data such as Mail, Messages, Photos and Time Machine backups."
          details={
            fda !== "granted" && (
              <ol className="list-decimal space-y-0.5 pl-4 text-sm text-muted-foreground">
                <li>Open System Settings → Privacy &amp; Security → Full Disk Access.</li>
                <li>Click + and choose Rclone GUI, or drag the app in from Finder.</li>
                <li>Turn its switch on, then come back here. Quit and reopen the app if rclone still cannot read a folder.</li>
              </ol>
            )
          }
          actions={
            <>
              <Button size="sm" onClick={() => openPane("fullDiskAccess")}>
                Open System Settings
              </Button>
              {appPath && (
                <Button size="sm" onClick={() => fm.reveal([appPath])}>
                  Show app in Finder
                </Button>
              )}
            </>
          }
        />
        <Row
          icon={<FolderLock />}
          title="Desktop, Documents and Downloads"
          status={
            loading ? (
              pending
            ) : fda === "granted" ? (
              <StatusBadge tone="success">Covered by Full Disk Access</StatusBadge>
            ) : !folders ? (
              <StatusBadge>Not asked yet</StatusBadge>
            ) : anyDenied ? (
              <StatusBadge tone="danger">Denied</StatusBadge>
            ) : allGranted ? (
              <StatusBadge tone="success">Granted</StatusBadge>
            ) : (
              <StatusBadge>Unknown</StatusBadge>
            )
          }
          description="macOS asks the first time an app reads these folders, and again for removable and network volumes. Requesting them now means no prompt interrupts a transfer later."
          details={
            folders && (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {folders.map((f) => (
                  <StatusBadge key={f.name} tone={FOLDER_STATUS[f.status].tone}>
                    {f.name} · {FOLDER_STATUS[f.status].label}
                  </StatusBadge>
                ))}
              </div>
            )
          }
          actions={
            <>
              {!folders && fda !== "granted" && (
                <Button size="sm" variant="default" loading={requesting} onClick={requestFolders}>
                  Request access
                </Button>
              )}
              {anyDenied && (
                <Button size="sm" onClick={() => openPane("filesAndFolders")}>
                  Open System Settings
                </Button>
              )}
            </>
          }
        />
        <Row
          icon={<HardDrive />}
          title="Mounting remotes as drives"
          tag="Optional"
          status={
            loading ? pending : fuse.length ? <StatusBadge tone="success">{fuse.map((f) => (f.version ? `${f.name} ${f.version}` : f.name)).join(" and ")} installed</StatusBadge> : <StatusBadge>Not installed</StatusBadge>
          }
          description={`Mounts need a FUSE layer, which rclone picks up automatically: macFUSE (a kernel extension you approve in System Settings${arch === "aarch64" ? ", after allowing kernel extensions from Recovery on Apple silicon" : ""}) or FUSE-T (no kernel extension, with a few limitations).`}
          actions={
            <>
              {kernelFuse && (
                <Button size="sm" onClick={() => openPane("security")}>
                  Open System Settings
                </Button>
              )}
              {!fuse.length && (
                <>
                  <Button size="sm" onClick={() => openExternal("https://macfuse.github.io/")}>
                    Get macFUSE
                  </Button>
                  <Button size="sm" onClick={() => openExternal("https://www.fuse-t.org/")}>
                    Get FUSE-T
                  </Button>
                </>
              )}
            </>
          }
        />
        <Row
          icon={<Network />}
          title="Local network"
          status={<StatusBadge>Asked when first used</StatusBadge>}
          description="macOS asks the first time rclone connects to a device on your network, such as a NAS over SFTP or SMB. If you declined, turn it back on in System Settings."
          actions={
            <Button size="sm" onClick={() => openPane("localNetwork")}>
              Open System Settings
            </Button>
          }
        />
      </div>
    </div>
  );
}

function Row({
  icon,
  title,
  tag,
  status,
  description,
  details,
  actions,
}: {
  icon: ReactNode;
  title: string;
  tag?: string;
  status: ReactNode;
  description: ReactNode;
  details?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 py-4">
      <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">{icon}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">{title}</span>
          {tag && <Badge>{tag}</Badge>}
          {status}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        {details && <div className="mt-2">{details}</div>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">{actions}</div>
    </div>
  );
}
