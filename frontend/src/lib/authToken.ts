/**
 * Single source of truth for the access token, shared between AuthContext
 * (React state) and non-React callers (the axios interceptor, raw fetch
 * calls in WalletContext) that need to read or silently refresh it without
 * going through a hook.
 *
 * Access tokens are short-lived (15m) and backed by a 7-day httpOnly refresh
 * cookie, but nothing previously called POST /auth/refresh — every session
 * hit a hard "Invalid or expired token" wall exactly 15 minutes after login
 * regardless of activity. refreshAccessToken() is what actually uses that
 * cookie to get a new access token silently.
 */

export const TOKEN_KEY = "stellarmarket_jwt";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000/api/v1";

type Listener = (token: string | null) => void;
const listeners = new Set<Listener>();

let currentToken: string | null =
  typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;

function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${value}; expires=${expires}; path=/; SameSite=Lax`;
}

function removeCookie(name: string) {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
}

export function getToken(): string | null {
  return currentToken;
}

/** Updates the token everywhere (memory, localStorage, readable cookie) and notifies subscribers. */
export function setToken(token: string | null): void {
  currentToken = token;
  if (typeof window === "undefined") return;
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    setCookie(TOKEN_KEY, token, 7);
  } else {
    localStorage.removeItem(TOKEN_KEY);
    removeCookie(TOKEN_KEY);
  }
  listeners.forEach((listener) => listener(token));
}

/** Lets AuthContext mirror this module's token into React state (e.g. after a silent refresh). */
export function subscribeToken(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let refreshPromise: Promise<string | null> | null = null;

/**
 * Exchanges the httpOnly refresh cookie for a new access token. Concurrent
 * callers share one in-flight request instead of each firing their own.
 * Only a genuine 401 from the endpoint (refresh token itself invalid/expired)
 * clears the token; a network hiccup returns null without forcing a logout.
 */
export function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${API}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (response.status === 401) {
        const body = await response.text().catch(() => "");
        // Diagnostic: a user is being forced back to logged-out with no
        // visible explanation. This is the one line that can actually say
        // why — missing/expired/invalid refresh cookie vs. something else —
        // without needing DevTools access to the browser that hit it.
        console.error("[auth] refresh rejected (401), logging out:", body);
        setToken(null);
        return null;
      }
      if (!response.ok) {
        console.error("[auth] refresh failed with non-401 status:", response.status);
        return null;
      }
      const data = (await response.json()) as { token: string };
      setToken(data.token);
      return data.token;
    } catch (err) {
      console.error("[auth] refresh request threw (network/CORS?):", err);
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}
