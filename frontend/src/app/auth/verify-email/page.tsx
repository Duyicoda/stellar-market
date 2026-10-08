import { Suspense } from "react";
import VerifyEmailClient from "./VerifyEmailClient";

export default function VerifyEmailPage() {
  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center p-4">
      <Suspense>
        <VerifyEmailClient />
      </Suspense>
    </div>
  );
}
