import { ChevronRight, FolderOpen, HardDrive, Home, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useLocalRoots, useRemotes } from "../../lib/hooks";
import { parseLocation, type Location } from "../../lib/paths";
import { useAppStore } from "../../store/app";
import { GroupLabel, Kbd } from "../ui";
import { Seal } from "./Seal";
import { modKey } from "./Sidebar";

/**
 * What an explorer pane shows before anything is open in it: every place it can open, one click each. Remotes
 * stand under their seals, the folders and drives of this computer under their icons.
 */
export function Places({ onPick }: { onPick: (loc: Location) => void }) {
  const remotes = useRemotes();
  const roots = useLocalRoots();
  const setPage = useAppStore((s) => s.setPage);
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-6 py-8">
      <div>
        <h2 className="font-display text-lg leading-7 font-semibold tracking-tight">Open a place</h2>
        <p className="text-sm text-muted-foreground">Then select files here and copy them to the other pane</p>
      </div>
      <section>
        <GroupLabel className="mb-2">Remotes</GroupLabel>
        <PlaceList>
          {remotes.data?.map((r) => (
            <Place key={r.name} mark={<Seal type={r.type} />} name={r.name} detail={r.type} onClick={() => onPick({ fs: `${r.name}:`, path: "" })} />
          ))}
          <Place mark={<Mark icon={<Plus />} />} name="Add a remote" detail="A cloud drive, a bucket, a server" onClick={() => setPage("remotes")} />
        </PlaceList>
      </section>
      {!!roots.data?.length && (
        <section>
          <GroupLabel className="mb-2">This computer</GroupLabel>
          <PlaceList>
            {roots.data.map((r) => (
              <Place
                key={r.path}
                mark={<Mark icon={r.kind === "home" ? <Home /> : r.kind === "folder" ? <FolderOpen /> : <HardDrive />} />}
                name={r.name}
                detail={r.path === r.name ? "Everything on this computer" : r.path}
                onClick={() => onPick(parseLocation(r.path))}
              />
            ))}
          </PlaceList>
        </section>
      )}
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Kbd>{modKey()}L</Kbd> to type a path instead
      </p>
    </div>
  );
}

function PlaceList({ children }: { children: ReactNode }) {
  return <div className="divide-y overflow-hidden rounded-xl bg-card text-card-foreground shadow-card ring-1 ring-border">{children}</div>;
}

/** The tile a local place stands under, the size of a remote's seal. */
function Mark({ icon }: { icon: ReactNode }) {
  return <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">{icon}</span>;
}

function Place({ mark, name, detail, onClick }: { mark: ReactNode; name: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="no-ring group flex h-14 w-full items-center gap-3 px-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60">
      {mark}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate font-mono text-xs text-muted-foreground">{detail}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-faint-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
    </button>
  );
}
