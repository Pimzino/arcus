import { formatSpeed } from "../../lib/format";
import { THROUGHPUT_SAMPLES } from "../../store/throughput";
import { cn } from "../ui";

const W = THROUGHPUT_SAMPLES - 1; // one unit across per second, at the full two minutes
const H = 40;

/** The scale's top: the next power of two in the peak's own unit (12.3 MiB/s draws against 16 MiB/s). */
function ceiling(peak: number): number {
  const floor = 1024; // a line that never leaves a few B/s still draws against 1 KiB/s
  return 2 ** Math.ceil(Math.log2(Math.max(peak, floor)));
}

/**
 * The combined speed of the running transfers, newest at the right edge: over the last minute until there is
 * more than a minute to show, then over the last two. The line runs through the middle of each pair of samples
 * and bends at the samples, so it is smooth and never overshoots what was measured.
 */
export function Throughput({ samples, className }: { samples: number[]; className?: string }) {
  const top = ceiling(Math.max(0, ...samples));
  const seconds = samples.length > 61 ? W : 60;
  const points = samples.map((v, i) => [W * (1 - (samples.length - 1 - i) / seconds), H - (v / top) * (H - 2)] as const);
  let line = "";
  if (points.length > 1) {
    line = `M${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length - 1; i++) {
      const [x, y] = points[i];
      const [nx, ny] = points[i + 1];
      line += `Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
    }
    const [lx, ly] = points[points.length - 1];
    line += `L${lx} ${ly}`;
  }
  const last = points[points.length - 1];
  return (
    <div className={cn("relative min-w-0", className)} role="img" aria-label={samples.length ? `Speed over the last ${seconds === 60 ? "minute" : "two minutes"}, now ${formatSpeed(samples[samples.length - 1])}` : "No transfer has run in the last two minutes"}>
      {/* The scale: its top, its middle and the ground, as hairlines the line is read against. */}
      <div aria-hidden className="absolute inset-0 flex flex-col justify-between">
        <div className="border-t border-dashed" />
        <div className="border-t border-dashed" />
        <div className="border-t" />
      </div>
      {line && (
        <svg aria-hidden viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
          <path d={line} fill="none" stroke="var(--stone-4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {/* Now: where the line has got to. */}
      {last && <div aria-hidden className="absolute right-0 size-2 translate-x-1/2 -translate-y-1/2 rounded-full bg-(--stone-5) ring-2 ring-card" style={{ top: `${(last[1] / H) * 100}%` }} />}
      <div aria-hidden className="tnum absolute top-1 left-0 text-xs text-muted-foreground">{formatSpeed(top)}</div>
      <div aria-hidden className="absolute bottom-1 left-0 text-xs text-muted-foreground">{seconds === 60 ? "1 min ago" : "2 min ago"}</div>
    </div>
  );
}
