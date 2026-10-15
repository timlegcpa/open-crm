import { describe, expect, it, vi } from 'vitest';
import type { ContactActivityCard } from '@/features/types';

// Two features contributing Activity cards. FEATURES lists messages before email, so only
// the registry's sort can put email's cards first on a tie.
const card = vi.hoisted(
  () => (key: string, order: number) => ({ key, order, Component: null as unknown as ContactActivityCard['Component'] }),
);

vi.mock('@/features/messages/manifest', () => ({
  manifest: { id: 'messages', contactActivityCards: [card('zeta', 10)] },
}));
vi.mock('@/features/email/manifest', () => ({
  manifest: { id: 'email', contactActivityCards: [card('alpha', 10), card('omega', 5)] },
}));

import { contactActivityCards, FEATURES } from '@/features/registry';

describe('the contact Activity card slot', () => {
  it("collects every feature's cards and sorts them by order, then by key", () => {
    const ids = FEATURES.map((f) => f.id);
    expect(ids.indexOf('messages')).toBeLessThan(ids.indexOf('email'));
    expect(contactActivityCards.map((c) => [c.order, c.key])).toEqual([
      [5, 'omega'],
      [10, 'alpha'],
      [10, 'zeta'],
    ]);
  });
});
