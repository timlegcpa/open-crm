import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Panel } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/sonner';
import { Switch } from '@/components/ui/switch';
import { PickListEditor } from '@/features/settings/PickListEditor';
import { getErrorMessage } from '@/lib/errors';
import { getReminderSettings, REQUEST_CATEGORIES, REQUEST_TAGS, saveReminderSettings } from './api';
import { requestKeys } from './keys';
import { INTERVAL_DAYS_RANGE, MAX_REMINDERS_RANGE, normalizeReminderSettings, type ReminderSettings } from './lib/requests';

/** Settings, Requests: the scheduled reminders, then the categories and tags items are filed under. */
export function RequestsSettings() {
  return (
    <div className="flex flex-col gap-4">
      <ReminderSettingsPanel />
      <PickListEditor
        title="Request categories"
        list={REQUEST_CATEGORIES}
        shape="open"
        description="What an item is, and the category its uploaded file is filed under. Clients do not see these."
      />
      <PickListEditor title="Request tags" list={REQUEST_TAGS} shape="open" description="A second way to sort items. Clients do not see these." />
    </div>
  );
}

function ReminderSettingsPanel() {
  const queryClient = useQueryClient();
  const stored = useQuery({ queryKey: requestKeys.reminders(), queryFn: getReminderSettings });
  const [form, setForm] = useState<ReminderSettings | null>(null);
  // The form is filled once the stored value is known, never from a default that a save would then write.
  useEffect(() => {
    if (stored.data && form === null) setForm(stored.data);
  }, [stored.data, form]);

  const save = useMutation({
    mutationFn: (value: ReminderSettings) => saveReminderSettings(value),
    onSuccess: () => {
      toast.success('Reminder settings saved.');
      void queryClient.invalidateQueries({ queryKey: requestKeys.reminders() });
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The settings were not saved.')),
  });

  const loaded = form !== null;
  const value = form ?? normalizeReminderSettings(null);
  const set = (change: Partial<ReminderSettings>) => setForm({ ...value, ...change });
  const number = (raw: string) => (raw.trim() === '' ? Number.NaN : Number(raw));

  return (
    <Panel title="Reminders" bodyClassName="flex flex-col gap-4 p-4">
      <p className="text-[13px] text-muted-foreground">
        Email a client about a request they have not finished, on a schedule. Only clients with a portal account are reminded this way; Remind now on a request works for anyone.
      </p>
      {stored.error && (
        <p role="alert" className="text-[13px] text-destructive">
          Could not load the settings: {getErrorMessage(stored.error)}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Switch id="reminders-enabled" checked={value.enabled} disabled={!loaded} onCheckedChange={(enabled) => set({ enabled })} />
        <Label htmlFor="reminders-enabled" className="font-normal">
          Send reminders automatically
        </Label>
      </div>
      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reminders-interval">Days between reminders</Label>
          <Input
            id="reminders-interval"
            className="w-28"
            inputMode="numeric"
            disabled={!loaded}
            value={Number.isFinite(value.interval_days) ? String(value.interval_days) : ''}
            onChange={(e) => set({ interval_days: number(e.target.value) })}
            aria-describedby="reminders-interval-range"
          />
          <p id="reminders-interval-range" className="text-[12px] text-muted-foreground">
            {INTERVAL_DAYS_RANGE.min} to {INTERVAL_DAYS_RANGE.max}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reminders-max">Most reminders per request</Label>
          <Input
            id="reminders-max"
            className="w-28"
            inputMode="numeric"
            disabled={!loaded}
            value={Number.isFinite(value.max_reminders) ? String(value.max_reminders) : ''}
            onChange={(e) => set({ max_reminders: number(e.target.value) })}
            aria-describedby="reminders-max-range"
          />
          <p id="reminders-max-range" className="text-[12px] text-muted-foreground">
            {MAX_REMINDERS_RANGE.min} to {MAX_REMINDERS_RANGE.max}
          </p>
        </div>
      </div>
      <div>
        <Button size="sm" disabled={!loaded || save.isPending} onClick={() => {
            // What is saved is what is shown: an out-of-range number lands on its bound first.
            const next = normalizeReminderSettings(value);
            setForm(next);
            save.mutate(next);
          }}
        >
          Save reminders
        </Button>
      </div>
    </Panel>
  );
}
