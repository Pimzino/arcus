import { Check, ChevronDown, Search, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

/** Shared look of every text control. Height and padding are set by each control:
    `cn` only concatenates, so two utilities for the same property must never both apply. */
export const controlBase =
  "no-ring min-w-0 rounded-lg border border-input bg-transparent text-sm transition-colors outline-none " +
  "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 " +
  "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 " +
  "aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-3 aria-[invalid=true]:ring-destructive/20 " +
  "dark:bg-input/30 dark:aria-[invalid=true]:border-destructive/50";

const hasWidth = (className?: string) => /(^|\s)(w-|flex-1|grow|basis-)/.test(className ?? "");

export type InputProps = ComponentProps<"input"> & {
  invalid?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  mono?: boolean;
  sizeVariant?: "sm" | "md";
};

export function Input({ className, invalid, leading, trailing, mono, sizeVariant = "md", ...rest }: InputProps) {
  const adorned = !!leading || !!trailing;
  /* The caller's className styles the outer element — the wrapper when an adornment creates one,
     the input itself otherwise — and gives it its width unless it already sets one. */
  const outer = cn(!hasWidth(className) && "w-full", className);
  const input = (
    <input
      aria-invalid={invalid || undefined}
      className={cn(
        controlBase,
        sizeVariant === "sm" ? "h-7" : "h-8",
        /* One padding class per side per state: `cn` concatenates, it cannot override. */
        "py-1",
        leading ? "pl-8" : "pl-2.5",
        trailing ? "pr-8" : "pr-2.5",
        mono && "font-mono",
        adorned ? "w-full" : outer,
      )}
      spellCheck={mono ? false : rest.spellCheck}
      {...rest}
    />
  );
  if (!adorned) return input;
  return (
    <div className={cn("relative", outer)}>
      {leading && (
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground [&_svg]:size-4">
          {leading}
        </span>
      )}
      {input}
      {trailing && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground [&_svg]:size-4">{trailing}</span>
      )}
    </div>
  );
}

/** Search box with its own clear button; the Search icon puts the input inside a wrapper, so the
    class that hides WebKit's native cancel button reaches the input as a descendant. */
export function SearchInput({
  value,
  onValueChange,
  className,
  ...rest
}: Omit<InputProps, "value" | "onChange"> & { value: string; onValueChange: (value: string) => void }) {
  return (
    <Input
      type="search"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      leading={<Search />}
      trailing={
        value ? (
          <button
            type="button"
            aria-label="Clear search"
            className="no-ring rounded-md p-0.5 hover:bg-muted hover:text-foreground"
            onClick={() => onValueChange("")}
          >
            <X className="size-3.5" />
          </button>
        ) : undefined
      }
      className={cn("[&_input::-webkit-search-cancel-button]:hidden", className)}
      {...rest}
    />
  );
}

export function Textarea({
  className,
  mono,
  invalid,
  ...rest
}: ComponentProps<"textarea"> & { mono?: boolean; invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(
        controlBase,
        "min-h-16 px-2.5 py-2 mac:overscroll-none",
        mono && "font-mono",
        !hasWidth(className) && "w-full",
        className,
      )}
      spellCheck={mono ? false : rest.spellCheck}
      {...rest}
    />
  );
}

export type SelectOption = { value: string; label: string; disabled?: boolean };

export function Select({
  className,
  options,
  children,
  invalid,
  sizeVariant = "md",
  ...rest
}: ComponentProps<"select"> & { options?: SelectOption[]; invalid?: boolean; sizeVariant?: "sm" | "md" }) {
  return (
    <div className={cn("relative", !hasWidth(className) ? "w-full" : className)}>
      <select
        aria-invalid={invalid || undefined}
        className={cn(
          controlBase,
          sizeVariant === "sm" ? "h-7" : "h-8",
          "w-full cursor-default appearance-none py-1 pr-7 pl-2.5",
          "dark:hover:bg-input/50",
        )}
        {...rest}
      >
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

export function Checkbox({
  label,
  description,
  checked,
  onChange,
  disabled,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label className={cn("group flex cursor-default items-start gap-2.5", disabled && "cursor-not-allowed opacity-50", className)}>
      <span className="relative mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          className="peer no-ring absolute inset-0 size-full cursor-pointer appearance-none rounded-[4px] border border-input bg-transparent transition-colors checked:border-primary checked:bg-primary focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:checked:bg-primary"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <Check className="pointer-events-none relative size-3.5 text-primary-foreground opacity-0 peer-checked:opacity-100" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm leading-tight">{label}</span>
        {description && <span className="block text-sm text-muted-foreground">{description}</span>}
      </span>
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  description,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "no-ring inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent px-px transition-colors",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        checked ? "bg-primary" : "bg-input dark:bg-input/80",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background transition-transform dark:bg-foreground",
          checked ? "translate-x-[14px] dark:bg-primary-foreground" : "translate-x-0",
        )}
      />
    </button>
  );
  if (!label) return control;
  return (
    <div className={cn("flex items-center justify-between gap-4", className)}>
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {description && <span className="block text-sm text-muted-foreground">{description}</span>}
      </span>
      {control}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className,
}: {
  options: { value: T; label: ReactNode; icon?: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      className={cn(
        "inline-flex w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground",
        size === "sm" ? "h-7" : "h-8",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-state={active ? "active" : "inactive"}
            onClick={() => onChange(o.value)}
            className={cn(
              "no-ring inline-flex h-[calc(100%-1px)] items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 font-medium whitespace-nowrap transition-colors",
              "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
              "dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30",
              size === "sm" ? "text-xs [&_svg]:size-3.5" : "text-sm [&_svg]:size-4",
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
