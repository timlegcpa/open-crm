import { PublicPage } from '@/components/layout/PublicPage';

/** Placeholder: where a signer's link lands. The e-sign feature replaces it. */
export function SignPage() {
  return (
    <PublicPage title="Sign a document" width="wide">
      <p className="text-[14px] text-muted-foreground">The document to sign will appear here.</p>
    </PublicPage>
  );
}
