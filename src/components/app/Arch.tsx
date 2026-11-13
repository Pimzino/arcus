import { useId, type ReactNode } from "react";
import { cn, lastStone, type Ended } from "../ui";

// The brand's arch as a gauge: the mark's own geometry (branding/build.py, in its 80 x 60 box), with each of its
// five stones filled as far as the work has got, so that a finished transfer leaves the whole mark standing.
const CX = 40;
const CY = 46; // the springing line
const INNER = 20;
const OUTER = 40;
const PROUD = 6; // how far the keystone stands above the others
const PIER = 14;
const JOINT = 2.6;
const KEY_SPAN = 28;
const SIDE_SPAN = (180 - KEY_SPAN) / 4;

/** The angles between the stones, in degrees from the right springing (0) over the top to the left one (180). */
const JOINTS = [180, 180 - SIDE_SPAN, 90 + KEY_SPAN / 2, 90 - KEY_SPAN / 2, SIDE_SPAN, 0];

const point = (radius: number, degrees: number) => {
  const a = (degrees * Math.PI) / 180;
  return `${(CX + radius * Math.cos(a)).toFixed(2)} ${(CY - radius * Math.sin(a)).toFixed(2)}`;
};

/** Each stone as a line down its middle, left to right, stroked as wide as the stone is deep: the outer two
 *  start and end at the foot of their piers, so the first rises from the ground and the last comes down to it. */
const STONES = JOINTS.slice(0, -1).map((from, i) => {
  const outer = i === 2 ? OUTER + PROUD : OUTER;
  const mid = (INNER + outer) / 2;
  const arc = `A${mid} ${mid} 0 0 1 ${point(mid, JOINTS[i + 1])}`;
  const d = i === 0 ? `M${point(mid, 180)}m0 ${PIER}v${-PIER}${arc}` : `M${point(mid, from)}${arc}${i === 4 ? `v${PIER}` : ""}`;
  return { d, width: outer - INNER, colour: `var(--stone-${i + 1})` };
});

/**
 * The arch. With no `value` it is only outlined in the track colour: nothing built yet. With one (0 to 100) the
 * stones are laid left to right, a fifth of the work each. `indeterminate` lights them in turn instead, for work
 * with no total. `ended` lays them in grey, for work that stopped short, with the stone it broke on in red. When the
 * arch stands whole the keystone is set last, as a mason would. Children stand in the doorway.
 */
export function Arch({
  value,
  indeterminate,
  ended,
  label,
  children,
  className,
}: {
  value?: number;
  indeterminate?: boolean;
  ended?: Ended;
  /** What the progress is of, for assistive technology; the arch is decoration without it. */
  label?: string;
  children?: ReactNode;
  className?: string;
}) {
  const mask = useId();
  const built = value === undefined ? 0 : Math.min(100, Math.max(0, value)) / 20;
  const whole = built === 5 && !ended;
  return (
    <div
      data-arch
      className={cn("relative aspect-[4/3] shrink-0", className)}
      {...(label ? { role: "progressbar", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": indeterminate ? undefined : Math.round(value ?? 0) } : { "aria-hidden": true })}
    >
      <svg viewBox="0 0 80 60" fill="none" className="absolute inset-0 size-full">
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="80" height="60">
          <rect width="80" height="60" fill="#fff" />
          {JOINTS.map((angle) => (
            <path key={angle} d={`M${CX} ${CY}L${point(OUTER + PROUD + 10, angle)}`} stroke="#000" strokeWidth={JOINT} />
          ))}
        </mask>
        <g mask={`url(#${mask})`}>
          {STONES.map((stone, i) => (
            <g key={i}>
              <path d={stone.d} strokeWidth={stone.width} className="stroke-foreground/14" />
              {(indeterminate || built > i) && (
                <path
                  d={stone.d}
                  strokeWidth={stone.width}
                  pathLength={1}
                  data-stone={i + 1}
                  stroke={ended ? undefined : stone.colour}
                  strokeDasharray={indeterminate ? undefined : `${Math.min(1, built - i)} 1`}
                  // A stone is set as it arrives: in turn while the arch is being built, and from both piers inwards
                  // when it stands whole, the keystone dropping in last.
                  style={{ animationDelay: `${indeterminate ? i * 180 : whole ? [0, 90, 360, 90, 0][i] : i * 70}ms` }}
                  className={cn(
                    "transition-[stroke-dasharray] duration-500",
                    ended && (ended === "broken" && i === lastStone(value!) ? "stroke-destructive" : "stroke-muted-foreground/60"),
                    indeterminate ? "animate-stone-wave" : whole && i === 2 ? "animate-keystone-set" : "animate-stone-set",
                  )}
                />
              )}
            </g>
          ))}
        </g>
      </svg>
      {/* The doorway: the middle half of the box, from under the crown to the ground. */}
      {children && <div className="absolute inset-x-1/4 top-[46%] bottom-0 flex flex-col items-center justify-end">{children}</div>}
    </div>
  );
}
