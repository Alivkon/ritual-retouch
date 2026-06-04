import crypto from "node:crypto";
import { Pool, types } from "pg";
import { DATABASE_URL, FREE_GENERATIONS } from "./config.js";

// Parse BIGINT (OID 20) and BIGSERIAL as Number — safe for Telegram IDs
types.setTypeParser(20, (val: string) => parseInt(val, 10));

let pool: Pool;

export async function initDb(): Promise<void> {
  pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id BIGINT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        balance DOUBLE PRECISION DEFAULT 0.0,
        free_generations INTEGER DEFAULT 3,
        total_generations INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(user_id),
        username TEXT,
        amount DOUBLE PRECISION NOT NULL,
        telegram_charge_id TEXT,
        provider_charge_id TEXT,
        yookassa_payment_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_yookassa_id
      ON payments (yookassa_payment_id)
      WHERE yookassa_payment_id IS NOT NULL
    `);
    await client.query(`
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS robokassa_inv_id BIGINT
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_robokassa_inv_id
      ON payments (robokassa_inv_id)
      WHERE robokassa_inv_id IS NOT NULL
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS generations (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(user_id),
        prompt TEXT,
        source_file_id TEXT,
        result_file_id TEXT,
        cost DOUBLE PRECISION DEFAULT 0.0,
        is_free INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);

    // Web authentication
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
      ON users (email) WHERE email IS NOT NULL
    `);

    // Email verification tokens
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Web sessions (Bearer token auth)
    await client.query(`
      CREATE TABLE IF NOT EXISTS web_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(user_id),
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_web_sessions_token ON web_sessions(token)
    `);

    // Uploaded files (web photo uploads)
    await client.query(`
      CREATE TABLE IF NOT EXISTS uploads (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(user_id),
        filename TEXT NOT NULL,
        original_name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } finally {
    client.release();
  }
}

export interface DbUser {
  user_id: number;
  username: string | null;
  first_name: string;
  balance: number;
  free_generations: number;
  total_generations: number;
  created_at: Date;
}

export async function getOrCreateUser(
  userId: number,
  username: string | null | undefined,
  firstName: string,
): Promise<DbUser> {
  const client = await pool.connect();
  try {
    const existing = await client.query<DbUser>(
      "SELECT * FROM users WHERE user_id = $1",
      [userId],
    );
    if (existing.rows[0]) return existing.rows[0];

    await client.query(
      "INSERT INTO users (user_id, username, first_name, free_generations) VALUES ($1, $2, $3, $4)",
      [userId, username ?? null, firstName, FREE_GENERATIONS],
    );
    const created = await client.query<DbUser>(
      "SELECT * FROM users WHERE user_id = $1",
      [userId],
    );
    return created.rows[0]!;
  } finally {
    client.release();
  }
}

export async function getUser(userId: number): Promise<DbUser | null> {
  const result = await pool.query<DbUser>(
    "SELECT * FROM users WHERE user_id = $1",
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function deductBalance(userId: number, amount: number): Promise<void> {
  await pool.query(
    "UPDATE users SET balance = balance - $1 WHERE user_id = $2",
    [amount, userId],
  );
}

export async function deductFreeGeneration(userId: number): Promise<void> {
  await pool.query(
    "UPDATE users SET free_generations = free_generations - 1 WHERE user_id = $1",
    [userId],
  );
}

export async function incrementTotalGenerations(userId: number): Promise<void> {
  await pool.query(
    "UPDATE users SET total_generations = total_generations + 1 WHERE user_id = $1",
    [userId],
  );
}

export async function addBalance(userId: number, amount: number): Promise<void> {
  await pool.query(
    "UPDATE users SET balance = balance + $1 WHERE user_id = $2",
    [amount, userId],
  );
}

export async function savePayment(params: {
  userId: number;
  amount: number;
  telegramChargeId?: string;
  providerChargeId?: string;
  username?: string;
  yookassaPaymentId?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO payments
     (user_id, username, amount, telegram_charge_id, provider_charge_id, yookassa_payment_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.userId,
      params.username ?? null,
      params.amount,
      params.telegramChargeId ?? null,
      params.providerChargeId ?? null,
      params.yookassaPaymentId ?? null,
    ],
  );
}

export async function creditYookassaPayment(params: {
  userId: number;
  amount: number;
  yookassaPaymentId: string;
}): Promise<{ credited: boolean; balance: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const insertResult = await client.query<{ id: number }>(
      `INSERT INTO payments (user_id, amount, yookassa_payment_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (yookassa_payment_id) WHERE yookassa_payment_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [params.userId, params.amount, params.yookassaPaymentId],
    );

    if (!insertResult.rows[0]) {
      const userResult = await client.query<{ balance: number }>(
        "SELECT balance FROM users WHERE user_id = $1",
        [params.userId],
      );
      await client.query("COMMIT");
      return { credited: false, balance: userResult.rows[0]?.balance ?? 0 };
    }

    const userResult = await client.query<{ balance: number }>(
      "UPDATE users SET balance = balance + $1 WHERE user_id = $2 RETURNING balance",
      [params.amount, params.userId],
    );
    await client.query("COMMIT");
    return { credited: true, balance: userResult.rows[0]?.balance ?? params.amount };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function creditManualBalance(params: {
  userId: number;
  amount: number;
  note?: string;
}): Promise<{ balance: number; paymentId: number; marker: string } | null> {
  const client = await pool.connect();
  const marker = `manual:${crypto.randomUUID()}`;
  try {
    await client.query("BEGIN");
    const userResult = await client.query<{ balance: number }>(
      "UPDATE users SET balance = balance + $1 WHERE user_id = $2 RETURNING balance",
      [params.amount, params.userId],
    );
    const user = userResult.rows[0];
    if (!user) {
      await client.query("ROLLBACK");
      return null;
    }

    const paymentResult = await client.query<{ id: number }>(
      `INSERT INTO payments (user_id, amount, yookassa_payment_id, provider_charge_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [params.userId, params.amount, marker, params.note ?? null],
    );
    await client.query("COMMIT");
    return {
      balance: user.balance,
      paymentId: paymentResult.rows[0]!.id,
      marker,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function createGeneration(
  userId: number,
  prompt: string,
  sourceFileId: string,
  cost: number,
  isFree: number,
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO generations (user_id, prompt, source_file_id, cost, is_free, status)
     VALUES ($1, $2, $3, $4, $5, 'processing')
     RETURNING id`,
    [userId, prompt, sourceFileId, cost, isFree],
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
  await pool.query(
    "UPDATE generations SET status = 'failed', completed_at = NOW() WHERE id = $1",
    [generationId],
  );
}

export async function getAdminUsers(limit = 200, offset = 0): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT user_id, username, first_name, balance,
            free_generations, total_generations, created_at
     FROM users
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

export async function setFreeGenerations(userId: number, count: number): Promise<void> {
  await pool.query(
    "UPDATE users SET free_generations = $1 WHERE user_id = $2",
    [count, userId],
  );
}

export async function getAdminStats(): Promise<Record<string, unknown>> {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users)::int AS total_users,
      (SELECT COUNT(*) FROM generations)::int AS total_generations,
      (SELECT COUNT(*) FROM generations WHERE status = 'completed')::int AS completed_generations,
      (SELECT COUNT(*) FROM generations WHERE status = 'failed')::int AS failed_generations,
      (SELECT COALESCE(SUM(amount), 0) FROM payments) AS total_revenue
  `);
  return result.rows[0] as Record<string, unknown>;
}

export async function getAdminGenerations(limit = 50, offset = 0): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT g.id, g.user_id, u.username, u.first_name,
            g.prompt, g.status, g.cost, g.is_free,
            g.created_at, g.completed_at
     FROM generations g
     JOIN users u ON u.user_id = g.user_id
     ORDER BY g.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}


export async function getAdminPayments(limit = 50, offset = 0): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT p.id, p.user_id, u.username, u.first_name,
            p.amount, p.yookassa_payment_id,
            p.telegram_charge_id, p.created_at
     FROM payments p
     JOIN users u ON u.user_id = p.user_id
     ORDER BY p.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

export async function getUserPayments(userId: number, limit = 20): Promise<{ id: number; amount: number; created_at: string }[]> {
  const result = await pool.query<{ id: number; amount: number; created_at: Date }>(
    `SELECT id, amount, created_at FROM payments
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return result.rows.map((r) => ({ id: r.id, amount: r.amount, created_at: r.created_at.toISOString() }));
}

// ─── Web auth ────────────────────────────────────────────────────────────────

export interface DbUserWithAuth extends DbUser {
  email: string | null;
  password_hash: string | null;
  email_verified: boolean;
}

export async function findUserByEmail(email: string): Promise<DbUserWithAuth | null> {
  const result = await pool.query<DbUserWithAuth>(
    "SELECT * FROM users WHERE email = $1",
    [email],
  );
  return result.rows[0] ?? null;
}

export async function createWebUser(email: string, passwordHash: string): Promise<DbUser> {
  const client = await pool.connect();
  try {
    // Web user IDs start from 1_000_000_000_000 to avoid collision with Telegram IDs
    const seqResult = await client.query<{ next_id: number }>(`
      SELECT COALESCE(MAX(user_id), 1000000000000) + 1 AS next_id
      FROM users WHERE user_id >= 1000000000000
    `);
    const userId = seqResult.rows[0]!.next_id;
    await client.query(
      `INSERT INTO users (user_id, first_name, email, password_hash, free_generations)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, email.split("@")[0] ?? email, email, passwordHash, FREE_GENERATIONS],
    );
    const created = await client.query<DbUser>("SELECT * FROM users WHERE user_id = $1", [userId]);
    return created.rows[0]!;
  } finally {
    client.release();
  }
}

export async function createWebSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  await pool.query(
    "INSERT INTO web_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)",
    [userId, token, expiresAt],
  );
  return { token, expiresAt };
}

export async function validateWebSession(token: string): Promise<DbUser | null> {
  const result = await pool.query<DbUser>(
    `SELECT u.* FROM users u
     JOIN web_sessions s ON s.user_id = u.user_id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token],
  );
  return result.rows[0] ?? null;
}

export async function deleteWebSession(token: string): Promise<void> {
  await pool.query("DELETE FROM web_sessions WHERE token = $1", [token]);
}

export async function createEmailVerification(userId: number): Promise<string> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  await pool.query("DELETE FROM email_verifications WHERE user_id = $1", [userId]);
  await pool.query(
    "INSERT INTO email_verifications (user_id, token, expires_at) VALUES ($1, $2, $3)",
    [userId, token, expiresAt],
  );
  return token;
}

export async function consumeEmailVerification(token: string): Promise<number | null> {
  const result = await pool.query<{ user_id: number }>(
    `DELETE FROM email_verifications
     WHERE token = $1 AND expires_at > NOW()
     RETURNING user_id`,
    [token],
  );
  return result.rows[0]?.user_id ?? null;
}

export async function markEmailVerified(userId: number): Promise<void> {
  await pool.query("UPDATE users SET email_verified = TRUE WHERE user_id = $1", [userId]);
}

export async function saveUpload(
  userId: number,
  filename: string,
  originalName: string,
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    "INSERT INTO uploads (user_id, filename, original_name) VALUES ($1, $2, $3) RETURNING id",
    [userId, filename, originalName],
  );
  return result.rows[0]!.id;
}

export async function getUserGenerations(
  userId: number,
  limit = 20,
  offset = 0,
): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT id, prompt, source_file_id, result_file_id, status, cost, is_free, created_at, completed_at
     FROM generations
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return result.rows;
}

export async function getGenerationById(
  id: number,
  userId: number,
): Promise<Record<string, unknown> | null> {
  const result = await pool.query(
    "SELECT * FROM generations WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return result.rows[0] ?? null;
}
