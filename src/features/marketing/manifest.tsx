import { TrendingUp } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const MarketingPage = lazyNamed(() => import('./pages'), 'MarketingPage');

export const manifest: FeatureManifest = {
  id: 'marketing',
  workspaceTabs: [{ key: 'marketing', label: 'Marketing', icon: TrendingUp, path: '/marketing', order: 30 }],
  workspaceRoutes: [{ path: 'marketing', element: <MarketingPage /> }],
};
