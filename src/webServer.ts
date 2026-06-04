import crypto from "node:crypto";
import path from "node:path";
import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import type { Bot } from "grammy";
import { registerAuthRoutes } from "./web/auth.js";
import { registerUploadRoute } from "./web/uploadRoute.js";
import { registerGenerateRoute } from "./web/generateRoute.js";
import { registerWebPaymentRoutes } from "./web/paymentRoute.js";
import IPCIDR from "ip-cidr";
import {
  ADMIN_ID,
  BOT_TOKEN,
  TOPUP_OPTIONS,
  WEB_SERVER_PORT,
  YOOKASSA_SECRET_KEY,
  YOOKASSA_SHOP_ID,
} from "./config.js";
import {
  creditManualBalance,
  creditYookassaPayment,
  getAdminGenerations,
  getAdminPayments,
  getAdminStats,
  getAdminUsers,
  getUser,
  setFreeGenerations,
} from "./database.js";

const STATIC_DIR = path.resolve(__dirname, "../static");

// YooKassa IP whitelist
const YOOKASSA_CIDR_RANGES = [
  new IPCIDR("185.71.76.0/27"),
  new IPCIDR("185.71.77.0/27"),
  new IPCIDR("77.75.153.0/25"),
  new IPCIDR("77.75.154.128/25"),
  new IPCIDR("2a02:5180::/32"),
];
const YOOKASSA_SINGLE_IPS = new Set(["77.75.156.11", "77.75.156.35"]);

function isYookassaIp(ipStr: string): boolean {
  if (ipStr.startsWith("::ffff:")) ipStr = ipStr.slice(7);
  if (YOOKASSA_SINGLE_IPS.has(ipStr)) return true;
  return YOOKASSA_CIDR_RANGES.some((cidr) => cidr.contains(ipStr));
}

function validateInitData(initData: string): Record<string, string> | null {
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

function requireAdmin(authHeader: string | undefined): boolean {
  if (!authHeader?.startsWith("tma ")) return false;
  const parsed = validateInitData(authHeader.slice(4));
  if (!parsed) return false;
  try {
    const user = JSON.parse(parsed["user"] ?? "{}") as { id?: number };
    return Number(user.id) === ADMIN_ID;
  } catch {
    return false;
  }
}

function rowsToJson(rows: Record<string, unknown>[]): unknown[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k,
        v instanceof Date ? v.toISOString() : v,
      ]),
    ),
  );
}

// YooKassa HTTP client (no SDK)
function yookassaAuthHeader(): string {
  return `Basic ${Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString("base64")}`;
}

async function yookassaCreatePayment(userId: number, amount: number): Promise<{ id?: string; confirmation_token?: string }> {
  const resp = await fetch("https://api.yookassa.ru/v3/payments", {
    method: "POST",
    headers: {
      Authorization: yookassaAuthHeader(),
      "Content-Type": "application/json",
      "Idempotence-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      amount: { value: amount.toFixed(2), currency: "RUB" },
      confirmation: { type: "embedded" },
      capture: true,
      description: `Пополнение баланса на ${amount}₽`,
      metadata: { user_id: String(userId) },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return (await resp.json()) as { id?: string; confirmation_token?: string };
}

async function yookassaFindPayment(paymentId: string): Promise<{
  status?: string;
  amount?: { value: string };
  metadata?: { user_id?: string };
}> {
  const resp = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
    headers: { Authorization: yookassaAuthHeader() },
    signal: AbortSignal.timeout(15_000),
  });
  return (await resp.json()) as {
    status?: string;
    amount?: { value: string };
    metadata?: { user_id?: string };
  };
}

const UPLOADS_DIR = path.resolve(__dirname, "../uploads");
const FRONTEND_DIST_DIR = path.resolve(__dirname, "../frontend-dist");

export async function startWebServer(bot: Bot): Promise<void> {
  const fastify = Fastify({ logger: true });

  await fastify.register(formbody);
  await fastify.register(multipart);

  // Telegram WebApp static files (admin panel, payment pages)
  await fastify.register(staticPlugin, { root: STATIC_DIR, prefix: "/", wildcard: false });

  // User uploads (photos + generated results)
  await fastify.register(staticPlugin, {
    root: UPLOADS_DIR,
    prefix: "/uploads/",
    decorateReply: false,
  });

  // Register web API routes
  registerAuthRoutes(fastify);
  registerUploadRoute(fastify);
  registerGenerateRoute(fastify, bot);
  registerWebPaymentRoutes(fastify);

  // Frontend SPA (served only if frontend-dist exists)
  const fs = await import("node:fs");
  if (fs.existsSync(FRONTEND_DIST_DIR)) {
    await fastify.register(staticPlugin, {
      root: FRONTEND_DIST_DIR,
      prefix: "/",
      decorateReply: false,
    });
    fastify.setNotFoundHandler((_req, reply) => {
      return reply.sendFile("index.html", FRONTEND_DIST_DIR);
    });
  }

  // Static pages
  fastify.get("/oferta", (_req, reply) => {
    reply.header("ngrok-skip-browser-warning", "true");
    return reply.sendFile("oferta.html");
  });

  fastify.get("/privacy", (_req, reply) => {
    reply.header("ngrok-skip-browser-warning", "true");
    return reply.sendFile("privacy.html");
  });

  fastify.get("/pay_yookassa", (_req, reply) => {
    reply.header("ngrok-skip-browser-warning", "true");
    return reply.sendFile("pay_yookassa.html");
  });

  fastify.get("/admin", (_req, reply) => {
    return reply.sendFile("admin.html");
  });

  // Admin API
  fastify.get("/api/admin/stats", async (req, reply) => {
    if (!requireAdmin(req.headers["authorization"])) return reply.code(403).send();
    const stats = await getAdminStats();
    return reply.send(stats);
  });

  fastify.get<{ Querystring: { page?: string } }>("/api/admin/generations", async (req, reply) => {
    if (!requireAdmin(req.headers["authorization"])) return reply.code(403).send();
    const page = Math.max(0, parseInt(req.query.page ?? "0", 10));
    const rows = await getAdminGenerations(50, page * 50);
    return reply.send(rowsToJson(rows));
  });

  fastify.get<{ Querystring: { page?: string } }>("/api/admin/users", async (req, reply) => {
    if (!requireAdmin(req.headers["authorization"])) return reply.code(403).send();
    const page = Math.max(0, parseInt(req.query.page ?? "0", 10));
    const rows = await getAdminUsers(200, page * 200);
    return reply.send(rowsToJson(rows));
  });

  fastify.get<{ Querystring: { page?: string } }>("/api/admin/payments", async (req, reply) => {
    if (!requireAdmin(req.headers["authorization"])) return reply.code(403).send();
    const page = Math.max(0, parseInt(req.query.page ?? "0", 10));
    const rows = await getAdminPayments(50, page * 50);
    return reply.send(rowsToJson(rows));
  });

  fastify.post("/api/admin/set-free", async (req, reply) => {
    if (!requireAdmin(req.headers["authorization"])) return reply.code(403).send();
    const body = req.body as { user_id?: unknown; count?: unknown };
    const userId = parseInt(String(body.user_id ?? ""), 10);
    const count = parseInt(String(body.count ?? "3"), 10);
    if (isNaN(userId) || isNaN(count)) return reply.code(400).send({ error: "Invalid params" });
    await setFreeGenerations(userId, count);
    return reply.send({ ok: true });
  });

  fastify.post("/api/admin/credit-balance", async (req, reply) => {
    if (!requireAdmin(req.headers["authorization"])) return reply.code(403).send();
    const body = req.body as { user_id?: unknown; amount?: unknown; note?: unknown };
    const userId = parseInt(String(body.user_id ?? ""), 10);
    const amount = parseFloat(String(body.amount ?? ""));
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";

    if (!Number.isFinite(userId) || !Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send({ error: "Invalid user_id or amount" });
    }

    const result = await creditManualBalance({
      userId,
      amount,
      ...(note ? { note } : {}),
    });
    if (!result) return reply.code(404).send({ error: "User not found" });

    await bot.api
      .sendMessage(
        userId,
        `✅ Баланс пополнен администратором.\n\n` +
        `Зачислено: <b>${amount.toFixed(0)}₽</b>\n` +
        `Ваш баланс: <b>${result.balance.toFixed(0)}₽</b>`,
        { parse_mode: "HTML" },
      )
      .catch(() => undefined);

    return reply.send({ ok: true, balance: result.balance, payment_id: result.paymentId });
  });

  // YooKassa — create embedded payment
  fastify.post("/api/payment/create", async (req, reply) => {
    const body = req.body as { user_id?: unknown; amount?: unknown };
    const userId = parseInt(String(body.user_id ?? ""), 10);
    const amount = parseInt(String(body.amount ?? ""), 10);

    if (isNaN(userId) || isNaN(amount)) {
      return reply.code(400).send({ error: "user_id and amount are required" });
    }
    if (!(TOPUP_OPTIONS as readonly number[]).includes(amount)) {
      return reply.code(400).send({ error: `Invalid amount. Allowed: ${TOPUP_OPTIONS.join(", ")}` });
    }

    const user = await getUser(userId);
    if (!user) return reply.code(404).send({ error: "User not found" });

    try {
      const payment = await yookassaCreatePayment(userId, amount);
      const token = (payment as Record<string, unknown>)["confirmation"]
        ? ((payment as Record<string, unknown>)["confirmation"] as Record<string, unknown>)["confirmation_token"]
        : payment.confirmation_token;
      return reply.send({ confirmation_token: token, payment_id: payment.id });
    } catch (err) {
      fastify.log.error("YooKassa create payment error: %s", err);
      return reply.code(500).send({ error: "Payment creation failed" });
    }
  });

  fastify.post("/api/payment/yookassa/confirm", async (req, reply) => {
    const body = req.body as { user_id?: unknown; payment_id?: unknown };
    const userId = parseInt(String(body.user_id ?? ""), 10);
    const paymentId = typeof body.payment_id === "string" ? body.payment_id : "";

    if (!Number.isFinite(userId) || !paymentId) {
      return reply.code(400).send({ error: "user_id and payment_id are required" });
    }

    let payment: Awaited<ReturnType<typeof yookassaFindPayment>>;
    try {
      payment = await yookassaFindPayment(paymentId);
    } catch (err) {
      fastify.log.error("YooKassa confirm lookup error: %s", err);
      return reply.code(502).send({ error: "Payment lookup failed" });
    }

    if (payment.status !== "succeeded") {
      const user = await getUser(userId);
      return reply.send({ credited: false, status: payment.status, balance: user?.balance ?? 0 });
    }

    const metadataUserId = parseInt(payment.metadata?.user_id ?? "0", 10);
    if (metadataUserId !== userId) {
      fastify.log.warn("YooKassa confirm metadata mismatch: payment=%s user=%s metadata=%s", paymentId, userId, metadataUserId);
      return reply.code(403).send({ error: "Payment belongs to another user" });
    }

    const amount = parseFloat(payment.amount?.value ?? "0");
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send({ error: "Invalid payment amount" });
    }

    const result = await creditYookassaPayment({ userId, amount, yookassaPaymentId: paymentId });
    return reply.send({ credited: result.credited, status: payment.status, balance: result.balance });
  });

  // YooKassa webhook
  fastify.post("/yookassa/webhook", async (req, reply) => {
    const forwarded = req.headers["x-forwarded-for"];
    const clientIp = (typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : req.ip) ?? req.ip;

    if (!isYookassaIp(clientIp)) {
      fastify.log.warn("Webhook from unknown IP: %s", clientIp);
      return reply.code(403).send();
    }

    const data = req.body as Record<string, unknown>;
    if (data["type"] !== "notification" || data["event"] !== "payment.succeeded") {
      return reply.code(200).send();
    }

    const paymentId = (data["object"] as Record<string, unknown> | undefined)?.["id"];
    if (typeof paymentId !== "string") return reply.code(400).send();

    let payment: Awaited<ReturnType<typeof yookassaFindPayment>>;
    try {
      payment = await yookassaFindPayment(paymentId);
    } catch (err) {
      fastify.log.error("YooKassa find_one error: %s", err);
      return reply.code(500).send();
    }

    if (payment.status !== "succeeded") return reply.code(200).send();

    const userId = parseInt(payment.metadata?.user_id ?? "0", 10);
    const amount = parseFloat(payment.amount?.value ?? "0");

    if (!userId) {
      fastify.log.error("No user_id in payment metadata: %s", paymentId);
      return reply.code(200).send();
    }

    const result = await creditYookassaPayment({ userId, amount, yookassaPaymentId: paymentId });
    if (!result.credited) return reply.code(200).send();

    await bot.api
      .sendMessage(
        userId,
        `✅ Оплата прошла успешно!\n\n` +
        `Зачислено: <b>${amount.toFixed(0)}₽</b>\n` +
        `Ваш баланс: <b>${result.balance.toFixed(0)}₽</b>`,
        { parse_mode: "HTML" },
      )
      .catch(() => undefined);

    return reply.code(200).send();
  });

  await fastify.listen({ port: WEB_SERVER_PORT, host: "0.0.0.0" });
}
