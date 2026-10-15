import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { LeadSource, ServiceType } from '@/api/pickLists';
import { RevenueTable } from '../components/RevenueTable';
import { LeadSourcesChart, SourceValueTable } from '../components/SourceCharts';
import { MonthlyTable } from '../components/MonthlyTable';
import { monthlyMarketing, serviceRevenueRows, totalMarketing, type MarketingContact, type MarketingQuote } from '../lib/metrics';

const svc = (service_type: string, cadence: string, amount: number, state = 'accepted'): MarketingQuote => ({ service_type, state, cadence, amount });

let seq = 0;
const contact = (o: Partial<MarketingContact>): MarketingContact => ({
  id: `c-${++seq}`,
  created_at: '2026-02-15T12:00:00Z',
  submitted_at: '2026-02-15T12:00:00Z',
  status: 'new_lead',
  source: 'referral',
  client_since: null,
  contact_services: [],
  ...o,
});

const SOURCES = new Map<string, LeadSource>([
  ['referral', { key: 'referral', label: 'Referral', colour: '#2563eb', sort_order: 10, is_active: true, is_system: false }],
  ['search', { key: 'search', label: 'Search', colour: null, sort_order: 30, is_active: true, is_system: false }],
  ['advertising', { key: 'advertising', label: 'Advertising', colour: null, sort_order: 50, is_active: true, is_system: false }],
]);

// 4 leads: one won on referral worth $12,000 ARR, one won on search worth $1,200 ARR plus
// $400 one-time, one search lead that went nowhere, and one advertising lead.
const LEADS: MarketingContact[] = [
  contact({ source: 'referral', status: 'client', client_since: '2026-04-01', contact_services: [svc('retainer', 'monthly', 1000)] }),
  contact({ source: 'search', status: 'client', client_since: '2026-05-01', contact_services: [svc('retainer', 'monthly', 100), svc('project', 'one_time', 400)] }),
  contact({ source: 'search' }),
  contact({ source: 'advertising' }),
];

const sourceProps = { contacts: LEADS, fromMonth: '2026-01', toMonth: '2026-12', rangeLabel: 'Year to date', sourcesByKey: SOURCES };

describe('SourceValueTable', () => {
  const rowFor = (name: string) => within(screen.getByText(name).closest('tr') as HTMLElement);

  it('prices each source, labels it from lead_sources, and ranks the highest-value one first', () => {
    render(<SourceValueTable {...sourceProps} />);
    const bodyRows = screen.getAllByRole('row').slice(1, 4) as HTMLTableRowElement[];
    expect(bodyRows.map((r) => r.cells[0].textContent)).toEqual(['Referral', 'Search', 'Advertising']);
    // One lead and $12,000 of ARR: the ARR and the per-lead figure are the same.
    expect(rowFor('Referral').getAllByText('$12,000')).toHaveLength(2);
  });

  it('keeps one-time money out of the ARR column and still prices it per lead', () => {
    render(<SourceValueTable {...sourceProps} />);
    const search = rowFor('Search');
    expect(search.getByText('$1,200')).toBeInTheDocument();
    expect(search.getByText('$400')).toBeInTheDocument();
    expect(search.getByText('$800')).toBeInTheDocument(); // 1,600 over 2 leads
  });

  it('shows a source that won nothing rather than dropping the row', () => {
    render(<SourceValueTable {...sourceProps} />);
    const ads = rowFor('Advertising');
    expect(ads.getByText('1')).toBeInTheDocument();
    expect(ads.getAllByText('–')).toHaveLength(4);
  });

  it('foots to the sum of the rows it drew', () => {
    render(<SourceValueTable {...sourceProps} />);
    const total = within(screen.getByTestId('source-total'));
    expect(total.getByText('4')).toBeInTheDocument();
    expect(total.getByText('2')).toBeInTheDocument();
    expect(total.getByText('$13,200')).toBeInTheDocument();
    expect(total.getByText('$400')).toBeInTheDocument();
    expect(total.getByText('$3,400')).toBeInTheDocument(); // 13,600 over 4 leads
  });

  it('names the cohort it priced, and says the figures are gross', () => {
    render(<SourceValueTable {...sourceProps} />);
    expect(screen.getByText(/leads that arrived in this range/i)).toBeInTheDocument();
    expect(screen.getByText(/never debited/i)).toBeInTheDocument();
  });

  it('says nothing arrived rather than drawing an empty table', () => {
    render(<SourceValueTable {...sourceProps} fromMonth="2025-01" toMonth="2025-12" />);
    expect(screen.getByText('No leads arrived in this range.')).toBeInTheDocument();
    expect(screen.queryByTestId('source-total')).not.toBeInTheDocument();
  });

  it('a source row opens its leads', () => {
    const onSourceClick = vi.fn();
    render(<SourceValueTable {...sourceProps} onSourceClick={onSourceClick} selectedSource="search" />);
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Referral' }));
    expect(onSourceClick).toHaveBeenCalledWith('referral');
  });
});

describe('LeadSourcesChart', () => {
  it('draws every source it counted, a source missing from the list included, with the same total as the table', () => {
    const contacts = [...LEADS, contact({ source: 'esign', status: 'esign_signer' })];
    render(<LeadSourcesChart {...sourceProps} contacts={contacts} />);
    expect(screen.getByText('5 leads')).toBeInTheDocument();
    const bars = within(screen.getByRole('list', { name: 'Leads by source' })).getAllByRole('listitem');
    expect(bars.map((b) => b.title)).toEqual(['Search: 2', 'Referral: 1', 'Advertising: 1', 'esign: 1']);
  });

  it('colours a source from lead_sources, and one with no colour in a neutral', () => {
    render(<LeadSourcesChart {...sourceProps} />);
    const swatchOf = (title: string) =>
      (screen.getByTitle(title).querySelector('[aria-hidden="true"]') as HTMLElement).style.backgroundColor;
    expect(swatchOf('Referral: 1')).toBe('rgb(37, 99, 235)');
    // Search has no colour of its own: never another source's hue.
    expect(swatchOf('Search: 2')).not.toBe('rgb(37, 99, 235)');
  });
});

const SERVICE_TYPES: ServiceType[] = [
  { key: 'retainer', label: 'Monthly retainer', colour: null, sort_order: 10, is_active: true, is_system: false, revenue_family: 'recurring', default_cadence: 'monthly' },
  { key: 'annual_plan', label: 'Annual plan', colour: null, sort_order: 20, is_active: true, is_system: false, revenue_family: 'recurring', default_cadence: 'annual' },
  { key: 'project', label: 'Project', colour: null, sort_order: 30, is_active: true, is_system: false, revenue_family: 'one_time', default_cadence: 'one_time' },
];

describe('RevenueTable', () => {
  const book = [
    contact({ status: 'client', contact_services: [svc('retainer', 'monthly', 500), svc('annual_plan', 'annual', 1200), svc('project', 'one_time', 300)] }),
    contact({ status: 'client', contact_services: [svc('retainer', 'monthly', 250)] }),
    contact({ status: 'hot', contact_services: [svc('retainer', 'monthly', 100, 'proposed')] }),
  ];
  const rows = serviceRevenueRows(book, SERVICE_TYPES.map((s) => s.key));
  const noUpsells = { proposedMRR: 0, proposedARR: 0, proposedAnnual: 0, proposedOneTime: 0 };

  it('labels rows from service_types and subtotals the recurring family', () => {
    render(<RevenueTable rows={rows} serviceTypes={SERVICE_TYPES} upsells={noUpsells} recurringClientsCount={2} />);
    const labels = screen.getAllByRole('row').map((r) => (r as HTMLTableRowElement).cells[0]?.textContent);
    expect(labels).toContain('Monthly retainer');
    expect(labels).toContain('Recurring services total');
    // A family with one service needs no subtotal.
    expect(labels).not.toContain('One-time services total');
  });

  it('foots from the rows drawn plus the upsells row, and shows distinct recurring clients', () => {
    render(
      <RevenueTable rows={rows} serviceTypes={SERVICE_TYPES} upsells={{ proposedMRR: 50, proposedARR: 600, proposedAnnual: 0, proposedOneTime: 0 }} recurringClientsCount={2} />,
    );
    const total = within(screen.getByTestId('revenue-total'));
    expect(total.getByText('$750')).toBeInTheDocument(); // MRR 500 + 250
    expect(total.getByText('$10,200')).toBeInTheDocument(); // 750 x 12 + 1,200
    expect(total.getByText('$300')).toBeInTheDocument();
    expect(total.getByText('$150')).toBeInTheDocument(); // proposed 100 + upsell 50
    expect(total.getByText('$1,800')).toBeInTheDocument(); // 1,200 + 600
    expect(total.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Upsells')).toBeInTheDocument();
  });

  it('foots to what it drew even when a row disagrees with any other total', () => {
    // A row passed in that no aggregate produced: the footer must still be its sum.
    const odd = [{ service: 'project', clients: 0, mrr: 0, arr: 0, oneTime: 777, proposedMRR: 0, proposedARR: 0, proposedOneTime: 0 }];
    render(<RevenueTable rows={odd} serviceTypes={SERVICE_TYPES} upsells={noUpsells} recurringClientsCount={0} />);
    expect(within(screen.getByTestId('revenue-total')).getByText('$777')).toBeInTheDocument();
  });

  it('says there are no quotes rather than drawing zeroes', () => {
    render(<RevenueTable rows={[]} serviceTypes={SERVICE_TYPES} upsells={noUpsells} recurringClientsCount={0} />);
    expect(screen.getByText('No quotes yet.')).toBeInTheDocument();
  });
});

describe('MonthlyTable', () => {
  it('draws no target as the actual alone, a target as "actual / target", and a zero target as "/ 0"', () => {
    const goals = [
      { month: '2026-02', ad_spend: '300.00', new_leads_target: 5, closed_clients_target: 0 },
      { month: '2026-01', ad_spend: '100.00', new_leads_target: null, closed_clients_target: null },
    ];
    const rows = monthlyMarketing(LEADS, goals, '2026-01', '2026-02');
    render(<MonthlyTable rows={rows} totals={totalMarketing(rows)} />);
    const feb = within(screen.getByText('Feb 2026').closest('tr') as HTMLElement);
    expect(feb.getByText('/ 5', { exact: false })).toBeInTheDocument();
    expect(feb.getByText('/ 0', { exact: false })).toBeInTheDocument();
    expect(feb.getByText('$75')).toBeInTheDocument(); // 300 over 4 leads
    const jan = screen.getByText('Jan 2026').closest('tr') as HTMLElement;
    expect(jan.textContent).not.toContain('/');
    const total = within(screen.getByTestId('monthly-total'));
    expect(total.getByText('$400')).toBeInTheDocument();
  });
});
