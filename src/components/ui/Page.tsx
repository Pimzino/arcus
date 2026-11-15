import type { ReactNode } from "react";
import { dragRegion } from "../../lib/native";
import { cn } from "./cn";

export function PageHeader({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Optional second row (filters, tabs, search). */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header {...dragRegion()} className={cn("shrink-0 border-b px-8 pt-6 pb-5", className)}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-[28px] leading-9 font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-5">{children}</div>}
    </header>
  );
}

/** The page's scroller. Its scrollbar's room is kept whether or not it scrolls, so a scrollbar coming or going (a
 *  classic one, where the system shows those) never moves what is on the page. */
export function PageBody({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-none [scrollbar-gutter:stable]", padded && "px-8 py-7", className)}>{children}</div>;
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex items-center gap-1", className)}>{children}</div>;
}

export function ToolbarSeparator() {
  return <span className="mx-1 h-4 w-px bg-border" aria-hidden />;
}
