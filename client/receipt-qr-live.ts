import { decodeReceiptQrFrame, rgbaToGray } from "./receipt-qr.js";

/* Structural types: BarcodeDetector is not part of the TS DOM lib. */
interface DetectedBarcodeLike {
  rawValue: string;
  format: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcodeLike[]>;
}

interface BarcodeDetectorStatic {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

/** Capabilities the DOM types do not model yet. */
interface MediaTrackCapabilityExtras {
  torch?: boolean;
  focusMode?: string[];
}

// applyConstraints payloads defined by browsers but absent from the DOM lib.
const FOCUS_CONTINUOUS = { advanced: [{ focusMode: "continuous" }] } as unknown as MediaTrackConstraints;
const torchConstraint = (on: boolean) => ({ advanced: [{ torch: on }] }) as unknown as MediaTrackConstraints;

export interface LiveQrScanHandle {
  /** Report whether the torch setting was applied while the scan was active. */
  setTorch(on: boolean): Promise<boolean>;
  /** True when the camera track can control the torch. */
  torchAvailable: boolean;
}

const FRAME_INTERVAL_MS = 250;
const MAX_FRAME_SIDE = 1280;

export async function startLiveQrScan(
  video: HTMLVideoElement,
  onPayload: (text: string) => void,
  signal: AbortSignal,
): Promise<LiveQrScanHandle> {
  signal.throwIfAborted();
  const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorStatic }).BarcodeDetector;
  let detector: BarcodeDetectorLike | null = null;
  if (Detector) {
    try {
      if ((await Detector.getSupportedFormats?.())?.includes("qr_code")) {
        detector = new Detector({ formats: ["qr_code"] });
      }
    } catch {
      // Fall back to ZXing when the native detector cannot start.
    }
  }

  let stream: MediaStream | undefined;
  let stopped = false;
  let scanning = false;
  let canvas: HTMLCanvasElement | null = null;
  let grayBuffer: Uint8ClampedArray | undefined;
  let interval: number | undefined;
  const stop = () => {
    stopped = true;
    signal.removeEventListener("abort", stop);
    if (interval !== undefined) {
      window.clearInterval(interval);
      interval = undefined;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      if (video.srcObject === stream) video.srcObject = null;
      stream = undefined;
    }
    canvas = null;
    grayBuffer = undefined;
  };

  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    // The permission prompt can resolve after the abort handler ran without a stream.
    signal.throwIfAborted();
    video.srcObject = stream;
    await video.play();
    signal.throwIfAborted();
  } catch (error) {
    stop();
    throw error;
  }

  const track = stream.getVideoTracks()[0];
  let torchSupported = false;
  try {
    const capabilities = track?.getCapabilities?.() as (MediaTrackCapabilities & MediaTrackCapabilityExtras) | undefined;
    torchSupported = capabilities?.torch === true;
    if (capabilities?.focusMode?.includes("continuous")) {
      void track.applyConstraints(FOCUS_CONTINUOUS).catch(() => undefined);
    }
  } catch {
    // Cameras can use their default focus mode if constraints are unavailable.
  }

  interval = window.setInterval(() => {
    if (stopped || scanning || video.readyState < 2) return;
    scanning = true;
    void (async () => {
      try {
        if (detector) {
          try {
            const codes = await detector.detect(video);
            for (const code of codes) {
              if (stopped) return;
              if (code.format === "qr_code" && code.rawValue) onPayload(code.rawValue);
            }
            return;
          } catch {
            // A native detection failure switches this session to ZXing.
            detector = null;
          }
        }
        // ZXing fallback (iOS Safari and friends): one downscaled grayscale
        // frame through the still decoder's fast passes.
        if (stopped || !video.videoWidth || !video.videoHeight) return;
        const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.round(video.videoWidth * scale);
        const height = Math.round(video.videoHeight * scale);
        canvas ??= document.createElement("canvas");
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return;
        context.drawImage(video, 0, 0, width, height);
        const pixels = rgbaToGray(context.getImageData(0, 0, width, height).data, width, height, grayBuffer);
        grayBuffer = pixels.gray;
        const text = decodeReceiptQrFrame(pixels);
        if (text) onPayload(text);
      } catch {
        /* A single bad frame never ends the scan. */
      } finally {
        scanning = false;
      }
    })();
  }, FRAME_INTERVAL_MS);

  return {
    setTorch: async (on) => {
      if (!torchSupported || stopped) return false;
      try {
        await track.applyConstraints(torchConstraint(on));
        return !stopped;
      } catch {
        return false;
      }
    },
    torchAvailable: torchSupported,
  };
}
