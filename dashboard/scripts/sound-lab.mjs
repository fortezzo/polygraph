// Session 11: render the dashboard's sounds without speakers, measure them, and
// save them as short WAV files to listen to.
//
//   node scripts/sound-lab.mjs --out <folder>
//   node scripts/sound-lab.mjs --root <another copy of the dashboard> --name before --out <folder>
//
// It starts the dashboard's development server, opens it in the Microsoft Edge
// already on this PC (invisibly), and drives the real Sound class from
// src/lib/sound.ts with a pretend audio device that renders to memory, so what's
// measured is exactly what the page plays. Four sounds:
//   thud          the CAUGHT stamp landing
//   scratch-calm  3 seconds of the pen on a calm line (small wiggles)
//   scratch-spike the pen racing up a spike and back, then calm again
//   replay        a short stretch of a replay: calm, a spike, the thud, calm
// For each: the peak and RMS level in dBFS, its length above -60 dBFS, how much of
// its energy is below 150 Hz (where phone and laptop speakers play little), and
// whether it clips.

import { createServer } from "vite";
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const root = resolve(opt("--root", resolve(here, "..")));
const out = resolve(opt("--out", resolve(process.env.TEMP ?? here, "polygraph-sound")));
const name = opt("--name", "after");
mkdirSync(out, { recursive: true });

const server = await createServer({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "silent", server: { port: 5199, strictPort: false, host: "127.0.0.1" } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: "msedge", headless: true });

function wav(samples, rate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}

try {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "load" });
  const results = await page.evaluate(async () => {
    const RATE = 48000;
    // The pretend audio device: every "new AudioContext()" the Sound class makes
    // becomes this offline context, which renders into memory instead of speakers.
    let offline = null;
    window.AudioContext = function () {
      return offline;
    };
    const { Sound } = await import("/src/lib/sound.ts");

    // Pen speeds over time, as ChartPaper feeds them: [seconds, level 0..1].
    const calm = (t0, t1) => {
      const out = [];
      for (let t = t0; t < t1; t += 0.05) out.push([t, 0.06 + 0.06 * Math.abs(Math.sin(t * 7.3)) + 0.04 * Math.abs(Math.sin(t * 19.1))]);
      return out;
    };
    const spike = (t0) => {
      const out = [];
      for (let k = 0; k < 24; k++) out.push([t0 + k * 0.05, Math.min(1, 0.25 + Math.sin((k / 23) * Math.PI) * 0.95)]);
      return out;
    };
    const plans = {
      thud: { seconds: 1.0, speeds: [], thuds: [0.05] },
      "scratch-calm": { seconds: 3.0, speeds: calm(0, 3), thuds: [] },
      "scratch-spike": { seconds: 3.0, speeds: [...calm(0, 0.8), ...spike(0.8), ...calm(2.0, 3)], thuds: [] },
      replay: { seconds: 4.0, speeds: [...calm(0, 1.0), ...spike(1.0), ...calm(2.2, 4)], thuds: [2.15] },
    };

    const results = {};
    for (const [key, plan] of Object.entries(plans)) {
      offline = new OfflineAudioContext(1, Math.round(RATE * plan.seconds), RATE);
      const sound = new Sound();
      sound.enable();
      // Suspend the rendering at each moment, change what the page would change, carry on.
      const moments = [...plan.speeds.map(([t, v]) => ({ t, act: () => sound.scratch(v) })), ...plan.thuds.map((t) => ({ t, act: () => sound.thud() }))]
        .map((m) => ({ ...m, t: Math.round(m.t * 1000) / 1000 }))
        .sort((a, b) => a.t - b.t);
      const byTime = new Map();
      for (const m of moments) {
        const q = Math.max(128 / RATE, Math.round((m.t * RATE) / 128) * 128 / RATE); // suspend works in blocks of 128 samples
        if (!byTime.has(q)) byTime.set(q, []);
        byTime.get(q).push(m.act);
      }
      for (const [t, acts] of byTime) {
        if (t >= plan.seconds) continue;
        offline.suspend(t).then(() => {
          for (const a of acts) a();
          offline.resume();
        });
      }
      const buf = await offline.startRendering();
      const x = buf.getChannelData(0);
      let peak = 0;
      let sum = 0;
      let first = -1;
      let last = -1;
      const floor = 10 ** (-60 / 20);
      for (let i = 0; i < x.length; i++) {
        const a = Math.abs(x[i]);
        if (a > peak) peak = a;
        sum += x[i] * x[i];
        if (a > floor) {
          if (first < 0) first = i;
          last = i;
        }
      }
      // Energy below 150 Hz: a simple one-pole low-pass, compared with the whole.
      // And what a phone speaker can play: the level above 300 Hz (a one-pole
      // high-pass), while the sound is audible.
      let lp = 0;
      let low = 0;
      let lp300 = 0;
      let high = 0;
      const k = 1 - Math.exp((-2 * Math.PI * 150) / RATE);
      const k3 = 1 - Math.exp((-2 * Math.PI * 300) / RATE);
      for (let i = 0; i < x.length; i++) {
        lp += k * (x[i] - lp);
        low += lp * lp;
        lp300 += k3 * (x[i] - lp300);
        if (i >= first && i <= last) high += (x[i] - lp300) ** 2;
      }
      const span = first < 0 ? 1 : last - first + 1;
      let inside = 0;
      for (let i = Math.max(0, first); i <= last; i++) inside += x[i] * x[i];
      const db = (v) => (v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -Infinity);
      results[key] = {
        peak_dbfs: db(peak),
        rms_dbfs: db(Math.sqrt(sum / x.length)),
        rms_while_audible_dbfs: db(Math.sqrt(inside / span)),
        above_300hz_rms_dbfs: db(Math.sqrt(high / span)),
        audible_ms: first < 0 ? 0 : Math.round(((last - first) / RATE) * 1000),
        under_150hz_percent: sum > 0 ? Math.round((low / sum) * 100) : 0,
        clips: peak >= 0.999,
        samples: Array.from(x),
        rate: RATE,
      };
    }
    return results;
  });
  const summary = {};
  for (const [key, r] of Object.entries(results)) {
    writeFileSync(resolve(out, `${name}-${key}.wav`), wav(r.samples, r.rate));
    const { samples, rate, ...rest } = r;
    summary[key] = rest;
    console.log(
      `${name} ${key.padEnd(14)} peak ${String(rest.peak_dbfs).padStart(6)} · RMS while audible ${String(rest.rms_while_audible_dbfs).padStart(6)} · ` +
        `phone-speaker range (above 300 Hz) ${String(rest.above_300hz_rms_dbfs).padStart(6)} dBFS · audible ${rest.audible_ms} ms · under 150 Hz ${rest.under_150hz_percent}%${rest.clips ? " · CLIPS" : ""}`,
    );
  }
  writeFileSync(resolve(out, `${name}-sound.json`), JSON.stringify(summary, null, 2) + "\n");
  console.log(`saved ${out}`);
} finally {
  await browser.close();
  await server.close();
}
