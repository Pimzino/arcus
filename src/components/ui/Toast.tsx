import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { create } from "zustand";
import { Button } from "./Button";
import { cn } from "./cn";

export type ToastTone = "neutral" | "success" | "warning" | "danger" | "info";

export type ToastOptions = {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  duration?: number;
  action?: { label: string; onClick: () => void };
};

type ToastEntry = ToastOptions & { id: number };

type ToastStore = {
  toasts: ToastEntry[];
  add: (t: ToastOptions) => number;
  remove: (id: number) => void;
};

let nextId = 1;
export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  add(t) {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
    return id;
  },
  remove(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Show a toast from anywhere (stores, event handlers). */
export function toast(options: ToastOptions) {
  return useToastStore.getState().add(options);
}

const icons: Record<ToastTone, ReactNode> = {
  neutral: <Info className="size-4 text-muted-foreground" />,
  info: <Info className="size-4 text-primary" />,
  success: <CircleCheck className="size-4 text-success" />,
  warning: <TriangleAlert className="size-4 text-warning" />,
  danger: <CircleX className="size-4 text-destructive" />,
};

function ToastItem({ entry }: { entry: ToastEntry }) {
  const remove = useToastStore((s) => s.remove);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const duration = entry.duration ?? (entry.tone === "danger" ? 9000 : 5000);

  const arm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => remove(entry.id), duration);
  };
  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
  };

  useEffect(() => {
    arm();
    return disarm;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex w-[356px] items-start gap-3 rounded-lg border bg-popover p-4 text-sm text-popover-foreground shadow-lg animate-slide-up",
      )}
      onMouseEnter={disarm}
      onMouseLeave={arm}
    >
      <span className="mt-0.5 shrink-0">{icons[entry.tone ?? "neutral"]}</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{entry.title}</div>
        {entry.description && <div className="mt-0.5 line-clamp-2 break-all text-muted-foreground">{entry.description}</div>}
        {entry.action && (
          <Button
            size="xs"
            variant="outline"
            className="mt-2"
            onClick={() => {
              entry.action?.onClick();
              remove(entry.id);
            }}
          >
            {entry.action.label}
          </Button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        className="no-ring -mr-1.5 -mt-1.5 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => remove(entry.id)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-4 bottom-[calc(var(--statusbar-height)+1rem)] z-[65] flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} entry={t} />
      ))}
    </div>
  );
}
