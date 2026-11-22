/**
 * DOM layer of the product barcode camera: it opens the main rear lens on
 * multi-camera phones (a plain facingMode request often hands out the
 * ultra-wide or telephoto lens, which cannot focus at barcode distance),
 * requests continuous autofocus, offers the torch, and remembers a lens the
 * user picked manually. The pure selection rules live in
 * client/barcode-camera.ts; the decoding loop itself stays in the component.
 */
import { pickRearCamera, rearCameras, type CameraDeviceLike } from "./barcode-camera";
import type { TorchState } from "./receipt-qr-live-state";

const LENS_STORAGE_KEY = "sv.barcodeCameraId";
const RESOLUTION_IDEALS = { width: { ideal: 1920 }, height: { ideal: 1080 } };

type CameraCapabilities = MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] };
type CameraSettings = MediaTrackConstraintSet & { torch?: boolean; focusMode?: "continuous" };
type CameraTrackSettings = MediaTrackSettings & { torch?: boolean };
const cameraConstraint = (setting: CameraSettings): MediaTrackConstraints => ({ advanced: [setting] });

export function readStoredLensId(): string | null {
  try {
    return globalThis.localStorage?.getItem(LENS_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function storeLensId(deviceId: string): void {
  try {
    globalThis.localStorage?.setItem(LENS_STORAGE_KEY, deviceId);
  } catch {
    // Private modes can refuse localStorage; the choice just does not persist.
  }
}

export function clearStoredLensId(): void {
  try {
    globalThis.localStorage?.removeItem(LENS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Stop every track of a stream the caller owns. Safe on null. */
export function stopBarcodeStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

async function getUserMedia(video: MediaTrackConstraints): Promise<MediaStream> {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) {
    throw new DOMException("This browser does not expose a camera API.", "NotSupportedError");
  }
  return media.getUserMedia({ audio: false, video });
}

async function listVideoDevices(): Promise<CameraDeviceLike[]> {
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices?.();
    if (!Array.isArray(devices)) return [];
    return devices
      .filter((device) => device.kind === "videoinput")
      .map((device) => ({ deviceId: device.deviceId ?? "", label: device.label ?? "" }));
  } catch {
    return [];
  }
}

function activeDeviceId(track: MediaStreamTrack): string | null {
  try {
    return track.getSettings?.().deviceId || null;
  } catch {
    return null;
  }
}

function applyContinuousFocus(track: MediaStreamTrack): void {
  try {
    const capabilities = track.getCapabilities?.() as CameraCapabilities | undefined;
    if (capabilities?.focusMode?.includes("continuous")) {
      void track.applyConstraints(cameraConstraint({ focusMode: "continuous" })).catch(() => undefined);
    }
  } catch {
    // Cameras keep their default focus mode when constraints are unavailable.
  }
}

function torchCapable(track: MediaStreamTrack): boolean {
  try {
    return (track.getCapabilities?.() as CameraCapabilities | undefined)?.torch === true;
  } catch {
    return false;
  }
}

export interface BarcodeCameraHandle {
  /** The stream the caller owns and must release with stopBarcodeStream. */
  stream: MediaStream;
  /** deviceId of the active video track, when the browser reports one. */
  deviceId: string | null;
  /** Label-identified back cameras, main lens first; empty while facing the user. */
  rearCameras: CameraDeviceLike[];
  torchAvailable: boolean;
}

function finish(stream: MediaStream, facing: "environment" | "user", devices: CameraDeviceLike[]): BarcodeCameraHandle {
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopBarcodeStream(stream);
    throw new DOMException("The camera stream contains no video track.", "NotFoundError");
  }
  applyContinuousFocus(track);
  return {
    stream,
    deviceId: activeDeviceId(track),
    rearCameras: facing === "environment" ? rearCameras(devices) : [],
    torchAvailable: torchCapable(track),
  };
}

/**
 * Open the barcode camera. With facing "environment" a lens chosen manually
 * (preferredDeviceId, or the remembered one in localStorage) wins; otherwise
 * the main rear lens is picked from the post-permission device labels. The
 * returned stream belongs to the caller.
 */
export async function openBarcodeCamera(
  facing: "environment" | "user",
  preferredDeviceId?: string,
): Promise<BarcodeCameraHandle> {
  const preferred = facing === "environment" ? (preferredDeviceId ?? readStoredLensId()) : null;
  if (preferred) {
    try {
      const stream = await getUserMedia({ deviceId: { exact: preferred }, ...RESOLUTION_IDEALS });
      return finish(stream, facing, await listVideoDevices());
    } catch {
      // The remembered lens is gone (a revoked device or a new browser
      // session); drop it so the automatic choice takes over again.
      clearStoredLensId();
    }
  }

  const initial = await getUserMedia({ facingMode: { ideal: facing }, ...RESOLUTION_IDEALS });
  if (facing === "user") return finish(initial, facing, []);

  // The labels are readable only after the permission grant above, so the
  // main lens can be identified now.
  const devices = await listVideoDevices();
  const track = initial.getVideoTracks()[0];
  const mainLens = track ? pickRearCamera(devices) : null;
  if (!track || !mainLens || mainLens === activeDeviceId(track)) return finish(initial, facing, devices);

  stopBarcodeStream(initial);
  try {
    const reopened = await getUserMedia({ deviceId: { exact: mainLens }, ...RESOLUTION_IDEALS });
    return finish(reopened, facing, devices);
  } catch {
    // The exact lens can be exclusive to another app or unavailable at this
    // resolution; a plain facingMode stream is the last resort.
    const fallback = await getUserMedia({ facingMode: { ideal: facing }, ...RESOLUTION_IDEALS });
    return finish(fallback, facing, devices);
  }
}

/**
 * Apply a torch request to the camera's video track. Null means the request
 * failed or the camera was already released; otherwise the state reports
 * what the camera read back, mirroring the receipt QR scanner.
 */
export async function setBarcodeTorch(stream: MediaStream, on: boolean): Promise<TorchState | null> {
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState === "ended") return null;
  try {
    await track.applyConstraints(cameraConstraint({ torch: on }));
  } catch {
    return null;
  }
  // applyConstraints can end the track (the camera was released meanwhile),
  // which the narrowing above cannot know about.
  if ((track.readyState as string) === "ended") return null;
  try {
    const settings = track.getSettings?.() as CameraTrackSettings | undefined;
    return { requested: on, reported: settings?.torch };
  } catch {
    return { requested: on, reported: undefined };
  }
}
