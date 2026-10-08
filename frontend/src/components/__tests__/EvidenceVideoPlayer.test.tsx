import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import EvidenceVideoPlayer from "@/components/EvidenceVideoPlayer";
import { parseTimestampFromHash } from "@/lib/mediaRecording";

// jsdom does not implement HTMLMediaElement playback or canvas 2d. Provide the
// minimal surface the player touches so scrubbing / frame-capture are testable.
let mockCurrentTime = 0;

beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: jest.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: jest.fn(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get: () => mockCurrentTime,
    set: (v: number) => {
      mockCurrentTime = v;
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "duration", {
    configurable: true,
    get: () => 120,
  });
  Object.defineProperty(HTMLMediaElement.prototype, "paused", {
    configurable: true,
    get: () => true,
  });
  Object.defineProperty(HTMLMediaElement.prototype, "videoWidth", {
    configurable: true,
    get: () => 640,
  });
  Object.defineProperty(HTMLMediaElement.prototype, "videoHeight", {
    configurable: true,
    get: () => 360,
  });
  HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
    drawImage: jest.fn(),
  })) as unknown as HTMLCanvasElement["getContext"];
  HTMLCanvasElement.prototype.toDataURL = jest.fn(
    () => "data:image/png;base64,ABC123",
  );
});

beforeEach(() => {
  mockCurrentTime = 0;
  window.location.hash = "";
});

function loadMetadata() {
  const video = screen.getByTestId("evidence-video");
  fireEvent.loadedMetadata(video);
}

describe("EvidenceVideoPlayer", () => {
  it("scrubs to a specific timestamp", () => {
    render(<EvidenceVideoPlayer src="blob:vid" fileName="clip.webm" />);
    loadMetadata();

    const scrubber = screen.getByLabelText("Seek") as HTMLInputElement;
    fireEvent.change(scrubber, { target: { value: "42" } });

    expect(mockCurrentTime).toBe(42);
    // The timestamp readout reflects the seek.
    expect(screen.getByTestId("video-timestamp")).toHaveTextContent(
      "0:42 / 2:00",
    );
  });

  it("seeks to a #t= fragment on load (shareable deep-link lands on the moment)", () => {
    window.location.hash = "#t=30";
    render(<EvidenceVideoPlayer src="blob:vid" />);
    loadMetadata();
    expect(mockCurrentTime).toBe(30);
  });

  it("produces a stable, shareable timestamp reference", async () => {
    const onRef = jest.fn();
    render(
      <EvidenceVideoPlayer src="blob:vid" onTimestampReference={onRef} />,
    );
    loadMetadata();

    const scrubber = screen.getByLabelText("Seek") as HTMLInputElement;
    fireEvent.change(scrubber, { target: { value: "12.5" } });

    // The copy handler is async (updates the URL + clipboard).
    await act(async () => {
      fireEvent.click(screen.getByText("Copy link to this moment"));
    });
    await waitFor(() => expect(onRef).toHaveBeenCalled());

    // Callback fired with a media-fragment hash, and the URL now deep-links there.
    expect(onRef).toHaveBeenCalledWith(12.5, "#t=12.5");
    expect(window.location.hash).toBe("#t=12.5");
    // The reference is stable: re-parsing the URL hash yields the same moment.
    expect(parseTimestampFromHash(window.location.hash)).toBeCloseTo(12.5);
  });

  it("captures a frame and reports the data URL + timestamp", () => {
    const onFrame = jest.fn();
    render(<EvidenceVideoPlayer src="blob:vid" onFrameCapture={onFrame} />);
    loadMetadata();

    const scrubber = screen.getByLabelText("Seek") as HTMLInputElement;
    fireEvent.change(scrubber, { target: { value: "8" } });

    fireEvent.click(screen.getByText("Capture frame"));
    expect(onFrame).toHaveBeenCalledWith("data:image/png;base64,ABC123", 8);
  });

  it("toggles play/pause", () => {
    render(<EvidenceVideoPlayer src="blob:vid" />);
    loadMetadata();
    const playBtn = screen.getByLabelText("Play");
    fireEvent.click(playBtn);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
});
