import ReceiptQrWorker from "./receipt-qr-worker.ts?worker";

type DetectedCode = { rawValue: string; format: string };

interface NativeQrDetectorClass {
  new (options: { formats: string[] }): { detect(source: HTMLCanvasElement): Promise<DetectedCode[]> };
  getSupportedFormats(): Promise<string[]>;
}

type CameraCapabilities = MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] };
type CameraSettings = MediaTrackConstraintSet & { torch?: boolean; focusMode?: "continuous" };
type CameraTrackSettings = MediaTrackSettings & { torch?: boolean };
const cameraConstraint = (setting: CameraSettings): MediaTrackConstraints => ({ advanced: [setting] });

export interface LiveQrScanHandle {
  /** Release the camera and stop reading frames. Safe to call again. */
  stop(): void;
  /** Report whether the torch setting was applied while the scan was active. */
  setTorch(on: boolean): Promise<boolean>;
  torchAvailable: boolean;
}

const FRAME_INTERVAL_MS = 250;
const FRAME_RESPONSE_TIMEOUT_MS = 4000;
const FRAME_TIMED_OUT = Symbol("QR frame timed out");
const MAX_FRAME_SIDE = 1280;
const MAX_CONSECUTIVE_NATIVE_FAILURES = 2;

function stopCamera(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

export async function startLiveQrScan(
  video: HTMLVideoElement,
  onPayload: (text: string) => void,
  signal: AbortSignal,
  onDecoderError?: () => void,
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
  let worker: Worker | undefined;
  let cancelFrame: (() => void) | undefined;
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
    cancelFrame?.();
    worker?.terminate();
    worker = undefined;
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

  const waitForFrame = async <T>(request: () => Promise<T>) => {
    let timeout: number | undefined;
    const interrupted = new Promise<undefined>((resolve, reject) => {
      cancelFrame = () => resolve(undefined);
      timeout = window.setTimeout(() => reject(FRAME_TIMED_OUT), FRAME_RESPONSE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([request(), interrupted]);
    } finally {
      window.clearTimeout(timeout);
      cancelFrame = undefined;
    }
  };

  const decodeInWorker = async (frame: ImageData) => {
    const decoder = worker ??= new ReceiptQrWorker();
    try {
      return await waitForFrame(() => new Promise<string | null>((resolve, reject) => {
        decoder.onmessage = ({ data }: MessageEvent<string | null>) => resolve(data);
        decoder.onerror = reject;
        decoder.onmessageerror = reject;
        decoder.postMessage(frame, [frame.data.buffer]);
      }));
    } finally {
      decoder.onmessage = null;
      decoder.onerror = null;
      decoder.onmessageerror = null;
    }
  };

  const scanFrame = async () => {
    if (stopped || scanning || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    scanning = true;
    try {
      const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const frameCanvas = canvas ??= document.createElement("canvas");
      if (frameCanvas.width !== width) frameCanvas.width = width;
      if (frameCanvas.height !== height) frameCanvas.height = height;
      const context = frameCanvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Could not read the camera preview");
      context.drawImage(video, 0, 0, width, height);

      if (detector) {
        const native = detector;
        let codes: DetectedCode[] | undefined;
        try {
          codes = await waitForFrame(() => native.detect(frameCanvas));
          nativeFailures = 0;
        } catch (error) {
          // A timed-out native call may still be running, so do not start another.
          if (error === FRAME_TIMED_OUT || ++nativeFailures >= MAX_CONSECUTIVE_NATIVE_FAILURES) detector = null;
        }
        if (codes) {
          for (const code of codes) {
            if (stopped) return;
            if (code.format === "qr_code" && code.rawValue) onPayload(code.rawValue);
          }
          return;
        }
      }
      if (stopped) return;
      const text = await decodeInWorker(context.getImageData(0, 0, width, height));
      if (!stopped && text) onPayload(text);
    } catch {
      if (!stopped) {
        stop();
        onDecoderError?.();
      }
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
        if (stopped) return false;
        const settings: CameraTrackSettings | undefined = track.getSettings?.();
        return settings?.torch === undefined || settings.torch === on;
      } catch {
        return false;
      }
    },
    torchAvailable: torchSupported,
  };
}
