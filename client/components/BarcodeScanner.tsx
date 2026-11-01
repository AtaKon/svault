import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { BarcodeFormat } from "@zxing/library";
import { Button, Spinner, cn } from "@/components/ui";
import { Icon } from "@/components/icons";

function friendlyCameraError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access was blocked. Allow the camera in your browser settings, or type the barcode below.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera found on this device. You can still type the barcode below.";
  }
  if (name === "NotReadableError") {
    return "The camera is busy in another app. Close it and try again, or type the barcode below.";
  }
  return "Could not start the camera. Type the barcode below instead.";
}

export function BarcodeScanner({
  onDetected,
  className,
}: {
  onDetected: (code: string, format?: string) => void;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const callbackRef = useRef(onDetected);
  callbackRef.current = onDetected;
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 140 });
    const element = videoRef.current;
    if (!element) return;
    setStarting(true);
    setError(null);

    reader
      .decodeFromConstraints({ video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } } }, element, (result) => {
        if (cancelled || !result) return;
        const text = result.getText();
        const now = Date.now();
        if (lastRef.current.code === text && now - lastRef.current.at < 2500) return;
        lastRef.current = { code: text, at: now };
        try {
          navigator.vibrate?.(60);
        } catch {
          /* ignore */
        }
        const formatName = BarcodeFormat[result.getBarcodeFormat() as unknown as keyof typeof BarcodeFormat];
        callbackRef.current(text, typeof formatName === "string" ? formatName : undefined);
      })
      .then((controls) => {
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setStarting(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStarting(false);
        setError(friendlyCameraError(err));
      });

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
      if (element.srcObject instanceof MediaStream) {
        element.srcObject.getTracks().forEach((track) => track.stop());
        element.srcObject = null;
      }
    };
  }, [facingMode, attempt]);

  return (
    <div className={cn("overflow-hidden rounded-3xl border border-line bg-black shadow-soft", className)}>
      <div className="relative aspect-[4/3] w-full sm:aspect-[16/10]">
        <video ref={videoRef} className="h-full w-full object-cover" muted playsInline autoPlay />
        {(starting || error) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#12100e] px-6 text-center text-white/80">
            {error ? (
              <>
                <Icon name="alert" size={26} className="text-amber-300" />
                <p className="max-w-xs text-xs leading-relaxed">{error}</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>
                    Retry
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Spinner size={24} />
                <p className="text-xs">Starting camera…</p>
              </>
            )}
          </div>
        )}

        {!error && (
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute inset-[12%] rounded-2xl border border-white/20" />
            {[
              "left-[12%] top-[12%] border-l-2 border-t-2",
              "right-[12%] top-[12%] border-r-2 border-t-2",
              "left-[12%] bottom-[12%] border-b-2 border-l-2",
              "right-[12%] bottom-[12%] border-b-2 border-r-2",
            ].map((corner) => (
              <div key={corner} className={cn("absolute h-7 w-7 rounded-[6px] border-white/90", corner)} />
            ))}
            <div className="absolute left-[12%] right-[12%] top-1/2 h-px bg-brand/70 shadow-[0_0_12px_2px_rgba(79,191,148,0.6)]" />
            <div className="absolute inset-x-0 bottom-3 text-center text-[11px] font-medium text-white/70">
              Point the camera at a barcode
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setFacingMode((mode) => (mode === "environment" ? "user" : "environment"))}
          className="absolute right-3 top-3 flex h-9 items-center gap-1.5 rounded-full bg-black/50 px-3 text-[11px] font-medium text-white/90 backdrop-blur transition-colors hover:bg-black/65"
        >
          <Icon name="refresh" size={13} />
          Flip
        </button>
      </div>
    </div>
  );
}
