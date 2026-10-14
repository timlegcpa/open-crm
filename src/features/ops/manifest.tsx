import { ListChecks, ShieldCheck } from 'lucide-react';
import { lazyNamed } from '@/features/lazy';
import type { FeatureManifest } from '@/features/types';

const AuditLogPage = lazyNamed(() => import('./pages'), 'AuditLogPage');
const JobsPage = lazyNamed(() => import('./pages'), 'JobsPage');

export const manifest: FeatureManifest = {
  id: 'ops',
  ownerNav: [
    { label: 'Audit log', icon: ShieldCheck, path: '/audit', order: 10, section: 'system' },
    { label: 'Jobs', icon: ListChecks, path: '/jobs', order: 20, section: 'system' },
  ],
  ownerRoutes: [
    { path: 'audit', element: <AuditLogPage /> },
    { path: 'jobs', element: <JobsPage /> },
  ],
};
