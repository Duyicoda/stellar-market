"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { User } from "@/types";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000/api/v1";

type Status = "verifying" | "success" | "error";

export default function VerifyEmailClient() {
  const searchParams = useSearchParams();
  const { login } = useAuth();
  const [status, setStatus] = useState<Status>("verifying");
  const [errorMessage, setErrorMessage] = useState("");
  // Effects run twice in React StrictMode during development; the token is
  // single-use server-side, so a second call would otherwise show an error
  // for what was actually a successful first verification.
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const token = searchParams?.get("token");
    if (!token) {
      setStatus("error");
      setErrorMessage("This verification link is missing its token.");
      return;
    }

    (async () => {
      try {
        const response = await fetch(`${API}/auth/verify-email/${encodeURIComponent(token)}`);
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || data.message || "Verification failed.");
        }
        setStatus("success");
        login(data.token as string, data.user as User); // redirects to /dashboard
      } catch (err) {
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : "Verification failed.");
      }
    })();
  }, [searchParams, login]);

  return (
    <div className="w-full max-w-md p-8 bg-theme-card border border-theme-border rounded-2xl shadow-xl text-center">
      {status === "verifying" && (
        <>
          <Loader2 size={48} className="mx-auto mb-4 text-stellar-blue animate-spin" />
          <h1 className="text-2xl font-bold text-theme-heading mb-2">Verifying your email…</h1>
          <p className="text-theme-text">This will just take a moment.</p>
        </>
      )}

      {status === "success" && (
        <>
          <CheckCircle2 size={48} className="mx-auto mb-4 text-theme-success" />
          <h1 className="text-2xl font-bold text-theme-heading mb-2">Email verified!</h1>
          <p className="text-theme-text">You're logged in — taking you to your dashboard…</p>
        </>
      )}

      {status === "error" && (
        <>
          <XCircle size={48} className="mx-auto mb-4 text-theme-error" />
          <h1 className="text-2xl font-bold text-theme-heading mb-2">Verification failed</h1>
          <p className="text-theme-text mb-6">{errorMessage}</p>
          <Link href="/auth/login" className="btn-primary inline-block">
            Back to login
          </Link>
        </>
      )}
    </div>
  );
}
