import crypto from "node:crypto";
import bcrypt from "bcrypt";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  findUserByEmail,
  createWebUser,
  createWebSession,
  validateWebSession,
  deleteWebSession,
  createEmailVerification,
  consumeEmailVerification,
  markEmailVerified,
  createTelegramLinkToken,
  createPasswordReset,
  consumePasswordReset,
  updateAccountPassword,
  syncMediaReviewerStatus,
  getOrCreateUser,
  type DbUser,
  type DbUserWithAuth,
} from "../database.js";
import { sendVerificationEmail, sendPasswordResetEmail } from "../email.js";
import { BOT_TOKEN, MEDIA_REVIEWER_EMAIL, TELEGRAM_BOT_USERNAME } from "../config.js";

const BCRYPT_ROUNDS = 10;

export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<DbUserWithAuth | null> {
  const auth = req.headers["authorization"] ?? "";
  if (!auth.startsWith("Bearer ")) {
    await reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  const token = auth.slice(7);
  const user = await validateWebSession(token);
  if (!user) {
    await reply.code(401).send({ error: "Session expired" });
    return null;
  }
  return user as DbUserWithAuth;
}

async function canReviewMedia(user: DbUserWithAuth): Promise<boolean> {
  const email = user.email?.trim().toLowerCase() ?? "";
  if (!user.email_verified || !MEDIA_REVIEWER_EMAIL || email !== MEDIA_REVIEWER_EMAIL) return false;
  return syncMediaReviewerStatus(user.user_id, MEDIA_REVIEWER_EMAIL);
}

function validateTelegramWebAppInitData(initData: string): Record<string, string> | null {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return null;
  params.delete("hash");

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expected = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (expected.length !== receivedHash.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedHash))) return null;

  return Object.fromEntries(params.entries());
}

export async function requireMediaReviewer(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<DbUserWithAuth | null> {
  const user = await requireAuth(req, reply);
  if (!user) return null;
  if (!(await canReviewMedia(user))) {
    await reply.code(403).send({ error: "Forbidden" });
    return null;
  }
  return user;
}

export function registerAuthRoutes(fastify: FastifyInstance): void {
  fastify.post("/api/auth/register", async (req, reply) => {
    const body = req.body as { email?: unknown; password?: unknown };
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");

    if (!email.includes("@") || password.length < 6) {
      return reply.code(400).send({ error: "Неверный email или пароль слишком короткий (минимум 6 символов)" });
    }

    const existing = await findUserByEmail(email);
    if (existing) {
      return reply.code(409).send({ error: "Email уже зарегистрирован" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await createWebUser(email, passwordHash);
    const token = await createEmailVerification(user.user_id);
    await sendVerificationEmail(email, token);

    return reply.code(201).send({
      message: `Письмо с подтверждением отправлено на ${email}. Проверьте почту.`,
    });
  });

  fastify.post("/api/auth/login", async (req, reply) => {
    const body = req.body as { email?: unknown; password?: unknown };
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");

    const user = await findUserByEmail(email);
    if (!user || !user.password_hash) {
      return reply.code(401).send({ error: "Неверный email или пароль" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return reply.code(401).send({ error: "Неверный email или пароль" });
    }

    if (!user.email_verified) {
      return reply.code(403).send({ error: `Email не подтверждён. Проверьте почту ${email} или запросите новое письмо.` });
    }

    const session = await createWebSession(user.user_id);

    return reply.send({
      token: session.token,
      expires_at: session.expiresAt.toISOString(),
      user: {
        user_id: user.user_id,
        email: user.email,
        balance: 0,
        free_generations: user.package_generations_remaining,
        total_generations: user.total_generations,
        has_package: user.package_code !== null,
        package_code: user.package_code,
        package_title: user.package_title,
        package_generations_total: user.package_generations_total,
        package_generations_remaining: user.package_generations_remaining,
        can_review_media: await canReviewMedia(user),
      },
    });
  });

  fastify.get("/api/auth/verify", async (req, reply) => {
    const token = (req.query as Record<string, string>)["token"] ?? "";
    if (!token) {
      return reply.code(400).send("Токен не указан.");
    }

    const userId = await consumeEmailVerification(token);
    if (!userId) {
      return reply.code(400).send("Ссылка недействительна или устарела.");
    }

    await markEmailVerified(userId);
    const session = await createWebSession(userId);

    return reply.redirect(`/?session=${session.token}`);
  });

  fastify.post("/api/auth/resend-verification", async (req, reply) => {
    const body = req.body as { email?: unknown };
    const email = String(body.email ?? "").trim().toLowerCase();

    const user = await findUserByEmail(email);
    if (!user || !user.password_hash) {
      // Не раскрываем факт существования аккаунта
      return reply.send({ message: "Если email зарегистрирован, письмо отправлено." });
    }

    if (user.email_verified) {
      return reply.send({ message: "Email уже подтверждён." });
    }

    const token = await createEmailVerification(user.user_id);
    await sendVerificationEmail(email, token);

    return reply.send({ message: "Письмо отправлено повторно." });
  });

  fastify.post("/api/auth/forgot-password", async (req, reply) => {
    const body = req.body as { email?: unknown };
    const email = String(body.email ?? "").trim().toLowerCase();

    const user = await findUserByEmail(email);
    if (user && user.password_hash) {
      const token = await createPasswordReset(user.user_id);
      await sendPasswordResetEmail(email, token);
    }

    // Не раскрываем факт существования аккаунта
    return reply.send({ message: "Если email зарегистрирован, письмо со ссылкой для сброса пароля отправлено." });
  });

  fastify.post("/api/auth/reset-password", async (req, reply) => {
    const body = req.body as { token?: unknown; password?: unknown };
    const token = String(body.token ?? "");
    const password = String(body.password ?? "");

    if (password.length < 6) {
      return reply.code(400).send({ error: "Пароль слишком короткий (минимум 6 символов)" });
    }

    const accountId = await consumePasswordReset(token);
    if (!accountId) {
      return reply.code(400).send({ error: "Ссылка недействительна или устарела." });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await updateAccountPassword(accountId, passwordHash);
    const session = await createWebSession(accountId);

    return reply.send({ token: session.token, message: "Пароль обновлён." });
  });

  fastify.post("/api/auth/telegram-webapp", async (req, reply) => {
    const body = req.body as { init_data?: unknown; initData?: unknown };
    const initData = String(body.init_data ?? body.initData ?? "").trim();
    if (!initData) {
      return reply.code(400).send({ error: "Telegram initData is required" });
    }

    const parsed = validateTelegramWebAppInitData(initData);
    if (!parsed) {
      return reply.code(401).send({ error: "Telegram initData verification failed" });
    }

    let userPayload: { id?: number; username?: string; first_name?: string } | null = null;
    try {
      userPayload = JSON.parse(parsed["user"] ?? "{}") as { id?: number; username?: string; first_name?: string };
    } catch {
      return reply.code(401).send({ error: "Invalid Telegram user payload" });
    }

    const telegramUserId = Number(userPayload.id ?? NaN);
    if (!Number.isFinite(telegramUserId)) {
      return reply.code(401).send({ error: "Telegram user id is missing" });
    }

    const dbUser = await getOrCreateUser(telegramUserId, userPayload.username, userPayload.first_name ?? "");
    const session = await createWebSession(dbUser.user_id);
    const authUser = { ...dbUser, password_hash: null, email_verified: false } as DbUserWithAuth;

    return reply.send({
      token: session.token,
      expires_at: session.expiresAt.toISOString(),
      user: {
        user_id: dbUser.user_id,
        username: dbUser.username ?? null,
        email: (dbUser as unknown as { email?: string }).email ?? null,
        balance: 0,
        free_generations: dbUser.package_generations_remaining,
        total_generations: dbUser.total_generations,
        has_package: dbUser.package_code !== null,
        package_code: dbUser.package_code,
        package_title: dbUser.package_title,
        package_generations_total: dbUser.package_generations_total,
        package_generations_remaining: dbUser.package_generations_remaining,
        can_review_media: await canReviewMedia(authUser),
      },
    });
  });

  fastify.post("/api/auth/telegram-link", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const token = await createTelegramLinkToken(user.user_id);
    const botUrl = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=link_${token}`;
    return reply.send({ bot_url: botUrl, expires_in_seconds: 900 });
  });

  fastify.post("/api/auth/logout", async (req, reply) => {
    const auth = req.headers["authorization"] ?? "";
    if (auth.startsWith("Bearer ")) {
      await deleteWebSession(auth.slice(7));
    }
    return reply.send({ ok: true });
  });

  fastify.get("/api/auth/me", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    return reply.send({
      user_id: user.user_id,
      username: user.username ?? null,
      email: (user as unknown as { email?: string }).email ?? null,
      balance: 0,
      free_generations: user.package_generations_remaining,
      total_generations: user.total_generations,
      has_package: user.package_code !== null,
      package_code: user.package_code,
      package_title: user.package_title,
      package_generations_total: user.package_generations_total,
      package_generations_remaining: user.package_generations_remaining,
      can_review_media: await canReviewMedia(user),
    });
  });
}
