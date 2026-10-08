"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import axios from "axios";
import { User } from "@/types";
import { useRouter } from "next/navigation";
import { getToken, setToken as setSharedToken, subscribeToken, TOKEN_KEY } from "@/lib/authToken";
import { installAxiosAuthInterceptor } from "@/lib/axiosAuthInterceptor";

// Runs once per page load (module init), not per render/mount.
installAxiosAuthInterceptor();

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (token: string, user: User) => void;
  register: (token: string, user: User) => void;
  logout: () => void;
  refreshUser: () => Promise<void>;
  updateUser: (data: Partial<User>) => void;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000/api/v1";
const USER_KEY = "stellarmarket_user";
const AUTH_LOGOUT_EVENT = "stellarmarket:authLogout";

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  const tokenRef = useRef<string | null>(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const logout = useCallback(() => {
    setSharedToken(null);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(AUTH_LOGOUT_EVENT));
    }
    router.push("/auth/login");
  }, [router]);

  // Mirrors the shared token module into React state — this is what makes a
  // silent refresh (axios interceptor, or refreshAccessToken() called
  // directly by a fetch-based caller like WalletContext) actually visible to
  // every component reading token/user from useAuth(), not just whichever
  // request happened to trigger the refresh.
  useEffect(() => {
    return subscribeToken((newToken) => {
      setToken(newToken);
    });
  }, []);

  const refreshUser = useCallback(async () => {
    const storedToken = getToken();
    if (!storedToken) {
      setIsLoading(false);
      setToken(null);
      setUser(null);
      return;
    }

    setToken(storedToken);

    try {
      const response = await axios.get(`${API}/users/me`, {
        headers: { Authorization: `Bearer ${storedToken}` },
      });
      const userData = response.data;
      if (typeof window !== "undefined" && getToken()) {
        setUser(userData);
        localStorage.setItem(USER_KEY, JSON.stringify(userData));
      }
    } catch (error) {
      // If this was a 401 that survived the axios interceptor's silent-refresh
      // attempt (see axiosAuthInterceptor.ts), getToken() is already null by
      // now — refreshAccessToken() clears it on a genuine 401. Logging the
      // status here pinpoints whether GET /users/me itself was the trigger.
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      console.error(`Failed to fetch user (status: ${status}), tokenAfterAttempt:`, getToken());
      if (typeof window !== "undefined" && !getToken()) {
        setToken(null);
        setUser(null);
        setIsLoading(false);
        return;
      }
      logout();
    } finally {
      setIsLoading(false);
    }
  }, [logout]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === TOKEN_KEY) {
        if (!event.newValue) {
          setSharedToken(null);
          setToken(null);
          setUser(null);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent(AUTH_LOGOUT_EVENT));
          }
          router.push("/auth/login");
        } else if (tokenRef.current && event.newValue !== tokenRef.current) {
          // A silent refresh in another tab rotates this same key every
          // ~15 minutes now — that used to be rare enough that "the token
          // changed under us" was a reasonable signal to force a logout here.
          // It no longer is: adopt the new token instead of treating a
          // routine refresh elsewhere as a hostile session change.
          setToken(event.newValue);
        }
      } else if (event.key === USER_KEY) {
        if (!event.newValue) {
          setUser(null);
        } else if (tokenRef.current) {
          try {
            setUser(JSON.parse(event.newValue));
          } catch {
            setUser(null);
          }
        }
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, [router]);

  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const storedToken = getToken();
    const storedUser = localStorage.getItem(USER_KEY);

    if (storedToken && storedUser) {
      try {
        setToken(storedToken);
        setUser(JSON.parse(storedUser));
        refreshUser();
      } catch {
        logout();
      }
    } else {
      setIsLoading(false);
    }
  }, [logout, refreshUser]);

  const login = useCallback(
    (newToken: string, newUser: User) => {
      setSharedToken(newToken);
      localStorage.setItem(USER_KEY, JSON.stringify(newUser));
      setToken(newToken);
      setUser(newUser);
      router.push("/dashboard");
    },
    [router],
  );

  const register = useCallback(
    (newToken: string, newUser: User) => {
      setSharedToken(newToken);
      localStorage.setItem(USER_KEY, JSON.stringify(newUser));
      setToken(newToken);
      setUser(newUser);
      router.push("/dashboard");
    },
    [router],
  );

  const updateUser = useCallback((data: Partial<User>) => {
    setUser((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, ...data };
      localStorage.setItem(USER_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const value = useMemo(
    () => ({
      user,
      token,
      isLoading,
      login,
      register,
      logout,
      refreshUser,
      updateUser,
    }),
    [user, token, isLoading, login, register, logout, refreshUser, updateUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
