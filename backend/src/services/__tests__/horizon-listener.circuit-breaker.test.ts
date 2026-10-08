/**
 * Tests for the HorizonListener circuit breaker.
 *
 * We test the pure CircuitBreaker class directly (no Prisma / Stellar SDK
 * needed) and verify the getHorizonListenerHealth / getCircuitBreakerStatus
 * exports via a fully-mocked service import.
 */

// ─── Mock logger so tests stay silent ────────────────────────────────────────
jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { CircuitBreaker } from "../../lib/circuit-breaker";

// ─── Pure CircuitBreaker unit tests ──────────────────────────────────────────

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({ failureThreshold: 5, openDurationMs: 60_000, name: "Test" });
  });

  it("starts CLOSED with zero failures", () => {
    const s = cb.getStatus();
    expect(s.state).toBe("CLOSED");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.reconnectAttempts).toBe(0);
  });

  it("getHealthLabel returns 'connected' when CLOSED", () => {
    expect(cb.getHealthLabel()).toBe("connected");
  });

  it("allows requests when CLOSED", () => {
    expect(cb.allowRequest()).toBe(true);
  });

  it("stays CLOSED after fewer than threshold failures", () => {
    for (let i = 0; i < 4; i++) cb.onFailure();
    expect(cb.getStatus().state).toBe("CLOSED");
    expect(cb.getStatus().consecutiveFailures).toBe(4);
  });

  it("opens after exactly 5 consecutive failures", () => {
    for (let i = 0; i < 5; i++) cb.onFailure();
    const s = cb.getStatus();
    expect(s.state).toBe("OPEN");
    expect(s.consecutiveFailures).toBe(5);
    expect(s.reconnectAttempts).toBe(1);
  });

  it("increments horizon_listener_reconnects_total on circuit open", () => {
    for (let i = 0; i < 5; i++) cb.onFailure();
    expect(cb.getStatus().reconnectAttempts).toBe(1);
  });

  it("blocks requests when OPEN (within cool-down)", () => {
    for (let i = 0; i < 5; i++) cb.onFailure();
    expect(cb.allowRequest()).toBe(false);
  });

  it("getHealthLabel returns 'down' when OPEN", () => {
    for (let i = 0; i < 5; i++) cb.onFailure();
    expect(cb.getHealthLabel()).toBe("down");
  });

  it("transitions OPEN → HALF_OPEN after cool-down", () => {
    jest.useFakeTimers();
    for (let i = 0; i < 5; i++) cb.onFailure();
    expect(cb.allowRequest()).toBe(false);

    jest.advanceTimersByTime(61_000);
    expect(cb.allowRequest()).toBe(true);
    expect(cb.getStatus().state).toBe("HALF_OPEN");
    jest.useRealTimers();
  });

  it("getHealthLabel returns 'degraded' in HALF_OPEN", () => {
    jest.useFakeTimers();
    for (let i = 0; i < 5; i++) cb.onFailure();
    jest.advanceTimersByTime(61_000);
    cb.allowRequest(); // triggers OPEN → HALF_OPEN
    expect(cb.getHealthLabel()).toBe("degraded");
    jest.useRealTimers();
  });

  it("closes circuit on successful probe (HALF_OPEN → CLOSED)", () => {
    jest.useFakeTimers();
    for (let i = 0; i < 5; i++) cb.onFailure();
    jest.advanceTimersByTime(61_000);
    cb.allowRequest(); // → HALF_OPEN
    cb.onSuccess();
    expect(cb.getStatus().state).toBe("CLOSED");
    expect(cb.getHealthLabel()).toBe("connected");
    jest.useRealTimers();
  });

  it("reopens circuit on failed probe (HALF_OPEN → OPEN)", () => {
    jest.useFakeTimers();
    for (let i = 0; i < 5; i++) cb.onFailure();
    jest.advanceTimersByTime(61_000);
    cb.allowRequest(); // → HALF_OPEN
    cb.onFailure();
    expect(cb.getStatus().state).toBe("OPEN");
    expect(cb.getHealthLabel()).toBe("down");
    jest.useRealTimers();
  });

  it("resets failure count and timestamps on success", () => {
    for (let i = 0; i < 3; i++) cb.onFailure();
    cb.onSuccess();
    const s = cb.getStatus();
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastFailureAt).toBeNull();
    expect(s.openedAt).toBeNull();
    expect(s.state).toBe("CLOSED");
  });

  it("increments reconnectAttempts again when circuit reopens after failed probe", () => {
    jest.useFakeTimers();
    for (let i = 0; i < 5; i++) cb.onFailure();
    const afterOpen = cb.getStatus().reconnectAttempts;

    jest.advanceTimersByTime(61_000);
    cb.allowRequest(); // → HALF_OPEN (increments reconnectAttempts)
    cb.onFailure();    // → OPEN again (increments reconnectAttempts)

    expect(cb.getStatus().reconnectAttempts).toBeGreaterThan(afterOpen);
    jest.useRealTimers();
  });
});

// ─── getHorizonListenerHealth / getCircuitBreakerStatus integration ───────────

describe("getHorizonListenerHealth and getCircuitBreakerStatus exports", () => {
  // These just verify the service re-exports delegate to the CB instance.
  // We mock all heavy deps so the module loads cleanly.

  beforeAll(() => {
    jest.mock("@stellar/stellar-sdk", () => ({
      rpc: { Server: jest.fn().mockImplementation(() => ({})) },
      scValToNative: jest.fn(),
    }));
    jest.mock("@prisma/client", () => ({
      PrismaClient: jest.fn().mockImplementation(() => ({})),
      BadgeTier: {},
    }));
    jest.mock("../notification.service", () => ({
      NotificationService: { sendNotification: jest.fn() },
    }));
    jest.mock("../../config", () => ({
      config: {
        stellar: {
          rpcUrl: "https://mock",
          escrowContractId: "C1",
          disputeContractId: "C2",
          reputationContractId: "C3",
        },
      },
    }));
  });

  it("getHorizonListenerHealth returns 'connected' by default", async () => {
    const svc = await import("../horizon-listener.service");
    expect(svc.getHorizonListenerHealth()).toBe("connected");
  });

  it("getCircuitBreakerStatus returns CLOSED state by default", async () => {
    const svc = await import("../horizon-listener.service");
    expect(svc.getCircuitBreakerStatus().state).toBe("CLOSED");
  });
});
