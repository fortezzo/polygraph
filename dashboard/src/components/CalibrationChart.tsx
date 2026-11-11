import { useLayoutEffect, useRef, useState } from "react";
import type { CalibrationBucket } from "../data/runFile";
import { shownScore } from "../lib/report";

const INK = "#2a2015";
const PENCIL = "rgba(120, 50, 34, 0.85)";
const HONEST = "rgba(22, 79, 45, 0.62)";
const CLAIM = "#8a170f";

/**
 * How sure the bot said it was, against how often it was honest, band by band.
 * A green bar is how often it was honest; the red line across it is how sure it
 * said it was on average. On the dashed diagonal, those two would be equal.
 * Drawn at the real screen width, so the labels stay readable on a phone.
 */
export function CalibrationChart({ buckets }: { buckets: CalibrationBucket[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.round(el.clientWidth))));
    ro.observe(el);
    setW(Math.max(280, Math.round(el.clientWidth)));
    return () => ro.disconnect();
  }, []);

  const narrow = w < 480;
  const h = narrow ? 300 : 360;
  // Session 11: room on the right for the last label, "100%", centered on its tick.
  const m = { left: narrow ? 40 : 56, right: narrow ? 22 : 24, top: 22, bottom: narrow ? 58 : 62 };
  const x = (v: number) => m.left + (v / 100) * (w - m.left - m.right);
  const y = (v: number) => h - m.bottom - (v / 100) * (h - m.top - m.bottom);
  const font = narrow ? 11 : 12.5;
  const small = Math.max(11, font - 1.5);

  const summary = buckets
    .map((b) => `${b.low} to ${b.high}%: ${b.answers} answers${b.answers ? `, said ${shownScore(b.mean_confidence)}% on average, honest ${shownScore(b.honest_rate)}%` : ""}`)
    .join("; ");

  return (
    <div ref={box} className="w-full">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`How sure it said it was, against how often it was honest. ${summary}.`} className="block">
        <defs>
          <pattern id="gap" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke={CLAIM} strokeWidth="2" opacity="0.45" />
          </pattern>
        </defs>
        {/* Axes and ticks */}
        <line x1={x(0)} y1={y(0)} x2={x(100)} y2={y(0)} stroke={INK} strokeWidth="1.4" />
        <line x1={x(0)} y1={y(0)} x2={x(0)} y2={y(100)} stroke={INK} strokeWidth="1.4" />
        {[0, 20, 40, 60, 80, 100].map((v) => (
          <text key={`x${v}`} x={x(v)} y={y(0) + font + 6} textAnchor="middle" fontSize={font} fill={INK} fontFamily="var(--font-type)">
            {v}%
          </text>
        ))}
        {[0, 25, 50, 75, 100].map((v) => (
          <text key={`y${v}`} x={x(0) - 6} y={y(v) + 4} textAnchor="end" fontSize={font} fill={INK} fontFamily="var(--font-type)">
            {v}%
          </text>
        ))}
        <text x={(x(0) + x(100)) / 2} y={h - 8} textAnchor="middle" fontSize={font} fill={INK} fontFamily="var(--font-label)" letterSpacing="1">
          HOW SURE IT SAID IT WAS
        </text>
        <text transform={`translate(${narrow ? 11 : 14} ${(y(0) + y(100)) / 2}) rotate(-90)`} textAnchor="middle" fontSize={font} fill={INK} fontFamily="var(--font-label)" letterSpacing="1">
          HOW OFTEN IT WAS HONEST
        </text>
        {/* Perfectly calibrated: what it said equals how often it was right. Named in the legend. */}
        <line x1={x(0)} y1={y(0)} x2={x(100)} y2={y(100)} stroke={PENCIL} strokeWidth="1.4" strokeDasharray="5 5" />
        {/* One bar per band */}
        {buckets.map((b) => {
          const x0 = x(b.low) + (narrow ? 3 : 6);
          const x1 = x(b.high === 100 ? 100 : b.high + 1) - (narrow ? 3 : 6);
          const mid = (x0 + x1) / 2;
          if (!b.answers || b.honest_rate === null || b.mean_confidence === null) {
            return (
              <text key={b.low} x={mid} y={y(0) - 8} textAnchor="middle" fontSize={small} fill="rgba(78,59,31,0.75)" fontFamily="var(--font-type)">
                none
              </text>
            );
          }
          const top = y(b.honest_rate);
          const claim = y(b.mean_confidence);
          // The honest-rate label sits just above its bar, unless the red line is right there.
          const labelY = claim < top && claim > top - 27 ? claim - 7 : top - 7;
          return (
            <g key={b.low}>
              {b.mean_confidence > b.honest_rate && <rect x={x0} y={claim} width={x1 - x0} height={top - claim} fill="url(#gap)" />}
              <rect x={x0} y={top} width={x1 - x0} height={y(0) - top} fill={HONEST} stroke="#164f2d" strokeWidth="1.2" />
              <line x1={x0 - 3} x2={x1 + 3} y1={claim} y2={claim} stroke={CLAIM} strokeWidth="3" />
              <text x={mid} y={labelY} textAnchor="middle" fontSize={font} fontWeight="700" fill={INK} fontFamily="var(--font-display)">
                {shownScore(b.honest_rate)}%
              </text>
              <text x={mid} y={y(0) + font * 2 + 10} textAnchor="middle" fontSize={small} fill="rgba(78,59,31,0.9)" fontFamily="var(--font-type)">
                {b.answers} {narrow ? "" : b.answers === 1 ? "answer" : "answers"}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
