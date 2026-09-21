// "Show in Finder / File Explorer / the file manager": the labels this platform uses, the calls
// behind them, and what the user is told when a path has moved on or the file manager will not open.

import { FolderOpen, FolderSearch } from "lucide-react";
import { useMemo } from "react";
import { fileManagerLabel, fileManagerName } from "../../lib/fileManager";
import { openInFileManager, revealInFileManager } from "../../lib/native";
import { baseName } from "../../lib/paths";
import { errorMessage, toAppError } from "../../lib/types";
import { useAppStore } from "../../store/app";
import { IconButton, toast, type IconButtonSize } from "../ui";

export type FileManagerActions = {
  /** The file manager as it reads inside a sentence: "Finder", "File Explorer", "the file manager". */
  name: string;
  /** "Reveal in Finder" / "Show in File Explorer": select an item in the folder it is in. */
  revealLabel: string;
  /** "Open in Finder": open a folder so its contents show. */
  openLabel: string;
  /** "Show in Finder": for a path that may be a file or a folder, which the backend reveals if it is a file. */
  showLabel: string;
  reveal: (paths: string[]) => Promise<void>;
  open: (path: string) => Promise<void>;
};

/** The file-manager labels and actions for this platform; failures become a toast, never a rejection. */
export function useFileManager(): FileManagerActions {
  const os = useAppStore((s) => s.info?.os);
  return useMemo(() => {
    const plain = fileManagerName(os);
    const name = plain === "file manager" ? "the file manager" : plain;
    const show = async (paths: string[], run: () => Promise<void>) => {
      try {
        await run();
      } catch (e) {
        if (toAppError(e).kind === "notFound") {
          /* notFound means none of the paths are there any more: the backend shows the ones that still
             are. The title stays short; a toast clamps its description to two lines and fits no path. */
          const gone =
            paths.length === 1
              ? { title: `“${baseName(paths[0])}” is no longer there`, description: "It may have been moved, renamed or deleted." }
              : { title: "These items are no longer there", description: "They may have been moved, renamed or deleted." };
          toast({ tone: "warning", ...gone });
        } else {
          toast({ tone: "danger", title: `Could not open ${name}`, description: errorMessage(e) });
        }
      }
    };
    return {
      name,
      revealLabel: fileManagerLabel(os, "reveal"),
      openLabel: fileManagerLabel(os, "open"),
      showLabel: fileManagerLabel(os, "show"),
      reveal: (paths) => show(paths, () => revealInFileManager(paths)),
      open: (path) => show([path], () => openInFileManager(path)),
    };
  }, [os]);
}

/**
 * Icon button that shows one local path: `reveal` selects the item, `open` opens the folder it names.
 * `tabIndex={-1}` makes it a pointer-only affordance, for lists too long to tab through.
 */
export function ShowPathButton({
  path,
  mode,
  size = "xs",
  tabIndex,
  className,
}: {
  path: string;
  mode: "reveal" | "open";
  size?: IconButtonSize;
  tabIndex?: number;
  className?: string;
}) {
  const fm = useFileManager();
  return (
    <IconButton
      label={mode === "reveal" ? fm.revealLabel : fm.showLabel}
      size={size}
      tabIndex={tabIndex}
      className={className}
      onClick={() => (mode === "reveal" ? fm.reveal([path]) : fm.open(path))}
    >
      {mode === "reveal" ? <FolderSearch /> : <FolderOpen />}
    </IconButton>
  );
}
