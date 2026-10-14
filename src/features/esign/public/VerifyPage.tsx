import { PublicPage } from '@/components/layout/PublicPage';

/** Placeholder: anyone can check a signed document's certificate here. The e-sign feature replaces it. */
export function VerifyPage() {
  return (
    <PublicPage title="Verify a signed document">
      <p className="text-[14px] text-muted-foreground">Check that a signed document is genuine and unchanged.</p>
    </PublicPage>
  );
}
