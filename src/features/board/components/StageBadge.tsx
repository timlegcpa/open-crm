import { Badge } from '@/components/ui/badge';
import type { BoardStage } from '../api';
import { stageLabel } from '../board';
import { stageTone } from '../stageTone';

/** A stage, as history stores it, in its lane's colour and current label. */
export function StageBadge({ stageKey, rows }: { stageKey: string | null; rows: ReadonlyMap<string, BoardStage> }) {
  const colour = stageTone(stageKey, stageKey ? rows.get(stageKey)?.colour : null).dot;
  return (
    <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-medium" style={{ borderColor: colour, color: colour }}>
      {stageLabel(stageKey, rows) || 'unknown'}
    </Badge>
  );
}
