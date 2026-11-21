import { decodeReceiptQrFrame, rgbaToGray } from "./receipt-qr.js";

type DetectedCode = { rawValue: string; format: string };

interface NativeQrDetectorClass {
  new (options: { formats: string[] }): { detect(source: HTMLCanvasElement): Promise<DetectedCode[]> };
  getSupportedFormats(): Promise<string[]>;
}

type CameraCapabilities = MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] };
type CameraSettings = MediaTrackConstraintSet & { torch?: boolean; focusMode?: "continuous" };
const cameraConstraint = (setting: CameraSettings): MediaTrackConstraints => ({ advanced: [setting] });

export interface LiveQrScanHandle {
  /** Release the camera and stop reading frames. Safe to call again. */
  stop(): void;
  /** Report whether the torch setting was applied while the scan was active. */
  setTorch(on: boolean): Promise<boolean>;
  /** True when the camera track can control the torch. */
  torchAvailable: boolean;
}

const FRAME_INTERVAL_MS = 250;
const MAX_FRAME_SIDE = 1280;
const MAX_CONSECUTIVE_NATIVE_FAILURES = 2;

function stopCamera(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

export async function startLiveQrScan(
  video: HTMLVideoElement,
  onPayload: (text: string) => void,
  signal: AbortSignal,
): Promise<LiveQrScanHandle> {
  signal.throwIfAborted();
  const Detector = (globalThis as { BarcodeDetector?: NativeQrDetectorClass }).BarcodeDetector;
  let detector: InstanceType<NativeQrDetectorClass> | null = null;
  if (Detector) {
    try {
      if ((await Detector.getSupportedFormats()).includes("qr_code")) {
        detector = new Detector({ formats: ["qr_code"] });
      }
    } catch {
      // Fall back to ZXing when the native detector cannot start.
    }
  }

  let stream: MediaStream | undefined;
  let stopped = false;
  let scanning = false;
  let nativeFailures = 0;
  let canvas: HTMLCanvasElement | null = null;
  let grayBuffer: Uint8ClampedArray | undefined;
  let interval: number | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal.removeEventListener("abort", stop);
    if (interval !== undefined) {
      window.clearInterval(interval);
      interval = undefined;
    }
    if (stream) {
      stopCamera(stream);
      if (video.srcObject === stream) video.srcObject = null;
      stream = undefined;
    }
    canvas = null;
    grayBuffer = undefined;
  };

  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    // Release a stream that arrived after cancellation before attaching it to the video.
    if (signal.aborted) {
      stopCamera(acquired);
      throw signal.reason;
    }
    stream = acquired;
    video.srcObject = stream;
    try {
      await video.play();
    } catch (error) {
      throw new Error("Could not play the camera preview", { cause: error });
    }
    signal.throwIfAborted();
  } catch (error) {
    stop();
    signal.throwIfAborted();
    throw error;
  }

  const track = stream.getVideoTracks()[0];
  let torchSupported = false;
  try {
    const capabilities = track?.getCapabilities?.() as CameraCapabilities | undefined;
    torchSupported = capabilities?.torch === true;
    if (capabilities?.focusMode?.includes("continuous")) {
      void track.applyConstraints(cameraConstraint({ focusMode: "continuous" })).catch(() => undefined);
    }
  } catch {
    // Cameras can use their default focus mode if constraints are unavailable.
  }

  const scanFrame = async () => {
    if (stopped || scanning || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    scanning = true;
    try {
      const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas ??= document.createElement("canvas");
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(video, 0, 0, width, height);

      if (detector) {
        let codes: DetectedCode[] | undefined;
        try {
          codes = await detector.detect(canvas);
        } catch {
          if (++nativeFailures >= MAX_CONSECUTIVE_NATIVE_FAILURES) detector = null;
        }
        if (codes) {
          nativeFailures = 0;
          for (const code of codes) {
            if (stopped) return;
            if (code.format === "qr_code" && code.rawValue) onPayload(code.rawValue);
          }
          return;
        }
      }
      if (stopped) return;
      const frame = rgbaToGray(context.getImageData(0, 0, width, height).data, width, height, grayBuffer);
      grayBuffer = frame.gray;
      const text = decodeReceiptQrFrame(frame);
      if (text) onPayload(text);
    } catch {
      // Continue with the next frame if the current one cannot be read.
    } finally {
      scanning = false;
    }
  };
  interval = window.setInterval(scanFrame, FRAME_INTERVAL_MS);

  return {
    stop,
    setTorch: async (on) => {
      if (!torchSupported || stopped) return false;
      try {
        await track.applyConstraints(cameraConstraint({ torch: on }));
        return !stopped;
      } catch {
        return false;
      }
    },
    torchAvailable: torchSupported,
  };
}
