import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ChevronUp, Play, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, ErrorMessage, IconButton, Input, PageHeader, Segmented, Textarea, cn } from "../components/ui";
import { rc } from "../lib/rc";
import { api } from "../lib/tauri";
import { errorMessage } from "../lib/types";
import { useDaemonRunning } from "../store/app";

/** Split a command line into arguments, honouring single and double quotes. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let pending = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      pending = true;
    } else if (/\s/.test(ch)) {
      if (current || pending) {
        out.push(current);
        current = "";
        pending = false;
      }
    } else {
      current += ch;
    }
  }
  if (current || pending) out.push(current);
  return out;
}

const EXAMPLES = ["version", "listremotes --long", "lsd remote:", "about remote:", "config show", "ls remote:path --max-depth 1", "size remote:path"];

type Line = { id: number; kind: "cmd" | "out" | "err"; text: string };
let lineId = 0;

export function ConsolePage() {
  const running = useDaemonRunning();
  const [tab, setTab] = useState<"command" | "rc">("command");
  const [lines, setLines] = useState<Line[]>([]);
  const [example, setExample] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const push = (kind: Line["kind"], text: string) => setLines((l) => [...l, { id: ++lineId, kind, text }]);
  const appendToLast = (text: string) =>
    setLines((l) => {
      const last = l[l.length - 1];
      if (last && last.kind === "out") return [...l.slice(0, -1), { ...last, text: last.text + text }];
      return [...l, { id: ++lineId, kind: "out", text }];
    });
  // rclone terminates a streamed core/command response with its (empty) JSON result.
  const trimTail = () =>
    setLines((l) => {
      const last = l[l.length - 1];
      if (last && last.kind === "out") return [...l.slice(0, -1), { ...last, text: last.text.replace(/\s*\{\}\s*$/, "") }];
      return l;
    });

  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <>
      <PageHeader
        title="Console"
        description="Run any rclone command through the daemon, or call the rc API directly."
        actions={
          <Segmented
            options={[
              { value: "command", label: "rclone command" },
              { value: "rc", label: "rc API" },
            ]}
            value={tab}
            onChange={setTab}
          />
        }
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={outputRef} className="selectable min-h-0 flex-1 overflow-auto overscroll-none border-b bg-terminal px-6 py-4 font-mono text-xs leading-5 text-terminal-fg">
          {lines.length === 0 && (
            <div className="text-muted-foreground">Output appears here. Commands run with the daemon's rclone binary and config file; long-running commands stream as they go.</div>
          )}
          {lines.map((l) => (
            <div key={l.id} className={cn("whitespace-pre-wrap break-words", l.kind === "cmd" && "mt-3 text-primary first:mt-0", l.kind === "err" && "text-destructive")}>
              {l.kind === "cmd" ? `> ${l.text}` : l.text}
            </div>
          ))}
        </div>
        <div className="shrink-0 px-6 py-4">
          {tab === "command" ? (
            <CommandForm
              disabled={!running}
              example={example}
              onCommand={(c) => push("cmd", `rclone ${c}`)}
              onChunk={appendToLast}
              onDone={trimTail}
              onError={(e) => push("err", e)}
            />
          ) : (
            <RcForm disabled={!running} onCall={(m, p) => push("cmd", `rc ${m} ${p}`)} onResult={(r) => push("out", r)} onError={(e) => push("err", e)} />
          )}
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {tab === "command" &&
                EXAMPLES.map((ex) => (
                  <Button key={ex} size="xs" variant="outline" className="font-mono" onClick={() => setExample(`${ex}​${Date.now()}`)}>
                    {ex}
                  </Button>
                ))}
            </div>
            <IconButton label="Clear output" size="sm" onClick={() => setLines([])}>
              <Trash2 />
            </IconButton>
          </div>
        </div>
      </div>
    </>
  );
}

function CommandForm({
  disabled,
  example,
  onCommand,
  onChunk,
  onDone,
  onError,
}: {
  disabled: boolean;
  /** Example text to load into the input (suffix after the zero-width space makes each click unique). */
  example: string | null;
  onCommand: (line: string) => void;
  onChunk: (chunk: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const history = useRef<string[]>([]);
  const cursor = useRef(-1);

  useEffect(() => {
    if (example) setLine(example.split("​")[0]);
  }, [example]);

  const run = async () => {
    const tokens = tokenize(line);
    if (tokens.length === 0) return;
    const [command, ...args] = tokens;
    history.current = [line, ...history.current.filter((h) => h !== line)].slice(0, 50);
    cursor.current = -1;
    setBusy(true);
    onCommand(line.trim());
    setLine("");
    try {
      await rc.commandStream(command, args, {}, onChunk);
      onDone();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-mono text-sm text-muted-foreground">rclone</span>
      <Input
        mono
        className="flex-1"
        value={line}
        disabled={disabled}
        placeholder={disabled ? "rclone is not running" : "lsd remote:   ·   copy src: dst: --dry-run   ·   any rclone command"}
        onChange={(e) => setLine(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !busy) void run();
          if (e.key === "ArrowUp") {
            e.preventDefault();
            cursor.current = Math.min(history.current.length - 1, cursor.current + 1);
            setLine(history.current[cursor.current] ?? line);
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            cursor.current = Math.max(-1, cursor.current - 1);
            setLine(cursor.current === -1 ? "" : (history.current[cursor.current] ?? ""));
          }
        }}
      />
      <Button variant="default" icon={<Play />} loading={busy} disabled={disabled} onClick={run}>
        Run
      </Button>
    </div>
  );
}

function RcForm({
  disabled,
  onCall,
  onResult,
  onError,
}: {
  disabled: boolean;
  onCall: (method: string, params: string) => void;
  onResult: (text: string) => void;
  onError: (message: string) => void;
}) {
  const running = useDaemonRunning();
  const commands = useQuery({ queryKey: ["rcList"], enabled: running, staleTime: Infinity, queryFn: () => rc.rcList() });
  const [method, setMethod] = useState("core/version");
  const [params, setParams] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const help = useMemo(() => commands.data?.find((c) => c.Path === method), [commands.data, method]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const parsed = params.trim() ? JSON.parse(params) : {};
      onCall(method, JSON.stringify(parsed));
      const result = await api.rc(method, parsed);
      onResult(JSON.stringify(result, null, 2));
    } catch (e) {
      setError(errorMessage(e));
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-start gap-2">
        <div>
          <Input mono list="rc-methods" value={method} disabled={disabled} onChange={(e) => setMethod(e.target.value)} />
          <datalist id="rc-methods">
            {commands.data?.map((c) => (
              <option key={c.Path} value={c.Path}>
                {c.Title}
              </option>
            ))}
          </datalist>
        </div>
        <Textarea mono rows={2} value={params} disabled={disabled} onChange={(e) => setParams(e.target.value)} placeholder='{"fs": "remote:", "remote": ""}' />
        <Button variant="default" icon={<Play />} loading={busy} disabled={disabled} onClick={run}>
          Call
        </Button>
      </div>
      {help && (
        <Card
          title={help.Title}
          actions={
            <Button variant="ghost" size="sm" icon={showHelp ? <ChevronUp /> : <ChevronDown />} onClick={() => setShowHelp(!showHelp)}>
              {showHelp ? "Hide" : "Help"}
            </Button>
          }
          bodyClassName={showHelp ? undefined : "hidden"}
        >
          <pre className="selectable max-h-40 overflow-auto mac:overscroll-none whitespace-pre-wrap font-mono text-xs text-muted-foreground">{help.Help}</pre>
        </Card>
      )}
      {error && <ErrorMessage error={error} onDismiss={() => setError(null)} />}
    </div>
  );
}
