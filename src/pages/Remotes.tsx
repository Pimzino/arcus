import { useQuery } from "@tanstack/react-query";
import { Cloud, FolderOpen, Info, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorMessage,
  IconButton,
  KeyValue,
  Menu,
  PageBody,
  PageHeader,
  ProgressBar,
  SearchInput,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
  toast,
} from "../components/ui";
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
        description="Storage defined in rclone's config file."
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
            icon={<Cloud />}
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
        {(remotes.isLoading || list.length > 0) && (
          <Card>
            {/* The card body is padded and the card itself has py-4: the listing spans the whole card. */}
            <div className="-m-4">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-12 px-6">Name</TableHead>
                    <TableHead className="h-12 px-4">Type</TableHead>
                    <TableHead className="h-12 px-4">Usage</TableHead>
                    <TableHead className="h-12 px-4 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {remotes.isLoading ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={4} className="px-6 py-14 text-center">
                        <Spinner className="size-6" />
                      </TableCell>
                    </TableRow>
                  ) : (
                    list.map((r) => (
                      <RemoteRow
                        key={r.name}
                        remote={r}
                        typeLabel={providerLabel(r.type)}
                        onBrowse={() => openInExplorer({ fs: `${r.name}:`, path: "" })}
                        onEdit={() => setWizard({ mode: "edit", remote: r })}
                        onDelete={() => setDeleting(r)}
                        onQuota={() => setAbout(r)}
                      />
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
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

function RemoteRow({
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
    <TableRow>
      <TableCell className="px-6 py-4">
        <button type="button" className="no-ring block max-w-full truncate text-left text-base font-semibold hover:text-primary" onClick={onBrowse}>
          {remote.name}
        </button>
        <div className="truncate text-xs text-muted-foreground">{typeLabel}</div>
      </TableCell>
      <TableCell className="px-4 py-4 font-mono text-muted-foreground">{remote.type}</TableCell>
      <TableCell className="px-4 py-4">
        <UsageCell name={remote.name} />
      </TableCell>
      <TableCell className="px-4 py-4 text-right">
        <div className="flex items-center justify-end gap-1">
          <IconButton size="sm" label={`Browse ${remote.name}:`} onClick={onBrowse}>
            <FolderOpen />
          </IconButton>
          <IconButton size="sm" label={`Edit ${remote.name}:`} onClick={onEdit}>
            <Pencil />
          </IconButton>
          <IconButton size="sm" label={`Delete ${remote.name}:`} onClick={onDelete}>
            <Trash2 />
          </IconButton>
          <Menu align="end" items={[{ label: "Storage usage…", icon: <Info />, onSelect: onQuota }]}>
            <IconButton size="sm" label={`More actions for ${remote.name}:`}>
              <MoreHorizontal />
            </IconButton>
          </Menu>
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * Usage is only shown once the app already knows it: the "Storage usage" action caches
 * operations/about under ["about", fs]. This observer is disabled so the listing never calls
 * operations/about by itself — some OAuth remotes hand out single-use refresh tokens, and one
 * automatic call per remote would invalidate the token the user's other machines rely on.
 */
function UsageCell({ name }: { name: string }) {
  const fs = `${name}:`;
  const about: AboutInfo | undefined = useQuery({ queryKey: ["about", fs], queryFn: () => rc.about(fs), enabled: false }).data;

  if (!about) return <span className="text-muted-foreground">—</span>;
  const used = about.used ?? 0;
  const total = about.total ?? 0;
  if (total <= 0) return <span className="tnum text-muted-foreground">{formatBytes(used)} used</span>;

  const share = Math.round(percent(used, total));
  return (
    <div className="w-60">
      <div className="flex items-center justify-between gap-4">
        <span className="tnum text-muted-foreground">
          {formatBytes(used)} / {formatBytes(total)}
        </span>
        <span className="tnum text-muted-foreground">{share}%</span>
      </div>
      <ProgressBar className="mt-2" size="sm" value={share} tone={share >= 85 ? "danger" : "accent"} />
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
              <ProgressBar value={percent(used, total)} />
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
          <div className="mb-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">Backend {fsinfo.data.Name}</div>
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
