# Video / Screen-Recording Evidence Capture & Playback (issue #901)

Adds in-browser video capture (screen share + webcam) and a dedicated review
player to the dispute evidence flow, integrated with the **existing** chunked,
integrity-hashed, resumable upload pipeline (`src/lib/evidenceUpload.ts`).

## Files

| File | Role |
| --- | --- |
| `frontend/src/lib/mediaRecording.ts` | Codec negotiation, `RecordingController` (MediaRecorder + IndexedDB chunk persistence), recovery, timestamp helpers |
| `frontend/src/components/EvidenceRecorder.tsx` | Capture UI: screen/camera, start/pause/stop, live preview, recovery |
| `frontend/src/components/EvidenceVideoPlayer.tsx` | Review player: timestamped scrubbing, `#t=` deep-links, frame capture |
| `frontend/src/components/EvidenceUpload.tsx` | Recorder wired in additively; recordings join the existing upload flow |
| `frontend/src/components/EvidenceViewer.tsx` | Renders the player for video evidence on the review side |

## Key design decisions

### Reuse the existing upload pipeline (no separate path)
A finished recording is assembled into a plain `File` on stop and handed to
`EvidenceUpload` via `onRecordingReady`, where it joins the exact same
`selectedFiles` flow as a hand-picked file — same SHA-256 hashing
(`hashFile`) and same resumable, chunked transfer (`uploadFileResumable`). A
recording's byte size is only known on stop, which is fine: the pipeline derives
chunk count from `file.size` at upload time.

### Cross-browser codec negotiation
`negotiateRecordingFormat()` probes a preference list
(`video/webm;codecs=vp9,opus` → … → `video/mp4;codecs=h264,aac` → …) with
`MediaRecorder.isTypeSupported` and picks the first supported format, adapting
per browser (Chrome/Firefox WebM vs Safari MP4). If nothing matches it returns an
empty mimeType (browser default) **and labels it as such** so the UI communicates
the format rather than failing silently.

### Interruption resilience (periodic persistence, not one final blob)
The `RecordingController` records with a MediaRecorder **timeslice**, and each
chunk is persisted to IndexedDB as it arrives (as raw bytes, which clone
reliably). A revoked permission, closed tab, or crash therefore leaves a
recoverable partial recording; `listRecoverableRecordings()` surfaces it and the
recorder offers **Recover** / **Discard**. A clean stop clears the persisted
partial (the assembled File is then owned by the upload pipeline, which has its
own persistence). A screen-share "ended" event is treated as a stop so ending
the share never loses content.

### Evidence-specific player
Beyond generic playback: a timestamped scrubber, a **stable shareable deep-link**
to the current moment using the W3C media-fragment form (`#t=12.5`) — read on
load so a shared link lands on the referenced moment — and a **frame capture**
that produces a PNG an arbitrator can reference in a vote rationale.

## Tests

- `src/lib/__tests__/mediaRecording.test.ts`
  - **Recording → pipeline**: a mocked screen-capture and a webcam clip flow
    through `hashFile` + `uploadFileResumable` against an in-memory backend that
    recomputes SHA-256 over the reassembled chunks — the hash matches.
  - **Codec negotiation** across two simulated browsers via mocked
    `MediaRecorder.isTypeSupported`, plus the no-match browser-default fallback.
  - **Interruption recovery**: persisted chunks survive an un-clean stop and
    reassemble into a usable File; a clean stop clears them (no false recovery).
  - Stream acquisition (getDisplayMedia/getUserMedia) + permission-error mapping.
  - Timestamp helpers (format, media-fragment round-trip).
- `src/components/__tests__/EvidenceVideoPlayer.test.tsx` — scrubbing, `#t=`
  deep-link seek on load, a stable shareable reference, and frame capture.
- `src/components/__tests__/EvidenceRecorder.test.tsx` — screen + webcam capture
  through the component, permission-error surfacing, negotiated-format display.

### Test-harness fix

`jest.setup.ts`'s `structuredClone` polyfill was a no-op
(`require("crypto").structuredClone` is `undefined`), so IndexedDB writes never
round-tripped in tests. It now uses Node's `v8` structured-clone, which makes the
recovery tests (and the pre-existing upload-persistence code paths) genuinely
exercise IndexedDB. No existing tests regressed.
