import type { VerdictIcon } from "../data/verdicts";

export type IconName = VerdictIcon | "pause" | "play" | "restart" | "sound-off" | "sound-on" | "document" | "pending" | "stop" | "saved";

const PATHS: Record<IconName, string> = {
  check: "M4.5 12.5l5 5.5L19.5 6.5",
  cross: "M6 6l12 12M18 6L6 18",
  down: "M12 4v15M6 13l6 6 6-6",
  notequal: "M5 9.5h14M5 14.5h14M15.5 5l-7 14",
  tilde: "M4 13.5c3-4.5 5.5-4.5 8-1.5s5 3 8-1.5",
  pause: "M8.5 5.5v13M15.5 5.5v13",
  play: "M8 5.5l11 6.5-11 6.5z",
  restart: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5V9H15",
  "sound-off": "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5",
  "sound-on": "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11",
  document: "M7 3.5h7l4 4v13H7zM14 3.5v4h4M9.5 12h6M9.5 15h6M9.5 18h4",
  pending: "M7 4h10M7 20h10M8 4c0 5 8 5 8 8s-8 3-8 8M16 4c0 5-8 5-8 8",
  stop: "M7 7h10v10H7z",
  saved: "M6 4h12v16l-6-4-6 4z",
};

/** A stroke icon. Decorative: whatever it sits next to carries the words. */
export function Icon({ name, className = "", strokeWidth = 2.4 }: { name: IconName; className?: string; strokeWidth?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
