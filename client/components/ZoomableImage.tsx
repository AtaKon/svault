import { useState, type ReactNode } from "react";
import { ImageLightbox } from "@/components/ImageLightbox";
import { cn } from "@/components/ui";

/**
 * A photo that opens in the full-size viewer when clicked, the same way
 * inventory item photos do. The wrapper stays in the layout, so callers keep
 * their existing sizing classes; a transparent button sits above the image and
 * stops the click from reaching a surrounding card or link.
 */
export function ZoomableImage({
  src,
  alt = "",
  label,
  className,
  wrapperClassName,
  overlay,
  loading,
}: {
  src: string;
  alt?: string;
  /** Accessible name for the open button. Defaults to the image alt text. */
  label?: string;
  /** Classes for the image itself. */
  className?: string;
  /** Classes for the wrapping element that carries the click target. */
  wrapperClassName?: string;
  /** Optional badge or icon drawn on top of the photo. */
  overlay?: ReactNode;
  loading?: "lazy" | "eager";
}) {
  const [open, setOpen] = useState(false);
  const buttonLabel = label ?? (alt ? `View full-size image: ${alt}` : "View full-size image");

  return (
    <>
      <div className={cn("group relative", wrapperClassName)}>
        <img src={src} alt={alt} loading={loading} className={className} />
        <button
          type="button"
          aria-label={buttonLabel}
          title="View full-size image"
          className="absolute inset-0 cursor-zoom-in rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }}
        />
        {overlay}
      </div>
      {open && <ImageLightbox src={src} alt={alt || buttonLabel} onClose={() => setOpen(false)} />}
    </>
  );
}
