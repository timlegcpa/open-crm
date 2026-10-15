// The public signer journey with the network stubbed per call: where the token is kept,
// which screen each answer leads to, the decline path and the text-code step.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ResolvedSigner } from '../contract';

vi.mock('@/lib/supabase', () => {
  throw new Error('the signer flow imported @/lib/supabase');
});
vi.mock('@/lib/auth', () => {
  throw new Error('the signer flow imported the auth provider');
});

const api = vi.hoisted(() => ({
  resolveToken: vi.fn(),
  requestSmsCode: vi.fn(),
  verifySmsCode: vi.fn(),
  decline: vi.fn(),
}));

vi.mock('../public/signer/signerApi', async () => {
  const actual = await vi.importActual<typeof import('../public/signer/signerApi')>('../public/signer/signerApi');
  return { ...actual, ...api };
});

// The review screen draws with pdf.js; here it is three buttons onto the flow's callbacks.
vi.mock('../public/signer/PdfReview', () => ({
  PdfReview: (props: { sessionToken: string | null; onSigned: () => void; onSessionExpired: () => void; onDecline: () => void }) => (
    <div>
      <p>review with session {props.sessionToken ?? 'none'}</p>
      <button onClick={props.onSigned}>stub sign</button>
      <button onClick={props.onSessionExpired}>stub expire</button>
      <button onClick={props.onDecline}>stub decline</button>
    </div>
  ),
}));

import { SignerFlow } from '../public/signer/SignerFlow';
import { TOKEN_STORAGE_KEY } from '../public/signer/signingToken';
import { SignPage } from '../public/SignPage';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

function resolved(over: Partial<ResolvedSigner> = {}): ResolvedSigner & { state: 'ok' } {
  return {
    state: 'ok',
    envelope: { id: 'env-1', title: 'Acme engagement letter', verification_level: 'standard', status: 'sent' },
    signer: { id: 's1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', status: 'invited', signed_at: null, phone_last_four: '0001' },
    document: { page_count: 1 },
    fields: [],
    needs_sms: false,
    org: { display_name: 'Acme LLC', legal_name: 'Acme Holdings LLC', contact_email: 'hello@example.com' },
    ...over,
  } as ResolvedSigner & { state: 'ok' };
}

beforeEach(() => {
  // input-otp asks where the caret sits; jsdom has no layout.
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 404 })));
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/sign');
  for (const fn of Object.values(api)) fn.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the token', () => {
  it('with no token, says the link is incomplete and calls nothing', async () => {
    render(<SignPage />);
    expect(await screen.findByText('This signing link is incomplete')).toBeInTheDocument();
    expect(api.resolveToken).not.toHaveBeenCalled();
  });

  it('is taken from the fragment, kept for the tab, and stripped from the address bar', async () => {
    window.history.replaceState(null, '', `/sign?x=1#token=${TOKEN}`);
    api.resolveToken.mockResolvedValue(resolved());
    render(<SignerFlow />);
    await screen.findByText(/Acme LLC has asked you to sign/);
    expect(api.resolveToken).toHaveBeenCalledWith(TOKEN);
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?x=1');
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
  });

  it('a refresh after the strip still finds it', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    api.resolveToken.mockResolvedValue(resolved());
    render(<SignerFlow />);
    await screen.findByText('Hello Ada,');
    expect(api.resolveToken).toHaveBeenCalledWith(TOKEN);
  });

  it('an end state clears it', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    api.resolveToken.mockResolvedValue({ state: 'voided', envelope: { title: 'Acme engagement letter' }, org: null });
    render(<SignerFlow />);
    expect(await screen.findByText('This signing request was cancelled')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });
});

describe('end states from resolve', () => {
  it.each([
    ['expired', 'This signing link has expired'],
    ['declined', 'You declined to sign'],
    ['co_signer_declined', 'This signing request was closed'],
  ] as const)('%s', async (state, title) => {
    api.resolveToken.mockResolvedValue({ state, org: null });
    render(<SignerFlow initialToken={TOKEN} />);
    expect(await screen.findByText(title)).toBeInTheDocument();
  });

  it('already signed shows the done screen', async () => {
    api.resolveToken.mockResolvedValue({ state: 'already_signed', envelope: { title: 'Acme engagement letter' }, org: null });
    render(<SignerFlow initialToken={TOKEN} />);
    expect(await screen.findByText('Already signed')).toBeInTheDocument();
  });

  it('a refused link reads as not found', async () => {
    api.resolveToken.mockRejectedValue(new Error('404'));
    render(<SignerFlow initialToken={TOKEN} />);
    expect(await screen.findByText('This document could not be opened')).toBeInTheDocument();
  });
});

describe('standard journey', () => {
  it('landing, consent (gated on the box, naming the sender and its address), review, done', async () => {
    api.resolveToken.mockResolvedValue(resolved());
    render(<SignerFlow initialToken={TOKEN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const agree = screen.getByRole('button', { name: 'I agree, continue' });
    expect(agree).toBeDisabled();
    expect(screen.getByText(/by asking Acme Holdings LLC before you sign/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'hello@example.com' })).toHaveAttribute('href', 'mailto:hello@example.com');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(agree);
    expect(await screen.findByText('review with session none')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'stub sign' }));
    expect(screen.getByText('You have signed')).toBeInTheDocument();
  });

  it('with no contact address the consent points to the email, never a guessed address', async () => {
    api.resolveToken.mockResolvedValue(resolved({ org: null }));
    render(<SignerFlow initialToken={TOKEN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(screen.getByText(/by replying to the email this link came in/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('decline sends the reason and ends on the declined screen', async () => {
    api.resolveToken.mockResolvedValue(resolved());
    api.decline.mockResolvedValue('ok');
    render(<SignerFlow initialToken={TOKEN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decline to sign' }));
    fireEvent.change(await screen.findByLabelText('Reason (optional)'), { target: { value: 'Wrong document' } });
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('You declined to sign')).toBeInTheDocument();
    expect(api.decline).toHaveBeenCalledWith(TOKEN, null, 'Wrong document');
  });
});

describe('high verification', () => {
  const high = () => resolved({ envelope: { id: 'env-1', title: 'Acme plan', verification_level: 'high', status: 'sent' }, needs_sms: true });

  it('asks for the code first, carries the session to review, and a lapsed session goes back', async () => {
    api.resolveToken.mockResolvedValue(high());
    api.requestSmsCode.mockResolvedValue('0001');
    api.verifySmsCode.mockResolvedValue({ ok: true, session_token: 'session-0123456789' });
    render(<SignerFlow initialToken={TOKEN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Text me a code' }));
    // Six digits submit by themselves.
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '123456' } });
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'I agree, continue' }));
    expect(await screen.findByText('review with session session-0123456789')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'stub expire' }));
    expect(screen.getByRole('button', { name: 'Text me a code' })).toBeInTheDocument();
  });

  it('a wrong code says how many tries are left; the fifth failure locks', async () => {
    api.resolveToken.mockResolvedValue(high());
    api.requestSmsCode.mockResolvedValue('0001');
    api.verifySmsCode.mockResolvedValue({ ok: false, attempts_left: 4 });
    render(<SignerFlow initialToken={TOKEN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Text me a code' }));
    const input = await screen.findByRole('textbox');
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        fireEvent.change(input, { target: { value: '111111' } });
      });
    }
    expect(screen.getByText('That code is not right. 4 attempts left.')).toBeInTheDocument();
    expect(api.verifySmsCode).toHaveBeenCalledTimes(4);
    await act(async () => {
      fireEvent.change(input, { target: { value: '111111' } });
    });
    expect(await screen.findByText('Too many attempts')).toBeInTheDocument();
  });

  it('a decline without a live session goes back to the code step', async () => {
    api.resolveToken.mockResolvedValue(high());
    api.requestSmsCode.mockResolvedValue('0001');
    api.verifySmsCode.mockResolvedValue({ ok: true, session_token: 'session-0123456789' });
    api.decline.mockResolvedValue('session_expired');
    render(<SignerFlow initialToken={TOKEN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Text me a code' }));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: '123456' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Decline to sign' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Text me a code' })).toBeInTheDocument());
    expect(api.decline).toHaveBeenCalledWith(TOKEN, 'session-0123456789', '');
  });
});
