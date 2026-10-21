import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CLIENT_PANEL_SEARCH_ID } from '@/features/types';

// The search reads the contact list: its own chunk, loaded on first open.
const QuickSearch = lazy(() => import('@/features/workspace/QuickSearch').then((m) => ({ default: m.QuickSearch })));

/** The Command symbol means nothing on Windows; the listener takes Ctrl and Meta alike. */
function shortcutHint(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K';
  return /Mac|iPhone|iPad/i.test(navigator.userAgent) ? '⌘K' : 'Ctrl K';
}

/**
 * The rail's search. Ctrl K (or Cmd K) reaches it from anywhere: where the client panel is
 * on screen, its box IS the search, so the shortcut focuses that box rather than floating a
 * second one over it; anywhere else a box floats out beside the rail. The floating box
 * folds away on Escape, a pick or a click outside, and takes its text with it (the popover
 * unmounts it), so it reopens empty. Closing it puts focus back on the rail's button.
 */
export function RailSearch() {
  const [open, setOpen] = useState(false);
  const hint = shortcutHint();

  const reach = useCallback(() => {
    const panelBox = document.getElementById(CLIENT_PANEL_SEARCH_ID) as HTMLInputElement | null;
    // getClientRects is empty for an element that is not rendered (a hidden pane).
    if (panelBox && panelBox.getClientRects().length > 0) {
      panelBox.focus();
      panelBox.select();
      return;
    }
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      reach();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [reach]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Search contacts and businesses"
          title={`Search (${hint})`}
          onClick={(e) => {
            // The panel's box wins where it shows; the popover opens only elsewhere.
            e.preventDefault();
            if (open) setOpen(false);
            else reach();
          }}
          className="size-9 text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <Search className="size-[18px] stroke-[1.75]" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" sideOffset={10} className="w-[340px] p-0">
        <Suspense fallback={<p className="p-3 text-[13px] text-muted-foreground">Loading...</p>}>
          <QuickSearch onDone={() => setOpen(false)} />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
