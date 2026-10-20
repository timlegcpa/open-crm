import { Fragment, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { shellCounts as registryCounts } from '@/features/registry';
import type { ShellCount } from '@/features/types';
import { cn } from '@/lib/utils';

/**
 * The shell's bottom bar: a 28px status strip pinned to the window's foot, desktop only.
 * It carries only figures the features already count (the registry's `shellCounts`): first
 * what is waiting on the owner (unread, to review, to accept), each a link to where that
 * work is and in the foreground colour while it is not zero; then, past a hairline, the size
 * of the book (clients, open leads). Its height is `--bottombar-h`, which a bounded page
 * inherits by sitting above it in the shell's column.
 */
export function BottomBar({ counts = registryCounts }: { counts?: readonly ShellCount[] }) {
  const waiting = counts.filter((c) => c.kind === 'waiting');
  const totals = counts.filter((c) => c.kind === 'total');
  return (
    <div
      role="region"
      aria-label="Status"
      className="sticky bottom-0 z-30 hidden h-[var(--bottombar-h)] shrink-0 items-center gap-4 border-t border-border bg-background px-4 text-[11.5px] text-muted-foreground md:flex"
    >
      {[waiting, totals].map((group, i) => (
        <Fragment key={i}>
          {i > 0 && waiting.length > 0 && totals.length > 0 && <span aria-hidden="true" className="h-3 w-px bg-border" />}
          {group.map(({ key, label, path, kind, Count }) => (
            <Suspense key={key} fallback={<span>{label}</span>}>
              <Count>
                {(value) => (
                  <Link
                    to={path}
                    className={cn('flex items-center gap-1.5 hover:text-foreground', (kind === 'total' || (value ?? 0) > 0) && 'text-foreground')}
                  >
                    <span className={cn(kind === 'total' && 'text-muted-foreground')}>{label}</span>
                    <span className="tabular-nums">{value ?? '-'}</span>
                  </Link>
                )}
              </Count>
            </Suspense>
          ))}
        </Fragment>
      ))}
    </div>
  );
}
