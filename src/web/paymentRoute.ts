import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getUser,
  creditYookassaPayment,
} from "../database.js";
import {
  PACKAGE_DEFINITIONS,
  TOPUP_OPTIONS,
  YOOKASSA_SHOP_ID,
  YOOKASSA_SECRET_KEY,
} from "../config.js";
import { requireAuth } from "./auth.js";

// YooKassa HTTP helpers (reused from webServer.ts logic)
function yookassaAuthHeader(): string {
  return `Basic ${Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString("base64")}`;
}

async function yookassaCreatePayment(
  userId: number,
  amount: number,
  packageCode: string,
): Promise<Record<string, unknown>> {
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
      description: `Пакет обработок ${packageCode} на ${amount}₽`,
      metadata: { user_id: String(userId), package_code: packageCode },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return (await resp.json()) as Record<string, unknown>;
}

async function yookassaFindPayment(paymentId: string): Promise<{
  status?: string;
  amount?: { value?: string };
  metadata?: { user_id?: string };
}> {
  const resp = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
    headers: { Authorization: yookassaAuthHeader() },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`YooKassa payment lookup failed: ${resp.status}`);
  return (await resp.json()) as {
    status?: string;
    amount?: { value?: string };
    metadata?: { user_id?: string };
  };
}

export function registerWebPaymentRoutes(fastify: FastifyInstance): void {

  // YooKassa — create embedded payment widget token
  fastify.post("/api/web/payment/yookassa", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const body = req.body as { amount?: unknown };
    const amount = parseInt(String(body.amount ?? ""), 10);

    if (!(TOPUP_OPTIONS as readonly number[]).includes(amount)) {
      return reply.code(400).send({ error: `Invalid amount. Allowed: ${TOPUP_OPTIONS.join(", ")}` });
    }

    const selectedPackage = PACKAGE_DEFINITIONS.find((pkg) => pkg.amount === amount);
    if (!selectedPackage) {
      return reply.code(400).send({ error: "Package not found" });
    }

    try {
      const payment = await yookassaCreatePayment(user.user_id, amount, selectedPackage.code);
      const confirmation = payment["confirmation"] as Record<string, unknown> | undefined;
      const token = confirmation?.["confirmation_token"];
      return reply.send({ confirmation_token: token, payment_id: payment["id"] });
    } catch (err) {
      fastify.log.error("YooKassa web payment error: %s", err);
      return reply.code(500).send({ error: "Payment creation failed" });
    }
  });

  // YooKassa — fallback confirmation for the web widget.
  // The webhook remains the primary path, but this reconciles successful
  // payments when the webhook is delayed or rejected by proxy/IP settings.
  fastify.post("/api/web/payment/yookassa/confirm", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const body = req.body as { payment_id?: unknown };
    const paymentId = typeof body.payment_id === "string" ? body.payment_id : "";
    if (!paymentId) return reply.code(400).send({ error: "payment_id is required" });

    let payment: Awaited<ReturnType<typeof yookassaFindPayment>>;
    try {
      payment = await yookassaFindPayment(paymentId);
    } catch (err) {
      fastify.log.error("YooKassa web confirm lookup error: %s", err);
      return reply.code(502).send({ error: "Payment lookup failed" });
    }

    if (payment.status !== "succeeded") {
      const dbUser = await getUser(user.user_id);
      return reply.send({
        credited: false,
        status: payment.status,
        balance: 0,
        package_generations_remaining: dbUser?.package_generations_remaining ?? 0,
        package_title: dbUser?.package_title ?? null,
      });
    }

    const metadataUserId = parseInt(payment.metadata?.user_id ?? "0", 10);
    if (metadataUserId !== user.user_id) {
      fastify.log.warn("YooKassa web confirm metadata mismatch: payment=%s user=%s metadata=%s", paymentId, user.user_id, metadataUserId);
      return reply.code(403).send({ error: "Payment belongs to another user" });
    }

    const amount = parseFloat(payment.amount?.value ?? "0");
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send({ error: "Invalid payment amount" });
    }

    const result = await creditYookassaPayment({ userId: user.user_id, amount, yookassaPaymentId: paymentId });
    return reply.send({
      credited: result.credited,
      status: payment.status,
      balance: 0,
      package_generations_remaining: result.generationsRemaining,
      package_title: result.packageTitle,
    });
  });

}
