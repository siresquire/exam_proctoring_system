import type { Emit } from "./collectors";

/**
 * Webcam capture: getUserMedia helper, canvas-based JPEG snapshot capture,
 * and camera-lost detection (track `ended` -> high-severity event, per
 * types.ts's defaultSeverity for "camera_lost"). No face detection / ML —
 * that's Phase 5 (MediaPipe/COCO-SSD), deliberately out of scope here.
 */

export interface WebcamHandle {
  stream: MediaStream;
  videoEl: HTMLVideoElement;
  /** Captures one JPEG snapshot from the current video frame. */
  captureSnapshot(options?: { maxWidth?: number; quality?: number }): Promise<Blob | null>;
  stop(): void;
}

const DEFAULT_MAX_WIDTH = 640;
const DEFAULT_QUALITY = 0.7;

/**
 * Requests camera access and wires up a hidden <video> element to receive
 * the stream (required for canvas capture — you can't draw a MediaStream
 * directly). Caller owns disposal via `stop()`. `emit` is optional so this
 * can be used standalone (e.g. the ConsentScreen's camera-check step)
 * without wiring the full event pipeline.
 */
export async function startWebcam(emit?: Emit): Promise<WebcamHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });

  const videoEl = document.createElement("video");
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.srcObject = stream;
  await videoEl.play().catch(() => {
    // Autoplay can reject without a user gesture in some browsers; the
    // stream is still live and capturable via drawImage regardless once
    // metadata has loaded, so this is not fatal.
  });

  const [track] = stream.getVideoTracks();
  if (track && emit) {
    track.addEventListener("ended", () => emit("camera_lost"));
  }

  async function captureSnapshot(options: { maxWidth?: number; quality?: number } = {}): Promise<Blob | null> {
    const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
    const quality = options.quality ?? DEFAULT_QUALITY;

    const sourceWidth = videoEl.videoWidth || maxWidth;
    const sourceHeight = videoEl.videoHeight || Math.round((maxWidth * 3) / 4);
    const scale = Math.min(1, maxWidth / sourceWidth);
    const width = Math.round(sourceWidth * scale);
    const height = Math.round(sourceHeight * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(videoEl, 0, 0, width, height);

    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    });
  }

  function stop() {
    stream.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  }

  return { stream, videoEl, captureSnapshot, stop };
}

/** True when getUserMedia exists at all — cheap capability check for the ConsentScreen's camera-check step. */
export function isWebcamSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}
