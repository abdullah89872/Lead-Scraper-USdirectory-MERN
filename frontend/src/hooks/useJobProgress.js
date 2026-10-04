import { useEffect, useRef, useState } from 'react';
import api, { TOKEN_KEY } from '../lib/api';

/**
 * Subscribe to a job's live progress via Server-Sent Events.
 *
 * `EventSource` cannot send an Authorization header, so the token is passed as a
 * query parameter and verified server-side. Falls back to polling if the stream
 * cannot be established (older proxies, blocked SSE).
 *
 * @param {string|null} jobId
 * @param {(job: object) => void} onUpdate
 */
export function useJobProgress(jobId, onUpdate) {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onUpdate);

  useEffect(() => {
    handlerRef.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    if (!jobId) return undefined;

    const token = localStorage.getItem(TOKEN_KEY);
    const base = import.meta.env.VITE_API_URL || '/api';
    const url = `${base}/jobs/${jobId}/progress?token=${encodeURIComponent(token || '')}`;

    let source;
    let pollTimer = null;
    let closed = false;

    const startPolling = () => {
      if (pollTimer || closed) return;
      pollTimer = setInterval(async () => {
        try {
          const { data } = await api.get(`/jobs/${jobId}`);
          handlerRef.current?.(data.job);
          if (['completed', 'failed', 'cancelled'].includes(data.job.status)) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        } catch {
          /* keep trying - the page will surface the error state */
        }
      }, 2000);
    };

    try {
      source = new EventSource(url);
      source.addEventListener('progress', (event) => {
        try {
          handlerRef.current?.(JSON.parse(event.data));
        } catch {
          /* ignore malformed frames */
        }
      });
      source.addEventListener('end', () => source.close());
      source.onopen = () => setConnected(true);
      source.onerror = () => {
        setConnected(false);
        source?.close();
        startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      closed = true;
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [jobId]);

  return { connected };
}