import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Two columns of fields on one grid. Each row of the grid holds a pair of fields, and their labels,
 * controls and messages share three sub-rows (CSS subgrid), so the two controls stay level however long
 * either description is. Put `Field`s with `layout="grid"` in it (`className="col-span-2"` for a wide one);
 * checkboxes go in a `ChoiceGrid` of their own, since they have no control row to line up.
 */
export function FormGrid({ children, className }: { children: ReactNode; className?: string }) {
  // The row gap is the space from label to control and control to message; each field's message row adds
  // the same again below itself, which spaces the pairs. The last one's is taken back off the grid.
  return <div className={cn("-mb-2 grid grid-cols-2 gap-x-6 gap-y-2", className)}>{children}</div>;
}

/** Checkboxes (or switches with their text) in two columns; each row starts level. */
export function ChoiceGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 items-start gap-x-6 gap-y-3", className)}>{children}</div>;
}

/**
 * Label + control + help/error. `layout="row"` puts the label on the left (settings style); `layout="grid"`
 * is a cell of a `FormGrid`. `field` names it for code that brings a field with an error into view
 * (`data-field`).
 */
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
  field,
}: {
  label: ReactNode;
  description?: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  layout?: "stack" | "row" | "grid";
  children: ReactNode;
  className?: string;
  field?: string;
}) {
  const labelNode = (
    <label htmlFor={htmlFor} className="block text-sm font-semibold">
      {label}
      {required && <span className="ml-0.5 text-destructive">*</span>}
    </label>
  );
  if (layout === "grid") {
    return (
      <div data-field={field} className={cn("row-span-3 grid min-w-0 grid-rows-subgrid", className)}>
        <div className="grid content-start gap-0.5">
          {labelNode}
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        <div className="min-w-0">{children}</div>
        <div className="pb-2">
          {help && <div className="whitespace-pre-line text-sm text-muted-foreground">{help}</div>}
          {error && <p className={cn("text-sm text-destructive", help && "mt-1")}>{error}</p>}
        </div>
      </div>
    );
  }
  if (layout === "row") {
    return (
      <div data-field={field} className={cn("grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-start gap-6 py-3", className)}>
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
    <div data-field={field} className={cn("flex flex-col gap-2", className)}>
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
