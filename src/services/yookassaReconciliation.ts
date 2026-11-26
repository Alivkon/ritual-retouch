import type { Bot } from "grammy";
import { ADMIN_ID, YOOKASSA_SECRET_KEY, YOOKASSA_SHOP_ID } from "../config.js";
import {
  claimMissingYookassaPaymentAlert,
  hasYookassaPayment,
  markMissingYookassaPaymentAlertNotified,
  resolveMissingYookassaPaymentAlert,
} from "../database.js";
import { escapeTelegramHtml } from "../utils/telegramHtml.js";

const RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PAGES_PER_RUN = 20;
const PAGE_SIZE = 100;

interface YooKassaPayment {
  id?: string;
  status?: string;
  amount?: { value?: string };
  metadata?: { user_id?: string };
}

interface YooKassaPaymentPage {
  items?: YooKassaPayment[];
  next_cursor?: string;
}

function yookassaAuthHeader(): string {
  return `Basic ${Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString("base64")}`;
}

async function fetchPaymentPage(createdAtGte: string, cursor?: string): Promise<YooKassaPaymentPage> {
  const url = new URL("https://api.yookassa.ru/v3/payments");
  url.searchParams.set("created_at.gte", createdAtGte);
  url.searchParams.set("limit", String(PAGE_SIZE));
  if (cursor) url.searchParams.set("cursor", cursor);

  const response = await fetch(url, {
    headers: { Authorization: yookassaAuthHeader() },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`YooKassa payment list failed: HTTP ${response.status}`);
  return (await response.json()) as YooKassaPaymentPage;
}

async function alertMissingPayment(bot: Bot, payment: YooKassaPayment): Promise<void> {
  const paymentId = payment.id;
  if (!paymentId) return;

  if (await hasYookassaPayment(paymentId)) {
    await resolveMissingYookassaPaymentAlert(paymentId);
    return;
  }

  if (!(await claimMissingYookassaPaymentAlert(paymentId))) return;

  const amount = Number(payment.amount?.value);
  const userId = payment.metadata?.user_id ?? "не указан";
  const text =
    `🚨 YooKassa: успешный платёж не найден в базе\n` +
    `👤 Аккаунт: ${escapeTelegramHtml(userId)}\n` +
    `💳 Сумма: ${Number.isFinite(amount) ? `${amount.toFixed(2)}₽` : "не определена"}\n` +
    `🧾 Платёж: ${escapeTelegramHtml(paymentId)}\n` +
    "Автоматическое зачисление не выполнялось. Проверьте платёж и баланс.";

  try {
    await bot.api.sendMessage(ADMIN_ID, text);
    await markMissingYookassaPaymentAlertNotified(paymentId);
  } catch (err) {
    console.error("Failed to send or record YooKassa reconciliation alert:", err);
  }
}

export async function reconcileYookassaPayments(bot: Bot): Promise<void> {
  const createdAtGte = new Date(Date.now() - LOOKBACK_MS).toISOString();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_RUN; pageNumber += 1) {
    const page = await fetchPaymentPage(createdAtGte, cursor);
    for (const payment of page.items ?? []) {
      if (payment.status === "succeeded") await alertMissingPayment(bot, payment);
    }

    if (!page.next_cursor) return;
    cursor = page.next_cursor;
  }

  console.warn(`YooKassa reconciliation stopped after ${MAX_PAGES_PER_RUN} pages; more pages may remain`);
}

export function startYookassaPaymentReconciliation(bot: Bot): void {
  let running = false;

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await reconcileYookassaPayments(bot);
    } catch (err) {
      console.error("YooKassa payment reconciliation failed:", err);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), RECONCILIATION_INTERVAL_MS);
  timer.unref();
}
