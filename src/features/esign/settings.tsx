import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, PenLine } from 'lucide-react';
import { Panel } from '@/components/layout/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { Switch } from '@/components/ui/switch';
import { getErrorMessage } from '@/lib/errors';
import { getEsignSettings, saveEsignSettings } from './api';
import { FILING_FOLDER_MAX, type EsignSettings as Settings } from './contract';
import { filingFolderProblem, normalizeFilingFolder } from './lib/filingFolder';
import { esignKeys } from './keys';

/** Settings > E-sign: where signed copies are filed, and whether High verification can text a code. */
export function EsignSettings() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: esignKeys.settings, queryFn: getEsignSettings });
  const [folder, setFolder] = useState('');
  const [sms, setSms] = useState(true);

  useEffect(() => {
    if (!settings.data) return;
    setFolder(settings.data.filing_folder);
    setSms(settings.data.sms_enabled);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (next: Settings) => saveEsignSettings(next),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: esignKeys.settings });
      toast.success('E-sign settings saved.');
    },
    onError: (err) => toast.error(getErrorMessage(err, 'The settings were not saved. Try again.')),
  });

  const problem = filingFolderProblem(folder);
  const changed = !!settings.data && (normalizeFilingFolder(folder) !== settings.data.filing_folder || sms !== settings.data.sms_enabled);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || !changed) return;
    save.mutate({ filing_folder: normalizeFilingFolder(folder), sms_enabled: sms });
  };

  return (
    <Panel title="E-sign" icon={<PenLine className="size-3.5" aria-hidden="true" />} bodyClassName="flex flex-col gap-4 p-4">
      {settings.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : settings.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load the e-sign settings: {getErrorMessage(settings.error)}
        </p>
      ) : (
        <form onSubmit={submit} className="flex max-w-md flex-col gap-5" aria-label="E-sign settings">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="esign-filing-folder">Filing folder</Label>
            <Input
              id="esign-filing-folder"
              value={folder}
              maxLength={FILING_FOLDER_MAX}
              onChange={(e) => setFolder(e.target.value)}
              aria-invalid={problem ? true : undefined}
              aria-describedby="esign-filing-folder-hint"
            />
            <p id="esign-filing-folder-hint" className={problem ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
              {problem ?? 'Each signed copy is filed in this folder of the contact’s documents. Use / for a folder inside another, for example Signed/Agreements.'}
            </p>
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="esign-sms">Text message codes</Label>
              <p className="text-xs text-muted-foreground">
                High verification texts each signer a code before they sign. Turn it off if no text provider is set up; envelopes then
                use Standard.
              </p>
            </div>
            <Switch id="esign-sms" checked={sms} onCheckedChange={setSms} />
          </div>
          <div>
            <Button type="submit" size="sm" disabled={!!problem || !changed || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              Save
            </Button>
          </div>
        </form>
      )}
    </Panel>
  );
}
