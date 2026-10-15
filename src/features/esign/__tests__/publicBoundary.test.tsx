// The public signer and verify pages run with no session. Two guards: their whole static
// import graph never reaches supabase-js, the auth provider or the signed-in edge helper,
// and the typed-signature refusal in the modal.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const SRC = resolve(__dirname, '../../..');
const FORBIDDEN = ['@supabase/supabase-js', '@/lib/supabase', '@/lib/auth', '@/lib/edge', '@/AuthenticatedApp'];

/** Every module reachable through static imports from `entry`, inside src/. */
function staticGraph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const text = readFileSync(file, 'utf8');
    // Static imports and re-exports only: `import('...')` is a separate chunk on purpose.
    const specs = [...text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2]);
    seen.set(file, specs);
    for (const spec of specs) {
      let base: string | null = null;
      if (spec.startsWith('@/')) base = resolve(SRC, spec.slice(2));
      else if (spec.startsWith('.')) base = resolve(dirname(file), spec);
      if (!base || spec.endsWith('.css')) continue;
      const hit = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((ext) => base + ext).find(existsSync);
      if (hit) queue.push(hit);
    }
  }
  return seen;
}

describe('public pages import nothing signed-in', () => {
  for (const page of ['public/SignPage.tsx', 'public/VerifyPage.tsx']) {
    it(page, () => {
      const graph = staticGraph(resolve(__dirname, '..', page));
      const offenders = [...graph].flatMap(([file, specs]) => specs.filter((s) => FORBIDDEN.includes(s)).map((s) => `${file} -> ${s}`));
      expect(offenders).toEqual([]);
      // Sanity: the walk really followed the flow down to the signer API.
      expect([...graph.keys()].some((f) => f.endsWith('signerApi.ts')) || page.includes('Verify')).toBe(true);
    });
  }
});

vi.mock('@/lib/supabase', () => {
  throw new Error('the signature modal imported @/lib/supabase');
});

import { SignatureModal } from '../public/signer/SignatureModal';

describe('SignatureModal', () => {
  it('refuses a typed name the fonts cannot draw, and offers drawing instead', () => {
    const onApply = vi.fn();
    render(<SignatureModal defaultName="Łukasz Ada" initial={null} onApply={onApply} onClose={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot be drawn in these fonts/);
    fireEvent.click(screen.getByRole('button', { name: 'Draw instead' }));
    expect(screen.getByText('Draw your signature')).toBeVisible();
  });

  it('applies a typed name in the chosen font, trimmed', () => {
    const onApply = vi.fn();
    render(<SignatureModal defaultName="  Ada Lovelace " initial={null} onApply={onApply} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Pacifico' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith({ kind: 'typed', signature_text: 'Ada Lovelace', font_key: 'pacifico' });
  });
});
