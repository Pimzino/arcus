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
    <header {...dragRegion()} className={cn("shrink-0 border-b px-6 py-4", className)}>
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-base text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-4">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </header>
  );
}

export function PageBody({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-none", padded && "px-6 py-6", className)}>{children}</div>;
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex items-center gap-1", className)}>{children}</div>;
}

export function ToolbarSeparator() {
  return <span className="mx-1 h-4 w-px bg-border" aria-hidden />;
}
