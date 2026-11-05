import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "@/state";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/toast";
import { App } from "@/App";
import "@/styles.css";

declare global {
  interface Window {
    __svInstallPrompt?: { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> } | null;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <I18nProvider>
            <App />
          </I18nProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  window.__svInstallPrompt = event as unknown as Window["__svInstallPrompt"];
  window.dispatchEvent(new Event("sv:installable"));
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
