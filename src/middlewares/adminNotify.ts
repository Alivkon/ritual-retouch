import type { NextFunction, Context } from "grammy";
import { getUser } from "../database.js";
import { ADMIN_ID } from "../config.js";

function isGenerationRequest(ctx: Context): boolean {
  return (
    ctx.message?.photo !== undefined &&
    ctx.message.caption !== undefined &&
    (ctx.from?.id ?? 0) !== ADMIN_ID
  );
}

async function notify(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from || from.id === ADMIN_ID) return;

  const userData = await getUser(from.id);
  const name = from.first_name ?? "";
  const usernameStr = from.username ? `@${from.username}` : `id:${from.id}`;
  const balanceStr = userData ? `${userData.balance.toFixed(0)}₽` : "—";
  const gensStr = userData ? String(userData.total_generations) : "—";
  const freeStr = userData ? String(userData.free_generations) : "—";

  let action = "";

  if (ctx.message) {
    const msg = ctx.message;
    if (msg.photo) {
      action = "отправил фото для генерации";
    } else if (msg.text?.startsWith("/start")) {
      action = "запустил бота (/start)";
    } else if (msg.text?.startsWith("/topup")) {
      action = "запросил пополнение (/topup)";
    } else if (msg.successful_payment) {
      const p = msg.successful_payment;
      const amount = p.total_amount / 100;
      action = `оплатил ${amount.toFixed(0)}₽ (charge: ${p.telegram_payment_charge_id})`;
    } else if (msg.text) {
      const preview = msg.text.length > 60 ? msg.text.slice(0, 60) + "…" : msg.text;
      action = `написал: «${preview}»`;
    } else {
      action = "прислал сообщение";
    }
  } else if (ctx.callbackQuery) {
    const cbData = ctx.callbackQuery.data ?? "";
    if (cbData.startsWith("topup_")) {
      action = `выбрал пополнение на ${cbData.replace("topup_", "")}₽`;
    } else if (cbData === "topup") {
      action = "открыл меню пополнения";
    } else if (cbData === "balance") {
      action = "запросил баланс";
    } else if (cbData === "generate") {
      action = "нажал «Сгенерировать»";
    } else if (cbData === "back_to_menu") {
      action = "вернулся в меню";
    } else {
      action = `нажал кнопку: ${cbData}`;
    }
  } else {
    return;
  }

  const text =
    `👤 ${name} ${usernameStr} (${from.id})\n` +
    `📝 Действие: ${action}\n` +
    `💰 Баланс: ${balanceStr} | Генераций: ${gensStr} | Бесплатных: ${freeStr}`;

  await ctx.api.sendMessage(ADMIN_ID, text);

  // Копируем само сообщение в чат админа
  if (ctx.message && ctx.chat && (ctx.message.photo || ctx.message.text)) {
    await ctx.api.copyMessage(ADMIN_ID, ctx.chat.id, ctx.message.message_id);
  }
}

export async function adminNotifyMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  if (isGenerationRequest(ctx)) {
    await notify(ctx).catch(() => undefined);
    return next();
  }

  await next();
  await notify(ctx).catch(() => undefined);
}
