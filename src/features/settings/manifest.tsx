import { Settings } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const SettingsPage = lazyNamed(() => import('./pages'), 'SettingsPage');
const IdentitySection = lazyNamed(() => import('./IdentitySection'), 'IdentitySection');
const ListsSection = lazyNamed(() => import('./ListsSection'), 'ListsSection');
const LeadIntakeSection = lazyNamed(() => import('./LeadIntakeSection'), 'LeadIntakeSection');
const SecuritySection = lazyNamed(() => import('./SecuritySection'), 'SecuritySection');
const AppearanceSection = lazyNamed(() => import('./AppearanceSection'), 'AppearanceSection');
const TwoFactorSection = lazyNamed(() => import('./TwoFactorSection'), 'TwoFactorSection');
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
    { key: 'identity', label: 'Identity', order: 10, Component: IdentitySection },
    { key: 'lists', label: 'Lists', order: 20, Component: ListsSection },
    { key: 'lead-intake', label: 'Lead intake', order: 30, Component: LeadIntakeSection },
    { key: 'security', label: 'Security', order: 40, Component: SecuritySection },
    { key: 'appearance', label: 'Appearance', order: 50, Component: AppearanceSection },
  ],
  // A client turns two-factor on and off from their portal Profile. No onEvent: a client
  // session cannot write the owner's audit log.
  portalProfileSections: [{ key: 'two-factor', order: 10, Component: TwoFactorSection }],
  publicRoutes: [
    { path: 'forgot-password', element: <ForgotPasswordPage /> },
    { path: 'reset-password', element: <ResetPasswordPage /> },
  ],
};
