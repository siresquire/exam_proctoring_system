import { FaceDetector as MediaPipeFaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";

import type { FaceDetector } from "@proctor/core";

/**
 * apps/web's MediaPipe Tasks Vision implementation of proctor-core's
 * framework-agnostic `FaceDetector` interface (PLAN.md Phase 1.6). This is
 * the ONLY place @mediapipe/tasks-vision is imported anywhere in the repo —
 * packages/proctor-core stays dependency-free and never imports it; the
 * engine only calls the interface it's handed (see engine.ts
 * processSnapshot).
 *
 * Self-hosted for offline/low-bandwidth use (Ghana — PLAN.md §1's "free
 * tiers" + RESEARCH.md's connectivity concerns): the WASM runtime is copied
 * from node_modules/@mediapipe/tasks-vision/wasm into
 * apps/web/public/mediapipe/ and the BlazeFace short-range model
 * (blaze_face_short_range.tflite, ~225KB) is downloaded into
 * apps/web/public/models/ — both served same-origin, no CDN round-trip and
 * no dependency on jsdelivr being reachable during a real exam. If the
 * self-hosted files are ever missing (e.g. a fresh checkout that skipped
 * the copy step), this module *does* fall back to loading both from the
 * jsdelivr CDN so the feature still works — see the TODO below to keep that
 * from silently becoming the production path.
 *
 * TODO(production): before any real (non-demo) exam depends on face
 * detection, verify apps/web/public/mediapipe/ and
 * apps/web/public/models/blaze_face_short_range.tflite are present in the
 * deployed build (they are gitignored-friendly static assets, not committed
 * source — see apps/web/README or the repo root README for the copy/
 * download commands). Silently running against the CDN fallback in
 * production defeats the self-hosting rationale above.
 */

const SELF_HOSTED_WASM_BASE = "/mediapipe";
const SELF_HOSTED_MODEL_URL = "/models/blaze_face_short_range.tflite";
const CDN_WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const CDN_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

let detectorPromise: Promise<MediaPipeFaceDetector> | null = null;

async function urlExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

async function createMediaPipeDetector(): Promise<MediaPipeFaceDetector> {
  const selfHostedAvailable = await urlExists(SELF_HOSTED_MODEL_URL);
  const wasmBase = selfHostedAvailable ? SELF_HOSTED_WASM_BASE : CDN_WASM_BASE;
  const modelUrl = selfHostedAvailable ? SELF_HOSTED_MODEL_URL : CDN_MODEL_URL;

  if (!selfHostedAvailable && process.env.NODE_ENV !== "production") {
    console.warn(
      "[proctor] Self-hosted face-detection model not found at",
      SELF_HOSTED_MODEL_URL,
      "— falling back to the jsdelivr CDN. Run the model download step " +
        "(see apps/web/public/models/README) before deploying.",
    );
  }

  const fileset = await FilesetResolver.forVisionTasks(wasmBase);
  return MediaPipeFaceDetector.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: modelUrl,
      delegate: "CPU",
    },
    runningMode: "IMAGE",
    minDetectionConfidence: 0.5,
  });
}

/** Lazily creates (once) and caches the MediaPipe FaceDetector task. */
function getDetector(): Promise<MediaPipeFaceDetector> {
  if (!detectorPromise) {
    detectorPromise = createMediaPipeDetector();
  }
  return detectorPromise;
}

/**
 * Builds a proctor-core `FaceDetector` backed by MediaPipe's BlazeFace
 * short-range model. Pass the result into `createProctorEngine`'s
 * `adapters.faceDetector` — see components/proctor/proctor-demo.tsx.
 *
 * Fairness note (RESEARCH.md §3, PLAN.md Phase 1.6): BlazeFace, like every
 * face detector, has lower recall in low light and for darker skin tones.
 * This module deliberately reports nothing beyond a raw face count — all
 * debouncing, severity policy, and "this is evidence not a verdict"
 * handling lives in proctor-core's engine and the human-review pipeline
 * downstream, never here.
 */
export function createMediaPipeFaceDetectorAdapter(): FaceDetector {
  return {
    async detect(bitmap: ImageBitmap) {
      const detector = await getDetector();
      const result = detector.detect(bitmap);
      return { faceCount: result.detections.length };
    },
  };
}
