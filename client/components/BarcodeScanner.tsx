import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { Button, Spinner, cn } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useI18n } from "@/i18n";
import { parseLabelScan } from "@shared/label-links";
import { nativeFormatName, PRODUCT_BARCODE_FORMATS } from "@/barcode-camera";
import { openBarcodeCamera, setBarcodeTorch, stopBarcodeStream, storeLensId } from "@/barcode-camera-stream";
import { nextDecodeFailureCount, nextTorchTarget, resolveTorchState, type TorchState } from "@/receipt-qr-live-state";

const DUPLICATE_SUPPRESSION_MS = 2500;
const NATIVE_SCAN_INTERVAL_MS = 150;
const NATIVE_RESPONSE_TIMEOUT_MS = 4000;
const MAX_CONSECUTIVE_NATIVE_FAILURES = 2;

type DetectedCode = { rawValue: string; format: string };

interface NativeBarcodeDetectorClass {
  new (options: { formats: string[] }): { detect(source: HTMLVideoElement): Promise<DetectedCode[]> };
  getSupportedFormats(): Promise<string[]>;
}

// The ZXing hint needs BarcodeFormat values, which nativeFormatName derives
// from the shared native format list, so both paths decode the same formats.
const ZXING_PRODUCT_FORMATS: BarcodeFormat[] = PRODUCT_BARCODE_FORMATS.map((format) =>
  BarcodeFormat[nativeFormatName(format) as keyof typeof BarcodeFormat],
);

function friendlyCameraError(error: unknown, t: (key: string) => string): string {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return t("Camera access was blocked. Allow the camera in your browser settings, or type the barcode below.");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return t("No camera found on this device. You can still type the barcode below.");
  }
  if (name === "NotReadableError") {
    return t("The camera is busy in another app. Close it and try again, or type the barcode below.");
  }
  return t("Could not start the camera. Type the barcode below instead.");
}

const overlayButtonClass =
  "flex h-9 items-center gap-1.5 rounded-full bg-black/50 px-3 text-[11px] font-medium text-white/90 backdrop-blur transition-colors hover:bg-black/65";

export function BarcodeScanner({
  onDetected,
  className,
}: {
  onDetected: (code: string, format?: string) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const callbackRef = useRef(onDetected);
  callbackRef.current = onDetected;
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const noticeTimer = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<AbortController | null>(null);
  const pausedRef = useRef(false);
  // Set right before a recognised label QR navigates away: from that moment
  // the scanner is done, and neither the visibilitychange handler nor the
  // camera effect may reopen the camera behind the next page. The location
  // effect below clears it once the navigation settles, for a label whose
  // target route keeps this component mounted.
  const navigatingRef = useRef(false);
  const torchPendingRef = useRef<MediaStream | null>(null);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [attempt, setAttempt] = useState(0);
  // A lens the user cycled to manually; it overrides the automatic pick and
  // is remembered in localStorage by the camera stream module.
  const [lens, setLens] = useState<string | null>(null);
  // Bumped to restart the camera after the page becomes visible again.
  const [cameraEpoch, setCameraEpoch] = useState(0);
  const [torch, setTorch] = useState<TorchState>({ requested: false, reported: false });
  const [torchPending, setTorchPending] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [rearLenses, setRearLenses] = useState<{ deviceId: string; label: string }[]>([]);
  const [activeLensId, setActiveLensId] = useState<string | null>(null);

  // A label QR whose target route is the one already shown keeps this
  // component mounted: the navigation pushes a new history entry (a new
  // location key) without unmounting the scanner. Once it settles, the flag
  // is cleared and the camera epoch bumped, so scanning resumes. A
  // label that points elsewhere unmounts this component, so the flag never
  // clears behind a different page.
  useEffect(() => {
    if (!navigatingRef.current) return;
    navigatingRef.current = false;
    setCameraEpoch((n) => n + 1);
  }, [location.key]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    // A label QR already released the camera for navigation; do not open a
    // new stream for a dep change (facing mode, epoch, …) on the way out.
    if (navigatingRef.current) return;
    const session = new AbortController();
    const signal = session.signal;
    sessionRef.current = session;
    let stream: MediaStream | null = null;
    let zxingControls: IScannerControls | null = null;
    let nativeInterval: number | undefined;
    let detector: InstanceType<NativeBarcodeDetectorClass> | null = null;
    let nativeFailures = 0;
    let scanning = false;
    let released = false;

    setStarting(true);
    setError(null);
    setTorchAvailable(false);
    setTorch({ requested: false, reported: false });
    torchPendingRef.current = null;
    setTorchPending(false);
    setRearLenses([]);
    setActiveLensId(null);

    const releaseCamera = () => {
      released = true;
      if (sessionRef.current === session) sessionRef.current = null;
      if (nativeInterval !== undefined) {
        window.clearInterval(nativeInterval);
        nativeInterval = undefined;
      }
      try {
        zxingControls?.stop();
      } catch {
        /* ignore */
      }
      zxingControls = null;
      detector = null;
      if (streamRef.current === stream) streamRef.current = null;
      const acquired = stream;
      stream = null;
      stopBarcodeStream(acquired);
      if (acquired && element.srcObject === acquired) {
        element.pause();
        element.srcObject = null;
      }
    };
    signal.addEventListener("abort", releaseCamera, { once: true });

    const handleResult = (text: string, formatName: string | undefined) => {
      if (released || !text) return;
      const now = Date.now();
      if (lastRef.current.code === text && now - lastRef.current.at < DUPLICATE_SUPPRESSION_MS) return;
      lastRef.current = { code: text, at: now };
      try {
        navigator.vibrate?.(60);
      } catch {
        /* ignore */
      }
      // A QR code is never a product barcode. SVault labels open in the app;
      // any other QR payload is ignored with a short message. QR_CODE stays
      // in the shared format list on both decode paths for that reason.
      if (formatName === "QR_CODE") {
        const target = parseLabelScan(text, window.location.origin);
        if (target) {
          navigatingRef.current = true;
          releaseCamera();
          navigate(target.path);
          return;
        }
        setNotice(t("That QR code is not an SVault label."));
        if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
        noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
        return;
      }
      callbackRef.current(text, typeof formatName === "string" ? formatName : undefined);
    };

    const startZxing = async () => {
      if (released) return;
      // Hints narrow ZXing to the product formats and ask for the slow,
      // whole-image pass that blurry close-up phone frames need.
      const hints = new Map<DecodeHintType, unknown>();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, ZXING_PRODUCT_FORMATS);
      hints.set(DecodeHintType.TRY_HARDER, true);
      const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 140 });
      // decodeFromVideoElement reads the stream the component already owns:
      // its controls stop the decode loop only, never the stream itself, so
      // the release path below remains the single owner of the camera.
      const controls = await reader.decodeFromVideoElement(element, (result) => {
        if (released || !result) return;
        const formatName = BarcodeFormat[result.getBarcodeFormat() as unknown as keyof typeof BarcodeFormat];
        handleResult(result.getText(), typeof formatName === "string" ? formatName : undefined);
      });
      if (released) {
        controls.stop();
        return;
      }
      zxingControls = controls;
    };

    const scanNativeFrame = async () => {
      const active = detector;
      if (!active || released || scanning) return;
      if (element.readyState < 2 || !element.videoWidth) return;
      scanning = true;
      let codes: DetectedCode[] | null = null;
      try {
        // detect has no cancellation API; a late reply after the timeout
        // guard is dropped, exactly like the receipt QR scanner does.
        codes = await new Promise<DetectedCode[]>((resolve, reject) => {
          let settled = false;
          const timeout = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error("The native barcode detector timed out"));
          }, NATIVE_RESPONSE_TIMEOUT_MS);
          void active.detect(element).then(
            (found) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timeout);
              resolve(found);
            },
            (detectError) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timeout);
              reject(detectError);
            },
          );
        });
        nativeFailures = nextDecodeFailureCount(nativeFailures, false);
      } catch {
        if (released) return;
        // Repeated native failures retire the detector for this session and
        // hand the frames to ZXing instead.
        nativeFailures = nextDecodeFailureCount(nativeFailures, true);
        if (nativeFailures >= MAX_CONSECUTIVE_NATIVE_FAILURES) {
          // Ordering matters: clear the interval and null the detector BEFORE
          // awaiting startZxing(), so no further native frame can start while
          // ZXing boots up. `scanning` also stays true until the finally below,
          // so a frame already in flight bails instead of decoding alongside
          // the ZXing loop.
          if (nativeInterval !== undefined) {
            window.clearInterval(nativeInterval);
            nativeInterval = undefined;
          }
          detector = null;
          try {
            await startZxing();
          } catch (error) {
            setError(friendlyCameraError(error, t));
          }
        }
      } finally {
        scanning = false;
      }
      // handleResult runs outside the try/catch that counts native failures:
      // a throw from it (or from navigate) is not evidence that the detector
      // is broken, so it must not push the session toward the ZXing fallback.
      if (!codes || released) return;
      for (const code of codes) {
        if (released) return;
        if (code.rawValue) handleResult(code.rawValue, nativeFormatName(code.format));
      }
    };

    void (async () => {
      try {
        const handle = await openBarcodeCamera(facingMode, lens ?? undefined);
        // A stream that arrived after cancellation is released before it
        // is ever attached to the video.
        if (signal.aborted) {
          stopBarcodeStream(handle.stream);
          return;
        }
        stream = handle.stream;
        streamRef.current = handle.stream;
        element.srcObject = handle.stream;
        try {
          await element.play();
        } catch {
          // The video element has autoPlay; a rejected play() here means
          // the preview was interrupted, and no frames ever arrive.
        }
        if (signal.aborted) return;
        setTorchAvailable(handle.torchAvailable);
        setRearLenses(handle.rearCameras);
        setActiveLensId(handle.deviceId);
        // The requested lens may have been refused and the stream fallen
        // back to the automatic pick; drop the stale request so the lens
        // state matches the camera that is actually open. The null guard
        // keeps this from looping: a cleared lens never differs again.
        if (lens !== null && handle.deviceId !== lens) setLens(null);

        // Chrome Android's native BarcodeDetector is far faster than ZXing;
        // ZXing takes over when it is missing or fails repeatedly.
        const Detector = (globalThis as { BarcodeDetector?: NativeBarcodeDetectorClass }).BarcodeDetector;
        let formats: string[] | null = null;
        if (Detector) {
          try {
            const supported = await Detector.getSupportedFormats();
            const usable = Array.isArray(supported)
              ? PRODUCT_BARCODE_FORMATS.filter((format) => supported.includes(format))
              : [];
            formats = usable.length > 0 ? usable : null;
          } catch {
            formats = null;
          }
        }
        if (signal.aborted) return;
        if (Detector && formats) {
          detector = new Detector({ formats });
          nativeInterval = window.setInterval(() => void scanNativeFrame(), NATIVE_SCAN_INTERVAL_MS);
        } else {
          await startZxing();
          if (signal.aborted) return;
        }
        setStarting(false);
      } catch (err: unknown) {
        if (signal.aborted) return;
        setStarting(false);
        setError(friendlyCameraError(err, t));
      }
    })();

    return () => {
      if (sessionRef.current === session) sessionRef.current = null;
      session.abort();
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    };
    // A label navigation to the already shown route restarts the camera by
    // bumping cameraEpoch (see the location effect above). Other URL changes
    // on the hosting page leave the running camera alone.
  }, [facingMode, attempt, lens, cameraEpoch, t, navigate]);

  // Galaxy Chrome often shows a black preview after app switching: release
  // the camera while hidden and open a fresh stream on the way back.
  useEffect(() => {
    const onVisibilityChange = () => {
      // A label QR navigation already released the camera; reopening it for
      // a tab switch on the way to the next page would grab the camera
      // behind the page the user is navigating to.
      if (navigatingRef.current) return;
      if (document.visibilityState === "hidden") {
        pausedRef.current = true;
        setStarting(true);
        sessionRef.current?.abort();
      } else if (pausedRef.current) {
        pausedRef.current = false;
        setCameraEpoch((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const toggleTorch = async () => {
    const stream = streamRef.current;
    if (!stream || torchPendingRef.current === stream) return;
    const next = nextTorchTarget(torch);
    torchPendingRef.current = stream;
    setTorchPending(true);
    try {
      const state = await setBarcodeTorch(stream, next);
      // A failed request reports null and keeps the last state.
      if (streamRef.current === stream) setTorch((previous) => resolveTorchState(previous, state));
    } catch {
      // Keep the last reported state if the camera request fails.
    } finally {
      if (torchPendingRef.current === stream) {
        torchPendingRef.current = null;
        setTorchPending(false);
      }
    }
  };

  const cycleLens = () => {
    const options = rearLenses;
    if (options.length < 2) return;
    const current = activeLensId ? options.findIndex((option) => option.deviceId === activeLensId) : -1;
    const next = options[(current + 1) % options.length];
    if (!next?.deviceId) return;
    storeLensId(next.deviceId);
    setActiveLensId(next.deviceId);
    setLens(next.deviceId);
  };

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
                    {t("Retry")}
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
              {t("Point the camera at a barcode or an SVault label")}
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

        <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={() => setFacingMode((mode) => (mode === "environment" ? "user" : "environment"))}
            className={overlayButtonClass}
          >
            <Icon name="refresh" size={13} />
            {t("Flip")}
          </button>
          {torchAvailable && (
            // A successful request can come back without a camera read-back,
            // so the reported state stays unknown: the button intentionally
            // keeps showing "mixed" instead of guessing the requested value.
            <button
              type="button"
              onClick={() => void toggleTorch()}
              disabled={torchPending}
              aria-pressed={torch.reported ?? "mixed"}
              className={cn(overlayButtonClass, "disabled:opacity-60", torch.reported && "bg-brand/80 hover:bg-brand/90")}
            >
              <Icon name="sun" size={13} />
              {t("Light")}
            </button>
          )}
          {rearLenses.length >= 2 && facingMode === "environment" && (
            <button type="button" onClick={cycleLens} className={overlayButtonClass}>
              <Icon name="camera" size={13} />
              {t("Switch lens")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
