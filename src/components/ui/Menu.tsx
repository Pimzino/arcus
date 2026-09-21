import { Check } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";

export type MenuItemDef =
  | { type: "separator" }
  | { type: "label"; label: ReactNode }
  | {
      type?: "item";
      id?: string;
      label: ReactNode;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      onSelect?: () => void;
    };

type Anchor = { x: number; y: number } | DOMRect;

function isRect(a: Anchor): a is DOMRect {
  return "width" in a;
}

/** Floating menu panel with keyboard navigation. Positioned at a point or below/above an anchor rect. */
export function MenuSurface({
  items,
  anchor,
  align = "start",
  onClose,
  minWidth = 180,
}: {
  items: MenuItemDef[];
  anchor: Anchor;
  align?: "start" | "end";
  onClose: () => void;
  minWidth?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState<number>(-1);
  const enabledIndexes = items
    .map((it, i) => (it.type === undefined || it.type === "item") && !it.disabled ? i : -1)
    .filter((i) => i >= 0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let top: number;
    let left: number;
    if (isRect(anchor)) {
      top = anchor.bottom + 4;
      left = align === "end" ? anchor.right - rect.width : anchor.left;
      if (top + rect.height > window.innerHeight - pad) top = Math.max(pad, anchor.top - rect.height - 4);
    } else {
      top = anchor.y;
      left = anchor.x;
      if (top + rect.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    left = Math.max(pad, Math.min(left, window.innerWidth - rect.width - pad));
    setPos({ top, left });
  }, [anchor, align]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((cur) => {
          if (enabledIndexes.length === 0) return -1;
          const pos = enabledIndexes.indexOf(cur);
          const next =
            e.key === "ArrowDown"
              ? enabledIndexes[(pos + 1) % enabledIndexes.length]
              : enabledIndexes[(pos - 1 + enabledIndexes.length) % enabledIndexes.length];
          return next;
        });
      } else if (e.key === "Home") {
        setActive(enabledIndexes[0] ?? -1);
      } else if (e.key === "End") {
        setActive(enabledIndexes[enabledIndexes.length - 1] ?? -1);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const item = items[active];
        if (item && (item.type === undefined || item.type === "item") && !item.disabled) {
          onClose();
          item.onSelect?.();
        }
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    const onResize = () => onClose();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [items, active, enabledIndexes, onClose]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      className="no-ring fixed z-[60] max-h-[70vh] min-w-[var(--menu-min)] overflow-y-auto overscroll-none rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md animate-scale-in"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, ["--menu-min" as string]: `${minWidth}px` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.type === "separator") return <div key={i} className="-mx-1 my-1 h-px bg-border" role="separator" />;
        if (item.type === "label")
          return (
            <div key={i} className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              {item.label}
            </div>
          );
        const isActive = i === active;
        return (
          <button
            key={item.id ?? i}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            data-highlighted={isActive ? "" : undefined}
            data-disabled={item.disabled ? "" : undefined}
            className={cn(
              "no-ring relative flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none select-none",
              "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
              item.danger
                ? "text-destructive data-[highlighted]:bg-destructive/10 [&_svg]:text-destructive"
                : "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:text-muted-foreground",
            )}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(-1)}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            <span className={cn("flex size-4 shrink-0 items-center justify-center [&_svg]:size-4", !item.icon && "opacity-0")}>
              {item.checked ? <Check /> : item.icon}
            </span>
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut && <span className="ml-auto pl-4 text-xs tracking-widest text-muted-foreground">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/** Dropdown menu opened from a trigger element (the single child). */
export function Menu({
  items,
  align = "start",
  minWidth,
  children,
}: {
  items: MenuItemDef[];
  align?: "start" | "end";
  minWidth?: number;
  children: ReactElement<Record<string, unknown>>;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  if (!isValidElement(children)) return children;
  const child = children as ReactElement<Record<string, unknown>>;
  const trigger = cloneElement(child, {
    "aria-haspopup": "menu",
    "aria-expanded": !!anchor,
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      (child.props.onClick as ((e: ReactMouseEvent<HTMLElement>) => void) | undefined)?.(e);
      setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect());
    },
  });
  return (
    <>
      {trigger}
      {anchor && <MenuSurface items={items} anchor={anchor} align={align} onClose={close} minWidth={minWidth} />}
    </>
  );
}

/** Hook for right-click menus: call `open(event, items)` from an onContextMenu handler. */
export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; items: MenuItemDef[] } | null>(null);
  const open = useCallback((e: ReactMouseEvent, items: MenuItemDef[]) => {
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, items });
  }, []);
  const close = useCallback(() => setState(null), []);
  const element = state ? <MenuSurface items={state.items} anchor={{ x: state.x, y: state.y }} onClose={close} /> : null;
  return { open, close, element, isOpen: !!state };
}
