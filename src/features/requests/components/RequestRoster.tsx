import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Panel } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { ARCHIVED_SECTION, requestRosterSections, type RequestWithItems } from '../lib/requests';
import { RequestRow } from './RequestRow';

/**
 * Requests grouped by whose move it is (the shared roster), with Archived folded away until
 * asked: a request closes itself once every answer is accepted, and closed ones would
 * otherwise pile up forever. `panels` is a page's layout, `compact` a strip inside another
 * screen. `contactName` names each row's contact; leave it out where every row is one
 * contact's.
 */
export function RequestRoster({
  requests,
  contactName,
  variant = 'panels',
}: {
  requests: RequestWithItems[];
  contactName?: (contactId: string) => string | null;
  variant?: 'panels' | 'compact';
}) {
  const [showArchived, setShowArchived] = useState(false);
  const sections = requestRosterSections(requests, (id) => contactName?.(id) ?? '');
  const archived = sections.find((s) => s.key === ARCHIVED_SECTION);
  const open = sections.filter((s) => s.key !== ARCHIVED_SECTION);
  const rows = (list: RequestWithItems[]) => list.map((r) => <RequestRow key={r.id} request={r} contactName={contactName?.(r.contact_id) ?? null} />);
  const compact = variant === 'compact';

  return (
    <div className={compact ? 'flex flex-col' : 'flex flex-col gap-4'}>
      {open.length === 0 && requests.length > 0 && (
        <p className={compact ? 'px-4 py-1.5 text-[13px] text-muted-foreground' : 'py-2 text-center text-[13px] text-muted-foreground'}>Nothing open.</p>
      )}
      {open.map((section) =>
        compact ? (
          <div key={section.key}>
            <h3 className="px-4 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">{section.label}</h3>
            <div className="divide-y divide-border">{rows(section.rows)}</div>
          </div>
        ) : (
          <Panel key={section.key} title={`${section.label} (${section.rows.length})`} bodyClassName="divide-y divide-border">
            {rows(section.rows)}
          </Panel>
        ),
      )}
      {archived && (
        <div className={compact ? 'pt-1' : undefined}>
          <Button size="sm" variant="ghost" className={compact ? 'ml-2 text-muted-foreground' : 'text-muted-foreground'} aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            {showArchived ? 'Hide archived' : `Show archived (${archived.rows.length})`}
          </Button>
          {showArchived &&
            (compact ? (
              <div className="divide-y divide-border">{rows(archived.rows)}</div>
            ) : (
              <Panel className="mt-2" title={`${archived.label} (${archived.rows.length})`} bodyClassName="divide-y divide-border">
                {rows(archived.rows)}
              </Panel>
            ))}
        </div>
      )}
    </div>
  );
}
