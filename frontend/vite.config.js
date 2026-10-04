import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api to the Node backend so the browser sees a single
// origin - no CORS preflight and no need to configure the API URL in dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Vite defaults to binding IPv6 ::1 only, which makes http://127.0.0.1:5173
    // fail while http://localhost:5173 works. Pin it to IPv4 so the dev server
    // answers on the same address as the backend (:4000) and the scraper (:8000).
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});