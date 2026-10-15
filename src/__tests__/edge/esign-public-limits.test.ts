// @vitest-environment node
// The shared (all-addresses) ceilings on the public e-sign functions. A low shared ceiling
// lets a handful of addresses lock every real signer out, so the functions that cost
// nothing to serve carry a high one. The two that send or check text message codes keep
// theirs low: request-sms because each call can spend money on a text.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LIMIT = /publicLimits\(db, '([a-z_]+)', \{ max: (\d+), windowMinutes: (\d+) \}, \{ max: (\d+), windowMinutes: (\d+) \}\)/;

function limits(fn: string) {
  const m = LIMIT.exec(readFileSync(`supabase/functions/${fn}/handler.ts`, 'utf8'));
  expect(m, fn).not.toBeNull();
  return { perIp: Number(m![2]), perIpMinutes: Number(m![3]), shared: Number(m![4]), sharedMinutes: Number(m![5]) };
}

describe('public e-sign rate limits', () => {
  it('free-to-serve signer functions carry a shared ceiling at least 100 times their per-address one', () => {
    for (const fn of ['esign-resolve-token', 'esign-signer-view-pdf', 'esign-signer-sign', 'esign-signer-decline', 'esign-verify-document', 'esign-signer-verify-sms']) {
      const l = limits(fn);
      expect([fn, l.shared >= 100 * l.perIp, l.sharedMinutes === l.perIpMinutes]).toEqual([fn, true, true]);
    }
  });

  it('the delivery webhook has a per-address ceiling under its shared one', () => {
    expect(limits('esign-resend-webhook')).toEqual({ perIp: 200, perIpMinutes: 1, shared: 600, sharedMinutes: 1 });
  });

  it('the text-sending function keeps its spend ceiling', () => {
    expect(limits('esign-signer-request-sms')).toEqual({ perIp: 10, perIpMinutes: 60, shared: 100, sharedMinutes: 60 });
  });
});
