import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One labelled row inside a record card: the label in a fixed column, the value beside it.
 * A top-aligned row (an email list) drops its label onto the value's first line.
 */
export function FieldRow({ label, children, align = 'center' }: { label: string; children: ReactNode; align?: 'center' | 'top' }) {
  return (
    <div className={cn('flex min-h-[34px] gap-2.5 px-3.5 py-1', align === 'top' ? 'items-start' : 'items-center')}>
      <div className={cn('w-[88px] shrink-0 text-[12px] text-muted-foreground', align === 'top' && 'mt-1.5')}>{label}</div>
      <div className="min-w-0 flex-1 text-[13px]">{children}</div>
    </div>
  );
}

/** A read-only value on the same left edge and height as the editable ones. */
export const STATIC_VALUE = 'flex min-h-7 items-center border border-transparent px-2.5 text-[13px] text-foreground';
