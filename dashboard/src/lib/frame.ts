// One animation loop for the whole screen. Everything that moves registers here,
// so it all updates in the same frame and in the same order.

type FrameFn = (now: number) => void;

const callbacks = new Set<FrameFn>();
let handle = 0;

function loop(now: number) {
  for (const fn of callbacks) fn(now);
  handle = callbacks.size ? requestAnimationFrame(loop) : 0;
}

export function onFrame(fn: FrameFn): () => void {
  callbacks.add(fn);
  if (!handle) handle = requestAnimationFrame(loop);
  return () => {
    callbacks.delete(fn);
  };
}
