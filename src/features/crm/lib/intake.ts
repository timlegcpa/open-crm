import { z } from 'zod';
import type { NewQuote } from '../api';
import { parseCurrencyInput } from './quotes';

const text = (max: number, message: string) => z.string().trim().max(max, message);

/** The intake form at the boundary: what the owner typed, checked before anything is written. */
export const intakeSchema = z.object({
  first_name: z.string().trim().min(1, 'Enter a first name.').max(200, 'Keep this under 200 characters.'),
  last_name: text(200, 'Keep this under 200 characters.'),
  email: z
    .string()
    .trim()
    .max(254, 'That email address is too long.')
    .refine((v) => v === '' || z.string().email().safeParse(v).success, 'Enter a valid email address.'),
  phone: text(40, 'That phone number is too long.'),
  business_name: text(200, 'Keep this under 200 characters.'),
  status: z.string().min(1, 'Choose a status.'),
  source: z.string().min(1, 'Choose a source.'),
  added_date: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Pick a valid date.'),
  note: text(10000, 'Keep the note under 10,000 characters.'),
});

export type IntakeForm = z.input<typeof intakeSchema>;

export interface ServiceDraft {
  key: string;
  default_cadence: 'monthly' | 'annual' | 'one_time';
}

/**
 * The quote rows the intake's Services block writes. A blank or zero amount writes
 * nothing. The state follows the status: a client gets accepted quotes at each service's
 * default cadence; a one-time client gets accepted one-time quotes; anyone else gets
 * proposed quotes. Returns an error message instead when an amount is not a number.
 */
export function intakeQuotes(
  contactId: string,
  status: string,
  services: readonly ServiceDraft[],
  amounts: Readonly<Record<string, string>>,
): { rows: NewQuote[] } | { error: string } {
  const rows: NewQuote[] = [];
  for (const s of services) {
    const amount = parseCurrencyInput(amounts[s.key] ?? '');
    if (amount === null || amount === 0) continue;
    if (Number.isNaN(amount) || amount < 0) return { error: 'Enter each service amount as a number, or leave it blank.' };
    rows.push({
      contact_id: contactId,
      organization_id: null,
      service_type: s.key,
      state: status === 'client' || status === 'one_time' ? 'accepted' : 'proposed',
      cadence: status === 'one_time' ? 'one_time' : s.default_cadence,
      amount,
    });
  }
  return { rows };
}
