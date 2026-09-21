import type { ReactNode } from "react";
import { cn } from "./cn";

/** Label + control + help/error. `layout="row"` puts the label on the left (settings style). */
export function Field({
  label,
  description,
  help,
  error,
  required,
  htmlFor,
  layout = "stack",
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  layout?: "stack" | "row";
  children: ReactNode;
  className?: string;
}) {
  const labelNode = (
    <label htmlFor={htmlFor} className="block text-sm font-semibold">
      {label}
      {required && <span className="ml-0.5 text-destructive">*</span>}
    </label>
  );
  if (layout === "row") {
    return (
      <div className={cn("grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-start gap-6 py-3", className)}>
        <div className="min-w-0 pt-1.5">
          {labelNode}
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        <div className="min-w-0">
          {children}
          {help && <p className="mt-1 text-sm text-muted-foreground">{help}</p>}
          {error && <p className="mt-1 text-sm text-destructive">{error}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="grid gap-0.5">
        {labelNode}
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
      {help && <p className="whitespace-pre-line text-sm text-muted-foreground">{help}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
