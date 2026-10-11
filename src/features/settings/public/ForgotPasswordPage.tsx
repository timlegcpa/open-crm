import { PublicPage } from '@/components/layout/PublicPage';

/** Placeholder: ask for a password-reset email. The settings feature replaces it. */
export function ForgotPasswordPage() {
  return (
    <PublicPage title="Reset your password">
      <p className="text-[14px] text-muted-foreground">Enter your email and we will send you a link to choose a new password.</p>
    </PublicPage>
  );
}
