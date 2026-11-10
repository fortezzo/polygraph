import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { motion, useAnimationControls } from "motion/react";
import type { Timeline, TrapPlan, Tone } from "../lib/timeline";
import type { Track } from "../lib/signal";
import { needleAt } from "../lib/signal";
import type { Playback } from "../lib/playback";
import type { Sound } from "../lib/sound";
import { onFrame } from "../lib/frame";
import { VERDICT_INFO } from "../data/verdicts";
import { stampX, stampXOnSheet } from "../lib/stamp";

// Ink colors on the cream paper. Calm is green ink (honest so far); the spike
// takes the verdict's color. Every spike also gets a written label, so color is
// never the only signal.
const INK: Record<"calm" | Tone, string> = {
  calm: "#1b6a3e",
  lie: "#c2241b",
  caved: "#9c5800",
  contradicted: "#94268f",
};
// Same values as --color-honest-ink and --color-dodged-ink in index.css.
const VERDICT_INK = { HONEST: "#164f2d", DODGED: "#173f78" } as const;
const PENCIL = "rgba(120, 50, 34, 0.92)";
const GRID_PERIOD = 48;

interface Geometry {
  w: number;
  h: number;
  phone: boolean;
  penX: number;
  speed: number; // paper speed, pixels a second
  left: number; // reduced motion: where each sheet starts
}

// On a phone the pen sits further left and the paper moves a bit faster, so a
// question's own stretch of paper is wide enough for its stamp (see stamp.ts).
export const PEN = { phone: 0.72, wide: 0.86 };
export const SPEED = { phone: 30, wide: 46 };

function geometry(w: number, h: number): Geometry {
  const phone = w < 640;
  return { w, h, phone, penX: Math.round(w * (phone ? PEN.phone : PEN.wide)), speed: phone ? SPEED.phone : SPEED.wide, left: 16 };
}

interface Props {
  timeline: Timeline;
  track: Track;
  playback: Playback;
  sound: Sound;
  reduced: boolean;
  trapIndex: number;
  stamped: boolean;
  /** Changes when a stamp lands while playing, to shake the paper. */
  slam: number;
}

export function ChartPaper({ timeline, track, playback, sound, reduced, trapIndex, stamped, slam }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geo = useRef<Geometry>(geometry(0, 0));
  const stampEls = useRef(new Map<string, HTMLDivElement>());
  const dirty = useRef(true);
  const shake = useAnimationControls();

  // The stamps on the paper right now: every caught trap whose stamp has landed.
  // With the paper still (reduced motion), each question gets a fresh sheet.
  const stamps = useMemo(
    () =>
      timeline.traps.filter(
        (p) =>
          p.stampAt !== null &&
          (p.index === trapIndex ? stamped : !reduced && p.index < trapIndex && p.index >= trapIndex - 4),
      ),
    [timeline, trapIndex, stamped, reduced],
  );

  // Keep the canvas sharp at the screen's pixel density, and redraw on resize.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      geo.current = geometry(r.width, r.height);
      dirty.current = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    dirty.current = true;
  }, [stamps, reduced, timeline]);

  useEffect(() => {
    if (slam > 0 && !reduced) void shake.start({ x: [0, -5, 4, -2.5, 1, 0], transition: { duration: 0.34 } });
  }, [slam, reduced, shake]);

  useEffect(() => {
    let lastT = -1;
    let prevY = 0;
    let prevNow = 0;
    return onFrame((now) => {
      const canvas = canvasRef.current;
      const g = geo.current;
      if (!canvas || !g.w) return;
      const t = playback.now();
      const playing = playback.status === "playing";

      // The scratch follows the pen.
      const y = needleAt(track, t).y;
      if (playing && sound.enabled) {
        const dt = Math.max(1, now - prevNow);
        sound.scratch((Math.abs(y - prevY) / dt) * 250);
      } else if (sound.enabled) sound.quiet();
      prevY = y;
      prevNow = now;

      if (t === lastT && !dirty.current) return;
      lastT = t;
      dirty.current = false;
      draw(canvas, g, t);
    });

    function sheetOf(t: number): TrapPlan | undefined {
      let cur: TrapPlan | undefined;
      for (const p of timeline.traps) if (t >= p.start) cur = p;
      return cur ?? timeline.traps[0];
    }

    function draw(canvas: HTMLCanvasElement, g: Geometry, t: number) {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = canvas.width / g.w;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, g.w, g.h);
      const mid = g.h / 2;
      // The tallest spike stops just under the pencil notes along the top.
      const amp = mid - (g.phone ? 34 : 42);

      // Paper position: scrolling with time, or one still sheet per question.
      const sheet = reduced ? sheetOf(t) : undefined;
      const xOf = (tau: number): number => {
        if (sheet) {
          const span = Math.max(1, sheet.end - sheet.start);
          return g.left + ((tau - sheet.start) / span) * (g.penX - g.left);
        }
        return g.penX - ((t - tau) / 1000) * g.speed;
      };
      const tOf = (x: number): number => {
        if (sheet) return sheet.start + ((x - g.left) / (g.penX - g.left)) * (sheet.end - sheet.start);
        return t - ((g.penX - x) / g.speed) * 1000;
      };
      const offset = reduced ? 0 : ((t / 1000) * g.speed) % GRID_PERIOD;
      if (gridRef.current) gridRef.current.style.transform = `translate3d(${-offset}px,0,0)`;
      const penX = sheet ? Math.min(g.penX, xOf(t)) : g.penX;

      // The trace, in runs of the same ink.
      const from = Math.max(0, sheet ? xOf(sheet.start) : 0);
      const startT = sheet ? sheet.start : 0;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      let tone: "calm" | Tone | null = null;
      let px = 0;
      let py = 0;
      const step = g.phone ? 1.5 : 2;
      for (let x = from; x <= penX + 0.01; x += step) {
        const tau = Math.min(tOf(x), t);
        if (tau < startT) continue;
        const p = needleAt(track, tau);
        const yy = mid - p.y * amp;
        const k = p.tone ?? "calm";
        if (k !== tone) {
          if (tone) ctx.stroke();
          ctx.beginPath();
          ctx.strokeStyle = INK[k];
          ctx.lineWidth = k === "calm" ? 2.1 : 2.6;
          if (tone) ctx.moveTo(px, py);
          else ctx.moveTo(x, yy);
          tone = k;
        }
        ctx.lineTo(x, yy);
        px = x;
        py = yy;
      }
      if (tone) ctx.stroke();

      // Pencil notes: when each question and answer started, and what the judge found.
      const fontSize = g.phone ? 11 : 12;
      ctx.font = `${fontSize}px "Special Elite", "Courier Prime", monospace`;
      const rows: [number, number][][] = [[], []];
      const place = (x: number, text: string): number | null => {
        const wText = ctx.measureText(text).width;
        for (let r = 0; r < rows.length; r++) {
          if (rows[r]!.every(([a, b]) => x + wText + 6 < a || x > b + 6)) {
            rows[r]!.push([x, x + wText]);
            return r;
          }
        }
        return null;
      };
      const visible = (x: number) => x > -200 && x < g.w;
      const traps = sheet ? [sheet] : timeline.traps;
      for (const p of traps) {
        if (p.start > t) break;
        if (!sheet && xOf(p.end) < -200) continue;
        for (const turn of p.turns) {
          if (turn.start > t) break;
          const x = xOf(turn.start);
          if (!visible(x)) continue;
          let text = "answer";
          if (turn.role === "user") {
            text = turn.kind === "push_back" ? "push-back" : turn.chats > 1 ? `Q${p.index + 1} · chat ${turn.chat}` : `Q${p.index + 1} asked`;
          }
          ctx.strokeStyle = "rgba(120, 50, 34, 0.5)";
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, 18);
          ctx.lineTo(Math.round(x) + 0.5, g.h - 18);
          ctx.stroke();
          ctx.setLineDash([]);
          // A note that would run under the machine housing goes on the left of its line.
          const wText = ctx.measureText(text).width;
          const tx = x + 5 + wText > g.w - 40 ? x - 5 - wText : x + 5;
          const row = place(tx, text);
          if (row !== null) {
            ctx.fillStyle = PENCIL;
            ctx.fillText(text, tx, 32 + row * (fontSize + 4));
          }
        }
        // Under a spike: a bracket and what it means.
        if (p.spike && p.verdict && p.spike.start <= t) {
          const x0 = xOf(p.spike.start);
          const x1 = Math.max(xOf(Math.min(p.spike.end, t)), x0 + 24);
          const base = g.h - (g.phone ? 40 : 52);
          const ink = INK[p.spike.tone];
          ctx.strokeStyle = ink;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(x0 - 3, base);
          ctx.lineTo(x0 - 3, base + 7);
          ctx.lineTo(x1 + 3, base + 7);
          ctx.lineTo(x1 + 3, base);
          ctx.stroke();
          ctx.fillStyle = ink;
          ctx.fillText(VERDICT_INFO[p.verdict].needleLabel, x0 - 3, base + 7 + fontSize + 6);
        }
        // An examiner's tick for answers that got through clean.
        if (p.verdict && !p.tone && p.verdictAt <= t) {
          const x = xOf(p.verdictAt);
          if (visible(x)) {
            const info = VERDICT_INFO[p.verdict];
            ctx.fillStyle = VERDICT_INK[p.verdict as keyof typeof VERDICT_INK] ?? PENCIL;
            ctx.fillText(`${info.glyph} ${info.word.toLowerCase()}`, x - 4, g.h - (g.phone ? 21 : 31));
          }
        }
      }

      // The pen arm, pivoting in the housing on the right.
      const now = needleAt(track, t);
      const penY = mid - now.y * amp;
      const pivotX = g.w - 21;
      ctx.strokeStyle = "#3a332b";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(penX, penY);
      ctx.lineTo(pivotX, mid);
      ctx.stroke();
      ctx.fillStyle = "#2b2620";
      ctx.strokeStyle = "#6a6052";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pivotX, mid, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = INK[now.tone ?? "calm"];
      ctx.beginPath();
      ctx.arc(penX, penY, 3.4, 0, Math.PI * 2);
      ctx.fill();

      // Each stamp sits on the spike it belongs to (stamp.ts) and rides with the paper.
      for (const p of stamps) {
        const el = stampEls.current.get(p.id);
        if (!el) continue;
        const sw = el.offsetWidth;
        const x = sheet
          ? stampXOnSheet(p, sw, { w: g.w, left: g.left, xOf })
          : stampX(p, sw, { w: g.w, penX: g.penX, speed: g.speed }, t);
        el.style.transform = `translate3d(${x}px, -50%, 0)`;
        el.style.visibility = x + sw < -40 ? "hidden" : "visible";
      }
    }
  }, [timeline, track, playback, sound, reduced, stamps]);

  return (
    <motion.div animate={shake} className="relative">
      <div ref={wrapRef} className="paper h-[150px] sm:h-[180px] lg:h-[214px]">
        <div ref={gridRef} className="paper-grid" aria-hidden="true">
          <div className="paper-holes top-0" />
          <div className="paper-holes bottom-0" />
        </div>
        <div className="paper-light" aria-hidden="true" />
        {/* Stamp ink is on the paper, under the pen: the trace, the pencil notes and
            the pen arm are drawn on top of it. */}
        {stamps.map((p) => (
          <div
            key={p.id}
            ref={(el) => {
              if (el) stampEls.current.set(p.id, el);
              else stampEls.current.delete(p.id);
            }}
            className="absolute top-1/2 left-0"
            style={{ visibility: "hidden" }}
            aria-hidden="true"
          >
            <StampInk fresh={playback.now() - (p.stampAt ?? 0) < 450} reduced={reduced} />
          </div>
        ))}
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
        <div className="housing" aria-hidden="true" />
      </div>
    </motion.div>
  );
}

function StampInk({ fresh, reduced }: { fresh: boolean; reduced: boolean }) {
  const initial = !fresh ? false : reduced ? { opacity: 0 } : { opacity: 0, scale: 1.9, rotate: -17 };
  return (
    <motion.div
      className="stamp-ink px-[9px] pt-[3px] pb-[4px] text-[28px] sm:text-[36px] lg:px-[15px] lg:pt-[5px] lg:pb-[6px] lg:text-[48px]"
      initial={initial}
      animate={{ opacity: 0.92, scale: 1, rotate: -9 }}
      transition={reduced ? { duration: 0.25 } : { type: "spring", stiffness: 700, damping: 21, mass: 0.9 }}
    >
      CAUGHT
    </motion.div>
  );
}
