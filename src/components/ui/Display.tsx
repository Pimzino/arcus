import { CircleCheck, CircleX, Info, Loader2, TriangleAlert } from "lucide-react";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { errorMessage } from "../../lib/types";
import { Button } from "./Button";
import { cn } from "./cn";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

/* Each tone sets its own border colour: `cn` only concatenates, and a border-transparent in
   the shared part would win over the outline tone's border-border. */
const badgeTones: Record<Tone, string> = {
  neutral: "border-border text-muted-foreground",
  accent: "border-transparent bg-primary/12 text-primary-ink",
  info: "border-transparent bg-primary/12 text-primary-ink",
  success: "border-transparent bg-success/12 text-success",
  warning: "border-transparent bg-warning/12 text-warning",
  danger: "border-transparent bg-destructive/12 text-destructive",
};

/** Small tag for categories and attributes (not for status; see StatusBadge). */
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
        "inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-sm border text-xs font-medium whitespace-nowrap [&>svg]:size-3",
        size === "sm" ? "h-4 px-1" : "h-5 px-1.5",
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const dotTones: Record<Tone, string> = {
  neutral: "bg-faint-foreground",
  accent: "bg-primary-ink",
  success: "bg-success",
  warning: "bg-signal",
  danger: "bg-destructive",
  info: "bg-primary-ink",
};

/** `pulse` is for something happening right now (a run, rclone starting), never for decoration. */
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

/* A transfer under way fills with the arch's stones; an outcome fills with its status colour. */
const spanFills: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  accent: "span-stones",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "span-stones",
};

/** How work that stopped short is drawn: `broken` (it failed) keeps the stones it laid in grey and marks the one
 *  it broke on; `drained` (it was stopped, or lost) only keeps them in grey. */
export type Ended = "broken" | "drained";

/** The stone (0 to 4) the work was on when it had got to `value` percent. */
export const lastStone = (value: number) => Math.min(4, Math.max(0, Math.ceil(value / 20) - 1));

const spanSizes = { sm: "h-1.5", md: "h-2", lg: "h-2.5" };

/** Progress as a span of five stones (.span in index.css). The fill is clipped, not resized: no layout runs as it grows. */
export function ProgressBar({
  value,
  indeterminate,
  tone = "accent",
  ended,
  size = "md",
  className,
}: {
  value: number;
  indeterminate?: boolean;
  tone?: Tone;
  ended?: Ended;
  size?: keyof typeof spanSizes;
  className?: string;
}) {
  const broke = lastStone(value) * 20;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
      data-ended={ended}
      className={cn("span relative w-full overflow-hidden", spanSizes[size], className)}
    >
      {indeterminate ? (
        <div className={cn("absolute inset-y-0 w-2/5 animate-indeterminate", spanFills[tone])} />
      ) : (
        <div
          className={cn("absolute inset-0 transition-[clip-path] duration-300", ended ? "span-drained" : spanFills[tone])}
          style={{
            clipPath: `inset(0 ${100 - Math.min(100, Math.max(0, value))}% 0 0)`,
            ...(ended === "broken" && { backgroundImage: `linear-gradient(90deg, transparent ${broke}%, var(--destructive) 0 ${broke + 20}%, transparent 0)` }),
          }}
        />
      )}
    </div>
  );
}

/** "There is nothing here yet": a quiet icon (or `art`, a drawing at its own size), what is missing, and the one
 *  thing to do about it. */
export function EmptyState({
  icon,
  art,
  title,
  description,
  action,
  compact,
  className,
}: {
  icon?: ReactNode;
  art?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full w-full min-w-0 flex-1 flex-col items-center justify-center text-center text-balance",
        compact ? "gap-3 p-4" : "gap-4 p-8",
        className,
      )}
    >
      {art}
      {icon && <div className="flex size-5 items-center justify-center text-faint-foreground [&_svg]:size-5">{icon}</div>}
      <div className={cn("flex flex-col items-center", art ? "max-w-md gap-2" : "max-w-sm gap-1")}>
        <div className={art ? "font-display text-xl leading-7 font-semibold tracking-tight" : "text-sm font-medium"}>{title}</div>
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
      </div>
      {action && <div className="flex flex-col items-center gap-2">{action}</div>}
    </div>
  );
}

/* A hairlined box, foreground text and a tone-coloured icon. The tone is never the text colour except
   for destructive, which stays legible on both themes. */
const calloutTones: Record<Exclude<Tone, "accent">, { box: string; icon: ReactNode }> = {
  neutral: { box: "border-border bg-card text-card-foreground", icon: <Info className="text-muted-foreground" /> },
  info: { box: "border-border bg-muted/60 text-foreground", icon: <Info className="text-primary-ink" /> },
  success: { box: "border-success/25 bg-success/8 text-foreground", icon: <CircleCheck className="text-success" /> },
  warning: { box: "border-warning/30 bg-warning/8 text-foreground", icon: <TriangleAlert className="text-warning" /> },
  danger: { box: "border-destructive/30 bg-destructive/8 text-destructive", icon: <CircleX /> },
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
        "[&>svg]:mt-0.5 [&>svg]:size-4",
        t.box,
        className,
      )}
    >
      {t.icon}
      {title && <div className="col-start-2 font-medium">{title}</div>}
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

/** A key of the keyboard, as a small keycap. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-b-2 bg-card px-1 font-sans text-xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** The name of a group of things, above them: quiet, sentence case. */
export function GroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("text-xs font-medium text-muted-foreground", className)}>{children}</div>;
}

/** A row or grid of figures in one hairlined band; give it the grid's columns and put `Stat`s in it. */
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid gap-px overflow-hidden rounded-xl bg-border shadow-card ring-1 ring-border", className)}>{children}</div>;
}

/** A labelled figure, a cell of a `StatStrip`. */
export function Stat({ label, value, hint, tone, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: Tone; className?: string }) {
  return (
    <div className={cn("min-w-0 bg-card px-4 py-3", className)}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("tnum mt-1 truncate text-lg font-medium", tone === "danger" && "text-destructive", tone === "success" && "text-success")}>{value}</div>
      {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/* A set of choices on a muted track; the chosen one is a raised surface with a hairline. Shared by Tabs and
   Segmented (Input.tsx), which set the height and text size. */
export const segmentTrack = "inline-flex w-fit items-center rounded-lg bg-muted p-0.5 text-muted-foreground";
export const segmentItem =
  "no-ring inline-flex h-full items-center justify-center gap-1.5 rounded-md border border-transparent px-2 font-medium whitespace-nowrap transition-colors " +
  "hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 " +
  "data-[state=active]:border-border data-[state=active]:bg-raised data-[state=active]:text-foreground";

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
    <div role="tablist" className={cn(segmentTrack, "h-8", className)}>
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
            className={cn(segmentItem, "text-sm")}
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
    <section data-card className={cn("flex flex-col gap-4 rounded-xl bg-card text-sm text-card-foreground shadow-card ring-1 ring-border", cardPadding, className)} {...rest}>
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
    <dl className={cn("grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm", className)}>
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{it.label}</dt>
          <dd className={cn("selectable min-w-0 break-all", it.mono !== false && "font-mono")}>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
