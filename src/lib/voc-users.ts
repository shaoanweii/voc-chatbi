import type { QueryResultRow } from 'pg';
import { randomUUID } from 'crypto';
import { hashPassword } from '@/lib/password';
import { query, transaction } from '@/storage/database/pg-client';

export interface VocUserProfile {
  id: string;
  accountId: string;
  accountName: string;
  avatarUrl: string | null;
  email: string;
  phone: string;
  company: string;
  companyRole: string;
  bio: string;
  userType: string;
}

interface VocUserRow extends QueryResultRow {
  id: string;
  account_id: string;
  account_name: string;
  password_hash: string | null;
  avatar_url: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  company_role: string | null;
  bio: string | null;
  user_type: string | null;
}

interface AuthIdentityUserRow extends VocUserRow {
  identity_credential_hash: string | null;
}

const userSelect = `
  id,
  account_id,
  account_name,
  avatar_url,
  email,
  phone,
  company,
  company_role,
  bio,
  user_type
`;

const authUserSelect = `
  voc_users.id,
  voc_users.account_id,
  voc_users.account_name,
  voc_users.password_hash,
  voc_users.avatar_url,
  voc_users.email,
  voc_users.phone,
  voc_users.company,
  voc_users.company_role,
  voc_users.bio,
  voc_users.user_type
`;

export async function ensureVocUsersTable() {
  await query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TABLE IF NOT EXISTS voc_users (
      id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
      account_id VARCHAR(128) NOT NULL UNIQUE,
      account_name VARCHAR(128) NOT NULL UNIQUE,
      user_type VARCHAR(20) NOT NULL DEFAULT 'account',
      password_hash VARCHAR(255),
      avatar_url TEXT,
      email VARCHAR(255),
      phone VARCHAR(50),
      phone_verified_at TIMESTAMPTZ,
      company VARCHAR(128) DEFAULT '富通科技',
      company_role VARCHAR(128),
      bio TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ
    );

    ALTER TABLE voc_users
    ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
    ALTER TABLE voc_users
    ADD COLUMN IF NOT EXISTS user_type VARCHAR(20) NOT NULL DEFAULT 'account';
    ALTER TABLE voc_users
    ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'voc_users_user_type_check'
      ) THEN
        ALTER TABLE voc_users
        ADD CONSTRAINT voc_users_user_type_check
        CHECK (user_type IN ('account', 'phone'));
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS voc_users_account_id_idx ON voc_users(account_id);
    CREATE INDEX IF NOT EXISTS voc_users_phone_idx ON voc_users(phone);

    DROP TRIGGER IF EXISTS voc_users_set_updated_at ON voc_users;
    CREATE TRIGGER voc_users_set_updated_at
    BEFORE UPDATE ON voc_users
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS voc_user_identities (
      id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id VARCHAR(36) NOT NULL REFERENCES voc_users(id) ON DELETE CASCADE,
      identity_type VARCHAR(32) NOT NULL,
      identifier VARCHAR(255) NOT NULL,
      credential_hash VARCHAR(255),
      verified_at TIMESTAMPTZ,
      is_primary BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ,

      CONSTRAINT voc_user_identities_type_check
        CHECK (identity_type IN ('account_id', 'phone'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS voc_user_identities_type_identifier_uidx
      ON voc_user_identities(identity_type, identifier);
    CREATE INDEX IF NOT EXISTS voc_user_identities_user_id_idx
      ON voc_user_identities(user_id);

    DROP TRIGGER IF EXISTS voc_user_identities_set_updated_at ON voc_user_identities;
    CREATE TRIGGER voc_user_identities_set_updated_at
    BEFORE UPDATE ON voc_user_identities
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

    INSERT INTO voc_user_identities (
      user_id, identity_type, identifier, credential_hash, verified_at, is_primary
    )
    SELECT id, 'account_id', account_id, password_hash, created_at, TRUE
    FROM voc_users
    ON CONFLICT (identity_type, identifier) DO UPDATE
    SET credential_hash = EXCLUDED.credential_hash;

    INSERT INTO voc_user_identities (
      user_id, identity_type, identifier, verified_at, is_primary
    )
    SELECT id, 'phone', phone, COALESCE(phone_verified_at, last_login_at, created_at), user_type = 'phone'
    FROM voc_users
    WHERE phone IS NOT NULL AND phone <> ''
    ON CONFLICT (identity_type, identifier) DO NOTHING;
  `);
}

export function toVocUserProfile(row: VocUserRow): VocUserProfile {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name || row.account_id,
    avatarUrl: row.avatar_url,
    email: row.email || '',
    phone: row.phone || '',
    company: row.company || '富通科技',
    companyRole: row.company_role || '',
    bio: row.bio || '',
    userType: row.user_type || 'account',
  };
}

export function normalizePhoneNumber(phone: string): string {
  const cleaned = phone.trim().replace(/[\s-]/g, '');
  const withoutCountryCode = cleaned.startsWith('+86')
    ? cleaned.slice(3)
    : cleaned.startsWith('86') && cleaned.length === 13
      ? cleaned.slice(2)
      : cleaned;
  return withoutCountryCode;
}

export function isValidMainlandPhone(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test(normalizePhoneNumber(phone));
}

export async function findVocUserByAccountId(accountId: string) {
  const result = await query<VocUserRow>(
    `SELECT ${userSelect} FROM voc_users WHERE account_id = $1 LIMIT 1`,
    [accountId]
  );

  return result.rows[0] ? toVocUserProfile(result.rows[0]) : null;
}

export async function findVocUserByAccountName(accountName: string) {
  const result = await query<VocUserRow>(
    `SELECT ${userSelect} FROM voc_users WHERE account_name = $1 LIMIT 1`,
    [accountName.trim()]
  );

  return result.rows[0] ? toVocUserProfile(result.rows[0]) : null;
}

export async function findVocUserAuthByAccountId(accountId: string) {
  const result = await query<VocUserRow>(
    `SELECT ${authUserSelect} FROM voc_users WHERE account_id = $1 LIMIT 1`,
    [accountId]
  );
  const row = result.rows[0];

  if (!row) return null;

  await ensureAccountIdentity(row.id, row.account_id, row.password_hash);

  return {
    profile: toVocUserProfile(row),
    passwordHash: row.password_hash,
  };
}

export async function findVocUserAuthByIdentity(identityType: 'account_id' | 'phone', identifier: string) {
  const normalizedIdentifier = identityType === 'phone' ? normalizePhoneNumber(identifier) : identifier.trim();
  const result = await query<AuthIdentityUserRow>(
    `SELECT ${authUserSelect}, voc_user_identities.credential_hash AS identity_credential_hash
     FROM voc_user_identities
     INNER JOIN voc_users ON voc_users.id = voc_user_identities.user_id
     WHERE voc_user_identities.identity_type = $1
       AND voc_user_identities.identifier = $2
     LIMIT 1`,
    [identityType, normalizedIdentifier]
  );
  const row = result.rows[0];

  if (!row) return null;

  return {
    profile: toVocUserProfile(row),
    passwordHash: row.identity_credential_hash || row.password_hash,
  };
}

export async function findVocUserById(id: string) {
  const result = await query<VocUserRow>(
    `SELECT ${userSelect} FROM voc_users WHERE id = $1 LIMIT 1`,
    [id]
  );

  return result.rows[0] ? toVocUserProfile(result.rows[0]) : null;
}

export async function findVocUserByPhone(phone: string) {
  const normalizedPhone = normalizePhoneNumber(phone);
  const result = await query<VocUserRow>(
    `SELECT ${userSelect}
     FROM voc_users
     WHERE phone = $1
     LIMIT 1`,
    [normalizedPhone]
  );

  return result.rows[0] ? toVocUserProfile(result.rows[0]) : null;
}

export async function markVocUserLogin(id: string) {
  await query('UPDATE voc_users SET last_login_at = NOW() WHERE id = $1', [id]);
}

export async function createVocUser(accountId: string, accountName: string | undefined, passwordHash: string) {
  const normalizedAccountId = accountId.trim();
  const normalizedAccountName = (accountName || normalizedAccountId).trim();

  const result = await transaction(async (client) => {
    const inserted = await client.query<VocUserRow>(
      `INSERT INTO voc_users (account_id, account_name, user_type, password_hash, company)
       VALUES ($1, $2, 'account', $3, '富通科技')
       RETURNING ${userSelect}`,
      [normalizedAccountId, normalizedAccountName, passwordHash]
    );

    await client.query(
      `INSERT INTO voc_user_identities (
        user_id, identity_type, identifier, credential_hash, verified_at, is_primary
      ) VALUES ($1, 'account_id', $2, $3, NOW(), TRUE)
      ON CONFLICT (identity_type, identifier) DO UPDATE
      SET credential_hash = EXCLUDED.credential_hash`,
      [inserted.rows[0].id, normalizedAccountId, passwordHash]
    );

    return inserted;
  });

  return toVocUserProfile(result.rows[0]);
}

export async function updateVocUserPassword(userId: string, passwordHash: string) {
  const result = await transaction(async (client) => {
    const updated = await client.query<VocUserRow>(
      `UPDATE voc_users
       SET password_hash = $2
       WHERE id = $1
       RETURNING ${userSelect}`,
      [userId, passwordHash]
    );

    if (updated.rows[0]) {
      await client.query(
        `INSERT INTO voc_user_identities (
          user_id, identity_type, identifier, credential_hash, verified_at, is_primary
        ) VALUES ($1, 'account_id', $2, $3, NOW(), TRUE)
        ON CONFLICT (identity_type, identifier) DO UPDATE
        SET credential_hash = EXCLUDED.credential_hash`,
        [userId, updated.rows[0].account_id, passwordHash]
      );
    }

    return updated;
  });

  return result.rows[0] ? toVocUserProfile(result.rows[0]) : null;
}

export async function findOrCreatePhoneUser(phone: string) {
  const normalizedPhone = normalizePhoneNumber(phone);
  const existing = await findVocUserAuthByIdentity('phone', normalizedPhone);
  if (existing) {
    await markVocUserLogin(existing.profile.id);
    return existing.profile;
  }

  const existingProfile = await findVocUserByPhone(normalizedPhone);
  if (existingProfile) {
    await bindPhoneIdentity(existingProfile.id, normalizedPhone, false);
    await markVocUserLogin(existingProfile.id);
    return existingProfile;
  }

  const existingByAccountId = await findVocUserByAccountId(normalizedPhone);
  if (existingByAccountId) {
    await bindPhoneIdentity(existingByAccountId.id, normalizedPhone, true);
    await markVocUserLogin(existingByAccountId.id);
    return existingByAccountId;
  }

  const accountId = normalizedPhone;
  const accountName = normalizedPhone;
  const defaultPasswordHash = hashPassword('20260527');

  const result = await transaction(async (client) => {
    const inserted = await client.query<VocUserRow>(
      `INSERT INTO voc_users (
        account_id, account_name, user_type, phone, phone_verified_at, company, last_login_at
      ) VALUES ($1, $2, 'phone', $3, NOW(), '富通科技', NOW())
      RETURNING ${userSelect}`,
      [accountId, accountName, normalizedPhone]
    );

    const userId = inserted.rows[0].id;

    await client.query(
      `INSERT INTO voc_user_identities (
        user_id, identity_type, identifier, credential_hash, verified_at, is_primary
      ) VALUES ($1, 'account_id', $2, $3, NOW(), TRUE)
      ON CONFLICT (identity_type, identifier) DO NOTHING`,
      [userId, accountId, defaultPasswordHash]
    );

    await client.query(
      `INSERT INTO voc_user_identities (
        user_id, identity_type, identifier, verified_at, is_primary
      ) VALUES ($1, 'phone', $2, NOW(), FALSE)
      ON CONFLICT (identity_type, identifier) DO NOTHING`,
      [userId, normalizedPhone]
    );

    return inserted;
  });

  return toVocUserProfile(result.rows[0]);
}

export async function bindPhoneIdentity(userId: string, phone: string, isPrimary = false) {
  const normalizedPhone = normalizePhoneNumber(phone);
  await query(
    `INSERT INTO voc_user_identities (
      user_id, identity_type, identifier, verified_at, is_primary
    ) VALUES ($1, 'phone', $2, NOW(), $3)
    ON CONFLICT (identity_type, identifier) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        verified_at = EXCLUDED.verified_at`,
    [userId, normalizedPhone, isPrimary]
  );
}

async function ensureAccountIdentity(userId: string, accountId: string, passwordHash: string | null) {
  await query(
    `INSERT INTO voc_user_identities (
      user_id, identity_type, identifier, credential_hash, verified_at, is_primary
    ) VALUES ($1, 'account_id', $2, $3, NOW(), TRUE)
    ON CONFLICT (identity_type, identifier) DO UPDATE
    SET credential_hash = EXCLUDED.credential_hash`,
    [userId, accountId, passwordHash]
  );
}

async function makeUniquePhoneAccountId(phone: string) {
  const baseId = `phone_${phone.slice(-4)}`;
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? Date.now().toString(36).slice(-5) : `${Date.now().toString(36).slice(-5)}_${index + 1}`;
    const candidate = `${baseId}_${suffix}`;
    const existing = await findVocUserByAccountId(candidate);
    if (!existing) return candidate;
  }

  return `${baseId}_${randomUUID().slice(0, 8)}`;
}

function maskPhoneNumber(phone: string) {
  if (phone.length !== 11) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(7)}`;
}

export async function updateVocUserProfile(
  id: string,
  data: Omit<VocUserProfile, 'id' | 'accountId' | 'userType'>
) {
  const normalizedPhone = data.phone ? normalizePhoneNumber(data.phone) : '';
  const phoneValue = normalizedPhone || null;
  const result = await transaction(async (client) => {
    const updated = await client.query<VocUserRow>(
      `UPDATE voc_users
       SET account_name = $2,
           avatar_url = $3,
           email = $4,
           phone = CAST($5 AS text),
           phone_verified_at = CASE
             WHEN COALESCE(CAST($5 AS text), '') = '' THEN NULL
             WHEN phone = CAST($5 AS text) THEN phone_verified_at
             ELSE NOW()
           END,
           company = $6,
           company_role = $7,
           bio = $8
       WHERE id = $1
       RETURNING ${userSelect}`,
      [
        id,
        data.accountName.trim() || '未命名用户',
        data.avatarUrl || null,
        data.email || null,
        phoneValue,
        data.company || null,
        data.companyRole || null,
        data.bio || null,
      ]
    );

    if (normalizedPhone && updated.rows[0]) {
      await client.query(
        `INSERT INTO voc_user_identities (
          user_id, identity_type, identifier, verified_at, is_primary
        ) VALUES ($1, 'phone', $2, NOW(), FALSE)
        ON CONFLICT (identity_type, identifier) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            verified_at = EXCLUDED.verified_at`,
        [id, normalizedPhone]
      );
    }

    return updated;
  });

  return result.rows[0] ? toVocUserProfile(result.rows[0]) : null;
}
