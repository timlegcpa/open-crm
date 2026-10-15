// The refusals the e-signature functions share. Every public message is one sentence
// that starts with a capital and ends in . ! or ?, so the browser shows it as written;
// the machine meaning is the code.

import { HttpError, REFUSALS } from '../../_shared/handler.ts';
import { pgCode } from './db.ts';

export const badRequest = (message: string = REFUSALS.badRequest.error, code: string = REFUSALS.badRequest.code) =>
  new HttpError(400, message, code);

export const envelopeNotFound = () => new HttpError(404, 'That envelope no longer exists.', 'not_found');

export const signerNotFound = () => new HttpError(404, 'That signer is not on this envelope.', 'signer_not_found');

/** A draft-only action on an envelope that has been sent. */
export const notDraft = () => new HttpError(409, 'This envelope has been sent and can no longer be edited.', 'not_draft');

/** The public signer functions' one answer for a link that is unknown, spent or not signable. */
export const linkNotFound = () => new HttpError(404, 'This signing link is not valid.', 'not_found');

/** A 'high' envelope's signer without a live SMS session from this address. */
export const sessionRequired = () => new HttpError(401, 'Confirm the code sent to your phone first.', 'session_required');

export const smsUnavailable = () =>
  new HttpError(409, 'Text message codes are not available. Turn SMS on in settings or choose standard verification.', 'sms_unavailable');

/** An RPC's own refusals: a draft check (55000) and a missing row (P0002). Anything else is rethrown. */
export function rpcRefusal(err: unknown): HttpError | null {
  const code = pgCode(err);
  if (code === '55000') return notDraft();
  if (code === 'P0002') return envelopeNotFound();
  return null;
}

/** A body that must be a JSON object. */
export function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest();
  return body as Record<string, unknown>;
}
