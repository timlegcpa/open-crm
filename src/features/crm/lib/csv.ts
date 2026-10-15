import type { Contact } from '@/api/contacts';
import { computeContactRevenue } from '@/lib/revenue';
import { isTerminalStatus } from '@/lib/contactStatus';

/**
 * The contacts export: one row per contact, Name, Email, Phone, Business, Status, MRR, ARR.
 * Cells go through `toCsv`, whose formula guard makes a name like `=HYPERLINK(...)` plain
 * text, because lead names arrive from public intake and are untrusted. MRR and ARR are
 * left empty on a terminal status, as on screen.
 */
export const CONTACT_CSV_HEADER = ['Name', 'Email', 'Phone', 'Business', 'Status', 'MRR', 'ARR'] as const;

export function contactCsvRows(
  contacts: readonly Contact[],
  opts: { businessOf: (c: Contact) => string; statusLabel: (status: string) => string },
): Array<Array<string | number | null>> {
  return [
    [...CONTACT_CSV_HEADER],
    ...contacts.map((c) => {
      const revenue = isTerminalStatus(c.status) ? null : computeContactRevenue(c);
      return [
        c.full_name || c.business_name || '',
        c.email ?? '',
        c.phone ?? '',
        opts.businessOf(c),
        opts.statusLabel(c.status),
        revenue ? revenue.mrr : null,
        revenue ? revenue.arr : null,
      ];
    }),
  ];
}
