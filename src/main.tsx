import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyBackgroundStyle, loadPreferences } from "./lib/preferences";
import "./styles.css";

// Apply the saved background style before React mounts so the first paint
// already matches the user's choice instead of flashing the default.
applyBackgroundStyle(loadPreferences().backgroundStyle);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

