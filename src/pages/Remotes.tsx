import { useQuery } from "@tanstack/react-query";
import { FolderOpen, Info, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorMessage,
  GroupLabel,
  IconButton,
  KeyValue,
  Menu,
  PageBody,
  PageHeader,
  ProgressBar,
  SearchInput,
  Spinner,
  cn,
  toast,
} from "../components/ui";
import { Aqueduct } from "../components/app/Arch";
import { Seal } from "../components/app/Seal";
import { formatBytes, percent } from "../lib/format";
import { useInvalidate, useProviders, useRemotes, type RemoteInfo } from "../lib/hooks";
import { rc } from "../lib/rc";
import { errorMessage, type AboutInfo } from "../lib/types";
import { useExplorerStore } from "../store/explorer";
import { RemoteWizard } from "./RemoteWizard";

export function RemotesPage() {
  const remotes = useRemotes();
  const providers = useProviders();
  const invalidate = useInvalidate();
  const openInExplorer = useExplorerStore((s) => s.open);
  const [search, setSearch] = useState("");
  const [wizard, setWizard] = useState<{ mode: "create" } | { mode: "edit"; remote: RemoteInfo } | null>(null);
  const [deleting, setDeleting] = useState<RemoteInfo | null>(null);
  const [about, setAbout] = useState<RemoteInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const providerLabel = (type: string) => providers.data?.find((p) => p.Name === type || p.Aliases?.includes(type))?.Description ?? type;
  const all = remotes.data ?? [];
  const query = search.trim().toLowerCase();
  const list = query
    ? all.filter((r) => r.name.toLowerCase().includes(query) || r.type.toLowerCase().includes(query) || providerLabel(r.type).toLowerCase().includes(query))
    : all;

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await rc.configDelete(deleting.name);
      invalidate("remotes");
      toast({ tone: "success", title: `Removed remote ${deleting.name}:` });
      setDeleting(null);
    } catch (e) {
      toast({ tone: "danger", title: "Could not delete remote", description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Remotes"
        description="Storage defined in rclone's config file"
        actions={
          <div className="flex items-center gap-2">
            <SearchInput value={search} onValueChange={setSearch} aria-label="Search remotes" placeholder="Search by name or type" className="w-56" />
            <Button size="lg" variant="default" icon={<Plus />} onClick={() => setWizard({ mode: "create" })}>
              Add remote
            </Button>
            <Button
              size="lg"
              variant="outline"
              icon={<RefreshCw className={cn(remotes.isFetching && "animate-spin")} />}
              disabled={remotes.isFetching}
              onClick={() => invalidate("remotes")}
            >
              Refresh
            </Button>
          </div>
        }
      />
      <PageBody>
        {remotes.error && <ErrorMessage error={remotes.error} className="mb-6" />}
        {remotes.data?.length === 0 && (
          <EmptyState
            art={<Aqueduct className="w-64" />}
            title="No remotes yet"
            description="Add a remote to connect a cloud drive, an S3 bucket, an SFTP server… anything rclone supports."
            action={
              <Button variant="outline" onClick={() => setWizard({ mode: "create" })}>
                Add remote
              </Button>
            }
          />
        )}
        {all.length > 0 && list.length === 0 && (
          <EmptyState icon={<Search />} title="No matches" description={`No remote matches “${search.trim()}”. Try a different name or type.`} />
        )}
        {remotes.isLoading && (
          <div className="flex justify-center py-16">
            <Spinner className="size-5" />
          </div>
        )}
        {list.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-5">
            {list.map((r) => (
              <RemoteCard
                key={r.name}
                remote={r}
                typeLabel={providerLabel(r.type)}
                onBrowse={() => openInExplorer({ fs: `${r.name}:`, path: "" })}
                onEdit={() => setWizard({ mode: "edit", remote: r })}
                onDelete={() => setDeleting(r)}
                onQuota={() => setAbout(r)}
              />
            ))}
            {!query && (
              <button
                type="button"
                onClick={() => setWizard({ mode: "create" })}
                className="no-ring group flex min-h-52 flex-col items-start justify-between rounded-2xl p-5 text-left ring-1 ring-border transition-[background-color,box-shadow] ring-inset hover:bg-card hover:shadow-card focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground transition-colors group-hover:text-primary-ink [&_svg]:size-5">
                  <Plus />
                </span>
                <span>
                  <span className="block font-display text-lg leading-7 font-semibold tracking-tight">Add a remote</span>
                  <span className="block text-sm text-muted-foreground">A cloud drive, a bucket, a server: anything rclone can reach</span>
                </span>
              </button>
            )}
          </div>
        )}
      </PageBody>

      {wizard && (
        <RemoteWizard
          mode={wizard.mode}
          remote={wizard.mode === "edit" ? wizard.remote : undefined}
          onClose={() => setWizard(null)}
          onSaved={(name) => {
            invalidate("remotes");
            toast({ tone: "success", title: `Remote ${name}: saved`, action: { label: "Browse", onClick: () => openInExplorer({ fs: `${name}:`, path: "" }) } });
            setWizard(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        title={`Delete remote “${deleting?.name}”?`}
        message="This removes the remote from rclone's config file. No files on the storage itself are touched. Transfers or mounts using it will stop working."
        confirmLabel="Delete remote"
        danger
        loading={busy}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
      {about && <AboutDialog remote={about} onClose={() => setAbout(null)} />}
    </>
  );
}

/**
 * A remote as a place: its backend's seal, its name and what it is, how full it is once that has been asked, and
 * the ways in. Its name opens it in the explorer.
 */
function RemoteCard({
  remote,
  typeLabel,
  onBrowse,
  onEdit,
  onDelete,
  onQuota,
}: {
  remote: RemoteInfo;
  typeLabel: string;
  onBrowse: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onQuota: () => void;
}) {
  return (
    <article data-remote className="flex min-h-52 min-w-0 flex-col rounded-2xl bg-card p-5 text-card-foreground shadow-card ring-1 ring-border">
      <div className="flex items-start justify-between gap-3">
        <Seal type={remote.type} className="size-12 rounded-xl text-sm" />
        <Menu align="end" items={[{ label: "Storage usage…", icon: <Info />, onSelect: onQuota }]}>
          <IconButton size="sm" label={`More actions for ${remote.name}:`} className="-mt-1 -mr-1">
            <MoreHorizontal />
          </IconButton>
        </Menu>
      </div>
      <button
        type="button"
        className="no-ring mt-4 block max-w-full truncate rounded-sm text-left font-display text-lg leading-7 font-semibold tracking-tight transition-colors hover:text-primary-ink focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={onBrowse}
      >
        {remote.name}
      </button>
      <div className="truncate text-sm text-muted-foreground" title={`${typeLabel} (${remote.type})`}>
        {typeLabel}
      </div>
      <div className="mt-auto pt-5">
        <Usage name={remote.name} onQuota={onQuota} />
      </div>
      <div className="mt-4 flex items-center gap-1 border-t pt-3">
        <Button size="sm" variant="ghost" icon={<FolderOpen />} onClick={onBrowse} className="-ml-2 mr-auto" aria-label={`Browse ${remote.name}:`}>
          Browse
        </Button>
        <IconButton size="sm" label={`Edit ${remote.name}:`} onClick={onEdit}>
          <Pencil />
        </IconButton>
        <IconButton size="sm" label={`Delete ${remote.name}:`} onClick={onDelete}>
          <Trash2 />
        </IconButton>
      </div>
    </article>
  );
}

/**
 * How full a remote is, shown only once the app already knows it: the "Storage usage" action caches
 * operations/about under ["about", fs]. This observer is disabled so the listing never calls
 * operations/about by itself — some OAuth remotes hand out single-use refresh tokens, and one
 * automatic call per remote would invalidate the token the user's other machines rely on.
 */
function Usage({ name, onQuota }: { name: string; onQuota: () => void }) {
  const fs = `${name}:`;
  const about: AboutInfo | undefined = useQuery({ queryKey: ["about", fs], queryFn: () => rc.about(fs), enabled: false }).data;

  if (!about)
    return (
      <button type="button" onClick={onQuota} className="no-ring rounded-sm text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
        How full is it?
      </button>
    );
  const used = about.used ?? 0;
  const total = about.total ?? 0;
  if (total <= 0) return <span className="tnum text-xs text-muted-foreground">{formatBytes(used)} used</span>;

  const share = Math.round(percent(used, total));
  return (
    <div className="text-xs">
      {/* Storage in use is a level, not a transfer: one neutral span, red once the remote is nearly full. */}
      <ProgressBar value={share} tone={share >= 85 ? "danger" : "neutral"} />
      <div className="tnum mt-2 flex justify-between gap-4 text-muted-foreground">
        <span>
          {formatBytes(used)} of {formatBytes(total)}
        </span>
        <span>{share}%</span>
      </div>
    </div>
  );
}

function AboutDialog({ remote, onClose }: { remote: RemoteInfo; onClose: () => void }) {
  const fs = `${remote.name}:`;
  const about = useQuery({ queryKey: ["about", fs], queryFn: () => rc.about(fs), retry: false });
  const fsinfo = useQuery({ queryKey: ["fsinfo", fs], queryFn: () => rc.fsinfo(fs) });
  const used = about.data?.used ?? 0;
  const total = about.data?.total ?? 0;
  return (
    <Dialog open onClose={onClose} title={`${remote.name}:`} description="Storage usage and backend capabilities" size="sm">
      {about.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Querying the remote…
        </div>
      )}
      {about.error && <ErrorMessage error={about.error} className="mb-3" />}
      {about.data && (
        <div className="flex flex-col gap-3">
          {total > 0 && (
            <div>
              <ProgressBar value={percent(used, total)} tone={percent(used, total) >= 85 ? "danger" : "neutral"} />
              <div className="tnum mt-1 text-xs text-muted-foreground">
                {formatBytes(used)} of {formatBytes(total)} used
              </div>
            </div>
          )}
          <KeyValue
            items={[
              { label: "Used", value: formatBytes(about.data.used), mono: false },
              { label: "Free", value: formatBytes(about.data.free), mono: false },
              { label: "Trashed", value: formatBytes(about.data.trashed), mono: false },
              { label: "Objects", value: about.data.objects?.toLocaleString() ?? "–", mono: false },
            ]}
          />
        </div>
      )}
      {fsinfo.data && (
        <div className="mt-4">
          <GroupLabel className="mb-2">Backend {fsinfo.data.Name}</GroupLabel>
          <div className="mb-2 text-xs text-muted-foreground">Hashes: {fsinfo.data.Hashes?.join(", ") || "none"}</div>
          <div className="flex flex-wrap gap-1">
            {Object.entries(fsinfo.data.Features ?? {})
              .filter(([, v]) => v)
              .map(([k]) => (
                <Badge key={k} size="sm">
                  {k}
                </Badge>
              ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}
