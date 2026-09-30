// Pure pieces of `npm run dev:bootstrap`, kept free of I/O so vitest can pin them.
// The script in scripts/dev-bootstrap.mjs does the reading, writing and network calls.

/**
 * Local secrets for the edge functions that later phases port. Each is generated
 * once and never rewritten: a regenerated DOCUMENT_ENCRYPTION_KEY would make every
 * stored document unreadable. The two encryption keys are AES-256 keys that the
 * source functions decode with atob, hence base64; the rest are compared as strings.
 */
export const FUNCTION_SECRETS = [
  { name: 'DOCUMENT_ENCRYPTION_KEY', bytes: 32, encoding: 'base64' },
  { name: 'PII_ENCRYPTION_KEY', bytes: 32, encoding: 'base64' },
  { name: 'CRON_SHARED_SECRET', bytes: 32, encoding: 'hex' },
  { name: 'MCP_INTERNAL_SECRET', bytes: 32, encoding: 'hex' },
  { name: 'ESIGN_INTERNAL_TOKEN', bytes: 32, encoding: 'hex' },
];

/** The system actor's sign-in address. `.invalid` is reserved (RFC 2606): mail to it goes nowhere. */
export const SYSTEM_ACTOR_EMAIL = 'system-actor@open-crm.invalid';

/**
 * Check the Supabase project's values. The URL must be https, except a local
 * address during development; the keys are single tokens, and the anon key going
 * into the browser must not be the service key.
 */
export function projectProblems({ url, anonKey, serviceKey }) {
  const problems = [];
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    // Reported below.
  }
  const local = parsed && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (!parsed || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local))) {
    problems.push('project URL: must be https://<ref>.supabase.co (or a local http address)');
  }
  if (!anonKey || /\s/.test(anonKey)) problems.push('anon key: missing or contains spaces');
  if (!serviceKey || /\s/.test(serviceKey)) problems.push('service role key: missing or contains spaces');
  if (anonKey && anonKey === serviceKey) problems.push('anon key: is the service role key; the browser must never get that one');
  return problems;
}

/** Parse a dotenv file into an ordered map. Comments and blank lines are ignored. */
export function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

/**
 * Append the entries of `wanted` that `existingText` lacks (or holds empty).
 * Existing values are never changed, so a second run is a no-op and a key an
 * adopter set by hand survives. Returns the new text and the names added.
 */
export function mergeEnv(existingText, wanted) {
  const existing = parseEnv(existingText);
  const added = [];
  const lines = [];
  for (const [name, value] of Object.entries(wanted)) {
    if (existing.get(name)) continue;
    if (!/^[A-Za-z0-9_+/=.:-]+$/.test(value)) throw new Error(`Refusing to write an unsafe value for ${name}.`);
    added.push(name);
    lines.push(`${name}=${value}`);
  }
  // An empty placeholder line (NAME=) would shadow the appended value in some
  // dotenv readers, so it is dropped when its name is being filled.
  const kept = existingText
    .split(/\r?\n/)
    .filter((line) => {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/.exec(line);
      return !(match && added.includes(match[1]));
    })
    .join('\n')
    .replace(/\n*$/, '');
  if (added.length === 0) return { text: existingText, added };
  const text = (kept ? `${kept}\n` : '') + lines.join('\n') + '\n';
  return { text, added };
}

/**
 * One value per FUNCTION_SECRETS entry, from the given random-bytes source.
 * @returns {Record<string, string>}
 */
export function generateSecrets(randomBytes) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const { name, bytes, encoding } of FUNCTION_SECRETS) {
    out[name] = Buffer.from(randomBytes(bytes)).toString(encoding);
  }
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The characters Supabase Auth counts as symbols for `lower_upper_letters_digits_symbols`. */
const AUTH_SYMBOLS = "!@#$%^&*()_+-=[]{};'\\:\"|<>?,./`~";

/** The system actor never signs in; a century-long ban makes that a server rule. */
export const BAN_FOR_A_CENTURY = '876000h';

/** Banned for at least fifty more years; a ban that runs out soon does not count. */
function isBanned(user) {
  return Date.parse(user.banned_until ?? '') > Date.now() + 50 * 365 * 24 * 3600 * 1000;
}

/**
 * A password nobody keeps, for the system actor. Auth applies the same strength
 * rules to it as to the owner's, so the random part gets one character of each
 * required class appended.
 */
export function systemActorPassword(randomBytes) {
  return Buffer.from(randomBytes(32)).toString('base64url') + 'Aa1!';
}

/**
 * The owner's password must meet the rules in supabase/config.toml: at least
 * eight characters with a lower-case letter, an upper-case letter, a digit and a symbol.
 */
export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'must be at least 8 characters';
  if (!/[a-z]/.test(password)) return 'needs a lower-case letter';
  if (!/[A-Z]/.test(password)) return 'needs an upper-case letter';
  if (!/[0-9]/.test(password)) return 'needs a digit';
  if (![...password].some((c) => AUTH_SYMBOLS.includes(c))) return `needs a symbol (one of ${AUTH_SYMBOLS})`;
  if (/\s/.test(password)) return 'must not contain spaces';
  return null;
}

/** Validate the owner details. Returns a list of problems; empty means usable. */
export function ownerProblems({ email, password, orgName }) {
  const problems = [];
  if (!email || !EMAIL.test(email)) problems.push('email: not an email address');
  if (email && email.toLowerCase() === SYSTEM_ACTOR_EMAIL) problems.push('email: reserved for the system actor');
  const pw = passwordProblem(password);
  if (pw) problems.push(`password: ${pw}`);
  if (!orgName || orgName.trim().length < 1 || orgName.trim().length > 120) {
    problems.push('organization name: 1 to 120 characters');
  }
  return problems;
}

/** `--email a@b.c --org-name "X"` → { email: 'a@b.c', orgName: 'X' }. Unknown flags throw. */
export function parseArgs(argv) {
  const known = { '--email': 'email', '--password': 'password', '--org-name': 'orgName' };
  const switches = { '--yes': 'yes', '--adopt-existing': 'adoptExisting' };
  const out = { yes: false, adoptExisting: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (switches[flag]) { out[switches[flag]] = true; continue; }
    const key = known[flag];
    if (!key) throw new Error(`Unknown option ${flag}. Known: ${[...Object.keys(known), ...Object.keys(switches)].join(', ')}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    out[key] = value;
    i++;
  }
  return out;
}

/**
 * Find a user by email through the admin API, paging until found or exhausted.
 * `listUsers` returns at most `perPage` users per call.
 */
export async function findUserByEmail(admin, email) {
  const target = email.toLowerCase();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
}

/**
 * Create the owner and the system actor and write the org_profile row.
 *
 * Re-runnable: an existing org_profile keeps its principals and a recorded owner
 * is reused, never re-created. Refused: a second, different owner (who owns the
 * install changes only by editing the database on purpose), and an account that
 * already holds the owner's email but was never recorded as the owner. That one
 * could have been made by anyone who reached the Auth API first, with a password
 * they chose; `--adopt-existing` takes it over and sets the password given here.
 *
 * `db` is a service-role supabase-js client; `db.auth.admin` is its admin API.
 * `randomPassword()` supplies the system actor's password, which nobody ever uses.
 */
export async function ensurePrincipals(db, { email, password, orgName, adoptExisting = false }, randomPassword) {
  const admin = db.auth.admin;
  const { data: profile, error: readErr } = await db
    .from('org_profile')
    .select('owner_user_id, system_user_id')
    .maybeSingle();
  if (readErr) throw readErr;

  // Every refusal comes before the first write, so a refused run changes nothing.
  let system = null;
  if (profile?.system_user_id) {
    const { data, error } = await admin.getUserById(profile.system_user_id);
    if (error) throw error;
    system = data.user;
  } else {
    system = await findUserByEmail(admin, SYSTEM_ACTOR_EMAIL);
  }
  // An unrecorded account at the system address is reused only if it cannot sign in.
  if (system && !profile?.system_user_id && !isBanned(system)) {
    throw new Error(`An account for ${SYSTEM_ACTOR_EMAIL} exists and is not banned for good. Delete it and run again. Nothing was changed.`);
  }
  let owner = await findUserByEmail(admin, email);
  if (profile?.owner_user_id && owner?.id !== profile.owner_user_id) {
    throw new Error('This install already has an owner with a different email. Nothing was changed.');
  }
  if (owner && !profile?.owner_user_id) {
    if (!adoptExisting) {
      throw new Error(
        `An account for ${email} already exists but is not recorded as the owner. ` +
          'If you made it (for example, an earlier bootstrap stopped part-way), run again with --adopt-existing; ' +
          'that sets its password to the one given here. Nothing was changed.',
      );
    }
    const { error } = await admin.updateUserById(owner.id, { password });
    if (error) throw error;
  }
  let ownerCreated = false;
  if (!owner) {
    const { data, error } = await admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    owner = data.user;
    ownerCreated = true;
  }

  let systemCreated = false;
  if (system && profile?.system_user_id && !isBanned(system)) {
    // The recorded system actor was unbanned by hand: put the ban back.
    const { error } = await admin.updateUserById(system.id, { ban_duration: BAN_FOR_A_CENTURY });
    if (error) throw error;
  }
  if (!system) {
    // The system actor never signs in: a random password nobody keeps, and banned.
    const { data, error } = await admin.createUser({
      email: SYSTEM_ACTOR_EMAIL,
      password: randomPassword(),
      email_confirm: true,
      ban_duration: BAN_FOR_A_CENTURY,
    });
    if (error) throw error;
    system = data.user;
    systemCreated = true;
  }

  if (profile) {
    if (!profile.owner_user_id || !profile.system_user_id) {
      const { error } = await db
        .from('org_profile')
        .update({ owner_user_id: owner.id, system_user_id: system.id })
        .eq('id', true);
      if (error) throw error;
    }
  } else {
    const { error } = await db.from('org_profile').insert({
      id: true,
      display_name: orgName.trim(),
      owner_user_id: owner.id,
      system_user_id: system.id,
    });
    if (error) throw error;
  }

  const ownerAdopted = Boolean(adoptExisting && !ownerCreated && !profile?.owner_user_id);
  return { ownerId: owner.id, systemId: system.id, ownerCreated, ownerAdopted, systemCreated, profileCreated: !profile };
}
