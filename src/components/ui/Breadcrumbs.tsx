import { ChevronRight, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { Menu } from "./Menu";

export type Crumb = { label: ReactNode; icon?: ReactNode; onClick?: () => void; title?: string };

/** Path breadcrumbs that collapse the middle into a menu when there are too many.
    Give the first crumb a `<Home />` icon for the root of a listing. */
export function Breadcrumbs({ items, maxVisible = 4, className }: { items: Crumb[]; maxVisible?: number; className?: string }) {
  let visible: (Crumb | "ellipsis")[] = items;
  let hidden: Crumb[] = [];
  if (items.length > maxVisible) {
    const head = items.slice(0, 1);
    const tail = items.slice(items.length - (maxVisible - 1));
    hidden = items.slice(1, items.length - (maxVisible - 1));
    visible = [...head, "ellipsis", ...tail];
  }
  return (
    <nav className={cn("flex min-w-0 items-center gap-1.5 text-sm break-words text-muted-foreground", className)} aria-label="Path">
      {visible.map((item, i) => {
        const last = i === visible.length - 1;
        if (item === "ellipsis") {
          return (
            <span key="ellipsis" className="flex items-center gap-1.5">
              <Menu items={hidden.map((h) => ({ label: h.label, icon: h.icon, onSelect: h.onClick }))}>
                <button
                  type="button"
                  className="no-ring flex size-5 items-center justify-center rounded-md transition-colors hover:text-foreground"
                  aria-label="Show hidden folders"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </Menu>
              <ChevronRight className="size-3.5 shrink-0" />
            </span>
          );
        }
        return (
          <span key={i} className={cn("flex min-w-0 items-center gap-1.5", last && "min-w-0 shrink")}>
            <button
              type="button"
              title={item.title}
              onClick={item.onClick}
              disabled={!item.onClick}
              aria-current={last ? "page" : undefined}
              className={cn(
                "no-ring flex min-w-0 items-center gap-1 rounded-md transition-colors [&_svg]:size-3.5",
                last ? "text-foreground" : "hover:text-foreground",
              )}
            >
              {item.icon}
              <span className="truncate">{item.label}</span>
            </button>
            {!last && <ChevronRight className="size-3.5 shrink-0" />}
          </span>
        );
      })}
    </nav>
  );
}
