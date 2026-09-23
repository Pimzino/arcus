import { FolderOpen, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/tauri";
import { errorMessage } from "../../lib/types";
import { useAppStore } from "../../store/app";
import { Button, Dialog, ErrorMessage, toast } from "../ui";
import { useFileManager } from "./FileManager";

/** Old copies the user chose to keep, so the question is asked once per copy. */
const DISMISSED_KEY = "legacyAppDismissed";

/**
 * The app was called Rclone GUI up to v0.5.x. Its identifier never changed, so settings, rclone binaries and
 * job history carried over, but on macOS dragging Arcus.app into Applications leaves Rclone GUI.app next to
 * it. This offers, once, to move that old copy to the Trash. (The Windows installers remove the old install
 * themselves.)
 */
export function LegacyAppNotice() {
  const isMac = useAppStore((s) => s.info?.os === "macos");
  const fm = useFileManager();
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isMac) return;
    let cancelled = false;
    void (async () => {
      try {
        const [found, dismissed] = await Promise.all([api.legacyAppInstalls(), api.storeGet<string[]>(DISMISSED_KEY)]);
        if (!cancelled) setPaths(found.filter((p) => !dismissed?.includes(p)));
      } catch {
        /* Only a convenience: if the check fails, say nothing. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isMac]);

  const keep = async () => {
    const dismissed = (await api.storeGet<string[]>(DISMISSED_KEY).catch(() => null)) ?? [];
    await api.storeSet(DISMISSED_KEY, [...new Set([...dismissed, ...paths])]).catch(() => undefined);
    setPaths([]);
  };

  const moveToTrash = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const path of paths) await api.trashLegacyApp(path);
      toast({ tone: "success", title: "Moved Rclone GUI to the Trash", description: "You can put it back from the Trash if you need it." });
      setPaths([]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={paths.length > 0}
      onClose={() => void keep()}
      title="Rclone GUI is now Arcus"
      description="Same app, new name. Your settings, rclone downloads and transfer history came across as they were."
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" className="mr-auto" onClick={() => void keep()}>
            Keep both
          </Button>
          <Button icon={<FolderOpen />} onClick={() => void fm.reveal(paths)}>
            {fm.revealLabel}
          </Button>
          <Button variant="default" icon={<Trash2 />} loading={busy} onClick={() => void moveToTrash()}>
            Move old app to Trash
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p>The old app is still installed, so you have two copies of the same app:</p>
        <ul className="flex flex-col gap-1">
          {paths.map((p) => (
            <li key={p} className="selectable font-mono text-xs [word-break:normal] wrap-anywhere text-muted-foreground">
              {p}
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground">
          Moving it to the Trash leaves your data alone, and you can put it back from the Trash. If it is in your Dock, remove it
          there and keep Arcus instead.
        </p>
        {error && <ErrorMessage error={`Couldn't move it: ${error}. You can drag it to the Trash in Finder instead.`} />}
      </div>
    </Dialog>
  );
}
