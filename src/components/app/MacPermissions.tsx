import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderLock, HardDrive, Network, RefreshCw, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import { openExternal } from "../../lib/native";
import { api } from "../../lib/tauri";
import { errorMessage, type MacFolderAccess, type MacPrivacyPane } from "../../lib/types";
import { selectMacFoldersAsked, selectMacLocalNetworkAsked, useAppStore } from "../../store/app";
import { Badge, Button, Callout, ErrorMessage, Spinner, StatusBadge, cn, toast, type Tone } from "../ui";
import { useFileManager } from "./FileManager";

const FOLDER_STATUS: Record<MacFolderAccess["status"], { tone: Tone; label: string }> = {
  granted: { tone: "success", label: "allowed" },
  denied: { tone: "danger", label: "not allowed" },
  missing: { tone: "neutral", label: "not found" },
  unknown: { tone: "neutral", label: "unknown" },
};

/** While something is still to be granted in System Settings, how often its status is read again. */
const LIVE_CHECK_MS = 1500;

/**
 * The macOS permissions checklist: what the app needs, whether it has it, and the one button that gets it. It is the
 * first thing a new Mac install shows, and it stays under Settings → macOS permissions.
 *
 * Nothing here makes macOS prompt on its own: Full Disk Access is read from a file only it may open, and the protected
 * folders are only listed once the user has asked for them under this code identity (listing a folder macOS has an
 * answer for is silent; one it has none for prompts). Every button that opens System Settings first makes sure Arcus
 * is in that pane's list, since macOS only lists apps that have tried to use a service.
 */
export function MacPermissionsList() {
  const foldersAsked = useAppStore(selectMacFoldersAsked);
  const localNetworkAsked = useAppStore(selectMacLocalNetworkAsked);
  const identity = useAppStore((s) => s.macPermissions.identity);
  const markFoldersRequested = useAppStore((s) => s.markMacFoldersRequested);
  const markLocalNetworkRequested = useAppStore((s) => s.markMacLocalNetworkRequested);
  const arch = useAppStore((s) => s.info?.arch);
  const fm = useFileManager();
  const queryClient = useQueryClient();
  const [requestingFolders, setRequestingFolders] = useState(false);
  const [requestingNetwork, setRequestingNetwork] = useState(false);
  const status = useQuery({
    queryKey: ["macPermissions", foldersAsked],
    queryFn: () => api.macPermissions(foldersAsked),
    refetchOnWindowFocus: true, // the user comes back from System Settings
    // Switches flipped in System Settings show up here without a click, while any are left to flip.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const foldersPending = !!data.folders?.some((f) => f.status === "denied");
      return data.fullDiskAccess !== "granted" || foldersPending ? LIVE_CHECK_MS : false;
    },
  });

  const requestFolders = async () => {
    setRequestingFolders(true);
    try {
      // macOS asks once per folder, one after the other; each listing waits for its answer.
      const result = await api.macPermissions(true);
      await markFoldersRequested();
      queryClient.setQueryData(["macPermissions", true], result);
    } catch (e) {
      toast({ tone: "danger", title: "Could not request access", description: errorMessage(e) });
    } finally {
      setRequestingFolders(false);
    }
  };
  const requestLocalNetwork = async () => {
    setRequestingNetwork(true);
    try {
      await api.macRequestLocalNetwork();
      await markLocalNetworkRequested();
    } catch (e) {
      toast({ tone: "danger", title: "Could not ask about the local network", description: errorMessage(e) });
    } finally {
      setRequestingNetwork(false);
    }
  };
  const openPane = (pane: MacPrivacyPane) =>
    api.macOpenPrivacySettings(pane).catch((e) => toast({ tone: "danger", title: "Could not open System Settings", description: errorMessage(e) }));

  const data = status.data;
  const loading = status.isLoading;
  const fda = data?.fullDiskAccess;
  const fdaGranted = fda === "granted";
  const folders = data?.folders ?? null;
  const anyDenied = folders?.some((f) => f.status === "denied") ?? false;
  const allGranted = !!folders && folders.every((f) => f.status === "granted" || f.status === "missing");
  const fuse = data?.fuse ?? [];
  const kernelFuse = fuse.find((f) => f.name !== "FUSE-T");
  const appPath = data?.appPath ?? null;
  const adHoc = !!identity?.startsWith("cdhash");
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
        rclone runs inside Arcus, so what you allow Arcus covers rclone too. macOS only asks when you press a button below.
      </Callout>
      {adHoc && (
        <Callout tone="warning" title="This copy of Arcus is ad-hoc signed">
          macOS recognises an ad-hoc signed app by its exact build, so after every update it asks for these permissions again.
          Release builds are signed with the Arcus certificate, which macOS recognises across updates.
        </Callout>
      )}
      {status.error && <ErrorMessage error={status.error} />}

      <div className="divide-y">
        <Row
          icon={<ShieldCheck />}
          title="Full Disk Access"
          tag="Recommended"
          status={
            loading ? pending : fdaGranted ? <StatusBadge tone="success">Allowed</StatusBadge> : fda === "notGranted" ? <StatusBadge tone="warning">Not allowed</StatusBadge> : <StatusBadge>Unknown</StatusBadge>
          }
          description="Lets rclone read and write anywhere on this Mac without a prompt for each folder or drive, including protected data such as Mail, Messages, Photos and Time Machine backups."
          details={
            !loading &&
            !fdaGranted && (
              <div className="flex flex-col gap-1.5">
                <ol className="list-decimal space-y-0.5 pl-4 text-sm text-muted-foreground">
                  <li>Press Open Full Disk Access. Arcus is added to the list there.</li>
                  <li>Turn on the switch next to Arcus. macOS may ask for your password.</li>
                  <li>Come back to Arcus. This page updates by itself.</li>
                </ol>
                {appPath && (
                  <p className="text-xs text-muted-foreground">
                    Arcus not in the list? Press + under the list and choose it in Applications, or drag it in from Finder with Show Arcus in Finder.
                  </p>
                )}
              </div>
            )
          }
          actions={
            !loading &&
            !fdaGranted && (
              <>
                <Button size="sm" variant="default" onClick={() => openPane("fullDiskAccess")}>
                  Open Full Disk Access
                </Button>
                {appPath && (
                  <Button size="sm" onClick={() => fm.reveal([appPath])}>
                    Show Arcus in Finder
                  </Button>
                )}
              </>
            )
          }
        />
        <Row
          icon={<FolderLock />}
          title="Desktop, Documents and Downloads"
          status={
            loading ? (
              pending
            ) : fdaGranted ? (
              <StatusBadge tone="success">Covered by Full Disk Access</StatusBadge>
            ) : !folders ? (
              <StatusBadge>Not asked yet</StatusBadge>
            ) : anyDenied ? (
              <StatusBadge tone="danger">Not allowed</StatusBadge>
            ) : allGranted ? (
              <StatusBadge tone="success">Allowed</StatusBadge>
            ) : (
              <StatusBadge>Unknown</StatusBadge>
            )
          }
          description={
            fdaGranted
              ? "Full Disk Access includes these folders, and external and network drives."
              : !folders
                ? "Without Full Disk Access, macOS asks the first time rclone opens each of these folders. Ask now, one prompt per folder, so none interrupts a transfer later. External and network drives are asked about when first used."
                : "macOS remembers these answers. Change them under Files and Folders, where Arcus is now listed."
          }
          details={
            !fdaGranted &&
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
            !loading &&
            !fdaGranted && (
              <>
                {!folders && (
                  <Button size="sm" variant="default" loading={requestingFolders} onClick={requestFolders}>
                    Ask for access
                  </Button>
                )}
                {folders && (
                  <Button size="sm" variant={anyDenied ? "default" : "outline"} onClick={() => openPane("filesAndFolders")}>
                    Open Files and Folders
                  </Button>
                )}
              </>
            )
          }
        />
        <Row
          icon={<Network />}
          title="Local network"
          tag="If you use a NAS"
          status={localNetworkAsked ? <StatusBadge tone="info">Asked</StatusBadge> : <StatusBadge>Not asked yet</StatusBadge>}
          description={
            localNetworkAsked
              ? "macOS keeps your answer under Local Network, where Arcus is listed. macOS does not let apps read it back."
              : "Needed to reach devices on your own network, such as a NAS over SFTP, SMB or WebDAV. Cloud storage does not need it. Ask now so the prompt does not wait on a transfer."
          }
          actions={
            localNetworkAsked ? (
              <Button size="sm" onClick={() => openPane("localNetwork")}>
                Open Local Network
              </Button>
            ) : (
              <Button size="sm" variant="default" loading={requestingNetwork} onClick={requestLocalNetwork}>
                Ask for access
              </Button>
            )
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
