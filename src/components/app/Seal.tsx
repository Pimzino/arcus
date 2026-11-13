import { cn } from "../ui";

/* The arch's four blues, with the text each one carries: white on the two deep ones, midnight on the two pale. */
const SEALS = ["bg-(--stone-1) text-white", "bg-(--stone-2) text-white", "bg-(--stone-4) text-midnight", "bg-(--stone-5) text-midnight"];

/** A remote's seal: the first two characters of its backend on one of the arch's blues, picked by the backend's
 *  name, so remotes of one kind look alike wherever they are listed. */
export function Seal({ type, className }: { type: string; className?: string }) {
  const seal = SEALS[[...type].reduce((sum, c) => sum + c.charCodeAt(0), 0) % SEALS.length];
  return (
    <span aria-hidden data-seal className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-medium", seal, className)}>
      {type.slice(0, 2).toUpperCase()}
    </span>
  );
}
