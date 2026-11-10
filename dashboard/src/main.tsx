import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Fonts are bundled with the app, so the dashboard never calls out to anyone.
import "@fontsource/courier-prime/400.css";
import "@fontsource/courier-prime/400-italic.css";
import "@fontsource/courier-prime/700.css";
import "@fontsource/courier-prime/700-italic.css";
import "@fontsource/special-elite/400.css";
import "@fontsource/oswald/600.css";
import "@fontsource/oswald/700.css";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
