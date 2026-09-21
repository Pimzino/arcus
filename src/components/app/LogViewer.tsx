import { useQuery } from "@tanstack/react-query";
import { Copy, FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { copyToClipboard } from "../../lib/native";
import { api } from "../../lib/tauri";
import { logRetentionDays, missingLogMessage } from "../../lib/transferLog";
import { useAppStore } from "../../store/app";
import { Button, Dialog, ErrorMessage, Spinner, cn } from "../ui";
import { useFileManager } from "./FileManager";

/** Shows the tail of a log file; `path === "daemon"` shows the main daemon log. */
export function LogViewerDialog({
  open,
  onClose,
  title,
  path,
  live,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  path: string;
  live?: boolean;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const fm = useFileManager();
  const settings = useAppStore((s) => s.settings);
  const log = useQuery({
    queryKey: ["logTail", path],
    enabled: open,
    refetchInterval: live ? 2000 : false,
    queryFn: () => (path === "daemon" ? api.daemonLogTail(800) : api.logTail(path, 800)),
  });

  useEffect(() => {
    if (live && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [log.data, live]);

  // `null` means the file does not exist; while the job is still live it may just not have been created yet.
  const missing = log.data === null && !live;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={path === "daemon" ? "Main rclone daemon log" : path}
      size="xl"
      bodyClassName="flex flex-col gap-3"
      footer={
        <Button variant="default" onClick={onClose}>
          Close
        </Button>
      }
    >
      {log.error && <ErrorMessage error={log.error} />}
      <div className="flex items-center gap-1.5">
        {path !== "daemon" && (
          <Button variant="outline" size="xs" icon={<FolderOpen />} onClick={() => fm.reveal([path])}>
            Reveal file
          </Button>
        )}
        <Button variant="outline" size="xs" icon={<Copy />} onClick={() => copyToClipboard(log.data ?? "")}>
          Copy
        </Button>
        <Button variant="outline" size="xs" icon={<RefreshCw className={cn(log.isFetching && "animate-spin")} />} onClick={() => log.refetch()}>
          Refresh
        </Button>
      </div>
      {/* The terminal block runs to the dialog's edges: the body's own padding is cancelled here. */}
      <pre
        ref={preRef}
        className="selectable -mx-6 -mb-4 h-[60vh] overflow-auto overscroll-none whitespace-pre-wrap break-words bg-terminal px-6 py-4 font-mono text-xs leading-5 text-terminal-fg"
      >
        {log.isLoading ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Spinner /> Loading…
          </span>
        ) : missing ? (
          <span className="text-muted-foreground">{missingLogMessage(logRetentionDays(settings))}</span>
        ) : (
          log.data || "(empty)"
        )}
      </pre>
    </Dialog>
  );
}
