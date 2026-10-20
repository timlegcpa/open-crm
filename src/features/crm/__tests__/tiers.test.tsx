import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Contact } from '@/api/contacts';
import { TierBoard } from '../components/TierBoard';
import { TierMark } from '../components/TierMark';
import { CLIENT_TIERS, groupByTier, isClientTier, TIER_OPTIONS, tierValue, UNRANKED } from '../lib/tiers';

const person = (id: string, first: string, last: string, status: string, tier: string | null) =>
  ({ id, first_name: first, last_name: last, full_name: `${first} ${last}`, business_name: null, email: null, status, tier }) as unknown as Contact;

const CONTACTS = [
  person('1', 'Ann', 'Top', 'client', 'S'),
  person('2', 'Ben', 'Mid', 'client', 'B'),
  person('3', 'Cal', 'Once', 'one_time', 'A'),
  person('4', 'Dee', 'Lead', 'active_lead', 'A'),
  person('5', 'Eve', 'Gone', 'former_client', 'C'),
  person('6', 'Fay', 'New', 'client', null),
];

function renderBoard(matches: (c: Contact) => boolean = () => true) {
  const onOpen = vi.fn();
  const onSaveTier = vi.fn().mockResolvedValue(undefined);
  render(<TierBoard contacts={CONTACTS} matches={matches} onSaveTier={onSaveTier} onOpen={onOpen} />);
  return { onOpen, onSaveTier };
}

describe('tiers', () => {
  it('run S at the top to E at the bottom', () => {
    expect([...CLIENT_TIERS]).toEqual(['S', 'A', 'B', 'C', 'D', 'E']);
  });

  it('write null for "not ranked" and for anything that is not a tier', () => {
    expect(tierValue('A')).toBe('A');
    expect(tierValue(UNRANKED)).toBeNull();
    expect(tierValue('')).toBeNull();
    expect(tierValue('a')).toBeNull();
    expect(isClientTier('F')).toBe(false);
  });

  it('offer every tier and then "Not ranked" in the select', () => {
    expect(TIER_OPTIONS.map((o) => o.value)).toEqual([...CLIENT_TIERS, UNRANKED]);
  });

  it('group into every row, S first and Not ranked last, empty rows kept, each row by name', () => {
    const people = [
      { id: 'z', name: 'Zed', tier: 'A' },
      { id: 'a', name: 'Amy', tier: 'A' },
      { id: 'b', name: 'Bo', tier: null },
      { id: 'c', name: 'Cy', tier: 'S' },
      { id: 'd', name: 'Di', tier: 'junk' },
    ];
    const rows = groupByTier(people, (p) => p.name);
    expect(rows.map((r) => r.key)).toEqual([...CLIENT_TIERS, UNRANKED]);
    expect(rows.find((r) => r.key === 'B')!.people).toEqual([]);
    expect(rows.find((r) => r.key === 'A')!.people.map((p) => p.name)).toEqual(['Amy', 'Zed']);
    // An unknown value lands under Not ranked rather than dropping the person.
    expect(rows.find((r) => r.key === UNRANKED)!.people.map((p) => p.name)).toEqual(['Bo', 'Di']);
  });
});

describe('the Tiers board', () => {
  it('draws one row per tier, S at the top and Not ranked last', () => {
    renderBoard();
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual([
      'S tier', 'A tier', 'B tier', 'C tier', 'D tier', 'E tier', 'Not ranked',
    ]);
  });

  it('holds active clients only, each in its own row; a stored tier on anyone else is not ranked here', () => {
    renderBoard();
    expect(within(screen.getByRole('region', { name: 'S tier' })).getByText('Top, Ann')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'B tier' })).getByText('Mid, Ben')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Not ranked' })).getByText('New, Fay')).toBeInTheDocument();
    expect(screen.queryByText(/Cal/)).toBeNull();
    expect(screen.queryByText(/Dee/)).toBeNull();
    expect(screen.queryByText(/Eve/)).toBeNull();
  });

  it('narrows with the page’s matcher', () => {
    renderBoard((c) => c.first_name === 'Ben');
    expect(screen.queryByText('Top, Ann')).toBeNull();
    expect(screen.getByText('Mid, Ben')).toBeInTheDocument();
  });

  it('opens the record when a card is clicked or Enter is pressed on it', () => {
    const { onOpen } = renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Open Top, Ann' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Open Mid, Ben' }), { key: 'Enter' });
    expect(onOpen.mock.calls).toEqual([['1'], ['2']]);
  });
});

describe('the tier mark', () => {
  it('draws the letter for a tier and nothing for an unranked contact', () => {
    const { container, rerender } = render(<TierMark tier="A" />);
    expect(screen.getByRole('img', { name: 'A tier' })).toHaveTextContent('A');
    rerender(<TierMark tier={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
