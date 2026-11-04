import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icons";

/**
 * Full-size image viewer. The image keeps its aspect ratio and is shown as
 * large as the viewport allows. Close it with the button, Escape or a tap on
 * the backdrop; focus returns to the element that opened it.
 */
export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
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
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = bodyOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `Full-size image: ${alt}` : "Full-size image"}
      className="fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-3 sm:p-6"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        ref={closeRef}
        type="button"
        aria-label="Close full-size image"
        title="Close"
        className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-white sm:right-5 sm:top-5"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        <Icon name="close" size={20} />
      </button>

      <img
        src={src}
        alt={alt}
        draggable={false}
        decoding="async"
        className="max-h-full max-w-full select-none rounded-lg object-contain shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      />

      {alt && (
        <p className="pointer-events-none absolute inset-x-4 bottom-3 truncate text-center text-xs text-white/70 sm:bottom-5">{alt}</p>
      )}
    </div>,
    document.body,
  );
}
