import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DollarSign, Pencil, Target, UserPlus } from 'lucide-react';
import { PAGE, PageHeader, Panel } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { PageTabsList, PageTabsTrigger } from '@/components/ui/page-tabs';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { links } from '@/features/links';
import { formatCurrencyShort, formatDate, todayISODate } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import type { PageContact } from './api';
import { AdSpendDialog } from './components/AdSpendDialog';
import { GoalBuilderDialog } from './components/GoalBuilderDialog';
import { GoalsTab } from './components/GoalsTab';
import { MonthlyTable } from './components/MonthlyTable';
import { MonthRangePicker, RANGE_LABEL, rangeFromPreset, type MonthRange } from './components/MonthRangePicker';
import {
  MetricChart,
  MetricTiles,
  ToFixPanel,
  TopSourcesPanel,
  type DrillKey,
  type FixRow,
  type MetricKey,
  type MetricTile,
} from './components/Overview';
import { PeoplePanel, type MarketingDrill } from './components/PeoplePanel';
import { RevenueTable } from './components/RevenueTable';
import { LeadSourcesChart, SourceValueTable } from './components/SourceCharts';
import {
  aggregateRevenue,
  leadsFrom,
  marketingSeries,
  monthlyMarketing,
  needsFixing,
  serviceRevenueRows,
  sourceValue,
  totalMarketing,
  wonCohortFees,
} from './lib/metrics';
import { monthsEnding } from './lib/months';
import { sourceLabel, sourceSwatch } from './sources';
import { useMarketingData, type MarketingData } from './useMarketingData';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'sources', label: 'Sources' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'goals', label: 'Goals' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const METRICS: readonly MetricKey[] = ['leads', 'won'];
const CHART_TITLE: Record<MetricKey, string> = { leads: 'New leads each month', won: 'New clients each month' };

/**
 * /marketing. Five tabs, each in the URL (`?tab=`, Overview drops the param). Overview: the
 * monthly recurring figure, new leads and new clients against the range's targets, one
 * 12-month chart of the selected figure (`?metric=`), what to fix, and the top sources.
 * Revenue, Sources, Monthly and Goals keep their own parts. A fix or a source opens the
 * people behind it in the right bar, with the fields that move the number editable there.
 */
export function MarketingPage() {
  const data = useMarketingData();
  const [range, setRange] = useState<MonthRange>(() => rangeFromPreset('ytd'));

  return (
    <>
      <PageHeader
        title="Marketing"
        subtitle="Revenue, lead sources and acquisition cost"
        actions={
          <>
            <MonthRangePicker value={range} onChange={setRange} />
            <Button asChild size="sm">
              <Link to={links.newContact()}>
                <UserPlus /> Add contact
              </Link>
            </Button>
          </>
        }
      />
      <div className={PAGE}>
        {data.error ? (
          <p role="alert" className="text-[13px] text-destructive">
            The marketing figures could not load: {getErrorMessage(data.error, 'an unexpected error')}. Reload the page to try again.
          </p>
        ) : !data.ready ? (
          <p role="status" className="text-[13px] text-muted-foreground">
            Loading the marketing figures…
          </p>
        ) : (
          <MarketingBody data={data} range={range} />
        )}
      </div>
    </>
  );
}

function MarketingBody({ data, range }: { data: MarketingData; range: MonthRange }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [drillKey, setDrillKey] = useState<DrillKey | null>(null);
  const [showAdSpend, setShowAdSpend] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);

  const setParam = (name: string, value: string, fallback: string) =>
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (value === fallback) p.delete(name);
        else p.set(name, value);
        return p;
      },
      { replace: true },
    );
  const tabParam = searchParams.get('tab');
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : 'overview';
  const metricParam = searchParams.get('metric');
  const metric: MetricKey = METRICS.includes(metricParam as MetricKey) ? (metricParam as MetricKey) : 'leads';

  const { contacts, goals, sourcesByKey } = data;
  const thisMonth = todayISODate().slice(0, 7);
  const rangeLabel = RANGE_LABEL[range.preset];

  const monthRows = useMemo(() => monthlyMarketing(contacts, goals, range.from, range.to), [contacts, goals, range.from, range.to]);
  const totals = useMemo(() => totalMarketing(monthRows), [monthRows]);
  const fees = useMemo(() => wonCohortFees(contacts, range.from, range.to), [contacts, range.from, range.to]);
  const fixes = useMemo(() => needsFixing(contacts), [contacts]);
  const series = useMemo(() => marketingSeries(contacts, monthsEnding(thisMonth, 12)), [contacts, thisMonth]);
  const revenue = useMemo(() => aggregateRevenue(contacts), [contacts]);
  const serviceRows = useMemo(
    () => serviceRevenueRows(contacts, data.serviceTypes.map((s) => s.key)),
    [contacts, data.serviceTypes],
  );
  // The top five sources for the range, by clients won, then leads.
  const topSources = useMemo(
    () =>
      sourceValue(contacts, range.from, range.to)
        .sort((a, b) => b.wins - a.wins || b.leads - a.leads)
        .slice(0, 5)
        .map((r) => ({ source: r.source, label: sourceLabel(sourcesByKey, r.source), swatch: sourceSwatch(sourcesByKey, r.source), leads: r.leads, wins: r.wins })),
    [contacts, range.from, range.to, sourcesByKey],
  );

  const drill = useMemo((): MarketingDrill | null => {
    if (!drillKey) return null;
    if (drillKey === 'noPrice') {
      return {
        title: 'Clients with no price',
        sub: `${fixes.noPrice.length} clients. They count as clients but add $0 to MRR, ARR and what a source was worth.`,
        people: fixes.noPrice.map((contact) => ({ contact })),
        fields: ['price', 'client_since'],
      };
    }
    if (drillKey === 'noSince') {
      return {
        title: 'Clients with no start date',
        sub: `${fixes.noSince.length} clients. Missing from New clients in every month.`,
        people: fixes.noSince.map((contact) => ({ contact })),
        fields: ['client_since', 'source'],
      };
    }
    const source = drillKey.slice('source:'.length);
    const people = leadsFrom<PageContact>(contacts, source, range.from, range.to);
    return {
      title: `Leads from ${sourceLabel(sourcesByKey, source)}`,
      sub: `${people.length} leads in the range. Wrong source? Change it here.`,
      people: people.map((contact) => ({ contact, note: `Added ${formatDate(contact.submitted_at ?? contact.created_at)}` })),
      fields: ['source', 'status'],
    };
  }, [drillKey, fixes, contacts, range.from, range.to, sourcesByKey]);

  const toggleDrill = (key: DrillKey) => setDrillKey((k) => (k === key ? null : key));
  const goalTone = (actual: number, goal: number | null) => (goal == null ? 'muted' : actual >= goal ? 'good' : 'warn');
  const tiles: MetricTile[] = [
    { label: 'Monthly recurring', value: formatCurrencyShort(fixes.quotedMRR), sub: 'Accepted monthly quotes' },
    {
      label: 'New leads',
      value: String(totals.leads),
      sub: totals.leadsTarget != null ? `Goal ${totals.leadsTarget}` : rangeLabel,
      subTone: goalTone(totals.leads, totals.leadsTarget),
      metric: 'leads',
    },
    {
      label: 'New clients',
      value: String(totals.closed),
      sub: totals.closedTarget != null ? `Goal ${totals.closedTarget}` : rangeLabel,
      subTone: goalTone(totals.closed, totals.closedTarget),
      metric: 'won',
    },
  ];
  const fixRows: FixRow[] = [
    { key: 'noPrice', count: fixes.noPrice.length, label: 'Clients with no price', why: 'Add $0 to monthly recurring' },
    { key: 'noSince', count: fixes.noSince.length, label: 'No start date', why: 'Missing from New clients' },
  ];
  const sourceKey = drillKey?.startsWith('source:') ? drillKey.slice('source:'.length) : null;
  const sourceProps = { contacts, fromMonth: range.from, toMonth: range.to, rangeLabel, sourcesByKey };
  const mutations = { createGoal: data.createGoal, updateGoal: data.updateGoal };

  return (
    <Tabs value={tab} onValueChange={(v) => setParam('tab', v, 'overview')}>
      <PageTabsList className="mb-4">
        {TABS.map((t) => (
          <PageTabsTrigger key={t.key} value={t.key}>
            {t.label}
          </PageTabsTrigger>
        ))}
      </PageTabsList>

      {/* The right bar sits beside the tab on a wide screen and above it on a narrow one, so a click always shows its list. */}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        {drill && (
          <div className="xl:order-last">
            <PeoplePanel
              drill={drill}
              sources={data.sources}
              statuses={data.statusesByKey}
              onSave={async (id, field, value) => {
                await data.updateField.mutateAsync({ id, field, value });
              }}
              onClose={() => setDrillKey(null)}
            />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <TabsContent value="overview" className="mt-0 space-y-4">
            <section className="overflow-hidden rounded-lg border border-border bg-card">
              <MetricTiles tiles={tiles} selected={metric} onSelect={(m) => setParam('metric', m, 'leads')} />
              <MetricChart title={CHART_TITLE[metric]} bars={series.map((p) => ({ month: p.month, value: p[metric] }))} />
            </section>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <ToFixPanel rows={fixRows} active={drillKey} onOpen={toggleDrill} />
              <TopSourcesPanel rows={topSources} rangeLabel={rangeLabel} onOpenTable={() => setParam('tab', 'sources', 'overview')} />
            </div>
          </TabsContent>

          <TabsContent value="revenue" className="mt-0">
            <RevenueTable rows={serviceRows} serviceTypes={data.serviceTypes} upsells={data.upsells} recurringClientsCount={revenue.recurringClientsCount} />
          </TabsContent>

          <TabsContent value="sources" className="mt-0 space-y-4">
            <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
              <LeadSourcesChart {...sourceProps} />
              <SourceValueTable {...sourceProps} onSourceClick={(s) => toggleDrill(`source:${s}`)} selectedSource={sourceKey} />
            </div>
            <p className="text-xs text-muted-foreground">Ad spend is entered per month, not per source, so there is no cost per lead by source.</p>
          </TabsContent>

          <TabsContent value="monthly" className="mt-0">
            {/* The controls that change this table sit on it: a control belongs beside its effect. */}
            <Panel
              title="Monthly marketing"
              action={
                <>
                  <span className="mr-1 hidden text-xs text-muted-foreground sm:inline">{rangeLabel}</span>
                  <Button variant="ghost" size="xs" onClick={() => setShowAdSpend(true)}>
                    <DollarSign /> Edit ad spend
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => setParam('tab', 'goals', 'overview')}>
                    <Pencil /> Edit goals
                  </Button>
                  <Button variant="outline" size="xs" onClick={() => setShowBuilder(true)}>
                    <Target /> Build a plan
                  </Button>
                </>
              }
            >
              <MonthlyTable rows={monthRows} totals={totals} />
            </Panel>
          </TabsContent>

          <TabsContent value="goals" className="mt-0">
            <Panel
              title="Goals"
              bodyClassName="p-4"
              action={
                <Button variant="outline" size="xs" onClick={() => setShowBuilder(true)}>
                  <Target /> Build a plan
                </Button>
              }
            >
              <GoalsTab goals={goals} contacts={contacts} mutations={mutations} />
            </Panel>
          </TabsContent>
        </div>
      </div>

      <GoalBuilderDialog
        open={showBuilder}
        onOpenChange={setShowBuilder}
        monthRows={monthRows}
        fees={fees}
        rangeLabel={rangeLabel}
        goals={goals}
        mutations={mutations}
      />
      <AdSpendDialog open={showAdSpend} onOpenChange={setShowAdSpend} goals={goals} mutations={mutations} />
    </Tabs>
  );
}
