import { describe, expect, it } from 'vitest';
import { isUuid as browserIsUuid } from '@/api/contacts';
import { isUuid as edgeIsUuid } from '../../../supabase/functions/_shared/http.ts';

// The browser checks a route id before using it; the edge function checks it again.
// If they disagree, an id the browser accepts gets a bare "Bad request" from the server.
const SAMPLES = [
  '3f2c1d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f',
  '3F2C1D4E-5B6A-4C7D-8E9F-0A1B2C3D4E5F',
  '018f2a1c-7d3e-7a1b-9c2d-3e4f5a6b7c8d',
  '00000000-0000-0000-0000-000000000000',
  '3f2c1d4e-5b6a-0c7d-8e9f-0a1b2c3d4e5f',
  '3f2c1d4e-5b6a-4c7d-7e9f-0a1b2c3d4e5f',
  '3f2c1d4e5b6a4c7d8e9f0a1b2c3d4e5f',
  'not-a-uuid',
  '',
];

describe('uuid checks', () => {
  it('the browser and the edge functions accept exactly the same ids', () => {
    for (const sample of SAMPLES) expect([sample, browserIsUuid(sample)]).toEqual([sample, edgeIsUuid(sample)]);
  });

  it('accepts generated ids and refuses the rest', () => {
    expect(SAMPLES.filter((s) => edgeIsUuid(s))).toEqual(SAMPLES.slice(0, 3));
  });
});
