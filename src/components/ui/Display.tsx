import { CircleCheck, CircleX, Info, Loader2, TriangleAlert } from "lucide-react";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { errorMessage } from "../../lib/types";
import { Button } from "./Button";
import { cn } from "./cn";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

/* Each tone sets its own border colour: `cn` only concatenates, and a border-transparent in
   the shared part would win over the outline tone's border-border. */
const badgeTones: Record<Tone, string> = {
  neutral: "border-border text-foreground",
  accent: "border-transparent bg-primary text-primary-foreground",
  info: "border-transparent bg-primary text-primary-foreground",
  success: "border-transparent bg-success/10 text-success",
  warning: "border-transparent bg-warning/10 text-warning",
  danger: "border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20",
};

/** Pill tag for categories, attributes and counts (not for status; see StatusBadge). */
export function Badge({
  tone = "neutral",
  children,
  className,
  size = "md",
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-4xl border font-medium whitespace-nowrap [&>svg]:size-3",
        size === "sm" ? "h-4 px-1.5 text-xs" : "h-5 px-2 py-0.5 text-xs",
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const dotTones: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  accent: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-primary",
};

export function StatusDot({ tone = "neutral", pulse, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", dotTones[tone], pulse && "animate-pulse", className)} />;
}

const statusText: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  accent: "text-foreground",
  success: "text-foreground",
  warning: "text-warning",
  danger: "text-destructive",
  info: "text-foreground",
};

/** Status as a coloured dot followed by text; no background. */
export function StatusBadge({ tone = "neutral", pulse, children, className }: { tone?: Tone; pulse?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs font-medium", statusText[tone], className)}>
      <StatusDot tone={tone} pulse={pulse} />
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 role="status" aria-label="Loading" className={cn("size-4 animate-spin text-muted-foreground", className)} />;
}

const barTones: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  accent: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-primary",
};

const trackTones: Record<Tone, string> = {
  neutral: "bg-muted",
  accent: "bg-primary/20",
  success: "bg-success/20",
  warning: "bg-warning/20",
  danger: "bg-destructive/20",
  info: "bg-primary/20",
};

export function ProgressBar({
  value,
  indeterminate,
  tone = "accent",
  size = "md",
  className,
}: {
  value: number;
  indeterminate?: boolean;
  tone?: Tone;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
      className={cn("relative w-full overflow-hidden rounded-full", trackTones[tone], size === "sm" ? "h-1.5" : "h-2", className)}
    >
      {indeterminate ? (
        <div className={cn("absolute inset-y-0 w-2/5 rounded-full animate-indeterminate", barTones[tone])} />
      ) : (
        <div
          className={cn("h-full rounded-full transition-all duration-300 ease-out", barTones[tone])}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      )}
    </div>
  );
}

/** Dashed panel for "there is nothing here yet". */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full w-full min-w-0 flex-1 flex-col items-center justify-center rounded-xl border border-dashed text-center text-balance",
        compact ? "gap-3 p-4" : "gap-4 p-6",
        className,
      )}
    >
      {icon && (
        <div className="mb-2 flex size-8 items-center justify-center rounded-lg bg-muted text-foreground [&_svg]:size-4">{icon}</div>
      )}
      <div className="flex max-w-sm flex-col items-center gap-2">
        <div className="text-sm font-medium tracking-tight">{title}</div>
        {description && <div className="text-sm/relaxed text-muted-foreground">{description}</div>}
      </div>
      {action && <div className="flex flex-col items-center gap-2.5">{action}</div>}
    </div>
  );
}

/* The alert recipe: a tinted box, foreground text and a tone-coloured icon. The tone is never
   the text colour except for destructive, which stays legible on both themes. */
const calloutTones: Record<Exclude<Tone, "accent">, { box: string; icon: ReactNode }> = {
  neutral: { box: "border-border bg-card text-card-foreground", icon: <Info className="text-muted-foreground" /> },
  info: { box: "border-primary/30 bg-primary/10 text-foreground", icon: <Info className="text-primary" /> },
  success: { box: "border-success/30 bg-success/10 text-foreground", icon: <CircleCheck className="text-success" /> },
  warning: { box: "border-warning/30 bg-warning/10 text-foreground", icon: <TriangleAlert className="text-warning" /> },
  danger: { box: "border-destructive/30 bg-destructive/10 text-destructive dark:bg-destructive/20", icon: <CircleX /> },
};

export function Callout({
  tone = "neutral",
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof calloutTones;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const t = calloutTones[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={cn(
        "grid w-full items-start gap-x-3 gap-y-0.5 rounded-lg border px-4 py-3 text-sm",
        action ? "grid-cols-[calc(var(--spacing)*4)_1fr_auto]" : "grid-cols-[calc(var(--spacing)*4)_1fr]",
        "[&>svg]:size-4 [&>svg]:translate-y-0.5",
        t.box,
        className,
      )}
    >
      {t.icon}
      {title && <div className="col-start-2 font-medium tracking-tight">{title}</div>}
      {children && <div className="selectable col-start-2 min-w-0 break-words">{children}</div>}
      {action && <div className="col-start-3 row-start-1 row-span-2 shrink-0 self-start">{action}</div>}
    </div>
  );
}

/** Inline error from a thrown value; renders nothing when there is no error. */
export function ErrorMessage({ error, onDismiss, className }: { error: unknown; onDismiss?: () => void; className?: string }) {
  if (!error) return null;
  const message = typeof error === "string" ? error : errorMessage(error);
  return (
    <Callout
      tone="danger"
      className={className}
      action={
        onDismiss && (
          <Button variant="ghost" size="xs" onClick={onDismiss}>
            Dismiss
          </Button>
        )
      }
    >
      {message}
    </Callout>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} style={style} />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm bg-muted px-1 font-sans text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** A labelled number in its own tile; `size="lg"` is the big dashboard figure. */
export function Stat({
  label,
  value,
  hint,
  tone,
  size = "default",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  size?: "default" | "lg";
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-lg border bg-card p-4", className)}>
      <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{label}</div>
      <div
        className={cn(
          "tnum mt-2 truncate",
          size === "lg" ? "text-4xl font-bold" : "text-base font-semibold",
          tone === "danger" && "text-destructive",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </div>
      {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Segmented control used as a tab bar. */
export function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: { id: string; label: ReactNode; count?: number }[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn("inline-flex h-8 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground", className)}
    >
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            data-state={isActive ? "active" : "inactive"}
            onClick={() => onChange(t.id)}
            className={cn(
              "no-ring inline-flex h-[calc(100%-1px)] items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-colors",
              "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
              "dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30",
            )}
          >
            {t.label}
            {t.count !== undefined && <span className="tnum text-xs font-normal text-muted-foreground">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  footer,
  padded = true,
  children,
  className,
  bodyClassName,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, "title" | "children"> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** `false` lets the body reach the card's edges (flush tables and listings). */
  padded?: boolean;
  children?: ReactNode;
  bodyClassName?: string;
}) {
  const hasHeader = !!(title || actions);
  /* The card owns the vertical padding, the body the horizontal one, so an unpadded body keeps
     only the inset its header needs. `cn` concatenates: each case is a separate branch. */
  const cardPadding = padded ? (footer ? "pt-4" : "py-4") : hasHeader ? "pt-4" : undefined;
  return (
    <section
      className={cn("flex flex-col gap-4 rounded-xl bg-card text-sm text-card-foreground ring-1 ring-foreground/10", cardPadding, className)}
      {...rest}
    >
      {hasHeader && (
        <header className={cn("grid items-start gap-1 px-4", actions && "grid-cols-[1fr_auto]")}>
          <div className="min-w-0">
            <h2 className="text-base leading-snug font-medium">{title}</h2>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(padded && "px-4", bodyClassName)}>{children}</div>
      {footer && <footer className="flex items-center border-t bg-muted/50 p-4">{footer}</footer>}
    </section>
  );
}

/** A settings-style row: title + description on the left, control on the right. */
export function SettingRow({
  title,
  description,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-6 border-t py-3 first:border-t-0", className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function KeyValue({ items, className }: { items: { label: ReactNode; value: ReactNode; mono?: boolean }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1.5 text-sm", className)}>
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{it.label}</dt>
          <dd className={cn("selectable min-w-0 break-all", it.mono !== false && "font-mono")}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
