// @vitest-environment node
// loadOwnerEmail: the owner's current address from Auth, by the id org_profile names.
import { describe, expect, it } from 'vitest';
import { loadOwnerEmail, type OwnerClient } from '../../../supabase/functions/_shared/owner';

function client(opts: { profile?: { data: unknown; error: unknown }; user?: { data: { user: { email?: string | null } | null }; error: unknown } }) {
  const asked: string[] = [];
  const db: OwnerClient = {
    from: (table) => ({
      select: (columns) => ({
        maybeSingle: async () => {
          asked.push(`${table}.${columns}`);
          return opts.profile ?? { data: null, error: null };
        },
      }),
    }),
    auth: {
      admin: {
        getUserById: async (id) => {
          asked.push(`user:${id}`);
          return opts.user ?? { data: { user: null }, error: null };
        },
      },
    },
  };
  return { db, asked };
}

describe('loadOwnerEmail', () => {
  it("reads the owner's id from org_profile, then the address from Auth", async () => {
    const { db, asked } = client({
      profile: { data: { owner_user_id: 'owner-1' }, error: null },
      user: { data: { user: { email: 'owner@example.com' } }, error: null },
    });
    expect(await loadOwnerEmail(db)).toBe('owner@example.com');
    expect(asked).toEqual(['org_profile.owner_user_id', 'user:owner-1']);
  });

  it('is null before there is an owner, without asking Auth', async () => {
    const { db, asked } = client({ profile: { data: { owner_user_id: null }, error: null } });
    expect(await loadOwnerEmail(db)).toBeNull();
    expect(asked).toEqual(['org_profile.owner_user_id']);
  });

  it('is null when the owner has no address', async () => {
    const { db } = client({ profile: { data: { owner_user_id: 'owner-1' }, error: null }, user: { data: { user: { email: null } }, error: null } });
    expect(await loadOwnerEmail(db)).toBeNull();
  });

  it('throws on a failed read rather than answering "no owner"', async () => {
    await expect(loadOwnerEmail(client({ profile: { data: null, error: new Error('down') } }).db)).rejects.toThrow('down');
    const authDown = client({ profile: { data: { owner_user_id: 'owner-1' }, error: null }, user: { data: { user: null }, error: new Error('auth down') } });
    await expect(loadOwnerEmail(authDown.db)).rejects.toThrow('auth down');
  });
});
