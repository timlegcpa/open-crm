import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { addContactNote } from '@/api/contactNotes';
import { createContact } from '@/api/contacts';
import { queryKeys } from '@/api/queryKeys';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import { useLeadSources, useServiceTypes } from '@/hooks/usePickLists';
import { PIPELINE_STATUSES } from '@/lib/contactStatus';
import { getErrorMessage } from '@/lib/errors';
import { auditContactCreate, createQuotes } from '../../api';

export interface NewLeadValues {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  source: string;
  status: string;
  /** Service type keys the lead asked about: each becomes a proposed, unpriced quote. */
  interests: string[];
  note: string;
}

const BLANK: NewLeadValues = { firstName: '', lastName: '', email: '', phone: '', source: 'other', status: 'new_lead', interests: [], note: '' };

const blankToNull = (v: string) => (v.trim() === '' ? null : v.trim());

/**
 * The board's quick add: the fields a lead call needs and nothing else (name, how to reach
 * them, where they came from, which column they land in, what they asked about, one note).
 * The full Add contact page stays for everything else.
 *
 * No <form> on purpose: Enter in a field never saves mid-call, Create is the one way out,
 * and a failed save leaves the dialog open with everything typed. Once the contact is saved
 * the quotes and the note are extras: their failure is said, never a failed create, or a
 * retry would add the person twice.
 */
export function NewLeadDialog({
  open,
  onOpenChange,
  stageLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stageLabel: (status: string) => string;
}) {
  const queryClient = useQueryClient();
  const sources = useLeadSources();
  const services = useServiceTypes();
  const [v, setV] = useState<NewLeadValues>(BLANK);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof NewLeadValues>(key: K, value: NewLeadValues[K]) => setV((cur) => ({ ...cur, [key]: value }));

  useEffect(() => {
    if (open) setV(BLANK);
  }, [open]);

  const activeSources = (sources.data ?? []).filter((s) => s.is_active);
  const activeServices = (services.data ?? []).filter((s) => s.is_active);
  // The default source is 'other' when the owner keeps it, else their first active one.
  const source = activeSources.some((s) => s.key === v.source) ? v.source : (activeSources[0]?.key ?? v.source);

  const create = async () => {
    if (saving) return;
    if (!v.firstName.trim()) {
      toast.error('Add at least a first name.');
      return;
    }
    if (v.email.trim() && !v.email.includes('@')) {
      toast.error('That email address is missing an @.');
      return;
    }
    setSaving(true);
    let id: string;
    try {
      id = await createContact({
        first_name: v.firstName.trim(),
        last_name: v.lastName.trim(),
        email: blankToNull(v.email),
        phone: blankToNull(v.phone),
        business_name: null,
        status: v.status,
        source,
        submitted_at: null,
      });
    } catch (err) {
      toast.error(getErrorMessage(err, 'The contact was not saved.'));
      setSaving(false);
      return;
    }
    void auditContactCreate(id);
    const rows = activeServices
      .filter((s) => v.interests.includes(s.key))
      .map((s) => ({ contact_id: id, organization_id: null, service_type: s.key, state: 'proposed' as const, cadence: s.default_cadence, amount: null }));
    if (rows.length > 0) {
      try {
        await createQuotes(rows);
      } catch (err) {
        toast.error('Contact saved; its services were not.', { description: getErrorMessage(err) });
      }
    }
    if (v.note.trim()) {
      try {
        await addContactNote(id, v.note.trim(), 'note');
      } catch (err) {
        toast.error('Contact saved; its note was not.', { description: getErrorMessage(err) });
      }
    }
    // The contacts prefix covers the list and the cards' note line.
    await queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
    setSaving(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New contact</DialogTitle>
          <DialogDescription>Add someone to the pipeline.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-lead-first">First name</Label>
              <Input id="new-lead-first" autoFocus value={v.firstName} onChange={(e) => set('firstName', e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-lead-last">Last name</Label>
              <Input id="new-lead-last" value={v.lastName} onChange={(e) => set('lastName', e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-lead-email">Email</Label>
              <Input id="new-lead-email" type="email" value={v.email} onChange={(e) => set('email', e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-lead-phone">Phone</Label>
              <Input id="new-lead-phone" type="tel" value={v.phone} onChange={(e) => set('phone', e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-lead-source">Source</Label>
              <Select value={source} onValueChange={(next) => set('source', next)}>
                <SelectTrigger id="new-lead-source"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {activeSources.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-lead-stage">Stage</Label>
              <Select value={v.status} onValueChange={(next) => set('status', next)}>
                <SelectTrigger id="new-lead-stage"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PIPELINE_STATUSES.map((s) => <SelectItem key={s} value={s}>{stageLabel(s)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {activeServices.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-sm font-medium leading-none" id="new-lead-interests">Interested in</div>
              <div role="group" aria-labelledby="new-lead-interests" className="flex flex-wrap gap-1.5">
                {activeServices.map((s) => (
                  <Toggle
                    key={s.key}
                    size="sm"
                    variant="outline"
                    className="h-8 text-[12.5px]"
                    pressed={v.interests.includes(s.key)}
                    onPressedChange={(on) => set('interests', on ? [...v.interests, s.key] : v.interests.filter((x) => x !== s.key))}
                  >
                    {s.label}
                  </Toggle>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-lead-note">Note</Label>
            <Textarea id="new-lead-note" rows={3} maxLength={10000} value={v.note} onChange={(e) => set('note', e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={saving} onClick={() => void create()}>
            {saving ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
