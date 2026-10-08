import "@testing-library/jest-dom";
import React from "react";
import { render, act, screen, fireEvent, waitFor } from "@testing-library/react";
import { WalletProvider, useWallet } from "../WalletContext";

jest.mock("@/components/Toast", () => ({
  useToast: () => ({
    toast: {
      success: jest.fn(),
      error: jest.fn(),
    },
  }),
}));

const mockRequestAccess = jest.fn();
const mockGetAddress = jest.fn();
const mockIsConnected = jest.fn();
const mockGetPublicKey = jest.fn();
const mockSignTransaction = jest.fn();

jest.mock("@stellar/freighter-api", () => ({
  requestAccess: (...args: any[]) => mockRequestAccess(...args),
  getAddress: (...args: any[]) => mockGetAddress(...args),
  isConnected: (...args: any[]) => mockIsConnected(...args),
  getPublicKey: (...args: any[]) => mockGetPublicKey(...args),
  signTransaction: (...args: any[]) => mockSignTransaction(...args),
}));

const mockSendTransaction = jest.fn();
const mockGetTransaction = jest.fn();

jest.mock("@stellar/stellar-sdk", () => ({
  Horizon: {
    Server: jest.fn().mockImplementation(() => ({
      loadAccount: jest.fn().mockResolvedValue({ balances: [] }),
    })),
  },
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      sendTransaction: (...args: any[]) => mockSendTransaction(...args),
      getTransaction: (...args: any[]) => mockGetTransaction(...args),
    })),
    Api: { GetTransactionStatus: { SUCCESS: "SUCCESS", FAILED: "FAILED" } },
  },
  Transaction: jest.fn().mockImplementation(() => ({ timeBounds: undefined })),
}));

function TestConsumer() {
  const { connect, disconnect, signAndBroadcastTransaction } = useWallet();
  const [result, setResult] = React.useState<string>("");

  return (
    <div>
      <button data-testid="connect-btn" onClick={() => connect("freighter")}>
        Connect
      </button>
      <button data-testid="disconnect-btn" onClick={disconnect}>
        Disconnect
      </button>
      <button
        data-testid="sign-btn"
        onClick={async () => {
          const r = await signAndBroadcastTransaction("XDR", { type: "RELEASE", jobId: "job1" });
          setResult(JSON.stringify(r));
        }}
      >
        Sign (tracked)
      </button>
      <button
        data-testid="sign-legacy-btn"
        onClick={async () => {
          const r = await signAndBroadcastTransaction("XDR");
          setResult(JSON.stringify(r));
        }}
      >
        Sign (legacy)
      </button>
      <div data-testid="result">{result}</div>
    </div>
  );
}

async function renderAndConnect() {
  (window as any).freighter = {};
  mockIsConnected.mockResolvedValue({ isConnected: true });
  mockRequestAccess.mockResolvedValue({ address: "GADDR" });
  mockGetPublicKey.mockResolvedValue("GADDR");

  render(
    <WalletProvider>
      <TestConsumer />
    </WalletProvider>
  );

  await act(async () => {
    fireEvent.click(screen.getByTestId("connect-btn"));
  });
}

function getResult() {
  return JSON.parse(screen.getByTestId("result").textContent || "{}");
}

async function startTransactionPendingSubmission() {
  let resolveSubmission!: (value: { status: string; hash: string }) => void;
  mockSignTransaction.mockResolvedValue({ signedTxXdr: "SIGNED_XDR" });
  mockSendTransaction.mockReturnValue(
    new Promise((resolve) => {
      resolveSubmission = resolve;
    }),
  );

  act(() => {
    fireEvent.click(screen.getByTestId("sign-btn"));
  });
  await waitFor(() => expect(mockSendTransaction).toHaveBeenCalled());

  return async () => {
    await act(async () => {
      resolveSubmission({ status: "PENDING", hash: "stale-hash" });
    });
  };
}

async function expectStaleSessionResult() {
  await waitFor(() => {
    expect(getResult()).toMatchObject({
      success: false,
      hash: "stale-hash",
      status: "STALE_SESSION",
      canRetry: false,
    });
  });
  expect(global.fetch).not.toHaveBeenCalled();
}

describe("WalletContext.signAndBroadcastTransaction — tracked path (meta supplied)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    delete (window as any).freighter;
    global.fetch = jest.fn();
  });

  it("resolves SUCCESS via the backend status endpoint and attaches resultXdr from one final RPC check", async () => {
    await renderAndConnect();

    mockSignTransaction.mockResolvedValue({ signedTxXdr: "SIGNED_XDR" });
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "hash1" });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // pre-register
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "SUCCESS" }) }); // status poll
    mockGetTransaction.mockResolvedValue({
      status: "SUCCESS",
      returnValue: { toXDR: () => "RESULT_XDR" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("sign-btn"));
    });

    await waitFor(() => {
      const parsed = getResult();
      expect(parsed.success).toBe(true);
      expect(parsed.status).toBe("SUCCESS");
      expect(parsed.resultXdr).toBe("RESULT_XDR");
    });
  });

  it("returns FAILED with canRetry: false and a message distinct from a timeout", async () => {
    await renderAndConnect();

    mockSignTransaction.mockResolvedValue({ signedTxXdr: "SIGNED_XDR" });
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "hash2" });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "FAILED" }) });

    await act(async () => {
      fireEvent.click(screen.getByTestId("sign-btn"));
    });

    await waitFor(() => {
      const parsed = getResult();
      expect(parsed.success).toBe(false);
      expect(parsed.status).toBe("FAILED");
      expect(parsed.canRetry).toBe(false);
      expect(parsed.error).toMatch(/failed on-chain/i);
    });
  });

  it("returns EXPIRED with canRetry: true so the caller knows it can rebuild and resubmit", async () => {
    await renderAndConnect();

    mockSignTransaction.mockResolvedValue({ signedTxXdr: "SIGNED_XDR" });
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "hash3" });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "EXPIRED", canRetry: true }) });

    await act(async () => {
      fireEvent.click(screen.getByTestId("sign-btn"));
    });

    await waitFor(() => {
      const parsed = getResult();
      expect(parsed.success).toBe(false);
      expect(parsed.status).toBe("EXPIRED");
      expect(parsed.canRetry).toBe(true);
    });
  });

  it("returns STALE_SESSION when the account changes during submission", async () => {
    await renderAndConnect();
    const resolveSubmission = await startTransactionPendingSubmission();

    mockGetAddress.mockResolvedValue({ address: "GOTHER" });
    await act(async () => {
      window.dispatchEvent(new Event("freighter#accountChanged"));
    });
    await resolveSubmission();

    await expectStaleSessionResult();
  });

  it("returns STALE_SESSION when Freighter disconnects during submission", async () => {
    await renderAndConnect();
    const resolveSubmission = await startTransactionPendingSubmission();

    mockIsConnected.mockResolvedValue({ isConnected: false });
    await act(async () => {
      window.dispatchEvent(new Event("freighter#disconnected"));
    });
    await resolveSubmission();

    await expectStaleSessionResult();
  });

  it("returns STALE_SESSION after an explicit disconnect during submission", async () => {
    await renderAndConnect();
    const resolveSubmission = await startTransactionPendingSubmission();

    act(() => {
      fireEvent.click(screen.getByTestId("disconnect-btn"));
    });
    await resolveSubmission();

    await expectStaleSessionResult();
  });

  it("returns STALE_SESSION when the wallet network changes during submission", async () => {
    await renderAndConnect();
    const resolveSubmission = await startTransactionPendingSubmission();

    act(() => {
      window.dispatchEvent(new Event("freighter#networkChanged"));
    });
    await resolveSubmission();

    await expectStaleSessionResult();
  });
});

describe("WalletContext.signAndBroadcastTransaction — legacy path (meta omitted)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    delete (window as any).freighter;
    global.fetch = jest.fn();
  });

  it("preserves raw RPC-only polling and never calls the backend when meta is omitted", async () => {
    await renderAndConnect();

    mockSignTransaction.mockResolvedValue({ signedTxXdr: "SIGNED_XDR" });
    mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "hash4" });
    mockGetTransaction.mockResolvedValue({
      status: "SUCCESS",
      returnValue: { toXDR: () => "RESULT_XDR" },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("sign-legacy-btn"));
    });

    await waitFor(() => {
      const parsed = getResult();
      expect(parsed.success).toBe(true);
      expect(parsed.resultXdr).toBe("RESULT_XDR");
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
