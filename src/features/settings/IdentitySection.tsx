import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Panel } from '@/components/layout/page';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { isEdgeError } from '@/lib/edge';
import {
  brandColor,
  fetchOrgProfile,
  LOGO_TYPES,
  logoUrl,
  MAX_LOGO_BYTES,
  NothingChangedError,
  recordAudit,
  removeLogo,
  saveIdentity,
  settingsKeys,
  uploadLogo,
  type IdentityPatch,
  type OrgProfile,
} from './api';

/**
 * The organization's name, sender name, postal address, brand colour and logo: what every
 * email, public page and the portal show. The logo goes through the org-logo function,
 * which checks the file's bytes; the browser checks type and size first only to say so
 * sooner.
 */

const HEX = /^#[0-9a-f]{6}$/;

const LIMITS = { display_name: 120, legal_name: 200, sender_name: 120, postal_address: 500 } as const;

interface Draft {
  display_name: string;
  legal_name: string;
  sender_name: string;
  postal_address: string;
  primary_color: string;
}

function draftFrom(profile: OrgProfile): Draft {
  return {
    display_name: profile.display_name,
    legal_name: profile.legal_name ?? '',
    sender_name: profile.sender_name ?? '',
    postal_address: profile.postal_address ?? '',
    primary_color: brandColor(profile) ?? '',
  };
}

const orNull = (value: string) => (value.trim() ? value.trim() : null);

/** The first problem with the draft, or null. */
export function identityProblem(draft: Draft): string | null {
  if (!draft.display_name.trim()) return 'The name is required.';
  for (const [field, max] of Object.entries(LIMITS)) {
    if (draft[field as keyof typeof LIMITS].trim().length > max) return `Keep that field to ${max} characters.`;
  }
  const colour = draft.primary_color.trim().toLowerCase();
  if (colour && !HEX.test(colour)) return 'Write the colour as # and six hex digits, such as #1f6feb.';
  return null;
}

export function IdentitySection() {
  const { data: profile, isLoading, isError } = useQuery({ queryKey: settingsKeys.orgProfile(), queryFn: fetchOrgProfile });

  return (
    <div className="flex flex-col gap-4">
      {isLoading && <p className="text-[13px] text-muted-foreground">Loading...</p>}
      {isError && <p className="text-[13px] text-destructive">The organization details could not be loaded.</p>}
      {!isLoading && !isError && !profile && (
        <p className="text-[13px] text-muted-foreground">The organization is not set up yet. Run the setup step first.</p>
      )}
      {profile && (
        <>
          <IdentityForm key={JSON.stringify(draftFrom(profile))} profile={profile} />
          <LogoPanel profile={profile} />
        </>
      )}
    </div>
  );
}

function IdentityForm({ profile }: { profile: OrgProfile }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(profile));
  const set = (field: keyof Draft) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft((d) => ({ ...d, [field]: event.target.value }));

  const save = useMutation({
    mutationFn: async (patch: IdentityPatch) => {
      await saveIdentity(profile, patch);
      void recordAudit('settings_update', { section: 'identity' });
    },
    onSuccess: () => toast.success('Saved.'),
    onError: (err) => toast.error(err instanceof NothingChangedError ? err.message : 'The details were not saved. Try again.'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: settingsKeys.orgProfile() }),
  });

  const problem = identityProblem(draft);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem) {
      toast.error(problem);
      return;
    }
    void save
      .mutateAsync({
        display_name: draft.display_name.trim(),
        legal_name: orNull(draft.legal_name),
        sender_name: orNull(draft.sender_name),
        postal_address: orNull(draft.postal_address),
        primary_color: orNull(draft.primary_color.toLowerCase()),
      })
      .catch(() => undefined);
  };

  const colour = draft.primary_color.trim().toLowerCase();

  return (
    <Panel title="Identity" bodyClassName="p-4">
      <form onSubmit={submit} className="flex max-w-xl flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="identity-display-name">Name</Label>
          <Input id="identity-display-name" value={draft.display_name} onChange={set('display_name')} maxLength={LIMITS.display_name} required />
          <p className="text-xs text-muted-foreground">Shown in the app, on public pages and in the portal.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="identity-legal-name">Legal name</Label>
          <Input id="identity-legal-name" value={draft.legal_name} onChange={set('legal_name')} maxLength={LIMITS.legal_name} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="identity-sender-name">Email sender name</Label>
          <Input id="identity-sender-name" value={draft.sender_name} onChange={set('sender_name')} maxLength={LIMITS.sender_name} />
          <p className="text-xs text-muted-foreground">The name emails come from. Left empty, the name above is used.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="identity-address">Postal address</Label>
          <Textarea id="identity-address" rows={3} value={draft.postal_address} onChange={set('postal_address')} maxLength={LIMITS.postal_address} />
          <p className="text-xs text-muted-foreground">Printed at the foot of marketing emails.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="identity-colour">Brand colour</Label>
          <div className="flex items-center gap-2">
            <Input
              id="identity-colour"
              value={draft.primary_color}
              onChange={set('primary_color')}
              placeholder="#1f6feb"
              maxLength={7}
              className="w-32 font-mono"
            />
            <input
              type="color"
              aria-label="Pick the brand colour"
              value={HEX.test(colour) ? colour : '#000000'}
              onChange={(e) => setDraft((d) => ({ ...d, primary_color: e.target.value.toLowerCase() }))}
              className="h-8 w-10 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
            />
          </div>
        </div>
        <Button type="submit" className="self-start" disabled={save.isPending}>
          Save
        </Button>
      </form>
    </Panel>
  );
}

function LogoPanel({ profile }: { profile: OrgProfile }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const url = logoUrl(profile.logo_path);
  const refresh = () => queryClient.invalidateQueries({ queryKey: settingsKeys.orgProfile() });

  const upload = useMutation({
    mutationFn: uploadLogo,
    onSuccess: () => toast.success('Logo updated.'),
    onError: (err) => toast.error(isEdgeError(err) ? err.message : 'The logo was not uploaded. Try again.'),
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: async () => {
      await removeLogo();
      void recordAudit('settings_update', { section: 'logo_removed' });
    },
    onSuccess: () => toast.success('Logo removed.'),
    onError: (err) => toast.error(err instanceof NothingChangedError ? err.message : 'The logo was not removed. Try again.'),
    onSettled: refresh,
  });

  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!(LOGO_TYPES as readonly string[]).includes(file.type)) {
      toast.error('Use a PNG, JPEG or WebP image.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error('Use an image of 1 MB or less.');
      return;
    }
    void upload.mutateAsync(file).catch(() => undefined);
  };

  return (
    <Panel title="Logo" bodyClassName="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="flex h-20 w-40 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
        {url ? (
          <img src={url} alt="Current logo" className="max-h-16 max-w-36 object-contain" />
        ) : (
          <span className="text-xs text-muted-foreground">No logo</span>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">PNG, JPEG or WebP, up to 1 MB. Shown on public pages and emails.</p>
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            accept={LOGO_TYPES.join(',')}
            className="sr-only"
            aria-label="Choose a logo image"
            tabIndex={-1}
            onChange={pick}
          />
          <Button variant="outline" size="sm" disabled={upload.isPending} onClick={() => input.current?.click()}>
            <ImageUp />
            {url ? 'Replace logo' : 'Upload logo'}
          </Button>
          {url && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" disabled={remove.isPending}>
                  <Trash2 />
                  Remove
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove the logo?</AlertDialogTitle>
                  <AlertDialogDescription>Public pages and emails show the name alone until a new logo is uploaded.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void remove.mutateAsync().catch(() => undefined)}>Remove</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </Panel>
  );
}
