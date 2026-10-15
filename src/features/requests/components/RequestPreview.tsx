import { CheckSquare, FileUp, Info, Lock, MessageSquareText } from 'lucide-react';
import type { DraftItem, ItemKind } from '../lib/requests';

export const KIND_ICONS: Record<ItemKind, typeof FileUp> = {
  document: FileUp,
  question: MessageSquareText,
  todo: CheckSquare,
  info: Info,
};

/** What the client will see, before it is sent: the title, the message and each item, read only. */
export function RequestPreview({
  title,
  intro,
  items,
  includeContactConfirm,
}: {
  title: string;
  intro: string;
  items: readonly DraftItem[];
  includeContactConfirm: boolean;
}) {
  return (
    <div className="flex flex-col gap-3" aria-label="Preview of what the client sees">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">What the client sees</p>
      <h2 className="text-lg font-semibold">{title.trim() || 'Untitled request'}</h2>
      {intro.trim() && <p className="whitespace-pre-wrap text-[14px] text-muted-foreground">{intro.trim()}</p>}
      {includeContactConfirm && <p className="text-[13px]">First, the client confirms their contact details.</p>}
      <ol className="flex flex-col gap-2">
        {items.map((item, i) => {
          const Icon = KIND_ICONS[item.kind];
          return (
            <li key={i} className="flex gap-3 rounded-md border border-border p-3">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <p className="break-words text-[14px] font-medium">
                  {item.label.trim() || 'Untitled item'}
                  {item.kind !== 'info' && !item.required && <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">(optional)</span>}
                </p>
                {item.description.trim() && <p className="whitespace-pre-wrap break-words text-[13px] text-muted-foreground">{item.description.trim()}</p>}
                {item.kind === 'question' && item.sensitive && (
                  <p className="mt-1 flex items-center gap-1 text-[12px] text-muted-foreground">
                    <Lock className="h-3 w-3" aria-hidden /> The answer is stored encrypted.
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
