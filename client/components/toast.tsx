import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { cn } from "./ui";

type ToastTone = "success" | "error" | "info";

export interface ToastAction {
  /** Button label, already translated. */
  label: string;
  /** Runs when the button is pressed; the toast closes straight after. */
  onClick: () => void;
}

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

export interface ToastOptions {
  /** Visible for this many milliseconds. Defaults to 4200. */
  duration?: number;
  /** Optional single button, for example Undo. */
  action?: ToastAction;
}

interface ToastApi {
  push: (message: string, tone?: ToastTone, options?: ToastOptions) => void;
  error: (message: string) => void;
  success: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION = 4200;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  /** Keep a toast with a button on screen while it is hovered or focused. */
  const hold = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (message: string, tone: ToastTone = "info", options?: ToastOptions) => {
      const id = ++counter.current;
      setToasts((current) => [...current.slice(-2), { id, message, tone, action: options?.action }]);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), options?.duration ?? DEFAULT_DURATION),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) window.clearTimeout(timer);
      active.clear();
    };
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
            role="status"
            aria-live="polite"
            onMouseEnter={() => hold(toast.id)}
            onFocus={() => hold(toast.id)}
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
            <span className="min-w-0 flex-1 leading-snug">{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                onClick={() => {
                  toast.action?.onClick();
                  dismiss(toast.id);
                }}
                className="-my-1 shrink-0 rounded-lg px-2 py-1 text-sm font-semibold underline decoration-2 underline-offset-2 transition-opacity hover:opacity-75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
              >
                {toast.action.label}
              </button>
            )}
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
