import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { TOPBAR_SLOT_ID } from '@/components/layout/topbarSlot';

/**
 * The page building blocks every owner screen shares. Import from here, never restyle a
 * copy in a feature folder:
 *
 *   <PageHeader title="Requests" subtitle="12 open" actions={<Button size="sm">New request</Button>} />
 *   <div className={PAGE}>
 *     <Panel title="Waiting on clients" action={<Button size="xs" variant="ghost">View all</Button>}>...</Panel>
 *   </div>
 */

/** THE scrolling page container: padding only, no max width (content fills the shell). */
export const PAGE = 'px-4 pb-5 pt-4 md:px-5';

/** THE fixed width of a side list (a contact index beside a record, a card's detail bar). */
export const SIDE_BAR_W = 'w-[300px]';

/** Table header cell for a plain `<Table>`: 11px semibold uppercase, muted. */
export const TABLE_TH =
  'px-3 py-2 text-left align-middle text-[11px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap';
/** A numeric column's header, right-aligned over tabular figures. */
export const TABLE_TH_NUM = `${TABLE_TH} text-right`;
/** An icon or action column's header. */
export const TABLE_TH_CENTER = `${TABLE_TH} text-center`;
/**
 * Row density for a report table: 6px above and below every cell. A CHILD selector on
 * purpose, so a table nested inside a cell keeps its own padding.
 */
export const TABLE_TR = '[&>td]:py-1.5';

/**
 * THE page header. Inside the owner shell it portals into the sticky top bar, so every page
 * gets the same bar without owning one; outside the shell (a test, a standalone screen) it
 * renders inline with a hairline under it. The title never shrinks; a long subtitle
 * truncates; actions sit right after the title, behind a hairline.
 */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  // A layout effect, so the header lands in the bar before paint instead of flashing inline.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setSlot(document.getElementById(TOPBAR_SLOT_ID));
  }, []);

  const bar = (
    <div className="flex min-w-0 flex-1 items-center gap-4">
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="flex-shrink-0 text-[15px] font-semibold text-foreground">{title}</h1>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2 border-l border-border pl-4">{actions}</div>}
    </div>
  );

  if (slot) return createPortal(bar, slot);
  return <div className="mb-3 flex min-h-11 items-center border-b border-border">{bar}</div>;
}

/** An untitled surface: a table, a chart, a figures strip. `padding={false}` lets a table fill it edge to edge. */
export function Surface({ children, className, padding = true }: { children: ReactNode; className?: string; padding?: boolean }) {
  return (
    <div className={cn('rounded-lg border border-border bg-card', padding ? 'p-4' : 'overflow-hidden', className)}>
      {children}
    </div>
  );
}

const SECTION_TITLE = 'text-xs font-semibold uppercase tracking-[0.06em] text-foreground';

/**
 * A titled surface: a 36px header band (uppercase title left, the panel's own action right,
 * a hairline under both) and the body below. A section heading is drawn ONE way: inside the
 * panel it names. The action slot stops click propagation, since a panel often sits inside
 * a clickable region.
 */
export function Panel({
  title,
  action,
  icon,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3.5">
        <h3 className={cn('flex min-w-0 items-center gap-1.5 truncate', SECTION_TITLE)}>
          {icon}
          {title}
        </h3>
        {action && (
          // Stops a click on the action from also activating a clickable ancestor.
          <div className="flex shrink-0 items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
            {action}
          </div>
        )}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** A heading above a block that is not itself a Panel. */
export function SectionHeader({ title, action, icon, className }: { title: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-3 flex items-center justify-between', className)}>
      <div className="flex items-center gap-2">
        {icon}
        <h3 className={SECTION_TITLE}>{title}</h3>
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

/**
 * A group label inside a list ("Primary", "Spouse"): small muted capitals with space above,
 * no fill and no border. Full-bleed: it carries its own horizontal padding.
 */
export function ListBand({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('px-4 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground', className)}>
      {children}
    </div>
  );
}

/** What an empty list or panel says: what would be here, and the one action that fills it. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-12 text-center', className)}>
      {icon && <div className="mb-4 text-muted-foreground/70 [&>svg]:h-10 [&>svg]:w-10 [&>svg]:stroke-[1.5]">{icon}</div>}
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A screen a feature has not built yet: its title in the top bar and one line saying what it will do. */
export function PlaceholderPage({ title, line }: { title: string; line: string }) {
  return (
    <>
      <PageHeader title={title} />
      <div className={PAGE}>
        <p className="text-[13px] text-muted-foreground">{line}</p>
      </div>
    </>
  );
}
