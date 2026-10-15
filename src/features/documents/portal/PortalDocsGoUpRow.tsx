import { CornerLeftUp } from 'lucide-react';
import { ClickRegion } from '@/components/ui/click-region';

export default function PortalDocsGoUpRow({ onGoUp }: { onGoUp: () => void }) {
  return (
    <li className="border-b border-border">
      <ClickRegion
        onClick={onGoUp}
        aria-label="Up one folder"
        className="flex w-full items-center gap-2.5 px-3.5 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/50"
      >
        <CornerLeftUp size={16} aria-hidden="true" className="shrink-0" />
        ..
      </ClickRegion>
    </li>
  );
}
