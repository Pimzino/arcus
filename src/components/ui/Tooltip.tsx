import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";

export type TooltipSide = "top" | "bottom" | "left" | "right";

type Pos = { top: number; left: number };

function computePosition(anchor: DOMRect, tip: DOMRect, side: TooltipSide, gap = 6): Pos {
  let top = 0;
  let left = 0;
  switch (side) {
    case "top":
      top = anchor.top - tip.height - gap;
      left = anchor.left + anchor.width / 2 - tip.width / 2;
      break;
    case "bottom":
      top = anchor.bottom + gap;
      left = anchor.left + anchor.width / 2 - tip.width / 2;
      break;
    case "left":
      top = anchor.top + anchor.height / 2 - tip.height / 2;
      left = anchor.left - tip.width - gap;
      break;
    case "right":
      top = anchor.top + anchor.height / 2 - tip.height / 2;
      left = anchor.right + gap;
      break;
  }
  const pad = 6;
  left = Math.max(pad, Math.min(left, window.innerWidth - tip.width - pad));
  top = Math.max(pad, Math.min(top, window.innerHeight - tip.height - pad));
  return { top, left };
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "ScrollLock", "Fn", "FnLock"]);

/* Only the keyboard may open a tooltip by focusing its trigger. The flag is module-wide because
   focus often arrives at a trigger that had no part in the click that moved it there: a dialog
   opening, or a dialog handing focus back to the button that opened it. One pair of listeners,
   added by the first tooltip to mount and kept for the life of the app, serves every tooltip. */
let lastInputWasKeyboard = false;
let watchingInput = false;

function watchInputModality() {
  if (watchingInput) return;
  watchingInput = true;
  window.addEventListener(
    "keydown",
    (e) => {
      if (!MODIFIER_KEYS.has(e.key)) lastInputWasKeyboard = true;
    },
    true,
  );
  window.addEventListener(
    "pointerdown",
    () => {
      lastInputWasKeyboard = false;
    },
    true,
  );
}

/** Focus the keyboard moved, and that the browser itself counts as keyboard focus. */
function isKeyboardFocus(node: HTMLElement | null) {
  if (!lastInputWasKeyboard || !node) return false;
  try {
    return node.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * Hover/focus tooltip. The child must be a single element that accepts mouse and
 * focus handlers (buttons, inputs, spans with tabIndex). Focus opens it for the
 * keyboard only, so a click that moves focus never leaves a tooltip behind.
 */
export function Tooltip({
  content,
  side = "top",
  delay = 450,
  shortcut,
  children,
}: {
  content: ReactNode;
  side?: TooltipSide;
  delay?: number;
  shortcut?: string;
  children: ReactElement<Record<string, unknown>>;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  }, [delay]);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  }, []);

  useEffect(watchInputModality, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  /* A control that disables itself under the pointer (Stop, while it stops) never gets a
     mouseleave, so its tooltip would otherwise hang there or open after the fact. */
  const disabled = !!children.props?.disabled;
  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !tipRef.current) return;
    setPos(computePosition(anchorRef.current.getBoundingClientRect(), tipRef.current.getBoundingClientRect(), side));
  }, [open, side, content]);

  if (!isValidElement(children) || !content) return children;

  const child = children as ReactElement<Record<string, unknown>>;
  const childProps = child.props;
  const trigger = cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
      const ref = (child as unknown as { ref?: unknown }).ref ?? (childProps.ref as unknown);
      if (typeof ref === "function") ref(node);
      else if (ref && typeof ref === "object") (ref as { current: HTMLElement | null }).current = node;
    },
    onMouseEnter: (e: unknown) => {
      (childProps.onMouseEnter as ((e: unknown) => void) | undefined)?.(e);
      show();
    },
    onMouseLeave: (e: unknown) => {
      (childProps.onMouseLeave as ((e: unknown) => void) | undefined)?.(e);
      hide();
    },
    onFocus: (e: unknown) => {
      (childProps.onFocus as ((e: unknown) => void) | undefined)?.(e);
      if (isKeyboardFocus(anchorRef.current)) show();
    },
    onBlur: (e: unknown) => {
      (childProps.onBlur as ((e: unknown) => void) | undefined)?.(e);
      hide();
    },
    onMouseDown: (e: unknown) => {
      (childProps.onMouseDown as ((e: unknown) => void) | undefined)?.(e);
      hide();
    },
    onKeyDown: (e: unknown) => {
      (childProps.onKeyDown as ((e: unknown) => void) | undefined)?.(e);
      /* Escape dismisses the tooltip of a control that keeps focus (and closes dialogs and menus,
         whose trigger gets focus back with its tooltip still counted as open). */
      if ((e as { key?: string }).key === "Escape") hide();
    },
  });

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className={cn(
              "pointer-events-none fixed z-[70] flex w-fit max-w-xs items-center gap-2 rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background animate-fade-in",
            )}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          >
            <span>{content}</span>
            {shortcut && <span className="rounded-sm bg-background/15 px-1 font-mono">{shortcut}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}
