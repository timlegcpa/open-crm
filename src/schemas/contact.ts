import { z } from 'zod';

const optionalText = z.string().trim().max(200, 'Keep this under 200 characters.');

export const contactIntakeSchema = z
  .object({
    first_name: optionalText,
    last_name: optionalText,
    email: z
      .string()
      .trim()
      .max(254, 'That email address is too long.')
      .refine((v) => v === '' || z.string().email().safeParse(v).success, 'Enter a valid email address.'),
    phone: z.string().trim().max(40, 'That phone number is too long.'),
    business_name: optionalText,
    status: z.string().min(1, 'Choose a status.'),
    source: z.string().min(1, 'Choose a source.'),
    submitted_date: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Enter a valid date.'),
    note: z.string().trim().max(10000, 'Keep the note under 10,000 characters.'),
  })
  .refine((v) => v.first_name !== '' || v.last_name !== '' || v.business_name !== '', {
    message: 'Enter a first name, a last name or a business name.',
    path: ['first_name'],
  });

export type ContactIntakeForm = z.input<typeof contactIntakeSchema>;
