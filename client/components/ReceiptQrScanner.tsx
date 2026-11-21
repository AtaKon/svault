import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Spinner, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useI18n } from "@/i18n";
import type { LiveQrScanHandle } from "@/receipt-qr-live";
import { matchReceiptQrLink, type ReceiptQrLink } from "@shared/receipt-qr-links";

function friendlyCameraError(error: unknown, t: (key: string) => string): string {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return t("Camera access was blocked. Allow the camera in your browser settings, or photograph the receipt instead.");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return t("No camera found on this device. You can still photograph the receipt.");
  }
  if (name === "NotReadableError") {
    return t("The camera is busy in another app. Close it and try again, or photograph the receipt instead.");
  }
  return t("Could not start the camera. You can photograph the receipt instead.");
}

export function ReceiptQrScanner({
  onLink,
  onClose,
  onPhotograph,
}: {
  onLink: (link: ReceiptQrLink) => void;
  onClose: () => void;
  onPhotograph: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanRef = useRef<LiveQrScanHandle | null>(null);
  const callbacks = useRef({ onLink, t });
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [pendingTorchHandle, setPendingTorchHandle] = useState<LiveQrScanHandle | null>(null);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useLayoutEffect(() => {
    callbacks.current = { onLink, t };
  }, [onLink, t]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const scan = new AbortController();
    let lastPayload = "";
    let lastPayloadAt = 0;
    let noticeTimer: number | undefined;
    setStarting(true);
    setError(null);
    setNotice(null);
    setTorchAvailable(false);
    setTorchOn(false);
    setPendingTorchHandle(null);

    const stopScan = () => {
      const handle = scanRef.current;
      scanRef.current = null;
      // The handle starts owning the stream after initialization completes.
      if (handle) handle.stop();
      else scan.abort();
    };

    const onPayload = (payload: string) => {
      const now = Date.now();
      if (lastPayload === payload && now - lastPayloadAt < 2500) return;
      lastPayload = payload;
      lastPayloadAt = now;
      const link = matchReceiptQrLink(payload);
      window.clearTimeout(noticeTimer);
      if (!link) {
        setNotice(callbacks.current.t("This QR code is not a receipt link."));
        noticeTimer = window.setTimeout(() => setNotice(null), 4000);
        return;
      }
      stopScan();
      callbacks.current.onLink(link);
    };

    import("@/receipt-qr-live")
      .then(({ startLiveQrScan }) => startLiveQrScan(element, onPayload, scan.signal))
      .then((handle) => {
        if (scan.signal.aborted) return;
        scanRef.current = handle;
        setTorchAvailable(handle.torchAvailable);
        setStarting(false);
      })
      .catch((err: unknown) => {
        if (scan.signal.aborted) return;
        setStarting(false);
        setError(friendlyCameraError(err, callbacks.current.t));
      });

    return () => {
      stopScan();
      window.clearTimeout(noticeTimer);
    };
  }, [attempt]);

  const toggleTorch = async () => {
    const handle = scanRef.current;
    if (!handle || pendingTorchHandle === handle) return;
    const next = !torchOn;
    setPendingTorchHandle(handle);
    try {
      const applied = await handle.setTorch(next);
      if (applied && scanRef.current === handle) setTorchOn(next);
    } finally {
      setPendingTorchHandle((pending) => pending === handle ? null : pending);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-label={t("Scan receipt code")}
      onClose={onClose}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-hidden bg-black p-0"
    >
      <video ref={videoRef} className="h-full w-full object-cover" muted playsInline autoPlay />
      {(starting || error) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#12100e] px-6 text-center text-white/80">
          {error ? (
            <>
              <Icon name="alert" size={26} className="text-amber-300" />
              <p className="max-w-xs text-xs leading-relaxed">{error}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>
                  {t("Retry")}
                </Button>
                <Button size="sm" variant="secondary" icon="camera" onClick={() => {
                  dialogRef.current?.close();
                  onPhotograph();
                }}>
                  {t("Photograph instead")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Spinner size={24} />
              <p role="status" className="text-xs">{t("Starting camera…")}</p>
            </>
          )}
        </div>
      )}

      {!starting && !error && (
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-[42%] aspect-square w-[68%] max-w-[340px] -translate-x-1/2 -translate-y-1/2">
            <div className="absolute inset-0 rounded-2xl border border-white/20" />
            {[
              "left-0 top-0 border-l-2 border-t-2",
              "right-0 top-0 border-r-2 border-t-2",
              "left-0 bottom-0 border-b-2 border-l-2",
              "right-0 bottom-0 border-b-2 border-r-2",
            ].map((corner) => (
              <div key={corner} className={cn("absolute h-8 w-8 rounded-[6px] border-white/90", corner)} />
            ))}
          </div>
          <div className="absolute inset-x-0 bottom-8 px-6 text-center text-[11px] font-medium leading-relaxed text-white/70">
            {t("Point the camera at the receipt's QR code")}
          </div>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-3 top-14 rounded-xl bg-black/75 px-3 py-2 text-center text-[11px] leading-relaxed text-white shadow-soft"
        >
          {notice}
        </div>
      )}

      <button
        type="button"
        onClick={() => dialogRef.current?.close()}
        aria-label={t("Close")}
        className="absolute left-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white/90 backdrop-blur transition-colors hover:bg-black/65"
      >
        <Icon name="close" size={16} />
      </button>

      {torchAvailable && (
        <button
          type="button"
          onClick={() => void toggleTorch()}
          disabled={pendingTorchHandle !== null}
          aria-pressed={torchOn}
          aria-label={t("Light")}
          className={cn(
            "absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white/90 backdrop-blur transition-colors hover:bg-black/65",
            torchOn && "text-amber-300",
          )}
        >
          <Icon name="sun" size={16} />
        </button>
      )}
    </dialog>
  );
}
