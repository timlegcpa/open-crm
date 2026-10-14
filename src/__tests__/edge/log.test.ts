// @vitest-environment node
// What reaches a function log. Token-shaped fixtures are built at runtime so the
// secret scanner never sees a literal.
import { describe, expect, it } from 'vitest';
import {
  createLogger,
  errSummary,
  redactText,
  safeFieldValue,
  type LogLevel,
} from '../../../supabase/functions/_shared/log';

const ID = '3f2c1d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f';
const b64url = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = () => `${b64url({ alg: 'HS256' })}.${b64url({ sub: ID, email: 'ada@example.test' })}.${'s'.repeat(43)}`;
const hexSecret = () => Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(i * 7) % 16]).join('');

describe('errSummary', () => {
  it('drops details and hint, which carry row values', () => {
    const out = errSummary({
      code: '23514',
      message: 'new row for relation "contacts" violates check constraint "chk_status"',
      details: 'Failing row contains (abc, Ada, Example, ada@example.test, 555-010-4477)',
      hint: null,
    });
    expect(out).toBe('[23514] new row for relation "contacts" violates check constraint "chk_status"');
  });

  it('redacts the quoted input of a data-type error, to the end even past an embedded quote', () => {
    expect(errSummary({ code: '22007', message: 'invalid input syntax for type date: "1980-13-45"' })).toBe(
      '[22007] invalid input syntax for type date: "[redacted]"',
    );
    expect(errSummary({ code: '22007', message: 'invalid input syntax for type date: ""123456789"' })).toBe(
      '[22007] invalid input syntax for type date: "[redacted]"',
    );
  });

  it('drops a JSON.parse error whole, since its message quotes the input', () => {
    let err: unknown;
    try {
      JSON.parse('{"street":"12 Elm St","phone":"555-010-4477"');
    } catch (e) {
      err = e;
    }
    expect(errSummary(err)).toBe('SyntaxError');
  });

  it('handles thrown Errors, bare codes and junk, and caps the length', () => {
    expect(errSummary(new Error('boom'))).toBe('boom');
    expect(errSummary({ code: 'PGRST116' })).toBe('[PGRST116]');
    expect(errSummary(null)).toBe('unknown');
    expect(errSummary('a string')).toBe('unknown');
    expect(errSummary(new Error('x'.repeat(500))).length).toBe(200);
  });
});

describe('redactText', () => {
  it.each([
    ['an email', 'sent to ada@example.test today', 'sent to [email] today'],
    ['a formatted phone', 'call +1 (555) 010-4477 back', 'call [number] back'],
    ['a dashed phone', 'phone 555-010-4477', 'phone [number]'],
    ['a bare phone', 'phone 5550104477', 'phone [number]'],
    ['a date of birth', 'born 1980-02-14', 'born [number]'],
    ['an id-number shape', 'ssn 123-45-6789', 'ssn [number]'],
    ['a Postgres key echo', 'Key (email)=(ada@example.test) already exists', 'Key (email)=([redacted]) already exists'],
    ['a failing row', 'Failing row contains (Ada, Example)', 'Failing row contains ([redacted])'],
    ['a bearer token', 'Authorization: Bearer abc.def.ghi', 'Authorization: [token] [token]'],
    ['a key=value secret', 'api_key=hunter2 rest', 'api_key=[token] rest'],
  ])('removes %s', (_label, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('removes a JWT, a hex secret and an API-key-shaped string', () => {
    expect(redactText(`token ${jwt()} end`)).toBe('token [token] end');
    expect(redactText(`secret ${hexSecret()} end`)).toBe('secret [token] end');
    expect(redactText(`key re_${'Ab1'.repeat(10)} end`)).toBe('key [token] end');
  });

  it('keeps UUIDs, SQLSTATE codes, statuses, short numbers and plain identifiers', () => {
    const line = `contact ${ID} status 502 [23505] check_auth_global_rate_limit took 1234 ms`;
    expect(redactText(line)).toBe(line);
    expect(redactText(`${ID} ${ID}`)).toBe(`${ID} ${ID}`);
  });

  it('cannot be confused by the parking character in the input', () => {
    const mark = String.fromCharCode(0xe000);
    expect(redactText(`${mark}0${mark} ${ID}`)).toBe(`0 ${ID}`);
  });
});

describe('safeFieldValue', () => {
  it('keeps ids, codes, numbers, booleans and null; refuses free text', () => {
    expect(safeFieldValue(ID)).toBe(ID);
    expect(safeFieldValue('provider_rejected')).toBe('provider_rejected');
    expect(safeFieldValue('lead_intake.ip')).toBe('lead_intake.ip');
    expect(safeFieldValue(502)).toBe('502');
    expect(safeFieldValue(true)).toBe('true');
    expect(safeFieldValue(null)).toBe('null');
    expect(safeFieldValue('Ada Example')).toBe('[redacted]');
    expect(safeFieldValue('ada@example.test')).toBe('[redacted]');
    expect(safeFieldValue({ a: 1 })).toBe('[redacted]');
    expect(safeFieldValue(Number.NaN)).toBe('[redacted]');
  });

  it('still redacts a phone number passed as a code or a number', () => {
    expect(safeFieldValue('5550104477')).toBe('[number]');
    expect(safeFieldValue(5550104477)).toBe('[number]');
  });
});

describe('createLogger', () => {
  function collect() {
    const lines: Array<[LogLevel, string]> = [];
    return { lines, sink: (level: LogLevel, line: string) => lines.push([level, line]) };
  }

  it('writes one redacted line per call, with the name and request id', () => {
    const { lines, sink } = collect();
    const log = createLogger('lead-intake', { requestId: 'rid-1', sink });
    log.error('insert failed for ada@example.test', { code: '23505', message: 'duplicate key', details: 'Key (email)=(ada@example.test)' }, {
      contact_id: ID,
      name: 'Ada Example',
      status: 409,
      'bad key!': 'x',
    });
    log.warn('slow', { ms: 1200 });
    log.info('done');
    expect(lines).toEqual([
      ['error', `[lead-intake] rid=rid-1 insert failed for [email]: [23505] duplicate key contact_id=${ID} name=[redacted] status=409`],
      ['warn', '[lead-intake] rid=rid-1 slow ms=1200'],
      ['info', '[lead-intake] rid=rid-1 done'],
    ]);
  });

  it('omits the request id when there is none and the summary when there is no error', () => {
    const { lines, sink } = collect();
    createLogger('job', { sink }).error('tick');
    expect(lines).toEqual([['error', '[job] tick']]);
  });
});
