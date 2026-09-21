import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, FolderOpen, HardDrive, Plus, RefreshCw, Unplug } from "lucide-react";
import { useState } from "react";
import { useFileManager } from "../components/app/FileManager";
import { LocationField } from "../components/app/Location";
import { Button, Callout, Card, Checkbox, Dialog, EmptyState, ErrorMessage, Field, Input, PageBody, PageHeader, Select, Textarea, cn, toast } from "../components/ui";
import { formatDateTime } from "../lib/format";
import { useInvalidate } from "../lib/hooks";
import { openExternal, pickFolder } from "../lib/native";
import { fsString, parseLocation, remoteName, type Location } from "../lib/paths";
import { rc } from "../lib/rc";
import { isTauri } from "../lib/tauri";
import { errorMessage, type MountPoint } from "../lib/types";
import { useAppStore, useDaemonRunning } from "../store/app";

/** Cards in the reference rule off their header; our Card has no slot for that line. */
const cardHeaderRule = "[&>header]:border-b [&>header]:pb-4";

export function MountsPage() {
  const running = useDaemonRunning();
  const os = useAppStore((s) => s.info?.os);
  const invalidate = useInvalidate();
  const mounts = useQuery({ queryKey: ["mounts"], enabled: running, refetchInterval: 5000, queryFn: () => rc.mountList() });
  const [creating, setCreating] = useState(false);

  const unmount = async (mountPoint: string) => {
    try {
      await rc.unmount(mountPoint);
      invalidate("mounts");
      toast({ tone: "success", title: "Unmounted", description: mountPoint });
    } catch (e) {
      toast({ tone: "danger", title: "Could not unmount", description: errorMessage(e) });
    }
  };

  const requirement =
    os === "macos"
      ? { text: "macOS needs macFUSE or FUSE-T installed to mount remotes.", url: "https://rclone.org/commands/rclone_mount/#macos" }
      : os === "windows"
        ? { text: "Windows needs WinFsp installed to mount remotes.", url: "https://rclone.org/commands/rclone_mount/#windows" }
        : { text: "Linux needs FUSE (fuse3) to mount remotes.", url: "https://rclone.org/commands/rclone_mount/" };

  return (
    <>
      <PageHeader
        title="Mounts"
        description="Expose a remote as a folder or drive that any application can use."
        actions={
          <>
            <Button size="lg" variant="default" icon={<Plus />} disabled={!running} onClick={() => setCreating(true)}>
              New mount
            </Button>
            <Button size="lg" variant="outline" icon={<RefreshCw className={cn(mounts.isFetching && "animate-spin")} />} onClick={() => invalidate("mounts")}>
              Refresh
            </Button>
          </>
        }
      />
      <PageBody>
        <div className="space-y-6">
          <Callout
            tone="info"
            action={
              <Button size="xs" variant="outline" onClick={() => openExternal(requirement.url)}>
                rclone mount docs
              </Button>
            }
          >
            {requirement.text} Mounts last while the rclone daemon runs and are unmounted when the app quits.
          </Callout>
          {mounts.error && <ErrorMessage error={mounts.error} />}
          {mounts.data?.length === 0 && (
            <EmptyState
              icon={<HardDrive />}
              title="No active mounts"
              description="Mount a remote to browse it with Finder, Explorer or any other app."
              action={
                <Button variant="outline" disabled={!running} onClick={() => setCreating(true)}>
                  New mount
                </Button>
              }
            />
          )}
          {(mounts.data?.length ?? 0) > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-start gap-6">
              {mounts.data!.map((m) => (
                <MountCard key={m.MountPoint} mount={m} onUnmount={() => unmount(m.MountPoint)} />
              ))}
            </div>
          )}
        </div>
      </PageBody>
      {creating && (
        <NewMountDialog
          os={os ?? "unknown"}
          onClose={() => setCreating(false)}
          onMounted={(mp) => {
            setCreating(false);
            invalidate("mounts");
            toast({ tone: "success", title: "Mounted", description: mp });
          }}
        />
      )}
    </>
  );
}

function MountCard({ mount, onUnmount }: { mount: MountPoint; onUnmount: () => void }) {
  const fm = useFileManager();
  return (
    <Card
      className={cardHeaderRule}
      title={remoteName(parseLocation(mount.Fs)) ?? mount.Fs}
      footer={
        /* Unmount keeps the room the card's one action had; showing the mount is the quieter one beside it.
           Neither button can shrink, so in a card as narrow as the grid allows they wrap instead of overflowing. */
        <div className="flex w-full flex-wrap items-center gap-2">
          <Button variant="outline" icon={<FolderOpen />} onClick={() => fm.open(mount.MountPoint)}>
            {fm.openLabel}
          </Button>
          <Button variant="destructive" className="flex-1" icon={<Unplug />} onClick={onUnmount}>
            Unmount
          </Button>
        </div>
      }
    >
      <dl className="space-y-4">
        <MountFact label="Source" value={mount.Fs} mono />
        <MountFact label="Mount point" value={mount.MountPoint} mono />
        <MountFact label="Mounted on" value={formatDateTime(mount.MountedOn)} />
      </dl>
    </Card>
  );
}

function MountFact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-1.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("selectable break-all text-base font-medium", mono ? "font-mono" : "tnum")}>{value}</dd>
    </div>
  );
}

function NewMountDialog({ os, onClose, onMounted }: { os: string; onClose: () => void; onMounted: (mountPoint: string) => void }) {
  const types = useQuery({ queryKey: ["mountTypes"], queryFn: () => rc.mountTypes() });
  const [fs, setFs] = useState<Location>({ fs: "", path: "" });
  const [mountPoint, setMountPoint] = useState(os === "windows" ? "*" : "");
  const [mountType, setMountType] = useState("");
  const [cacheMode, setCacheMode] = useState("full");
  const [readOnly, setReadOnly] = useState(false);
  const [dirCacheTime, setDirCacheTime] = useState("");
  const [cacheMaxSize, setCacheMaxSize] = useState("");
  const [cacheMaxAge, setCacheMaxAge] = useState("");
  const [volumeName, setVolumeName] = useState("");
  const [allowOther, setAllowOther] = useState(false);
  const [extraVfs, setExtraVfs] = useState("");
  const [extraMount, setExtraMount] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!fs.fs || !mountPoint.trim()) {
      setError("Choose a remote and a mount point.");
      return;
    }
    setBusy(true);
    try {
      const vfsOpt: Record<string, unknown> = { CacheMode: cacheMode };
      if (readOnly) vfsOpt.ReadOnly = true;
      if (dirCacheTime) vfsOpt.DirCacheTime = dirCacheTime;
      if (cacheMaxSize) vfsOpt.CacheMaxSize = cacheMaxSize;
      if (cacheMaxAge) vfsOpt.CacheMaxAge = cacheMaxAge;
      if (extraVfs.trim()) Object.assign(vfsOpt, JSON.parse(extraVfs));
      const mountOpt: Record<string, unknown> = {};
      if (volumeName) mountOpt.VolumeName = volumeName;
      if (allowOther) mountOpt.AllowOther = true;
      if (extraMount.trim()) Object.assign(mountOpt, JSON.parse(extraMount));
      const res = await rc.mount({ fs: fsString(fs), mountPoint: mountPoint.trim(), ...(mountType ? { mountType } : {}), mountOpt, vfsOpt });
      onMounted(res.mountPoint ?? mountPoint.trim());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New mount"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="default" loading={busy} onClick={submit}>
            Mount
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <ErrorMessage error={error} onDismiss={() => setError(null)} />}
        <Card className={cardHeaderRule} title="Source and destination" description="Choose the remote to expose and where it appears on this computer.">
          <div className="flex flex-col gap-4">
            <LocationField label="Remote to mount" required value={fs} onChange={setFs} autoFocus />
            <Field
              label="Mount point"
              required
              help={os === "windows" ? "A free drive letter such as X:, * for the first free letter, or an empty folder." : "An empty folder; it is created if missing."}
            >
              <div className="flex items-center gap-1.5">
                <Input mono value={mountPoint} onChange={(e) => setMountPoint(e.target.value)} placeholder={os === "windows" ? "X:" : "/Users/you/mnt/remote"} />
                {isTauri && (
                  <Button
                    onClick={async () => {
                      const picked = await pickFolder();
                      if (picked) setMountPoint(picked);
                    }}
                  >
                    Choose…
                  </Button>
                )}
              </div>
            </Field>
          </div>
        </Card>
        <Card className={cardHeaderRule} title="Mount options" description="How the mount caches file contents and how it appears to other applications.">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            <Field label="VFS cache mode" help="full is the most compatible; off uses no local cache.">
              <Select value={cacheMode} onChange={(e) => setCacheMode(e.target.value)} options={["off", "minimal", "writes", "full"].map((v) => ({ value: v, label: v }))} />
            </Field>
            <Field label="Mount type">
              <Select value={mountType} onChange={(e) => setMountType(e.target.value)}>
                <option value="">auto</option>
                {types.data?.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Directory cache time" help="e.g. 5m, 1h">
              <Input value={dirCacheTime} onChange={(e) => setDirCacheTime(e.target.value)} placeholder="5m" />
            </Field>
            <Field label="Cache max size" help="e.g. 10G">
              <Input value={cacheMaxSize} onChange={(e) => setCacheMaxSize(e.target.value)} placeholder="unlimited" />
            </Field>
            <Field label="Cache max age" help="e.g. 1h, 24h">
              <Input value={cacheMaxAge} onChange={(e) => setCacheMaxAge(e.target.value)} placeholder="1h" />
            </Field>
            <Field label="Volume name">
              <Input value={volumeName} onChange={(e) => setVolumeName(e.target.value)} placeholder="Shown in Finder / Explorer" />
            </Field>
            <Checkbox label="Read only" checked={readOnly} onChange={setReadOnly} />
            {os !== "windows" && <Checkbox label="Allow other users (allow_other)" checked={allowOther} onChange={setAllowOther} />}
          </div>
        </Card>
        <Card
          className={cn(advanced && cardHeaderRule)}
          title="Advanced"
          description="Raw vfsOpt and mountOpt JSON, merged over the options above."
          actions={
            <Button variant="ghost" size="sm" icon={advanced ? <ChevronUp /> : <ChevronDown />} onClick={() => setAdvanced(!advanced)}>
              {advanced ? "Hide" : "Show"}
            </Button>
          }
          bodyClassName={advanced ? undefined : "hidden"}
        >
          <div className="grid grid-cols-2 gap-4">
            <Field label="vfsOpt" help='e.g. {"ChunkSize": "64M", "NoModTime": true}'>
              <Textarea mono rows={3} value={extraVfs} onChange={(e) => setExtraVfs(e.target.value)} placeholder="{}" />
            </Field>
            <Field label="mountOpt" help='e.g. {"NetworkMode": true}'>
              <Textarea mono rows={3} value={extraMount} onChange={(e) => setExtraMount(e.target.value)} placeholder="{}" />
            </Field>
          </div>
        </Card>
      </div>
    </Dialog>
  );
}
