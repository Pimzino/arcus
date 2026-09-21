import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export type ButtonVariant = "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
export type ButtonSize = "xs" | "sm" | "default" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
  block?: boolean;
};

/** Shared box and focus ring. The text and icon sizes live in buttonSizes: `cn` only
    concatenates, so two utilities for the same property must never both be applied. */
export const buttonBase =
  "no-ring inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border bg-clip-padding " +
  "font-medium whitespace-nowrap transition-all outline-none select-none " +
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 " +
  "disabled:pointer-events-none disabled:opacity-50 " +
  "[&_svg]:pointer-events-none [&_svg]:shrink-0";

export const buttonVariants: Record<ButtonVariant, string> = {
  default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
  outline:
    "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground " +
    "dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
  secondary:
    "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary",
  ghost:
    "border-transparent hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
  destructive:
    "border-transparent bg-destructive/10 text-destructive hover:bg-destructive/20 " +
    "focus-visible:border-destructive/40 focus-visible:ring-destructive/20 " +
    "dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
  link: "border-transparent text-primary underline-offset-4 hover:underline",
};

export const buttonSizes: Record<ButtonSize, string> = {
  default: "h-8 gap-1.5 px-2.5 text-sm [&_svg:not([class*='size-'])]:size-4",
  xs: "h-6 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
  sm: "h-7 gap-1 px-2.5 text-[0.8rem] [&_svg:not([class*='size-'])]:size-3.5",
  lg: "h-9 gap-1.5 px-2.5 text-sm [&_svg:not([class*='size-'])]:size-4",
  icon: "size-8 text-sm [&_svg:not([class*='size-'])]:size-4",
  "icon-xs": "size-6 text-xs [&_svg:not([class*='size-'])]:size-3",
  "icon-sm": "size-7 text-sm [&_svg:not([class*='size-'])]:size-4",
  "icon-lg": "size-9 text-sm [&_svg:not([class*='size-'])]:size-4",
};

export function Button({
  variant = "outline",
  size = "default",
  icon,
  iconRight,
  loading,
  block,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonBase, buttonVariants[variant], buttonSizes[size], block && "w-full", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="animate-spin" /> : icon}
      {children}
      {iconRight}
    </button>
  );
}
