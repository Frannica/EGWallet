import { useEffect } from 'react';
import { logout } from '../api';
import { INACTIVITY_MS } from '../utils/ui';

export function useInactivityLogout(onLogout) {
  useEffect(() => {
    let timer;
    function reset() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        logout();
        onLogout?.();
      }, INACTIVITY_MS);
    }
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [onLogout]);
}

export function useHeartbeat() {
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const { sendHeartbeat } = await import('../api');
        await sendHeartbeat();
      } catch {
        // ignore
      }
    }, 60000);
    return () => clearInterval(interval);
  }, []);
}
