import axios from 'axios';

/**
 * Shared axios instance.
 *
 * The dev server proxies /api to the backend, so relative URLs work in both
 * development and production (where the API serves the built frontend).
 * A 401 interceptor bounces the user back to the login screen.
 */
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
});

export const TOKEN_KEY = 'leadforge.token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    // Never bounce the user out on the login/register endpoints themselves.
    const isAuthRoute = /\/api\/auth\/(login|register)/.test(error.config?.url || '');
    if (status === 401 && !isAuthRoute) {
      setToken(null);
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login');
      }
    }
    return Promise.reject(error);
  }
);

/** Turn an axios failure into a readable message for the UI. */
export function errorMessage(error, fallback = 'Something went wrong') {
  const data = error?.response?.data;
  if (data?.details?.length) {
    return `${data.error}: ${data.details.map((d) => d.message).join(', ')}`;
  }
  if (data?.error) return data.error;
  if (error?.code === 'ECONNABORTED') return 'The request timed out. Please try again.';
  return error?.message || fallback;
}

export default api;