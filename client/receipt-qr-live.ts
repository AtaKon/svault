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

export type TorchState = { requested: boolean; reported: boolean | undefined };

export interface LiveQrScanHandle {
  /** Release the camera and stop reading frames. Safe to call again. */
  stop(): void;
  /** Report the request and any camera read-back. Null means the request failed or was canceled. */
  setTorch(on: boolean): Promise<TorchState | null>;
  torchAvailable: boolean;
}

const FRAME_INTERVAL_MS = 250;
const RESPONSE_TIMEOUT_MS = 4000;
const RESPONSE_TIMED_OUT = Symbol("QR scanner response timed out");
const SCAN_STOPPED = Symbol("QR scan stopped");
const MAX_FRAME_SIDE = 1280;
const MAX_CONSECUTIVE_NATIVE_FAILURES = 2;
const MAX_CONSECUTIVE_WORKER_FAILURES = 2;

function stopCamera(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

export async function startLiveQrScan(
  video: HTMLVideoElement,
  onPayload: (text: string) => void,
  signal: AbortSignal,
  onScanError?: () => void,
): Promise<LiveQrScanHandle> {
  signal.throwIfAborted();
  const session = new AbortController();
  const sessionSignal = session.signal;
  const Detector = (globalThis as { BarcodeDetector?: NativeQrDetectorClass }).BarcodeDetector;
  let detector: InstanceType<NativeQrDetectorClass> | null = null;
  let stream: MediaStream | undefined;
  let track: MediaStreamTrack | undefined = undefined;
  let scanning = false;
  let nativeFailures = 0;
  let workerFailures = 0;
  let canvas: HTMLCanvasElement | null = null;
  let worker: Worker | undefined;
  let interval: number | undefined;
  function stop() {
    signal.removeEventListener("abort", stop);
    track?.removeEventListener("ended", failScan);
    session.abort(SCAN_STOPPED);
    if (interval !== undefined) {
      window.clearInterval(interval);
      interval = undefined;
    }
    if (stream) {
      const acquired = stream;
      stream = undefined;
      stopCamera(acquired);
      if (video.srcObject === acquired) {
        video.pause();
        video.srcObject = null;
      }
    }
    detector = null;
    canvas = null;
    worker?.terminate();
    worker = undefined;
  }
  function failScan() {
    if (sessionSignal.aborted) return;
    stop();
    onScanError?.();
  }

  const waitForResponse = <T>(request: () => Promise<T>) => {
    sessionSignal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => fail(RESPONSE_TIMED_OUT), RESPONSE_TIMEOUT_MS);
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        sessionSignal.removeEventListener("abort", cancel);
        complete();
      };
      const fail = (error: unknown) => finish(() => reject(error));
      const cancel = () => fail(SCAN_STOPPED);
      sessionSignal.addEventListener("abort", cancel, { once: true });
      try {
        // Keep both reply handlers attached even after timeout or cancellation.
        void request().then((value) => finish(() => resolve(value)), fail);
      } catch (error) {
        fail(error);
      }
    });
  };

  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    // Release a stream that arrived after cancellation before attaching it to the video.
    if (sessionSignal.aborted) {
      stopCamera(acquired);
      throw sessionSignal.reason;
    }
    stream = acquired;
    track = stream.getVideoTracks()[0];
    if (!track) throw new DOMException("The camera stream contains no video", "NotFoundError");
    video.srcObject = stream;
    try {
      await waitForResponse(() => video.play());
    } catch (error) {
      throw new Error("Could not play the camera preview", { cause: error });
    }
    signal.throwIfAborted();
    if (Detector) {
      try {
        const formats = await waitForResponse(() => Detector.getSupportedFormats());
        if (formats?.includes("qr_code")) detector = new Detector({ formats: ["qr_code"] });
      } catch {
        // Use ZXing if the native detector cannot start.
      }
    }
    signal.throwIfAborted();
  } catch (error) {
    stop();
    signal.throwIfAborted();
    throw error;
  }

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

  const decodeInWorker = async (frame: ImageData) => {
    if (sessionSignal.aborted) return;
    const decoder = worker ??= new ReceiptQrWorker();
    try {
      return await waitForResponse(() => new Promise<string | null>((resolve, reject) => {
        decoder.onmessage = ({ data }: MessageEvent<unknown>) => {
          if (data === null || typeof data === "string") resolve(data);
          else reject(new Error("Unexpected receipt QR worker reply"));
        };
        decoder.onerror = reject;
        decoder.onmessageerror = reject;
        decoder.postMessage(frame, [frame.data.buffer]);
      }));
    } catch (error) {
      // A timed-out worker must never deliver a reply to a later frame.
      if (worker === decoder) {
        decoder.terminate();
        worker = undefined;
      }
      throw error;
    } finally {
      decoder.onmessage = null;
      decoder.onerror = null;
      decoder.onmessageerror = null;
    }
  };

  const scanFrame = async () => {
    if (sessionSignal.aborted || scanning || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
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
          codes = await waitForResponse(() => native.detect(frameCanvas));
          nativeFailures = 0;
        } catch (error) {
          if (error === SCAN_STOPPED) return;
          if (error === RESPONSE_TIMED_OUT) {
            // BarcodeDetector.detect has no cancellation API. Use software for
            // the rest of this session and null the canvas so the next frame
            // allocates a fresh one the pending call can still be reading. On
            // every other path detect has already settled (or never ran), so
            // one reused canvas is safe across frames.
            detector = null;
            canvas = null;
            return;
          }
          if (++nativeFailures >= MAX_CONSECUTIVE_NATIVE_FAILURES) detector = null;
        }
        if (sessionSignal.aborted) return;
        if (codes) {
          for (const code of codes) {
            if (sessionSignal.aborted) return;
            if (code.format === "qr_code" && code.rawValue) onPayload(code.rawValue);
          }
          return;
        }
      }
      if (sessionSignal.aborted) return;
      const frame = context.getImageData(0, 0, width, height);
      let text: string | null | undefined;
      try {
        text = await decodeInWorker(frame);
        workerFailures = 0;
      } catch (error) {
        if (error === SCAN_STOPPED) return;
        if (++workerFailures >= MAX_CONSECUTIVE_WORKER_FAILURES) throw error;
        return;
      }
      if (!sessionSignal.aborted && text) onPayload(text);
    } catch {
      failScan();
    } finally {
      scanning = false;
    }
  };
  signal.throwIfAborted();
  sessionSignal.throwIfAborted();
  if (track.readyState === "ended") {
    stop();
    throw new Error("The camera stopped before scanning began");
  }
  track.addEventListener("ended", failScan, { once: true });
  interval = window.setInterval(scanFrame, FRAME_INTERVAL_MS);

  const cameraIsActive = () => !sessionSignal.aborted && track.readyState !== "ended";
  return {
    stop,
    setTorch: async (on) => {
      if (!torchSupported || !cameraIsActive()) return null;
      try {
        await track.applyConstraints(cameraConstraint({ torch: on }));
      } catch {
        return null;
      }
      if (!cameraIsActive()) return null;
      try {
        const settings: CameraTrackSettings | undefined = track.getSettings?.();
        return { requested: on, reported: settings?.torch };
      } catch {
        return { requested: on, reported: undefined };
      }
    },
    torchAvailable: torchSupported,
  };
}
