import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { ClickRegion } from '@/components/ui/click-region';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency, formatPhoneNumber, NO_VALUE_TEXT } from '@/lib/format';
import { cn } from '@/lib/utils';
import { parseCurrencyInput } from '../lib/quotes';

type SelectOption = { value: string; label: string };

interface CommonProps {
  /** The field's accessible name ("City"); it is also the editor's label. */
  label: string;
  /** Rejects when the save failed; the caller reports it. */
  onSave: (value: string | number | null) => Promise<unknown> | void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

export type EditableFieldProps =
  | (CommonProps & { type: 'text' | 'email' | 'phone' | 'textarea'; value: string | null | undefined })
  | (CommonProps & { type: 'currency'; value: number | string | null | undefined })
  | (CommonProps & { type: 'date'; value: string | null | undefined })
  | (CommonProps & { type: 'select'; value: string | null | undefined; options: SelectOption[] });

type SaveStatus = 'idle' | 'saving' | 'saved';

// ── Tab handoff ─────────────────────────────────────────────────────
// Tabbing out of an open editor lands the NEXT field already editing. The field being
// left arms this flag on Tab (synchronously, before the browser moves focus); the field
// receiving focus consumes it. The timeout clears a handoff no field claimed.
let tabHandoffArmed = false;

function armTabHandoff() {
  tabHandoffArmed = true;
  window.setTimeout(() => {
    tabHandoffArmed = false;
  }, 0);
}

function consumeTabHandoff(): boolean {
  if (!tabHandoffArmed) return false;
  tabHandoffArmed = false;
  return true;
}

function useSaveStatus() {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const run = useCallback(async (op: () => Promise<unknown> | void) => {
    setStatus('saving');
    try {
      await op();
      setStatus('saved');
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setStatus('idle'), 1500);
    } catch {
      setStatus('idle');
    }
  }, []);
  return { status, run };
}

function StatusMark({ status }: { status: SaveStatus }) {
  if (status === 'saved') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-success">
        <Check className="h-3 w-3" aria-hidden="true" /> Saved
      </span>
    );
  }
  if (status === 'saving') return <span className="shrink-0 text-[10px] text-muted-foreground">Saving...</span>;
  return null;
}

function Shell({ status, children, className }: { status: SaveStatus; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <div className="min-w-0 flex-1">{children}</div>
      <StatusMark status={status} />
    </div>
  );
}

const BARE = 'border-transparent bg-transparent shadow-none hover:border-border hover:bg-muted data-[state=open]:border-border data-[state=open]:bg-card';

/**
 * A value edited in place: plain text at rest, an input on click, saved on Enter, Tab or
 * blur. One save per edit session; the editor closes at once, before the save resolves;
 * Escape discards; an unchanged draft never saves; a currency typo aborts rather than
 * clearing. A cleared text field saves '' (the API stores a nullable column's '' as null).
 */
export function EditableField(props: EditableFieldProps) {
  const { status, run } = useSaveStatus();

  if (props.type === 'select') {
    return (
      <Shell status={status} className={props.className}>
        <Select value={props.value || undefined} disabled={props.disabled} onValueChange={(v) => void run(() => props.onSave(v))}>
          <SelectTrigger aria-label={props.label} className={cn('h-7 px-2.5 text-[13px]', BARE)}>
            <SelectValue placeholder={props.placeholder ?? NO_VALUE_TEXT} />
          </SelectTrigger>
          <SelectContent>
            {props.options.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-[13px]">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Shell>
    );
  }

  if (props.type === 'date') {
    return (
      <Shell status={status} className={props.className}>
        <DatePicker
          aria-label={props.label}
          value={props.value}
          disabled={props.disabled}
          placeholder={props.placeholder ?? NO_VALUE_TEXT}
          onChange={(v) => void run(() => props.onSave(v || null))}
          className={cn('h-7 w-full px-2.5 text-[13px]', BARE)}
        />
      </Shell>
    );
  }

  return <TextLikeField {...props} status={status} run={run} />;
}

type TextLikeProps = Extract<EditableFieldProps, { type: 'text' | 'email' | 'phone' | 'textarea' | 'currency' }> & {
  status: SaveStatus;
  run: (op: () => Promise<unknown> | void) => Promise<void>;
};

function TextLikeField({ label, value, type, disabled, className, placeholder, onSave, status, run }: TextLikeProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  // One save per edit session: Enter commits and unmounts a focused input, Escape
  // discards, and neither may let the trailing blur commit again.
  const committedRef = useRef(false);

  const startEdit = useCallback(() => {
    if (disabled) return;
    committedRef.current = false;
    setDraft(value == null ? '' : String(value));
    setEditing(true);
  }, [disabled, value]);

  useEffect(() => {
    if (!editing || !inputRef.current) return;
    inputRef.current.focus();
    if (inputRef.current instanceof HTMLInputElement) inputRef.current.select();
  }, [editing]);

  const commit = useCallback(async () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const original = value == null ? '' : String(value);
    // Close NOW, never after the save resolves: keystrokes typed into a field whose
    // commit already happened would be silently lost.
    setEditing(false);
    if (draft === original) return;
    if (type === 'currency') {
      const parsed = parseCurrencyInput(draft);
      if (parsed !== null && Number.isNaN(parsed)) return;
      await run(() => onSave(parsed));
      return;
    }
    await run(() => onSave(draft.trim()));
  }, [draft, value, type, run, onSave]);

  const cancel = useCallback(() => {
    committedRef.current = true;
    setEditing(false);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
        return;
      }
      if (type === 'textarea') {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void commit();
        }
        return;
      }
      if (e.key === 'Tab') {
        // Arm and get out of the way: the native focus move walks to the next field and
        // the blur commits. Committing here would unmount the focused input and restart
        // the tab order from the top of the page.
        armTabHandoff();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        void commit();
      }
    },
    [cancel, commit, type],
  );

  const empty = value == null || value === '';
  const display = (() => {
    if (empty) return placeholder ?? NO_VALUE_TEXT;
    if (type === 'currency') {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isNaN(n) ? String(value) : formatCurrency(n);
    }
    if (type === 'phone') return formatPhoneNumber(String(value));
    return String(value);
  })();

  return (
    <Shell status={status} className={className}>
      {editing ? (
        type === 'textarea' ? (
          <Textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            aria-label={label}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={onKeyDown}
            className="min-h-[72px] text-[13px]"
          />
        ) : (
          <Input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            aria-label={label}
            type={type === 'email' ? 'email' : type === 'phone' ? 'tel' : 'text'}
            inputMode={type === 'currency' ? 'decimal' : type === 'phone' ? 'tel' : undefined}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={onKeyDown}
            className="h-7 text-[13px]"
          />
        )
      ) : (
        <ClickRegion
          aria-label={`${label}: ${empty ? 'empty' : display}. Edit`}
          onClick={startEdit}
          onFocus={() => {
            if (consumeTabHandoff()) startEdit();
          }}
          disabled={disabled}
          className={cn(
            'flex min-h-7 w-full items-start rounded-md border border-transparent px-2.5 py-1',
            !disabled && 'cursor-text hover:border-border hover:bg-card focus-visible:border-border focus-visible:bg-card',
            empty && 'text-muted-foreground',
          )}
        >
          <span className={cn('min-w-0 break-words text-[13px]', type === 'textarea' && 'whitespace-pre-wrap')}>{display}</span>
        </ClickRegion>
      )}
    </Shell>
  );
}
