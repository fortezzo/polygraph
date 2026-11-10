// Dates are shown in the time zone they were recorded in, read straight from the
// text ("2026-11-09T15:48:46-06:00"), so the date never shifts with the viewer's clock.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

export function recordedDate(iso: string | undefined): string | null {
  const m = iso ? ISO.exec(iso) : null;
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : null;
}

export function recordedTime(iso: string | undefined): string | null {
  const m = iso ? ISO.exec(iso) : null;
  if (!m) return null;
  const h = Number(m[4]);
  return `${h % 12 || 12}:${m[5]} ${h >= 12 ? "PM" : "AM"}`;
}

/** "Nov 9, 2026", or "Nov 8 – 9, 2026" when the answers were recorded over several days. */
export function recordedRange(isos: (string | undefined)[]): string | null {
  const days = [...new Set(isos.filter((s): s is string => !!s && ISO.test(s)).map((s) => s.slice(0, 10)))].sort();
  if (days.length === 0) return null;
  const first = recordedDate(`${days[0]}T00:00`);
  const last = recordedDate(`${days[days.length - 1]}T00:00`);
  if (!first || !last || first === last) return first;
  const [fm, fd, fy] = first.replace(",", "").split(" ");
  const [lm, ld, ly] = last.replace(",", "").split(" ");
  if (fy === ly && fm === lm) return `${fm} ${fd} – ${ld}, ${fy}`;
  return `${first} – ${last}`;
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
