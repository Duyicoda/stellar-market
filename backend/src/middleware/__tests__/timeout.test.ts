jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { EventEmitter } from "events";
import type { Request, Response } from "express";
import { requestTimeoutMiddleware, REQUEST_TIMEOUT_MS } from "../timeout";
import { logger } from "../../lib/logger";

type MockResponse = EventEmitter & {
  headersSent: boolean;
  status: jest.Mock;
  json: jest.Mock;
  end: jest.Mock;
};

function makeRes(): MockResponse {
  const res = new EventEmitter() as MockResponse;
  res.headersSent = false;
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.end = jest.fn();
  return res;
}

describe("requestTimeoutMiddleware", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("calls next immediately and does not respond before the timeout elapses", () => {
    const req = { originalUrl: "/api/jobs", method: "GET", requestId: "req-1" } as Partial<Request> as Request;
    const res = makeRes();
    const next = jest.fn();

    requestTimeoutMiddleware(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("responds 503 RequestTimeout and logs a warning once the timeout elapses", () => {
    const req = {
      originalUrl: "/api/escrow/job-1/ttl",
      method: "GET",
      requestId: "req-2",
    } as Partial<Request> as Request;
    const res = makeRes();
    const next = jest.fn();

    requestTimeoutMiddleware(req, res as unknown as Response, next);
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "RequestTimeout", requestId: "req-2" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ route: "/api/escrow/job-1/ttl", method: "GET" }),
      "Request timed out",
    );
  });

  it("does not fire the timeout once the response has already finished", () => {
    const req = { originalUrl: "/api/jobs", method: "GET", requestId: "req-3" } as Partial<Request> as Request;
    const res = makeRes();
    const next = jest.fn();

    requestTimeoutMiddleware(req, res as unknown as Response, next);
    res.emit("finish");
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);

    expect(res.status).not.toHaveBeenCalled();
  });

  it("does not double-respond if headers were already sent", () => {
    const req = { originalUrl: "/api/jobs", method: "GET", requestId: "req-4" } as Partial<Request> as Request;
    const res = makeRes();
    res.headersSent = true;
    const next = jest.fn();

    requestTimeoutMiddleware(req, res as unknown as Response, next);
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });

  it("skips timeout for SSE stream routes", () => {
    const req = {
      originalUrl: "/api/v1/disputes/abc/stream",
      path: "/abc/stream",
      method: "GET",
      headers: { accept: "text/event-stream" },
      requestId: "req-5",
    } as Partial<Request> as Request;
    const res = makeRes();
    const next = jest.fn();

    requestTimeoutMiddleware(req, res as unknown as Response, next);
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
