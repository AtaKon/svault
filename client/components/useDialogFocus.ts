import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** Open dialogs, innermost last: only the top one answers Escape and Tab, so
 * a confirm dialog over a sheet closes alone. */
const openDialogs: symbol[] = [];

/**
 * Focus management for modal dialogs, shared by Sheet and ImageLightbox:
 * when the dialog opens, focus moves into it and the body scroll locks; Tab
 * cycles within the dialog instead of escaping behind the backdrop; Escape
 * closes it; and focus returns to the element that opened it. Returns the ref
 * to attach to the dialog container, which should carry tabIndex={-1} so it
 * can hold focus when it has no focusable children.
 */
export function useDialogFocus(open: boolean, onClose: () => void): RefObject<HTMLDivElement | null> {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const token = Symbol("dialog");
    openDialogs.push(token);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus moves in after the portal content has painted.
    const focusTimer = window.setTimeout(() => {
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      (focusable?.length ? focusable[0] : dialogRef.current)?.focus();
    }, 0);

    const onKey = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== token) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKey, true);
      const index = openDialogs.indexOf(token);
      if (index >= 0) openDialogs.splice(index, 1);
      document.body.style.overflow = bodyOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  return dialogRef;
}
