// The public demo site (Session 10), built with `npm run build:demo`, which is
// `vite build --mode demo`. It only replays recorded runs. Live mode needs
// Polygraph's server and its API keys, which only run on the computer where
// Polygraph is installed, so the demo never offers it.

export const DEMO: boolean = import.meta.env.MODE === "demo";
