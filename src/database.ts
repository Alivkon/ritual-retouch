import crypto from "node:crypto";
import { Pool, type PoolClient, types } from "pg";
import { DATABASE_URL, FREE_GENERATIONS, PACKAGE_DEFINITIONS } from "./config.js";

types.setTypeParser(20, (val: string) => parseInt(val, 10));

let pool: Pool;

export interface DbUser {
  user_id: number; // public API compatibility: this is account_id
  username: string | null;
  first_name: string;
  email: string | null;
  balance: number;
  free_generations: number;
  total_generations: number;
  created_at: Date;
  package_code: string | null;
  package_title: string | null;
  package_generations_total: number;
  package_generations_remaining: number;
}

export interface DbUserWithAuth extends DbUser {
  password_hash: string | null;
  email_verified: boolean;
}

interface Entitlement {
  has_package: boolean;
  package_code: string | null;
  package_title: string | null;
  package_generations_total: number;
  package_generations_remaining: number;
}

const ACCOUNT_SELECT = `
  SELECT
    a.id AS user_id,
    tg.telegram_username AS username,
    COALESCE(a.first_name, tg.telegram_first_name, split_part(a.primary_email, '@', 1), '') AS first_name,
    a.primary_email AS email,
    a.password_hash,
    a.email_verified,
    a.total_generations,
    a.created_at,
    0::double precision AS balance,
    COALESCE(up.generations_remaining, 0)::integer AS free_generations,
    p.code AS package_code,
    p.title AS package_title,
    COALESCE(up.generations_total, 0)::integer AS package_generations_total,
    COALESCE(up.generations_remaining, 0)::integer AS package_generations_remaining
  FROM accounts a
  LEFT JOIN user_packages up ON up.account_id = a.id
  LEFT JOIN packages p ON p.id = up.package_id
  LEFT JOIN LATERAL (
    SELECT telegram_username, telegram_first_name
    FROM account_identities
    WHERE account_id = a.id AND provider = 'telegram'
    ORDER BY updated_at DESC
    LIMIT 1
  ) tg ON TRUE
`;

export async function initDb(): Promise<void> {
  pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id BIGSERIAL PRIMARY KEY,
        first_name TEXT,
        primary_email TEXT UNIQUE,
        password_hash TEXT,
        email_verified BOOLEAN DEFAULT FALSE,
        total_generations INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS account_identities (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('telegram', 'email')),
        provider_user_id TEXT NOT NULL,
        email TEXT,
        telegram_username TEXT,
        telegram_first_name TEXT,
        verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (provider, provider_user_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_account_identities_account_id ON account_identities(account_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS packages (
        id BIGSERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        generations_count INTEGER NOT NULL CHECK (generations_count > 0),
        price_rub INTEGER NOT NULL CHECK (price_rub >= 0),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    for (const pkg of PACKAGE_DEFINITIONS) {
      await client.query(
        `INSERT INTO packages (code, title, generations_count, price_rub, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (code) DO UPDATE SET
           title = EXCLUDED.title,
           generations_count = EXCLUDED.generations_count,
           price_rub = EXCLUDED.price_rub,
           is_active = TRUE`,
        [pkg.code, pkg.title, pkg.generations, pkg.amount],
      );
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        package_id BIGINT REFERENCES packages(id),
        username TEXT,
        amount DOUBLE PRECISION NOT NULL,
        provider TEXT NOT NULL DEFAULT 'yookassa',
        telegram_charge_id TEXT,
        provider_charge_id TEXT,
        yookassa_payment_id TEXT,
        status TEXT NOT NULL DEFAULT 'paid',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        paid_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_yookassa_id ON payments (yookassa_payment_id) WHERE yookassa_payment_id IS NOT NULL`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_telegram_charge_id ON payments (telegram_charge_id) WHERE telegram_charge_id IS NOT NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_packages (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
        package_id BIGINT NOT NULL REFERENCES packages(id),
        payment_id BIGINT UNIQUE REFERENCES payments(id),
        generations_total INTEGER NOT NULL CHECK (generations_total > 0),
        generations_remaining INTEGER NOT NULL CHECK (generations_remaining >= 0),
        purchased_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS generation_adjustments (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        admin_telegram_id BIGINT NOT NULL,
        delta INTEGER NOT NULL CHECK (delta > 0),
        reason TEXT,
        before_remaining INTEGER NOT NULL CHECK (before_remaining >= 0),
        after_remaining INTEGER NOT NULL CHECK (after_remaining >= 0),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_generation_adjustments_account_id ON generation_adjustments(account_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_generation_adjustments_created_at ON generation_adjustments(created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS generations (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        user_package_id BIGINT REFERENCES user_packages(id),
        prompt TEXT,
        source_file_id TEXT,
        result_file_id TEXT,
        generation_cost INTEGER DEFAULT 1,
        cost DOUBLE PRECISION DEFAULT 0.0,
        is_free INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS account_link_tokens (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS web_sessions (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_web_sessions_token ON web_sessions(token)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS uploads (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        original_name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Email campaign tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_recipients (
        md_key  VARCHAR(32) PRIMARY KEY,
        email   VARCHAR(255) UNIQUE NOT NULL
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_opens (
        id         BIGSERIAL PRIMARY KEY,
        campaign   VARCHAR(50),
        md_key     VARCHAR(32),
        ip         VARCHAR(45),
        user_agent TEXT,
        opened_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_clicks (
        id         BIGSERIAL PRIMARY KEY,
        campaign   VARCHAR(50),
        md_key     VARCHAR(32),
        ip         VARCHAR(45),
        user_agent TEXT,
        clicked_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } finally {
    client.release();
  }
}

function userFromRow(row: DbUserWithAuth | undefined): DbUserWithAuth | null {
  return row ?? null;
}

async function getAccountById(accountId: number): Promise<DbUserWithAuth | null> {
  const result = await pool.query<DbUserWithAuth>(`${ACCOUNT_SELECT} WHERE a.id = $1`, [accountId]);
  return userFromRow(result.rows[0]);
}

async function resolveAccountId(identifier: number): Promise<number | null> {
  const account = await pool.query<{ id: number }>("SELECT id FROM accounts WHERE id = $1", [identifier]);
  if (account.rows[0]) return account.rows[0].id;

  const identity = await pool.query<{ account_id: number }>(
    "SELECT account_id FROM account_identities WHERE provider = 'telegram' AND provider_user_id = $1",
    [String(identifier)],
  );
  return identity.rows[0]?.account_id ?? null;
}

async function resolveAccountIdInTx(client: PoolClient, identifier: number): Promise<number | null> {
  const account = await client.query<{ id: number }>("SELECT id FROM accounts WHERE id = $1", [identifier]);
  if (account.rows[0]) return account.rows[0].id;

  const identity = await client.query<{ account_id: number }>(
    "SELECT account_id FROM account_identities WHERE provider = 'telegram' AND provider_user_id = $1",
    [String(identifier)],
  );
  return identity.rows[0]?.account_id ?? null;
}

async function grantInitialFreeGenerations(client: PoolClient, accountId: number): Promise<void> {
  if (FREE_GENERATIONS <= 0) return;

  const freePackage = await client.query<{ id: number }>(
    `INSERT INTO packages (code, title, generations_count, price_rub, is_active)
     VALUES ('free_start', 'Стартовые бесплатные генерации', $1, 0, FALSE)
     ON CONFLICT (code) DO UPDATE SET
       title = EXCLUDED.title,
       generations_count = EXCLUDED.generations_count,
       price_rub = EXCLUDED.price_rub,
       is_active = FALSE
     RETURNING id`,
    [FREE_GENERATIONS],
  );

  await client.query(
    `INSERT INTO user_packages (account_id, package_id, generations_total, generations_remaining)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId, freePackage.rows[0]!.id, FREE_GENERATIONS],
  );
}

export async function getOrCreateUser(
  telegramUserId: number,
  username: string | null | undefined,
  firstName: string,
): Promise<DbUser> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query<{ account_id: number }>(
      "SELECT account_id FROM account_identities WHERE provider = 'telegram' AND provider_user_id = $1 FOR UPDATE",
      [String(telegramUserId)],
    );

    let accountId = existing.rows[0]?.account_id;
    if (!accountId) {
      const created = await client.query<{ id: number }>(
        "INSERT INTO accounts (first_name) VALUES ($1) RETURNING id",
        [firstName || null],
      );
      accountId = created.rows[0]!.id;
      await client.query(
        `INSERT INTO account_identities
         (account_id, provider, provider_user_id, telegram_username, telegram_first_name, verified)
         VALUES ($1, 'telegram', $2, $3, $4, TRUE)`,
        [accountId, String(telegramUserId), username ?? null, firstName || null],
      );
      await grantInitialFreeGenerations(client, accountId);
    } else {
      await client.query(
        `UPDATE account_identities
         SET telegram_username = $2, telegram_first_name = $3, updated_at = NOW()
         WHERE provider = 'telegram' AND provider_user_id = $1`,
        [String(telegramUserId), username ?? null, firstName || null],
      );
      await client.query(
        "UPDATE accounts SET first_name = COALESCE(first_name, $2), updated_at = NOW() WHERE id = $1",
        [accountId, firstName || null],
      );
    }

    const result = await client.query<DbUserWithAuth>(`${ACCOUNT_SELECT} WHERE a.id = $1`, [accountId]);
    await client.query("COMMIT");
    return result.rows[0]!;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function getUser(identifier: number): Promise<DbUser | null> {
  const accountId = await resolveAccountId(identifier);
  if (!accountId) return null;
  return getAccountById(accountId);
}

export async function getTelegramIdForAccount(identifier: number): Promise<number | null> {
  const accountId = await resolveAccountId(identifier);
  if (!accountId) return null;
  const result = await pool.query<{ provider_user_id: string }>(
    "SELECT provider_user_id FROM account_identities WHERE account_id = $1 AND provider = 'telegram' ORDER BY updated_at DESC LIMIT 1",
    [accountId],
  );
  const id = parseInt(result.rows[0]?.provider_user_id ?? "", 10);
  return Number.isFinite(id) ? id : null;
}

export async function getUserEntitlement(identifier: number): Promise<Entitlement> {
  const accountId = await resolveAccountId(identifier);
  if (!accountId) {
    return {
      has_package: false,
      package_code: null,
      package_title: null,
      package_generations_total: 0,
      package_generations_remaining: 0,
    };
  }
  const result = await pool.query<Entitlement>(
    `SELECT
       (up.id IS NOT NULL) AS has_package,
       p.code AS package_code,
       p.title AS package_title,
       COALESCE(up.generations_total, 0)::integer AS package_generations_total,
       COALESCE(up.generations_remaining, 0)::integer AS package_generations_remaining
     FROM accounts a
     LEFT JOIN user_packages up ON up.account_id = a.id
     LEFT JOIN packages p ON p.id = up.package_id
     WHERE a.id = $1`,
    [accountId],
  );
  return result.rows[0] ?? {
    has_package: false,
    package_code: null,
    package_title: null,
    package_generations_total: 0,
    package_generations_remaining: 0,
  };
}

export async function reserveGenerationCredit(identifier: number): Promise<{ userPackageId: number; generationsRemaining: number } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const accountId = await resolveAccountIdInTx(client, identifier);
    if (!accountId) {
      await client.query("ROLLBACK");
      return null;
    }

    const current = await client.query<{ id: number; generations_remaining: number }>(
      `SELECT id, generations_remaining
       FROM user_packages
       WHERE account_id = $1
       FOR UPDATE`,
      [accountId],
    );
    const row = current.rows[0];
    if (!row || row.generations_remaining <= 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const updated = await client.query<{ generations_remaining: number }>(
      `UPDATE user_packages
       SET generations_remaining = generations_remaining - 1
       WHERE id = $1
       RETURNING generations_remaining`,
      [row.id],
    );
    await client.query("COMMIT");
    return { userPackageId: row.id, generationsRemaining: updated.rows[0]!.generations_remaining };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function refundGenerationCredit(userPackageId: number): Promise<void> {
  await pool.query(
    `UPDATE user_packages
     SET generations_remaining = LEAST(generations_remaining + 1, generations_total)
     WHERE id = $1`,
    [userPackageId],
  );
}

export async function incrementTotalGenerations(identifier: number): Promise<void> {
  const accountId = await resolveAccountId(identifier);
  if (!accountId) return;
  await pool.query("UPDATE accounts SET total_generations = total_generations + 1, updated_at = NOW() WHERE id = $1", [accountId]);
}

export async function deductBalance(_userId: number, _amount: number): Promise<void> { return; }
export async function addBalance(_userId: number, _amount: number): Promise<void> { return; }

export async function deductFreeGeneration(identifier: number): Promise<void> {
  const reserved = await reserveGenerationCredit(identifier);
  if (!reserved) throw new Error("No generation credits available");
}

async function getPackageByAmount(amount: number): Promise<{ id: number; title: string; generations_count: number } | null> {
  const result = await pool.query<{ id: number; title: string; generations_count: number }>(
    "SELECT id, title, generations_count FROM packages WHERE price_rub = $1 AND is_active = TRUE",
    [amount],
  );
  return result.rows[0] ?? null;
}

async function ensureTelegramAccount(client: PoolClient, telegramUserId: number, username?: string): Promise<number> {
  const existing = await client.query<{ account_id: number }>(
    "SELECT account_id FROM account_identities WHERE provider = 'telegram' AND provider_user_id = $1",
    [String(telegramUserId)],
  );
  if (existing.rows[0]) return existing.rows[0].account_id;

  const created = await client.query<{ id: number }>("INSERT INTO accounts DEFAULT VALUES RETURNING id");
  const accountId = created.rows[0]!.id;
  await client.query(
    `INSERT INTO account_identities (account_id, provider, provider_user_id, telegram_username, verified)
     VALUES ($1, 'telegram', $2, $3, TRUE)`,
    [accountId, String(telegramUserId), username ?? null],
  );
  await grantInitialFreeGenerations(client, accountId);
  return accountId;
}

export async function savePayment(params: {
  userId: number;
  amount: number;
  telegramChargeId?: string;
  providerChargeId?: string;
  username?: string;
  yookassaPaymentId?: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const accountId = params.telegramChargeId
      ? await ensureTelegramAccount(client, params.userId, params.username)
      : (await resolveAccountIdInTx(client, params.userId)) ?? params.userId;
    await client.query("COMMIT");

    await creditPackagePayment({
      accountId,
      amount: params.amount,
      provider: params.telegramChargeId ? "telegram_yookassa" : "yookassa",
      paymentKey: params.yookassaPaymentId ?? params.telegramChargeId ?? params.providerChargeId ?? `manual:${crypto.randomUUID()}`,
      ...(params.telegramChargeId ? { telegramChargeId: params.telegramChargeId } : {}),
      ...(params.providerChargeId ? { providerChargeId: params.providerChargeId } : {}),
      ...(params.username ? { username: params.username } : {}),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function creditPackagePayment(params: {
  accountId: number;
  amount: number;
  provider: string;
  paymentKey: string;
  yookassaPaymentId?: string;
  telegramChargeId?: string;
  providerChargeId?: string;
  username?: string;
}): Promise<{ credited: boolean; generationsRemaining: number; packageTitle: string | null; paymentId?: number }> {
  const pkg = await getPackageByAmount(params.amount);
  if (!pkg) throw new Error(`Unknown package amount: ${params.amount}`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const insertPayment = await client.query<{ id: number }>(
      `INSERT INTO payments
       (account_id, package_id, username, amount, provider, telegram_charge_id, provider_charge_id, yookassa_payment_id, status, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'paid', NOW())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        params.accountId,
        pkg.id,
        params.username ?? null,
        params.amount,
        params.provider,
        params.telegramChargeId ?? null,
        params.providerChargeId ?? null,
        params.yookassaPaymentId ?? (params.provider === "yookassa" ? params.paymentKey : null),
      ],
    );

    const paymentId = insertPayment.rows[0]?.id;

    if (!paymentId) {
      const currentPackage = await client.query<{ generations_remaining: number; title: string | null }>(
        `SELECT up.generations_remaining, p.title
         FROM user_packages up
         LEFT JOIN packages p ON p.id = up.package_id
         WHERE up.account_id = $1`,
        [params.accountId],
      );
      await client.query("COMMIT");
      return {
        credited: false,
        generationsRemaining: currentPackage.rows[0]?.generations_remaining ?? 0,
        packageTitle: currentPackage.rows[0]?.title ?? null,
      };
    }

    const packageResult = await client.query<{ generations_remaining: number }>(
      `INSERT INTO user_packages (account_id, package_id, payment_id, generations_total, generations_remaining)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (account_id) DO UPDATE SET
         package_id = EXCLUDED.package_id,
         payment_id = EXCLUDED.payment_id,
         generations_total = user_packages.generations_total + EXCLUDED.generations_total,
         generations_remaining = user_packages.generations_remaining + EXCLUDED.generations_remaining,
         purchased_at = NOW()
       RETURNING generations_remaining`,
      [params.accountId, pkg.id, paymentId, pkg.generations_count],
    );

    await client.query("COMMIT");
    return {
      credited: true,
      generationsRemaining: packageResult.rows[0]!.generations_remaining,
      packageTitle: pkg.title,
      paymentId,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function creditYookassaPayment(params: {
  userId: number;
  amount: number;
  yookassaPaymentId: string;
}): Promise<{ credited: boolean; balance: number; generationsRemaining: number; packageTitle: string | null }> {
  const accountId = (await resolveAccountId(params.userId)) ?? params.userId;
  const result = await creditPackagePayment({
    accountId,
    amount: params.amount,
    provider: "yookassa",
    paymentKey: params.yookassaPaymentId,
    yookassaPaymentId: params.yookassaPaymentId,
  });
  return {
    credited: result.credited,
    balance: result.generationsRemaining,
    generationsRemaining: result.generationsRemaining,
    packageTitle: result.packageTitle,
  };
}

export async function creditManualBalance(params: {
  userId: number;
  amount: number;
  note?: string;
}): Promise<{ balance: number; paymentId: number; marker: string } | null> {
  const accountId = await resolveAccountId(params.userId);
  if (!accountId) return null;
  const marker = `manual:${crypto.randomUUID()}`;
  const result = await creditPackagePayment({
    accountId,
    amount: params.amount,
    provider: "manual",
    paymentKey: marker,
    ...(params.note ? { providerChargeId: params.note } : {}),
  });
  if (!result.paymentId) return null;
  return { balance: result.generationsRemaining, paymentId: result.paymentId, marker };
}

export async function createGeneration(
  identifier: number,
  prompt: string,
  sourceFileId: string,
  cost: number,
  isFree: number,
  userPackageId?: number,
  generationCost = 1,
): Promise<number> {
  const accountId = await resolveAccountId(identifier);
  if (!accountId) throw new Error("Account not found");
  const result = await pool.query<{ id: number }>(
    `INSERT INTO generations (account_id, user_package_id, prompt, source_file_id, cost, is_free, generation_cost, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing')
     RETURNING id`,
    [accountId, userPackageId ?? null, prompt, sourceFileId, cost, isFree, generationCost],
  );
  return result.rows[0]!.id;
}

export async function completeGeneration(generationId: number, resultFileId: string): Promise<void> {
  await pool.query(
    `UPDATE generations SET status = 'completed', result_file_id = $1, completed_at = NOW()
     WHERE id = $2`,
    [resultFileId, generationId],
  );
}

export async function failGeneration(generationId: number): Promise<void> {
  await pool.query("UPDATE generations SET status = 'failed', completed_at = NOW() WHERE id = $1", [generationId]);
}

export async function getAdminUsers(limit = 200, offset = 0): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT a.id AS user_id, tg.telegram_username AS username,
            COALESCE(a.first_name, tg.telegram_first_name, '') AS first_name,
            a.primary_email AS email, a.created_at,
            0::double precision AS balance,
            COALESCE(up.generations_remaining, 0)::integer AS free_generations,
            COALESCE(up.generations_total, 0)::integer AS package_generations_total,
            COALESCE(up.generations_remaining, 0)::integer AS package_generations_remaining,
            a.total_generations,
            p.title AS package_title,
            last_gen.created_at AS last_generation_at,
            last_pay.created_at AS last_payment_at,
            tg.provider_user_id AS telegram_id
     FROM accounts a
     LEFT JOIN user_packages up ON up.account_id = a.id
     LEFT JOIN packages p ON p.id = up.package_id
     LEFT JOIN LATERAL (
       SELECT provider_user_id, telegram_username, telegram_first_name FROM account_identities
       WHERE account_id = a.id AND provider = 'telegram'
       ORDER BY updated_at DESC
       LIMIT 1
     ) tg ON TRUE
     LEFT JOIN LATERAL (
       SELECT created_at FROM generations g
       WHERE g.account_id = a.id
       ORDER BY created_at DESC
       LIMIT 1
     ) last_gen ON TRUE
     LEFT JOIN LATERAL (
       SELECT created_at FROM payments pay
       WHERE pay.account_id = a.id AND pay.status = 'paid'
       ORDER BY created_at DESC
       LIMIT 1
     ) last_pay ON TRUE
     ORDER BY a.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

export async function addUserGenerations(params: {
  userId: number;
  adminId: number;
  count: number;
  reason?: string;
}): Promise<{ beforeRemaining: number; afterRemaining: number; generationsTotal: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const accountId = await resolveAccountIdInTx(client, params.userId);
    if (!accountId) {
      await client.query("ROLLBACK");
      throw new Error("User not found");
    }

    const current = await client.query<{ generations_remaining: number }>(
      "SELECT generations_remaining FROM user_packages WHERE account_id = $1 FOR UPDATE",
      [accountId],
    );
    const beforeRemaining = current.rows[0]?.generations_remaining ?? 0;

    const adminPackage = await client.query<{ id: number }>(
      `INSERT INTO packages (code, title, generations_count, price_rub, is_active)
       VALUES ('admin_grant', 'Ручное начисление администратора', 1, 0, FALSE)
       ON CONFLICT (code) DO UPDATE SET
         title = EXCLUDED.title,
         is_active = FALSE
       RETURNING id`,
    );

    const updated = await client.query<{ generations_remaining: number; generations_total: number }>(
      `INSERT INTO user_packages (account_id, package_id, generations_total, generations_remaining)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (account_id) DO UPDATE SET
         generations_total = user_packages.generations_total + EXCLUDED.generations_total,
         generations_remaining = user_packages.generations_remaining + EXCLUDED.generations_remaining
       RETURNING generations_remaining, generations_total`,
      [accountId, adminPackage.rows[0]!.id, params.count],
    );
    const row = updated.rows[0]!;

    await client.query(
      `INSERT INTO generation_adjustments
       (account_id, admin_telegram_id, delta, reason, before_remaining, after_remaining)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [accountId, params.adminId, params.count, params.reason ?? null, beforeRemaining, row.generations_remaining],
    );

    await client.query("COMMIT");
    return {
      beforeRemaining,
      afterRemaining: row.generations_remaining,
      generationsTotal: row.generations_total,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function setFreeGenerations(identifier: number, count: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const accountId = await resolveAccountIdInTx(client, identifier);
    if (!accountId) {
      await client.query("ROLLBACK");
      return;
    }
    const manualPackage = await client.query<{ id: number }>(
      `INSERT INTO packages (code, title, generations_count, price_rub, is_active)
       VALUES ('manual', 'Ручной пакет', $1, 0, FALSE)
       ON CONFLICT (code) DO UPDATE SET generations_count = GREATEST(packages.generations_count, EXCLUDED.generations_count)
       RETURNING id`,
      [Math.max(count, 1)],
    );
    await client.query(
      `INSERT INTO user_packages (account_id, package_id, generations_total, generations_remaining)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (account_id) DO UPDATE SET
         generations_total = GREATEST(user_packages.generations_total, EXCLUDED.generations_total),
         generations_remaining = EXCLUDED.generations_remaining`,
      [accountId, manualPackage.rows[0]!.id, count],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function getAdminStats(): Promise<Record<string, unknown>> {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM accounts)::int AS total_users,
      (SELECT COUNT(*) FROM accounts WHERE created_at >= CURRENT_DATE)::int AS new_users_today,
      (SELECT COUNT(*) FROM accounts WHERE created_at >= NOW() - INTERVAL '7 days')::int AS new_users_7d,
      (SELECT COUNT(*) FROM generations)::int AS total_generations,
      (SELECT COUNT(*) FROM generations WHERE status = 'completed')::int AS completed_generations,
      (SELECT COUNT(*) FROM generations WHERE status = 'failed')::int AS failed_generations,
      (SELECT COUNT(*) FROM generations WHERE status = 'processing')::int AS processing_generations,
      (SELECT COUNT(*) FROM payments WHERE status = 'paid')::int AS paid_payments,
      (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'paid') AS total_revenue,
      (SELECT COALESCE(SUM(generations_remaining), 0)::int FROM user_packages) AS available_generations,
      (SELECT COALESCE(SUM(delta), 0)::int FROM generation_adjustments) AS manually_granted_generations
  `);
  return result.rows[0] as Record<string, unknown>;
}

export async function getAdminGenerations(limit = 50, offset = 0): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT g.id, g.account_id AS user_id, tg.telegram_username AS username,
            COALESCE(a.first_name, tg.telegram_first_name, '') AS first_name,
            a.primary_email AS email,
            g.prompt, g.status, g.cost, g.is_free, g.generation_cost,
            g.source_file_id, g.result_file_id, g.created_at, g.completed_at
     FROM generations g
     JOIN accounts a ON a.id = g.account_id
     LEFT JOIN LATERAL (
       SELECT telegram_username, telegram_first_name FROM account_identities
       WHERE account_id = a.id AND provider = 'telegram'
       ORDER BY updated_at DESC
       LIMIT 1
     ) tg ON TRUE
     ORDER BY g.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

export async function getAdminPayments(limit = 50, offset = 0): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT p.id, p.account_id AS user_id, tg.telegram_username AS username,
            COALESCE(a.first_name, tg.telegram_first_name, '') AS first_name,
            a.primary_email AS email,
            p.amount, p.provider, p.status, p.yookassa_payment_id,
            p.telegram_charge_id, pkg.title AS package_title, p.created_at, p.paid_at
     FROM payments p
     JOIN accounts a ON a.id = p.account_id
     LEFT JOIN packages pkg ON pkg.id = p.package_id
     LEFT JOIN LATERAL (
       SELECT telegram_username, telegram_first_name FROM account_identities
       WHERE account_id = a.id AND provider = 'telegram'
       ORDER BY updated_at DESC
       LIMIT 1
     ) tg ON TRUE
     ORDER BY p.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

export async function getAdminAdjustments(limit = 50, offset = 0): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT adj.id, adj.account_id AS user_id, tg.telegram_username AS username,
            COALESCE(a.first_name, tg.telegram_first_name, '') AS first_name,
            a.primary_email AS email,
            adj.admin_telegram_id AS admin_id, adj.delta, adj.reason,
            adj.before_remaining, adj.after_remaining, adj.created_at
     FROM generation_adjustments adj
     JOIN accounts a ON a.id = adj.account_id
     LEFT JOIN LATERAL (
       SELECT telegram_username, telegram_first_name FROM account_identities
       WHERE account_id = a.id AND provider = 'telegram'
       ORDER BY updated_at DESC
       LIMIT 1
     ) tg ON TRUE
     ORDER BY adj.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

export async function getUserPayments(identifier: number, limit = 20): Promise<{ id: number; amount: number; package_title: string | null; created_at: string }[]> {
  const accountId = await resolveAccountId(identifier);
  if (!accountId) return [];
  const result = await pool.query<{ id: number; amount: number; package_title: string | null; created_at: Date }>(
    `SELECT p.id, p.amount, pkg.title AS package_title, p.created_at
     FROM payments p
     LEFT JOIN packages pkg ON pkg.id = p.package_id
     WHERE p.account_id = $1
     ORDER BY p.created_at DESC
     LIMIT $2`,
    [accountId, limit],
  );
  return result.rows.map((r) => ({ id: r.id, amount: r.amount, package_title: r.package_title, created_at: r.created_at.toISOString() }));
}

export async function findUserByEmail(email: string): Promise<DbUserWithAuth | null> {
  const result = await pool.query<DbUserWithAuth>(`${ACCOUNT_SELECT} WHERE lower(a.primary_email) = lower($1)`, [email]);
  return userFromRow(result.rows[0]);
}

export async function createWebUser(email: string, passwordHash: string): Promise<DbUser> {
  const normalizedEmail = email.trim().toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await client.query<{ id: number }>(
      `INSERT INTO accounts (first_name, primary_email, password_hash, email_verified)
       VALUES ($1, $2, $3, FALSE)
       RETURNING id`,
      [normalizedEmail.split("@")[0] ?? normalizedEmail, normalizedEmail, passwordHash],
    );
    const accountId = created.rows[0]!.id;
    await client.query(
      `INSERT INTO account_identities (account_id, provider, provider_user_id, email, verified)
       VALUES ($1, 'email', $2, $2, FALSE)`,
      [accountId, normalizedEmail],
    );
    await grantInitialFreeGenerations(client, accountId);
    const result = await client.query<DbUserWithAuth>(`${ACCOUNT_SELECT} WHERE a.id = $1`, [accountId]);
    await client.query("COMMIT");
    return result.rows[0]!;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function createWebSession(accountId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await pool.query("INSERT INTO web_sessions (account_id, token, expires_at) VALUES ($1, $2, $3)", [accountId, token, expiresAt]);
  return { token, expiresAt };
}

export async function validateWebSession(token: string): Promise<DbUser | null> {
  const result = await pool.query<DbUserWithAuth>(
    `${ACCOUNT_SELECT}
     JOIN web_sessions s ON s.account_id = a.id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token],
  );
  return userFromRow(result.rows[0]);
}

export async function deleteWebSession(token: string): Promise<void> {
  await pool.query("DELETE FROM web_sessions WHERE token = $1", [token]);
}

export async function createEmailVerification(accountId: number): Promise<string> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await pool.query("DELETE FROM email_verifications WHERE account_id = $1", [accountId]);
  await pool.query("INSERT INTO email_verifications (account_id, token, expires_at) VALUES ($1, $2, $3)", [accountId, token, expiresAt]);
  return token;
}

export async function consumeEmailVerification(token: string): Promise<number | null> {
  const result = await pool.query<{ account_id: number }>(
    `DELETE FROM email_verifications
     WHERE token = $1 AND expires_at > NOW()
     RETURNING account_id`,
    [token],
  );
  return result.rows[0]?.account_id ?? null;
}

export async function markEmailVerified(accountId: number): Promise<void> {
  await pool.query("UPDATE accounts SET email_verified = TRUE, updated_at = NOW() WHERE id = $1", [accountId]);
  await pool.query("UPDATE account_identities SET verified = TRUE, updated_at = NOW() WHERE account_id = $1 AND provider = 'email'", [accountId]);
}

export async function createTelegramLinkToken(accountId: number): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await pool.query("DELETE FROM account_link_tokens WHERE account_id = $1 AND consumed_at IS NULL", [accountId]);
  await pool.query("INSERT INTO account_link_tokens (account_id, token, expires_at) VALUES ($1, $2, $3)", [accountId, token, expiresAt]);
  return token;
}

async function moveUserPackage(client: PoolClient, sourceAccountId: number, targetAccountId: number): Promise<void> {
  const source = await client.query<{ package_id: number; generations_total: number; generations_remaining: number }>(
    "SELECT package_id, generations_total, generations_remaining FROM user_packages WHERE account_id = $1 FOR UPDATE",
    [sourceAccountId],
  );
  const sourcePackage = source.rows[0];
  if (!sourcePackage) return;

  const target = await client.query<{ id: number }>(
    "SELECT id FROM user_packages WHERE account_id = $1 FOR UPDATE",
    [targetAccountId],
  );

  if (target.rows[0]) {
    await client.query(
      `UPDATE user_packages
       SET generations_total = generations_total + $2,
           generations_remaining = generations_remaining + $3,
           purchased_at = NOW()
       WHERE account_id = $1`,
      [targetAccountId, sourcePackage.generations_total, sourcePackage.generations_remaining],
    );
    await client.query("DELETE FROM user_packages WHERE account_id = $1", [sourceAccountId]);
  } else {
    await client.query("UPDATE user_packages SET account_id = $1 WHERE account_id = $2", [targetAccountId, sourceAccountId]);
  }
}

async function mergeAccounts(client: PoolClient, sourceAccountId: number, targetAccountId: number): Promise<void> {
  if (sourceAccountId === targetAccountId) return;

  await moveUserPackage(client, sourceAccountId, targetAccountId);
  await client.query("UPDATE payments SET account_id = $1 WHERE account_id = $2", [targetAccountId, sourceAccountId]);
  await client.query("UPDATE generations SET account_id = $1 WHERE account_id = $2", [targetAccountId, sourceAccountId]);
  await client.query("UPDATE uploads SET account_id = $1 WHERE account_id = $2", [targetAccountId, sourceAccountId]);
  await client.query("UPDATE generation_adjustments SET account_id = $1 WHERE account_id = $2", [targetAccountId, sourceAccountId]);
  await client.query("UPDATE web_sessions SET account_id = $1 WHERE account_id = $2", [targetAccountId, sourceAccountId]);

  const source = await client.query<{ primary_email: string | null; password_hash: string | null; email_verified: boolean; total_generations: number; first_name: string | null }>(
    "SELECT primary_email, password_hash, email_verified, total_generations, first_name FROM accounts WHERE id = $1",
    [sourceAccountId],
  );
  const src = source.rows[0];
  if (src) {
    await client.query(
      `UPDATE accounts
       SET total_generations = total_generations + $2,
           primary_email = COALESCE(primary_email, $3),
           password_hash = COALESCE(password_hash, $4),
           email_verified = email_verified OR $5,
           first_name = COALESCE(first_name, $6),
           updated_at = NOW()
       WHERE id = $1`,
      [targetAccountId, src.total_generations, src.primary_email, src.password_hash, src.email_verified, src.first_name],
    );
  }

  const identities = await client.query<{ id: number; provider: string; provider_user_id: string }>(
    "SELECT id, provider, provider_user_id FROM account_identities WHERE account_id = $1",
    [sourceAccountId],
  );
  for (const identity of identities.rows) {
    const conflict = await client.query<{ id: number }>(
      "SELECT id FROM account_identities WHERE provider = $1 AND provider_user_id = $2 AND account_id <> $3",
      [identity.provider, identity.provider_user_id, targetAccountId],
    );
    if (!conflict.rows[0]) {
      await client.query("UPDATE account_identities SET account_id = $1, updated_at = NOW() WHERE id = $2", [targetAccountId, identity.id]);
    } else {
      await client.query("DELETE FROM account_identities WHERE id = $1", [identity.id]);
    }
  }

  await client.query("DELETE FROM accounts WHERE id = $1", [sourceAccountId]);
}

export async function linkTelegramAccount(params: {
  token: string;
  telegramUserId: number;
  username?: string | null;
  firstName?: string | null;
}): Promise<DbUser | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tokenResult = await client.query<{ account_id: number }>(
      `SELECT account_id FROM account_link_tokens
       WHERE token = $1 AND consumed_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [params.token],
    );
    const targetAccountId = tokenResult.rows[0]?.account_id;
    if (!targetAccountId) {
      await client.query("ROLLBACK");
      return null;
    }

    const existingTelegram = await client.query<{ account_id: number }>(
      "SELECT account_id FROM account_identities WHERE provider = 'telegram' AND provider_user_id = $1 FOR UPDATE",
      [String(params.telegramUserId)],
    );
    const sourceAccountId = existingTelegram.rows[0]?.account_id;
    if (sourceAccountId && sourceAccountId !== targetAccountId) {
      await mergeAccounts(client, sourceAccountId, targetAccountId);
    }

    await client.query(
      `INSERT INTO account_identities
       (account_id, provider, provider_user_id, telegram_username, telegram_first_name, verified)
       VALUES ($1, 'telegram', $2, $3, $4, TRUE)
       ON CONFLICT (provider, provider_user_id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         telegram_username = EXCLUDED.telegram_username,
         telegram_first_name = EXCLUDED.telegram_first_name,
         verified = TRUE,
         updated_at = NOW()`,
      [targetAccountId, String(params.telegramUserId), params.username ?? null, params.firstName ?? null],
    );
    await client.query("UPDATE account_link_tokens SET consumed_at = NOW() WHERE token = $1", [params.token]);

    const result = await client.query<DbUserWithAuth>(`${ACCOUNT_SELECT} WHERE a.id = $1`, [targetAccountId]);
    await client.query("COMMIT");
    return result.rows[0] ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function saveUpload(identifier: number, filename: string, originalName: string): Promise<number> {
  const accountId = await resolveAccountId(identifier);
  if (!accountId) throw new Error("Account not found");
  const result = await pool.query<{ id: number }>(
    "INSERT INTO uploads (account_id, filename, original_name) VALUES ($1, $2, $3) RETURNING id",
    [accountId, filename, originalName],
  );
  return result.rows[0]!.id;
}

export async function getUserGenerations(identifier: number, limit = 20, offset = 0): Promise<Record<string, unknown>[]> {
  const accountId = await resolveAccountId(identifier);
  if (!accountId) return [];
  const result = await pool.query(
    `SELECT id, prompt, source_file_id, result_file_id, status, cost, is_free, generation_cost, created_at, completed_at
     FROM generations
     WHERE account_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [accountId, limit, offset],
  );
  return result.rows;
}

export async function getGenerationById(id: number, identifier: number): Promise<Record<string, unknown> | null> {
  const accountId = await resolveAccountId(identifier);
  if (!accountId) return null;
  const result = await pool.query("SELECT * FROM generations WHERE id = $1 AND account_id = $2", [id, accountId]);
  return result.rows[0] ?? null;
}

// ─── Email campaign tracking ──────────────────────────────────────────────────

export async function addEmailRecipient(email: string): Promise<string> {
  const mdKey = crypto.createHash("md5").update(email.toLowerCase()).digest("hex");
  await pool.query(
    `INSERT INTO email_recipients (md_key, email) VALUES ($1, $2)
     ON CONFLICT (md_key) DO NOTHING`,
    [mdKey, email.toLowerCase()],
  );
  return mdKey;
}

export async function logEmailOpen(
  campaign: string,
  mdKey: string,
  ip: string,
  userAgent: string,
): Promise<void> {
  await pool.query(
    "INSERT INTO email_opens (campaign, md_key, ip, user_agent) VALUES ($1, $2, $3, $4)",
    [campaign, mdKey, ip, userAgent],
  );
}

export async function logEmailClick(
  campaign: string,
  mdKey: string,
  ip: string,
  userAgent: string,
): Promise<void> {
  await pool.query(
    "INSERT INTO email_clicks (campaign, md_key, ip, user_agent) VALUES ($1, $2, $3, $4)",
    [campaign, mdKey, ip, userAgent],
  );
}

export async function getCampaignStats(campaign: string): Promise<{
  sent: number;
  opened: number;
  clicked: number;
}> {
  const result = await pool.query<{ sent: number; opened: number; clicked: number }>(`
    SELECT
      (SELECT COUNT(DISTINCT o.md_key)
       FROM email_opens o
       JOIN email_recipients r ON r.md_key = o.md_key
       WHERE o.campaign = $1)::int AS opened,
      (SELECT COUNT(DISTINCT c.md_key)
       FROM email_clicks c
       JOIN email_recipients r ON r.md_key = c.md_key
       WHERE c.campaign = $1)::int AS clicked,
      (SELECT COUNT(DISTINCT md_key)
       FROM email_opens WHERE campaign = $1)::int +
      (SELECT COUNT(DISTINCT md_key)
       FROM email_clicks WHERE campaign = $1)::int AS sent
  `, [campaign]);
  return result.rows[0] ?? { sent: 0, opened: 0, clicked: 0 };
}

export async function getCampaignSentCount(campaign: string): Promise<number> {
  const result = await pool.query<{ cnt: number }>(
    `SELECT COUNT(DISTINCT md_key)::int AS cnt FROM email_opens WHERE campaign = $1`,
    [campaign],
  );
  return result.rows[0]?.cnt ?? 0;
}

export async function getCampaignDetails(campaign: string): Promise<Array<{
  email: string;
  opened_at: string | null;
  clicked_at: string | null;
  open_count: number;
  ip: string | null;
  user_agent: string | null;
}>> {
  const result = await pool.query<{
    email: string;
    opened_at: Date | null;
    clicked_at: Date | null;
    open_count: number;
    ip: string | null;
    user_agent: string | null;
  }>(`
    WITH opens AS (
      SELECT md_key,
             MIN(opened_at) AS first_open,
             COUNT(*)::int AS open_count,
             (array_agg(ip ORDER BY opened_at ASC))[1] AS ip,
             (array_agg(user_agent ORDER BY opened_at ASC))[1] AS user_agent
      FROM email_opens
      WHERE campaign = $1
      GROUP BY md_key
    ),
    clicks AS (
      SELECT md_key,
             MIN(clicked_at) AS first_click,
             (array_agg(ip ORDER BY clicked_at ASC))[1] AS click_ip,
             (array_agg(user_agent ORDER BY clicked_at ASC))[1] AS click_ua
      FROM email_clicks
      WHERE campaign = $1
      GROUP BY md_key
    )
    SELECT
      r.email,
      o.first_open AS opened_at,
      COALESCE(o.open_count, 0) AS open_count,
      COALESCE(o.ip, c.click_ip) AS ip,
      COALESCE(o.user_agent, c.click_ua) AS user_agent,
      c.first_click AS clicked_at
    FROM email_recipients r
    LEFT JOIN opens o ON o.md_key = r.md_key
    LEFT JOIN clicks c ON c.md_key = r.md_key
    WHERE o.md_key IS NOT NULL OR c.md_key IS NOT NULL
    ORDER BY COALESCE(o.first_open, c.first_click) DESC
  `, [campaign]);
  return result.rows.map(r => ({
    email: r.email,
    opened_at: r.opened_at ? r.opened_at.toISOString() : null,
    clicked_at: r.clicked_at ? r.clicked_at.toISOString() : null,
    open_count: r.open_count,
    ip: r.ip,
    user_agent: r.user_agent,
  }));
}

export async function getAllCampaignsStats(): Promise<Array<{
  campaign: string;
  opened: number;
  clicked: number;
  last_activity: string | null;
}>> {
  const result = await pool.query<{
    campaign: string;
    opened: number;
    clicked: number;
    last_activity: Date | null;
  }>(`
    SELECT
      COALESCE(o.campaign, c.campaign) AS campaign,
      COALESCE(o.opened, 0) AS opened,
      COALESCE(c.clicked, 0) AS clicked,
      GREATEST(o.last_open, c.last_click) AS last_activity
    FROM (
      SELECT campaign, COUNT(DISTINCT md_key)::int AS opened, MAX(opened_at) AS last_open
      FROM email_opens GROUP BY campaign
    ) o
    FULL OUTER JOIN (
      SELECT campaign, COUNT(DISTINCT md_key)::int AS clicked, MAX(clicked_at) AS last_click
      FROM email_clicks GROUP BY campaign
    ) c ON o.campaign = c.campaign
    ORDER BY GREATEST(o.last_open, c.last_click) DESC NULLS LAST
  `);
  return result.rows.map(r => ({
    ...r,
    last_activity: r.last_activity ? r.last_activity.toISOString() : null,
  }));
}
