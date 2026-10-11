import { createContext, useCallback, useContext, useLayoutEffect, useState } from 'react';
import { safeStorage, storageKey } from '@/lib/storage';

/**
 * Light or dark for the owner's app. The `dark` class goes on <html>, not on a wrapper:
 * Radix renders dialogs, popovers, menus and tooltips into a portal on <body>, and a wrapper
 * class would leave every one of them light.
 *
 * The owner's explicit choice is stored in this browser (when storage allows). With no
 * stored choice the operating system's preference decides. The class is removed when the
 * shell unmounts, so the sign-in screen, the portal and public pages are never left dark.
 *
 * Mount `useTheme` once (AppShell does) and read it elsewhere through `useThemeControls`:
 * a second instance would strip the class when it unmounted.
 */

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = storageKey('theme');

function initialTheme(): Theme {
  const stored = safeStorage.get(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  // Before paint, so a dark app never flashes light for a frame.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
    return () => {
      root.classList.remove('dark');
      root.style.colorScheme = '';
    };
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      // Idempotent, so StrictMode's double call of an updater is harmless.
      safeStorage.set(THEME_STORAGE_KEY, next);
      return next;
    });
  }, []);

  return { theme, isDark: theme === 'dark', toggle };
}

export interface ThemeControls {
  isDark: boolean;
  toggle: () => void;
}

export const ThemeContext = createContext<ThemeControls | null>(null);

/** The shell's theme instance, or null outside the owner shell. */
export function useThemeControls(): ThemeControls | null {
  return useContext(ThemeContext);
}
