import { Suspense, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { newMenu as registryNewMenu } from '@/features/registry';
import type { NewMenuItem } from '@/features/types';
import { cn } from '@/lib/utils';

/**
 * THE New menu: Contact, Work item, Request, E-sign envelope, each from the feature that
 * creates it (the registry's `newMenu`). An entry with a `path` goes to the feature's create
 * screen; an entry with a `Dialog` opens it where the owner is, never by sending them to
 * the feature's own page.
 *
 * Focus: the dialog opens only after the menu has handed focus back to the New button, and
 * closing it puts focus back on the button. A feature's dialog has no trigger of its own to
 * return to (it opens from code), so without this the focus would fall to the page's body.
 * The dialog stays mounted after its first open so it can animate out.
 */
export function NewMenu({ compact = false, items = registryNewMenu }: { compact?: boolean; items?: readonly NewMenuItem[] }) {
  const navigate = useNavigate();
  const pending = useRef<NewMenuItem | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<NewMenuItem | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const choose = (item: NewMenuItem) => {
    if (item.path) navigate(item.path);
    else pending.current = item;
  };

  const ActiveDialog = dialog?.Dialog;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            type="button"
            aria-label="New"
            title="New"
            className={cn('rounded-full text-[13px] font-semibold', compact ? 'size-8 px-0' : 'h-8 w-full gap-1.5 px-3')}
          >
            <Plus className="stroke-[2.25]" aria-hidden="true" />
            {!compact && <span>New</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={compact ? 'right' : 'bottom'}
          align="start"
          sideOffset={6}
          className="w-52"
          onCloseAutoFocus={() => {
            // The default (focus back on the button) runs after this; the dialog mounts
            // on the next task, once the button holds focus.
            const next = pending.current;
            pending.current = null;
            if (!next) return;
            window.setTimeout(() => {
              setDialog(next);
              setDialogOpen(true);
            }, 0);
          }}
        >
          {items.map((item) => (
            <DropdownMenuItem key={item.key} onSelect={() => choose(item)} className="cursor-pointer">
              <item.icon className="mr-2 size-4" aria-hidden="true" />
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {ActiveDialog && (
        <Suspense fallback={null}>
          <ActiveDialog
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open);
              // After the close has rendered: the dialog's focus trap is off by then.
              if (!open) window.setTimeout(() => trigger.current?.focus(), 0);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
