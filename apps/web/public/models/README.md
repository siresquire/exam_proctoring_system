# Self-hosted face-detection assets

`apps/web/public/mediapipe/` and `apps/web/public/models/blaze_face_short_range.tflite`
are committed, self-hosted copies of MediaPipe Tasks Vision's WASM runtime and the
BlazeFace short-range face detector model (PLAN.md Phase 1.6 — see
`apps/web/lib/proctor/face-detector.ts`).

Self-hosted (not CDN-only) deliberately, for offline/low-bandwidth resilience — a real
USTED exam session should not depend on `cdn.jsdelivr.net`/`storage.googleapis.com`
being reachable mid-exam. `face-detector.ts` still has a jsdelivr/Google Storage CDN
fallback in case these files are ever missing from a deployment, but that fallback is a
safety net, not the intended production path — see the `TODO(production)` comment there.

## Regenerating these files

If `node_modules` is reinstalled or the `@mediapipe/tasks-vision` version bumps, redo
both copy steps from the repo root:

```sh
# 1. WASM runtime -> apps/web/public/mediapipe/
cp node_modules/@mediapipe/tasks-vision/wasm/* apps/web/public/mediapipe/

# 2. BlazeFace short-range model -> apps/web/public/models/
curl -fsSL -o apps/web/public/models/blaze_face_short_range.tflite \
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
```

Both are plain static files served same-origin by Next.js from `public/` — no build step
required.
