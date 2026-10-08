import pino from "pino";
import { getRequestId } from "./request-context";

const isProd = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? "info" : "debug"),
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "password",
      "*.password",
      "token",
      "*.token",
      "secret",
      "*.secret",
      "authorization",
      "*.authorization",
      'req.headers["authorization"]',
      "headers.authorization",
      "*.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
  mixin() {
    const requestId = getRequestId();
    return requestId ? { requestId } : {};
  },
  transport: isProd
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
        },
      },
});

interface ConsolePatchedGlobal {
  __requestId_console_patched?: boolean;
}

// This function's entire purpose is to monkey-patch the global `console`
// object so that any stray console.* calls elsewhere get routed through the
// structured pino logger. Referencing `console.*` here is therefore
// unavoidable and intentional (not the debug cruft `no-console` targets
// elsewhere in the codebase), so it is narrowly disabled for this block only.
/* eslint-disable no-console */
export function installRequestIdConsolePatch(): void {
  const g = global as typeof global & ConsolePatchedGlobal;
  if (g.__requestId_console_patched) return;

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug ? console.debug.bind(console) : console.log.bind(console),
  };

  const formatArgs = (args: unknown[]): string =>
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

  console.log = (...args: unknown[]) => {
    try {
      logger.info({ args }, formatArgs(args));
    } catch {
      orig.log(...args);
    }
  };
  console.info = (...args: unknown[]) => {
    try {
      logger.info({ args }, formatArgs(args));
    } catch {
      orig.info(...args);
    }
  };
  console.warn = (...args: unknown[]) => {
    try {
      logger.warn({ args }, formatArgs(args));
    } catch {
      orig.warn(...args);
    }
  };
  console.debug = (...args: unknown[]) => {
    try {
      logger.debug({ args }, formatArgs(args));
    } catch {
      orig.debug(...args);
    }
  };
  console.error = (...args: unknown[]) => {
    try {
      const first = args[0];
      if (first instanceof Error) {
        logger.error({ err: first }, first.message);
      } else {
        logger.error({ args }, formatArgs(args));
      }
    } catch {
      orig.error(...args);
    }
  };

  g.__requestId_console_patched = true;
}
/* eslint-enable no-console */
