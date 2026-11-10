// Shared by the three direction mockups (Session 6, step 1). It fills in the
// real recorded text from sample.js and draws a still needle trace. This is
// mockup code only. The real dashboard is built after Christian's pick.
(function () {
  const S = window.SAMPLE;
  const trap = S.traps.find((t) => t.id === "ghost-004");
  const answerTurn = trap.conversations[0].turns.find((t) => t.role === "assistant");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // "2026-11-09T15:48:46-06:00" -> "Nov 9, 2026" and "3:48 PM", in the
  // recorded time zone (read straight from the text, no conversion).
  function recordedDate(iso) {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return `${MONTHS[m - 1]} ${d}, ${y}`;
  }
  function recordedTime(iso) {
    let [h, min] = iso.slice(11, 16).split(":").map(Number);
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${String(min).padStart(2, "0")} ${ap}`;
  }

  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Just enough Markdown for the mockups: paragraphs, bullets, bold, italics.
  // The made-up phrase is marked first, so the highlight wraps the exact words.
  function renderAnswer(raw, phrase) {
    let text = raw;
    if (phrase) text = text.replace(phrase, "\u0001" + phrase + "\u0002");
    const blocks = text.trim().split(/\n\s*\n/);
    const inline = (s) =>
      escapeHtml(s)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/\u0001/g, '<mark class="madeup">')
        .replace(/\u0002/g, "</mark>");
    return blocks
      .map((b) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*\*\s+/.test(l))) {
          return "<ul>" + lines.map((l) => "<li>" + inline(l.replace(/^\s*\*\s+/, "")) + "</li>").join("") + "</ul>";
        }
        return "<p>" + inline(lines.join(" ")) + "</p>";
      })
      .join("");
  }

  const iso = answerTurn.call.first_collected_at;
  const M = {
    question: trap.trap.question,
    answerHtml: renderAnswer(answerTurn.content, trap.made_up_phrase),
    answerChars: answerTurn.content.length.toLocaleString("en-US"),
    confidence: answerTurn.confidence.value,
    confidenceReply: answerTurn.confidence.reply.trim(),
    truth: trap.trap.truth,
    source: trap.trap.source.title,
    reason: trap.reason,
    votesFor: trap.judgement.votes.filter((v) => v.verdict === trap.verdict).length,
    votes: trap.judgement.votes.length,
    model: S.run.target.model,
    family: "Gemma 3 12B",
    maker: S.run.judge.bot_company,
    via: S.run.target.provider_label,
    judge: S.run.judge.model,
    judgeCo: S.run.judge.company,
    date: recordedDate(iso),
    time: recordedTime(iso),
    stamp: iso.slice(0, 10).replace(/-/g, ".") + " " + iso.slice(11, 19),
    index: S.traps.indexOf(trap) + 1,
    total: S.traps.length,
    typeLabel: trap.label,
    trapId: trap.id,
    needleNote:
      "The needle shows where Polygraph’s judge found made-up words, replayed in sync with the answer. It’s not a live signal.",
  };
  window.MOCK = M;

  // Text: <span data-bind="question"></span>. HTML: data-bind-html.
  document.querySelectorAll("[data-bind]").forEach((el) => {
    el.textContent = M[el.dataset.bind];
  });
  document.querySelectorAll("[data-bind-html]").forEach((el) => {
    el.innerHTML = M[el.dataset.bindHtml];
  });

  // Icons (the same five glyphs as the terminal report, drawn as strokes).
  const ICONS = {
    honest: '<path d="M4.5 12.5l5 5.5L19.5 6.5"/>',
    lie: '<path d="M6 6l12 12M18 6L6 18"/>',
    caved: '<path d="M12 4v15M6 13l6 6 6-6"/>',
    contradicted: '<path d="M5 9.5h14M5 14.5h14M15.5 5l-7 14"/>',
    dodged: '<path d="M4 13.5c3-4.5 5.5-4.5 8-1.5s5 3 8-1.5"/>',
    pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
    restart: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5V9H15"/>',
    soundoff: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    play: '<path d="M8 5.5l11 6.5-11 6.5z"/>',
  };
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML =
      '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      ICONS[el.dataset.icon] +
      "</svg>";
  });

  // A still needle trace. Time runs left to right and the pen is at penX.
  // The calm part is a slow breathing wave plus a little jitter; the spike is
  // a damped swing that starts where the made-up words streamed in.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  window.makeTrace = function ({
    width, height, penX, pxPerSec = 46, spikeAt, calmAmp = 0.11,
    spikeAmp = 0.42, quietFrom = -1, quietTo = -1, seed = 7, step = 2,
  }) {
    const rnd = mulberry32(seed);
    const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
    let walk = 0;
    const mid = height / 2;
    const pts = [];
    for (let x = 0; x <= penX; x += step) {
      const t = (x - penX) / pxPerSec; // seconds before "now" (negative)
      walk = walk * 0.86 + (rnd() - 0.5) * 0.5;
      // While the question is typed out, the bot isn't answering: flatter line.
      const quiet = x >= quietFrom && x < quietTo ? 0.35 : 1;
      let v =
        quiet * calmAmp * (0.62 * Math.sin(2 * Math.PI * 0.23 * t + ph[0]) +
          0.28 * Math.sin(2 * Math.PI * 1.15 * t + ph[1]) +
          0.12 * Math.sin(2 * Math.PI * 2.9 * t + ph[2]) +
          0.35 * walk);
      let red = false;
      if (spikeAt != null) {
        const ts = (x - spikeAt) / pxPerSec;
        if (ts >= -0.05 && ts < 2.2) {
          const e = Math.exp(-Math.max(ts, 0) / 0.55);
          v += spikeAmp * e * (Math.sin(2 * Math.PI * 2.1 * Math.max(ts, 0)) + 0.18 * Math.sin(2 * Math.PI * 9 * ts));
          red = ts < 1.7;
        }
      }
      pts.push({ x, y: mid - v * height, red });
    }
    // Build the two paths (calm and red) as runs of points.
    const runs = { calm: "", red: "" };
    let cur = null, d = "";
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const kind = p.red ? "red" : "calm";
      if (kind !== cur) {
        if (cur) runs[cur] += d;
        // start the new run at the previous point so the line is unbroken
        const prev = pts[Math.max(i - 1, 0)];
        d = "M" + prev.x.toFixed(1) + " " + prev.y.toFixed(1);
        cur = kind;
      }
      d += "L" + p.x.toFixed(1) + " " + p.y.toFixed(1);
    }
    if (cur) runs[cur] += d;
    return { calm: runs.calm, red: runs.red, penY: pts[pts.length - 1].y, mid };
  };
})();
