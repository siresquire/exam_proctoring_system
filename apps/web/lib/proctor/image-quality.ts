/**
 * Phase 1.6 portrait quality gating (identity-check.tsx): pure, canvas-
 * agnostic pixel-math helpers so the brightness/sharpness heuristics are
 * unit-testable independent of any DOM canvas. Takes `ImageData` (a plain
 * typed-array wrapper, not a live canvas), so these work the same in a
 * browser or (if ever needed) a headless test with a hand-built ImageData-
 * shaped object.
 *
 * These are heuristics, not proof of anything — same "evidence, not
 * verdict" posture as every other proctoring signal in this repo. They only
 * gate whether the identity PHOTO is accepted (retake or continue); they
 * never feed proctor_events or any violation count.
 */

/**
 * Acceptable mean-luma range, 0-255 scale. Tuned generously (webcam JPEGs
 * from typical laptop cameras in normal room lighting land well inside this
 * band) — the goal is to reject genuinely too-dark (backlit/no-light) and
 * genuinely overexposed (camera pointed at a bright window/lamp) photos,
 * not to demand studio lighting.
 */
export const MIN_ACCEPTABLE_BRIGHTNESS = 60;
export const MAX_ACCEPTABLE_BRIGHTNESS = 200;

/**
 * Minimum acceptable sharpness score from `estimateSharpness` below. Below
 * this, the photo is rejected as "blurry" (motion blur, camera not
 * focused, heavy compression artifacting that destroyed edges). Tuned by
 * eyeballing scores from an in-focus vs. deliberately-shaken webcam capture
 * at the same 640px capture width used elsewhere in this file
 * (webcam.ts's DEFAULT_MAX_WIDTH) — comfortably in-focus portraits score
 * in the low hundreds to low thousands; a heavily blurred frame drops
 * below ~15.
 */
export const MIN_ACCEPTABLE_SHARPNESS = 15;

/** Mean luma (perceptual brightness) of an image, 0 (black) - 255 (white). */
export function computeMeanBrightness(imageData: ImageData): number {
  const { data } = imageData;
  let sum = 0;
  const pixelCount = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    // ITU-R BT.601 luma weights — standard "perceived brightness" from RGB.
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return pixelCount > 0 ? sum / pixelCount : 0;
}

/**
 * Simple high-frequency-energy sharpness heuristic: convolves a 3x3
 * Laplacian kernel (the standard "variance of Laplacian" blur detector,
 * simplified to a mean of squared responses for speed on a downscaled
 * frame) over the grayscale image and returns the mean squared response.
 * In-focus images have strong edges (high-frequency content) and score
 * high; blurred images smear edges out and score low.
 */
export function estimateSharpness(imageData: ImageData): number {
  const { data, width, height } = imageData;
  if (width < 3 || height < 3) return 0;

  // Precompute grayscale once (avoids re-reading 3 channels per neighbor).
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    const rowUp = row - width;
    const rowDown = row + width;
    for (let x = 1; x < width - 1; x++) {
      // Laplacian kernel: [[0,1,0],[1,-4,1],[0,1,0]].
      const laplacian =
        gray[rowUp + x] +
        gray[rowDown + x] +
        gray[row + x - 1] +
        gray[row + x + 1] -
        4 * gray[row + x];
      sumSquares += laplacian * laplacian;
      count += 1;
    }
  }
  return count > 0 ? sumSquares / count : 0;
}

export type PortraitQualityFailure =
  | "too_dark"
  | "too_bright"
  | "blurry"
  | "no_face"
  | "multiple_faces";

export interface PortraitQualityResult {
  ok: boolean;
  failures: PortraitQualityFailure[];
  brightness: number;
  sharpness: number;
  faceCount: number;
}

/** User-facing guidance for each failure reason, in a fixed priority order (see evaluatePortraitQuality). */
export const PORTRAIT_QUALITY_MESSAGES: Record<PortraitQualityFailure, string> = {
  too_dark: "Too dark — move to a brighter spot or reduce backlight, then retake.",
  too_bright: "Too bright — reduce glare or strong backlight, then retake.",
  blurry: "Photo looks blurry — hold steady and retake.",
  no_face: "No face detected — face the camera directly and retake.",
  multiple_faces: "More than one face detected — make sure only you are in frame, then retake.",
};

/**
 * Runs all three checks and reports every failure found (not just the
 * first) so `PORTRAIT_QUALITY_MESSAGES` can show one specific, actionable
 * message per problem rather than a generic rejection.
 */
export function evaluatePortraitQuality(
  imageData: ImageData,
  faceCount: number,
): PortraitQualityResult {
  const brightness = computeMeanBrightness(imageData);
  const sharpness = estimateSharpness(imageData);
  const failures: PortraitQualityFailure[] = [];

  if (brightness < MIN_ACCEPTABLE_BRIGHTNESS) failures.push("too_dark");
  else if (brightness > MAX_ACCEPTABLE_BRIGHTNESS) failures.push("too_bright");

  if (sharpness < MIN_ACCEPTABLE_SHARPNESS) failures.push("blurry");

  if (faceCount === 0) failures.push("no_face");
  else if (faceCount >= 2) failures.push("multiple_faces");

  return { ok: failures.length === 0, failures, brightness, sharpness, faceCount };
}
