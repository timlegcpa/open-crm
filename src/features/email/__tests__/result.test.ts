import { describe, expect, it } from 'vitest';
import { deliveryNote, describeSendResult } from '../result';
import type { GroupEmailSendResult } from '../api';

const base: GroupEmailSendResult = { campaign_id: 'c1', sent: 5, failed: 0, skipped: 0, delivery: 'provider' };

describe('describeSendResult', () => {
  it('a clean send: "Sent", with only the delivered count', () => {
    expect(describeSendResult(base)).toEqual({ title: 'Sent', description: '5 delivered.', incomplete: false });
  });

  it('adds failed and skipped counts when present', () => {
    const r = describeSendResult({ ...base, failed: 2, skipped: 3 });
    expect(r).toEqual({ title: 'Sent', description: '5 delivered, 2 failed, 3 skipped.', incomplete: false });
  });

  it('unconfirmed delivery makes the send incomplete', () => {
    expect(describeSendResult({ ...base, sent: 12, unknown: 3 })).toEqual({
      title: 'Sent, but not to everyone',
      description: '12 delivered, 3 unconfirmed.',
      incomplete: true,
    });
  });

  it('unsent while still running reads "still sending", and is not an alarm', () => {
    const r = describeSendResult({ ...base, sent: 12, unsent: 38, still_running: true, duplicate: true });
    expect(r).toEqual({
      title: 'Already sent',
      description: 'Nothing new went out. This email was already submitted. 12 delivered, 38 still sending.',
      incomplete: false,
    });
  });

  it('unsent with nothing running reads "never sent", and is incomplete', () => {
    const r = describeSendResult({ ...base, sent: 12, unsent: 38, still_running: false, duplicate: true });
    expect(r.title).toBe('Sent, but not to everyone');
    expect(r.description).toBe('Nothing new went out. This email was already submitted. 12 delivered, 38 never sent.');
    expect(r.incomplete).toBe(true);
  });

  it('a plain replay never reads "Sent"', () => {
    expect(describeSendResult({ ...base, sent: 50, duplicate: true })).toEqual({
      title: 'Already sent',
      description: 'Nothing new went out. This email was already submitted. 50 delivered.',
      incomplete: false,
    });
  });

  it('composes every clause in order', () => {
    const r = describeSendResult({ ...base, sent: 1, failed: 2, skipped: 3, unknown: 4, unsent: 5, still_running: false, duplicate: true });
    expect(r.description).toBe(
      'Nothing new went out. This email was already submitted. 1 delivered, 2 failed, 3 skipped, 4 unconfirmed, 5 never sent.',
    );
    expect(r.incomplete).toBe(true);
  });

  it('omits zero counts', () => {
    expect(describeSendResult({ ...base, unknown: 0, unsent: 0, still_running: true }).description).toBe('5 delivered.');
  });

  it('never calls dev-outbox writes delivered', () => {
    const r = describeSendResult({ ...base, sent: 12, delivery: 'dev_outbox' });
    expect(r.description).toBe('12 written to the dev outbox. No email provider is configured, so nothing left this server.');
    expect(r.description).not.toContain('delivered');
    expect(deliveryNote('dev_outbox')).toMatch(/nobody receives them/);
    expect(deliveryNote('provider')).toBeNull();
  });
});
