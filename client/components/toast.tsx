import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { cn } from "./ui";

type ToastTone = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastApi {
  push: (message: string, tone?: ToastTone) => void;
  error: (message: string) => void;
  success: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const push = useCallback((message: string, tone: ToastTone = "info") => {
    const id = ++counter.current;
    setToasts((current) => [...current.slice(-2), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  }, []);

  const value = useMemo<ToastApi>(
    () => ({
      push,
      error: (message) => push(message, "error"),
      success: (message) => push(message, "success"),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] flex flex-col items-center gap-2 px-4 sm:bottom-8">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto flex max-w-sm items-start gap-2.5 rounded-2xl border px-3.5 py-2.5 text-sm shadow-soft rise-in",
              toast.tone === "error"
                ? "border-danger/30 bg-danger-soft text-danger"
                : toast.tone === "success"
                  ? "border-brand/25 bg-brand-soft text-brand"
                  : "border-line bg-surface text-ink",
            )}
          >
            <Icon
              name={toast.tone === "error" ? "alert" : toast.tone === "success" ? "check" : "bell"}
              size={17}
              className="mt-0.5 shrink-0"
            />
            <span className="leading-snug">{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}

export type { IconName };
