import { PublicPage } from '@/components/layout/PublicPage';

/** Placeholder: where the password-reset email lands. The settings feature replaces it. */
export function ResetPasswordPage() {
  return (
    <PublicPage title="Choose a new password">
      <p className="text-[14px] text-muted-foreground">Pick a new password for your account.</p>
    </PublicPage>
  );
}
