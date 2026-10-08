"use client";

import { useEffect } from "react";
import ErrorFallback from "@/components/ErrorFallback";
import { logError } from "@/utils/errorLogger";

export default function PageError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    logError(error, "page");
  }, [error]);

  return <ErrorFallback error={error} reset={reset} />;
}
