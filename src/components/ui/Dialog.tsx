import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { cn } from "./cn";
import { IconButton } from "./IconButton";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export type DialogSize = "sm" | "md" | "lg" | "xl";

const sizes: Record<DialogSize, string> = {
  sm: "max-w-[420px]",
  md: "max-w-[600px]",
  lg: "max-w-[820px]",
  xl: "max-w-[1040px]",
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  initialFocusRef,
  bodyClassName,
  bodyPadded = true,
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
  initialFocusRef?: RefObject<HTMLElement | null>;
  bodyClassName?: string;
  /** `false` lets the body reach the dialog's edges (listings, browsers, terminals). */
  bodyPadded?: boolean;
  closeOnBackdrop?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);
  /* The open effect must run once per open, never on a re-render. It depends on `open` alone
     and reads whatever else it needs from here, so that a dialog whose body updates while it
     is open (a running job's statistics) cannot move focus away and back on every tick. */
  const latest = useRef({ onClose, initialFocusRef });
  useEffect(() => {
    latest.current = { onClose, initialFocusRef };
  });

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    previouslyFocused.current = document.activeElement;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        latest.current.onClose();
        return;
      }
      if (e.key === "Tab" && panel) {
        const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        /* The panel itself holds focus when there is nothing to type in, and it is not in the
           tab order, so Tab from there has to be sent into the dialog rather than out of it. */
        const from = document.activeElement;
        if (e.shiftKey && (from === first || from === panel)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (from === last || from === panel)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);

    /* Never the close button: focusing it would open its tooltip with the pointer nowhere near. */
    const target =
      latest.current.initialFocusRef?.current ??
      panel?.querySelector<HTMLElement>("[data-autofocus]") ??
      panel?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select') ??
      panel;
    target?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 animate-fade-in"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        /* Focused on open when the dialog has nothing to type in, so it takes no focus ring. */
        tabIndex={-1}
        className={cn(
          "no-ring flex max-h-full w-full flex-col overflow-hidden rounded-xl border bg-background text-sm shadow-lg outline-none animate-scale-in",
          sizes[size],
        )}
      >
        <header className="flex items-start gap-4 px-6 pt-6 pb-4">
          <div className="grid min-w-0 flex-1 gap-1">
            <h2 className="text-lg leading-none font-semibold">{title}</h2>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          <IconButton label="Close" size="sm" onClick={onClose} className="-mr-2 -mt-1">
            <X />
          </IconButton>
        </header>
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-none",
            /* `cn` concatenates, so the padded and flush cases are exclusive branches. */
            bodyPadded && (footer ? "px-6 pb-4" : "px-6 pb-6"),
            bodyClassName,
          )}
        >
          {children}
        </div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t bg-muted/50 px-6 py-4">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  loading,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant={danger ? "destructive" : "default"} onClick={onConfirm} loading={loading} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-muted-foreground">{message}</div>
    </Dialog>
  );
}
