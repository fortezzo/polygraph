import { radarPoint, shownScore, TRAP_TYPES } from "../lib/report";

// Wider than tall, so the labels at the sides have room.
const W = 560;
const H = 450;
const CX = W / 2;
const CY = H / 2 + 4;
const R = 132;
const PENCIL = "rgba(78, 59, 31, 0.38)";

/**
 * The 8 trap-type scores as a radar. Each score is also written next to its
 * point. A type the run didn't test (a live run can test just a few, Session 8)
 * gets no point and says "not tested": it's never drawn as a zero.
 */
export function Radar({ scores }: { scores: Record<string, number | null> }) {
  const pts = TRAP_TYPES.map((t, i) => {
    const tested = t.key in scores;
    const s = scores[t.key] ?? null;
    return { ...t, tested, score: s, ...radarPoint(i, s ?? 0, CX, CY, R) };
  });
  const shown = pts.filter((p) => p.tested && p.score !== null);
  const ring = (pct: number) =>
    TRAP_TYPES.map((_, i) => {
      const p = radarPoint(i, pct, CX, CY, R);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    }).join(" ");
  const label = pts.map((p) => `${p.label} ${!p.tested ? "not tested" : p.score === null ? "not scored" : shownScore(p.score)}`).join(", ");
  return (
    <figure className="m-0 w-full max-w-[520px]">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Scores by trap type, out of 100: ${label}.`}>
        {[25, 50, 75, 100].map((pct) => (
          <polygon key={pct} points={ring(pct)} fill="none" stroke={PENCIL} strokeWidth={pct === 100 ? 1.4 : 1} strokeDasharray={pct === 100 ? undefined : "3 4"} />
        ))}
        {pts.map((p, i) => {
          const rim = radarPoint(i, 100, CX, CY, R);
          return <line key={p.key} x1={CX} y1={CY} x2={rim.x} y2={rim.y} stroke={PENCIL} strokeWidth={1} strokeDasharray={p.tested ? undefined : "2 5"} />;
        })}
        {shown.length >= 3 && (
          <polygon
            points={shown.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
            fill="rgba(42, 32, 21, 0.14)"
            stroke="#2a2015"
            strokeWidth={2.4}
            strokeLinejoin="round"
          />
        )}
        {pts.map((p, i) => {
          const rim = radarPoint(i, 100, CX, CY, R + 24);
          const cos = Math.cos(p.angle);
          const sin = Math.sin(p.angle);
          const anchor = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
          const dy = sin > 0.3 ? 14 : sin < -0.3 ? -12 : 0;
          const ink = p.tested ? "#2a2015" : "#4e3b1f";
          return (
            <g key={p.key}>
              {p.tested && p.score !== null && <circle cx={p.x} cy={p.y} r={4} fill="#2a2015" />}
              <text x={rim.x} y={rim.y + dy} textAnchor={anchor} fontSize="16" fill={ink} fontFamily="var(--font-type)">
                {p.short}
              </text>
              {p.tested ? (
                <text x={rim.x} y={rim.y + dy + 19} textAnchor={anchor} fontSize="17" fontWeight="700" fill={ink} fontFamily="var(--font-display)">
                  {p.score === null ? "–" : shownScore(p.score)}
                </text>
              ) : (
                <text x={rim.x} y={rim.y + dy + 18} textAnchor={anchor} fontSize="14" fontStyle="italic" fill={ink} fontFamily="var(--font-type)">
                  not tested
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 text-center text-[12px] text-manila-label">
        Rings at 25, 50, 75 and 100. Further out is more honest.{shown.length < pts.length ? " Dashed spokes: not tested in this run." : ""}
      </figcaption>
    </figure>
  );
}
