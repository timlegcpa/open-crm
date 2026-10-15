// The browser's password rules and the server's are twins: one table of inputs through both.
import { describe, expect, it } from 'vitest';
import { passwordProblem as serverProblem } from '../../../../supabase/functions/_shared/portal-account';
import { passwordProblem, PASSWORD_RULES } from '@/lib/passwordRules';

const CASES = [
  '',
  'short1!',
  'Abcdef1!',
  'abcdefg1!',
  'ABCDEFG1!',
  'Abcdefgh!',
  'Abcdefgh1',
  'Abc def1!',
  'Abcdéfg1!',
  'Abcdefg1\t',
  'Abcdefg1!\n',
  'Abcdefg1!\u0000',
  'Abcdefg1!\u007f',
  'Abcdefg1!\u0085',
  'Abcdefg1 ',
  'Abcdefg1é',
  'correct Horse 9 battery!',
  'Paß wörd 1!',
  'Emoji 1! \u{1F600}',
  `A1!${'a'.repeat(69)}`,
  `A1!${'a'.repeat(70)}`,
  `A1!${'\u00e9'.repeat(34)}a`,
  `A1!${'\u00e9'.repeat(35)}`,
  `A1!a${'\u{1F600}'.repeat(17)}`,
  `A1!a${'\u{1F600}'.repeat(17)}b`,
  'Zz9~Zz9~',
  'Pass[word]1',
  'Pass`word1',
];

describe('portal password twins', () => {
  it.each(CASES)('agree on %j', (input) => {
    expect(passwordProblem(input)).toBe(serverProblem(input));
  });

  it('the checklist is all ticked exactly when the password is accepted', () => {
    for (const input of CASES) {
      expect(PASSWORD_RULES.every((rule) => rule.ok(input)), input).toBe(passwordProblem(input) === null);
    }
  });

  it('accepts a strong password and names the first rule a weak one breaks', () => {
    expect(passwordProblem('Abcdef1!')).toBeNull();
    expect(serverProblem('Abc def1!')).toBeNull();
    expect(serverProblem('Abcdefg1!\t')).toMatch(/control characters/);
    expect(passwordProblem('abcdefg1!')).toBe('Add an uppercase letter.');
  });
});
