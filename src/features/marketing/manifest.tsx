import { TrendingUp } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const MarketingPage = lazyNamed(() => import('./pages'), 'MarketingPage');

export const manifest: FeatureManifest = {
  id: 'marketing',
  ownerNav: [{ label: 'Marketing', icon: TrendingUp, path: '/marketing', order: 10, section: 'growth' }],
  ownerRoutes: [{ path: 'marketing', element: <MarketingPage /> }],
};
