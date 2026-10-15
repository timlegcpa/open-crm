import { useEffect, useRef } from 'react';

/** The portal signs a client out after this long with no input. */
export const INACTIVITY_LIMIT_MS = 30 * 60 * 1000;
const CHECK_EVERY_MS = 30 * 1000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'mousemove'] as const;

/**
 * Calls `onTimeout` once after INACTIVITY_LIMIT_MS with no pointer, key, scroll or touch.
 * It compares clock times rather than trusting one long timer, because a background tab's
 * timers are throttled: coming back to the tab after an hour signs out at once. The latest
 * `onTimeout` is always the one called.
 */
export function useInactivityTimeout(onTimeout: () => unknown, limitMs: number = INACTIVITY_LIMIT_MS): void {
  const latest = useRef(onTimeout);
  useEffect(() => {
    latest.current = onTimeout;
  });

  useEffect(() => {
    let lastActivity = Date.now();
    let fired = false;
    const touch = () => {
      lastActivity = Date.now();
    };
    const check = () => {
      if (fired || Date.now() - lastActivity < limitMs) return;
      fired = true;
      void latest.current();
    };
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, touch, { passive: true });
    document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(check, Math.min(CHECK_EVERY_MS, limitMs));
    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, touch);
      document.removeEventListener('visibilitychange', check);
      window.clearInterval(timer);
    };
  }, [limitMs]);
}
