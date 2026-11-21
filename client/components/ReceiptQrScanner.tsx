import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, IconButton, Spinner } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useI18n } from "@/i18n";
import type { LiveQrScanHandle, TorchState } from "@/receipt-qr-live";
import { matchReceiptQrLink, type ReceiptQrLink } from "@shared/receipt-qr-links";

function friendlyCameraError(error: unknown, t: (key: string) => string): string {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return t("Allow camera access in your browser settings.");
  }
  if (name === "NotFoundError") {
    return t("No camera found on this device.");
  }
  if (name === "NotReadableError") {
    return t("The camera is busy. Close other apps and retry.");
  }
  return t("Could not start the camera.");
}

export function ReceiptQrScanner({
  onLink,
  onClose,
  onPhotograph,
}: {
  onLink: (link: ReceiptQrLink) => boolean;
  onClose: () => void;
  onPhotograph: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanRef = useRef<LiveQrScanHandle | null>(null);
  const stopScanRef = useRef<(() => void) | null>(null);
  const pendingTorchRef = useRef<LiveQrScanHandle | null>(null);
  const callbacks = useRef({ onLink, t });
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [torch, setTorch] = useState<TorchState>({ requested: false, reported: false });
  const [torchPending, setTorchPending] = useState(false);
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
    let handled = false;
    let lastPayload = "";
    let lastPayloadAt = 0;
    let noticeTimer: number | undefined;
    setStarting(true);
    setError(null);
    setNotice(null);
    setTorchAvailable(false);
    setTorch({ requested: false, reported: false });
    pendingTorchRef.current = null;
    setTorchPending(false);

    const stopScan = () => {
      window.clearTimeout(noticeTimer);
      const handle = scanRef.current;
      scanRef.current = null;
      // The handle starts owning the stream after initialization completes.
      if (handle) handle.stop();
      else scan.abort();
    };
    stopScanRef.current = stopScan;

    const onPayload = (payload: string) => {
      if (handled) return;
      const link = matchReceiptQrLink(payload);
      if (link && callbacks.current.onLink(link)) {
        handled = true;
        stopScan();
        return;
      }
      const now = Date.now();
      if (lastPayload === payload && now - lastPayloadAt < 2500) return;
      lastPayload = payload;
      lastPayloadAt = now;
      window.clearTimeout(noticeTimer);
      const { t } = callbacks.current;
      setNotice(link
        ? t("Wait for the current receipt operation to finish.")
        : t("This QR code is not a receipt link."));
      noticeTimer = window.setTimeout(() => setNotice(null), 4000);
    };

    import("@/receipt-qr-live")
      .then(({ startLiveQrScan }) => startLiveQrScan(element, onPayload, scan.signal, () => {
        stopScan();
        setTorchAvailable(false);
        setError(callbacks.current.t("Could not scan the QR code."));
      }))
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
      stopScanRef.current = null;
      stopScan();
    };
  }, [attempt]);

  const photograph = () => {
    stopScanRef.current?.();
    dialogRef.current?.close();
    onPhotograph();
  };

  const toggleTorch = async () => {
    const handle = scanRef.current;
    if (!handle || pendingTorchRef.current === handle) return;
    const next = !(torch.reported ?? torch.requested);
    pendingTorchRef.current = handle;
    setTorchPending(true);
    try {
      const state = await handle.setTorch(next);
      if (state && scanRef.current === handle) setTorch(state);
    } finally {
      if (pendingTorchRef.current === handle) {
        pendingTorchRef.current = null;
        setTorchPending(false);
      }
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
              <Button size="sm" variant="secondary" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>
                {t("Retry")}
              </Button>
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
          <div className="absolute left-1/2 top-[42%] aspect-square w-[68%] max-w-[340px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border-2 border-white/70" />
          <div className="absolute inset-x-0 bottom-20 px-6 text-center text-[11px] font-medium leading-relaxed text-white/70">
            {t("Point the camera at the receipt's QR code")}
          </div>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-6 flex justify-center">
        <Button size="sm" variant="secondary" icon="camera" onClick={photograph}>
          {t("Photograph instead")}
        </Button>
      </div>

      {notice && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-3 top-14 rounded-xl bg-black/75 px-3 py-2 text-center text-[11px] leading-relaxed text-white shadow-soft"
        >
          {notice}
        </div>
      )}

      <IconButton
        type="button"
        onClick={() => dialogRef.current?.close()}
        icon="close"
        label={t("Close")}
        variant="secondary"
        className="absolute left-3 top-3"
      />

      {torchAvailable && (
        <IconButton
          type="button"
          onClick={() => void toggleTorch()}
          disabled={torchPending}
          aria-pressed={torch.reported ?? "mixed"}
          icon="sun"
          label={t("Light")}
          variant={torch.reported ? "primary" : "secondary"}
          className="absolute right-3 top-3"
        />
      )}
    </dialog>
  );
}
