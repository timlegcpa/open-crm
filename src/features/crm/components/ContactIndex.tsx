import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import type { Contact } from '@/api/contacts';
import type { ContactStatus } from '@/api/pickLists';
import { StatusMonogram } from '@/components/contacts/StatusBadge';
import { Checkbox } from '@/components/ui/checkbox';
import { ClickRegion } from '@/components/ui/click-region';
import { initialsOf } from '@/components/ui/monogram';
import { links } from '@/features/links';
import { cn } from '@/lib/utils';
import { contactRowName, type CrmSection } from '../lib/sections';

/**
 * One 44px index row: the monogram tinted by status, swapped for a checkbox on hover (and
 * kept once anything is selected), then the name. Nothing to the right of a name.
 */
export function ContactIndexRow({
  contact,
  status,
  selected,
  selecting,
  onToggleSelect,
  search,
}: {
  contact: Contact;
  status: ContactStatus | undefined;
  selected: boolean;
  /** Something is selected: every row shows its checkbox. */
  selecting: boolean;
  onToggleSelect: (id: string) => void;
  /** Carried into the record link so the index keeps its query. */
  search: string;
}) {
  const name = contactRowName(contact);
  return (
    <li className={cn('group flex h-11 min-w-0 items-center gap-2.5 px-3', selected && 'bg-muted')}>
      <span className="relative inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center">
        <span className={cn('absolute inset-0', (selecting || selected) ? 'invisible' : 'group-hover:invisible group-focus-within:invisible')}>
          <StatusMonogram initials={initialsOf(contact.full_name || contact.business_name || contact.email)} status={status} />
        </span>
        <Checkbox
          aria-label={`Select ${name}`}
          checked={selected}
          onCheckedChange={() => onToggleSelect(contact.id)}
          className={cn('relative', !(selecting || selected) && 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100')}
        />
      </span>
      <NavLink
        to={`${links.contact(contact.id)}${search}`}
        className={({ isActive }) =>
          cn('min-w-0 flex-1 truncate rounded-sm text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring', isActive ? 'font-semibold' : 'text-foreground')
        }
      >
        {name}
      </NavLink>
    </li>
  );
}

/** A section heading: its status label and count; a collapsible one toggles. */
export function ContactIndexGroup({
  section,
  label,
  count,
  collapsed,
  onToggle,
  children,
}: {
  section: CrmSection;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const heading = (
    <>
      {section.collapsible && (
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', !collapsed && 'rotate-90')} aria-hidden="true" />
      )}
      <span className="truncate">{label}</span>
      <span className="ml-auto tabular-nums">{count}</span>
    </>
  );
  const headClass = 'flex w-full items-center gap-1.5 px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground';
  return (
    <section aria-label={label}>
      {section.collapsible ? (
        <ClickRegion aria-expanded={!collapsed} onClick={onToggle} className={cn(headClass, 'hover:text-foreground')}>
          {heading}
        </ClickRegion>
      ) : (
        <h3 className={headClass}>{heading}</h3>
      )}
      {!collapsed && <ul>{children}</ul>}
    </section>
  );
}
