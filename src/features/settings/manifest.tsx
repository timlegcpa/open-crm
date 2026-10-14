import { Settings } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const SettingsPage = lazyNamed(() => import('./pages'), 'SettingsPage');
const ProfileSettings = lazyNamed(() => import('./pages'), 'ProfileSettings');
const SecuritySettings = lazyNamed(() => import('./pages'), 'SecuritySettings');
const ForgotPasswordPage = lazyNamed(() => import('./public/ForgotPasswordPage'), 'ForgotPasswordPage');
const ResetPasswordPage = lazyNamed(() => import('./public/ResetPasswordPage'), 'ResetPasswordPage');

export const manifest: FeatureManifest = {
  id: 'settings',
  ownerNav: [{ label: 'Settings', icon: Settings, path: '/settings', order: 90, section: 'system' }],
  ownerRoutes: [
    { path: 'settings', element: <SettingsPage /> },
    { path: 'settings/:section', element: <SettingsPage /> },
  ],
  settingsSections: [
    { key: 'profile', label: 'Profile', order: 10, Component: ProfileSettings },
    { key: 'security', label: 'Security', order: 20, Component: SecuritySettings },
  ],
  publicRoutes: [
    { path: 'forgot-password', element: <ForgotPasswordPage /> },
    { path: 'reset-password', element: <ResetPasswordPage /> },
  ],
};
