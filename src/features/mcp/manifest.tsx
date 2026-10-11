import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const ConnectPage = lazyNamed(() => import('./pages'), 'ConnectPage');
const ConnectorSettings = lazyNamed(() => import('./pages'), 'ConnectorSettings');

export const manifest: FeatureManifest = {
  id: 'mcp',
  ownerStandaloneRoutes: [{ path: 'connect', element: <ConnectPage /> }],
  settingsSections: [{ key: 'connector', label: 'AI connector', order: 50, Component: ConnectorSettings }],
};
