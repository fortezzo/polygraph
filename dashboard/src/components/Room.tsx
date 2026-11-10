import type { ReactNode } from "react";

/** The near-black room with one warm overhead light and film grain (PLAN.md section 8). */
export function Room({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-dvh">
      <div className="lamp" aria-hidden="true" />
      <div className="relative z-10">{children}</div>
      <div className="grain" aria-hidden="true" />
    </div>
  );
}
