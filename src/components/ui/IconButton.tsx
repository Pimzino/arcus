import type { ButtonHTMLAttributes, ReactNode } from "react";
import { buttonBase, buttonSizes, buttonVariants, type ButtonSize, type ButtonVariant } from "./Button";
import { cn } from "./cn";
import { Tooltip, type TooltipSide } from "./Tooltip";

export type IconButtonSize = "xs" | "sm" | "default" | "lg";

const iconSizes: Record<IconButtonSize, ButtonSize> = {
  xs: "icon-xs",
  sm: "icon-sm",
  default: "icon",
  lg: "icon-lg",
};

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  /** Accessible name; also shown as the tooltip. */
  label: string;
  shortcut?: string;
  tooltipSide?: TooltipSide;
  size?: IconButtonSize;
  variant?: Extract<ButtonVariant, "ghost" | "outline" | "secondary">;
  active?: boolean;
  children: ReactNode;
};

export function IconButton({
  label,
  shortcut,
  tooltipSide,
  size = "default",
  variant = "ghost",
  active,
  className,
  children,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      <button
        type={type}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          buttonBase,
          /* `cn` concatenates, so the pressed look replaces the variant instead of layering on it. */
          active ? "border-transparent bg-muted text-foreground" : buttonVariants[variant],
          buttonSizes[iconSizes[size]],
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}
