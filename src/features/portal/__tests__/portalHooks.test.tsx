// The 30-minute inactivity sign-out and the portal's noindex / no-referrer meta.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { INACTIVITY_LIMIT_MS, useInactivityTimeout } from '../components/useInactivityTimeout';
import { usePortalMeta } from '../components/usePortalMeta';

function Idle({ onTimeout }: { onTimeout: () => void }) {
  useInactivityTimeout(onTimeout);
  return null;
}

function Meta() {
  usePortalMeta();
  return null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('inactivity timeout', () => {
  it('fires once after 30 quiet minutes, and activity starts the clock again', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    render(<Idle onTimeout={onTimeout} />);
    act(() => vi.advanceTimersByTime(INACTIVITY_LIMIT_MS - 60_000));
    window.dispatchEvent(new Event('keydown'));
    act(() => vi.advanceTimersByTime(INACTIVITY_LIMIT_MS - 60_000));
    expect(onTimeout).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(120_000));
    expect(onTimeout).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(INACTIVITY_LIMIT_MS * 2));
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('calls the latest handler, not the one from the first render', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Idle onTimeout={first} />);
    rerender(<Idle onTimeout={second} />);
    act(() => vi.advanceTimersByTime(INACTIVITY_LIMIT_MS + 60_000));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('portal meta', () => {
  it('sets noindex and no-referrer while mounted, and puts the page back after', () => {
    const existing = document.createElement('meta');
    existing.setAttribute('name', 'referrer');
    existing.setAttribute('content', 'strict-origin-when-cross-origin');
    document.head.appendChild(existing);

    const { unmount } = render(<Meta />);
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, nofollow');
    expect(existing.getAttribute('content')).toBe('no-referrer');
    expect(document.head.querySelectorAll('meta[name="referrer"]')).toHaveLength(1);

    unmount();
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
    expect(existing.getAttribute('content')).toBe('strict-origin-when-cross-origin');
    existing.remove();
  });
});
