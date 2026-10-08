import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";
import { refreshAccessToken } from "./authToken";

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

let installed = false;

/**
 * Installs a global response interceptor on axios's default instance so an
 * expired access token is silently refreshed and the original request
 * retried once, instead of surfacing "Invalid or expired token" to the user.
 * Every call site in the app does a plain `import axios from "axios"`, so
 * they all share this one default instance — no per-call-site changes needed.
 */
export function installAxiosAuthInterceptor(): void {
  if (installed) return;
  installed = true;

  axios.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const originalRequest = error.config as RetryableConfig | undefined;
      const authHeader = originalRequest?.headers?.Authorization;
      const url = originalRequest?.url ?? "";

      const isRefreshable =
        error.response?.status === 401 &&
        originalRequest &&
        !originalRequest._retry &&
        Boolean(authHeader) &&
        !url.includes("/auth/refresh") &&
        !url.includes("/auth/login") &&
        !url.includes("/auth/register");

      if (!isRefreshable) {
        return Promise.reject(error);
      }

      originalRequest._retry = true;
      const newToken = await refreshAccessToken();
      if (!newToken) {
        return Promise.reject(error);
      }

      originalRequest.headers.Authorization = `Bearer ${newToken}`;
      return axios(originalRequest);
    },
  );
}
