import { PublicPage } from '@/components/layout/PublicPage';
import { SignerFlow } from './signer/SignerFlow';

/** /sign#token=...: where a signer's emailed link lands. No session; the token is the capability. */
export function SignPage() {
  return (
    <PublicPage title="Sign a document" width="wide">
      <SignerFlow />
    </PublicPage>
  );
}
