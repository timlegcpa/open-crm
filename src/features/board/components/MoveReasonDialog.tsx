import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import type { BoardStageKey } from '../api';
import { defaultMoveNote, EVENT_NOTE_MAX, moveReasonChips } from '../board';

export interface MoveRequest {
  /** Resets the reason when a different card opens the dialog. */
  key: string;
  to: BoardStageKey;
  /** The lane's current label. */
  toLabel: string;
  /** "Call back for Ada Lovelace". */
  description: string;
}

/**
 * Every move asks for a reason (the database refuses one without). The quick reasons are
 * selectable pills; a move into Done gets a Done pill, first and already selected, so
 * marking a card done is one click on Confirm.
 */
export function MoveReasonDialog({
  move,
  submitting,
  onCancel,
  onConfirm,
}: {
  move: MoveRequest | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  const moveKey = move?.key;
  const moveTo = move?.to;

  useEffect(() => {
    setNote(moveTo ? defaultMoveNote(moveTo) : '');
  }, [moveKey, moveTo]);

  const canConfirm = note.trim() !== '' && !submitting;

  return (
    <Dialog
      open={move !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Move to {move?.toLabel}</DialogTitle>
          <DialogDescription>
            {move ? `A reason is required to move ${move.description}.` : 'A reason is required to move this card.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick reasons">
          {(moveTo ? moveReasonChips(moveTo) : []).map((chip) => (
            <Toggle
              key={chip}
              size="sm"
              variant="outline"
              pressed={note.trim() === chip}
              onPressedChange={() => setNote(chip)}
              className="h-7 px-2 text-[12px]"
            >
              {chip}
            </Toggle>
          ))}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="board-move-note">Reason</Label>
          <Textarea
            id="board-move-note"
            maxLength={EVENT_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            placeholder="Why is this moving?"
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" disabled={!canConfirm} onClick={() => onConfirm(note.trim())}>
            {submitting ? 'Moving...' : 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
