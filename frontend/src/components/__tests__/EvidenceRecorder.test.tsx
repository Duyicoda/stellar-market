import "fake-indexeddb/auto";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import EvidenceRecorder from "@/components/EvidenceRecorder";

// ---- Controllable MediaRecorder + media devices ----
class MockMediaRecorder {
  static supported = new Set<string>(["video/webm;codecs=vp9,opus"]);
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported(t: string) {
    return MockMediaRecorder.supported.has(t);
  }
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "";
    MockMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  requestData() {}
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
  emit(blob: Blob) {
    this.ondataavailable?.({ data: blob });
  }
}

function fakeStream() {
  const track = { stop: jest.fn(), addEventListener: jest.fn() };
  return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

let getDisplayMedia: jest.Mock;
let getUserMedia: jest.Mock;
let disputeCounter = 0;

beforeAll(() => {
  // jsdom lacks these on HTMLMediaElement.
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: jest.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    configurable: true,
    writable: true,
    value: null,
  });
});

beforeEach(() => {
  MockMediaRecorder.instances = [];
  MockMediaRecorder.supported = new Set(["video/webm;codecs=vp9,opus"]);
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder =
    MockMediaRecorder;
  getDisplayMedia = jest.fn(async () => fakeStream());
  getUserMedia = jest.fn(async () => fakeStream());
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getDisplayMedia, getUserMedia },
    configurable: true,
  });
});

async function startRecording() {
  fireEvent.click(screen.getByText("Start recording"));
  // Wait for the async stream acquisition + status transition.
  await screen.findByText("Pause");
  return MockMediaRecorder.instances.at(-1)!;
}

describe("EvidenceRecorder", () => {
  it("records a screen capture and hands a File to the pipeline", async () => {
    const onReady = jest.fn();
    render(
      <EvidenceRecorder
        disputeId={`d-${disputeCounter++}`}
        onRecordingReady={onReady}
      />,
    );

    // Default source is screen.
    const recorder = await startRecording();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      recorder.emit(new Blob([new Uint8Array([1, 2, 3])]));
    });

    fireEvent.click(screen.getByText("Stop & attach"));
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    const file = onReady.mock.calls[0][0] as File;
    expect(file).toBeInstanceOf(File);
    expect(file.size).toBe(3);
    expect(file.type).toContain("video/webm");
  });

  it("records a webcam capture via getUserMedia", async () => {
    const onReady = jest.fn();
    render(
      <EvidenceRecorder
        disputeId={`d-${disputeCounter++}`}
        onRecordingReady={onReady}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Camera" }));

    const recorder = await startRecording();
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      recorder.emit(new Blob([new Uint8Array([7, 7])]));
    });
    fireEvent.click(screen.getByText("Stop & attach"));
    await waitFor(() => expect(onReady).toHaveBeenCalled());
  });

  it("surfaces a permission error without crashing", async () => {
    const onReady = jest.fn();
    getDisplayMedia.mockRejectedValueOnce(
      Object.assign(new Error("no"), { name: "NotAllowedError" }),
    );
    render(
      <EvidenceRecorder
        disputeId={`d-${disputeCounter++}`}
        onRecordingReady={onReady}
      />,
    );
    fireEvent.click(screen.getByText("Start recording"));
    expect(
      await screen.findByText(/permission was denied/i),
    ).toBeInTheDocument();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("shows the negotiated recording format while recording", async () => {
    render(
      <EvidenceRecorder
        disputeId={`d-${disputeCounter++}`}
        onRecordingReady={jest.fn()}
      />,
    );
    await startRecording();
    expect(await screen.findByText(/Recording as WebM/i)).toBeInTheDocument();
  });
});
