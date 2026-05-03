import React from "react";
import { createRoot } from "react-dom/client";
import "tldraw/tldraw.css";
import "./styles.css";
import { App } from "./App";
import { LanguageProvider } from "./i18n";

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>
);
