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
  type DbUser,
} from "../database.js";
import { sendVerificationEmail } from "../email.js";
import { TELEGRAM_BOT_USERNAME } from "../config.js";

const BCRYPT_ROUNDS = 10;

export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<DbUser | null> {
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
      email: (user as unknown as { email?: string }).email ?? null,
      balance: 0,
      free_generations: user.package_generations_remaining,
      total_generations: user.total_generations,
      has_package: user.package_code !== null,
      package_code: user.package_code,
      package_title: user.package_title,
      package_generations_total: user.package_generations_total,
      package_generations_remaining: user.package_generations_remaining,
    });
  });
}
