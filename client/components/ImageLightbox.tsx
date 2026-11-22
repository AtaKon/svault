import { createPortal } from "react-dom";
import { Icon } from "@/components/icons";
import { useDialogFocus } from "@/components/useDialogFocus";
import { useI18n } from "@/i18n";

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
  const { t } = useI18n();
  const dialogRef = useDialogFocus(true, onClose);

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `${t("Full-size image")}: ${alt}` : t("Full-size image")}
      tabIndex={-1}
      className="fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-3 focus:outline-none sm:p-6"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        aria-label={t("Close full-size image")}
        title={t("Close")}
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
