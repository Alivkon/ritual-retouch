import { Composer } from "grammy";
import { getUser, addBalance, savePayment } from "../database.js";
import { topupAmountsKb, mainMenuKb } from "../keyboards/inline.js";
import { YOOKASSA_TOKEN, ADMIN_ID, MIN_TOPUP, TOPUP_OPTIONS } from "../config.js";

export const paymentRouter = new Composer();

paymentRouter.command("topup", async (ctx) => {
  await ctx.reply("💳 Выберите сумму пополнения:", { reply_markup: topupAmountsKb() });
});

paymentRouter.callbackQuery("topup", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("💳 Выберите сумму пополнения:", { reply_markup: topupAmountsKb() });
});

paymentRouter.callbackQuery(/^topup_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();

  const amountStr = ctx.match[1];
  const amount = parseInt(amountStr ?? "", 10);

  if (isNaN(amount)) {
    await ctx.reply("Некорректная сумма.");
    return;
  }
  if (amount < MIN_TOPUP) {
    await ctx.reply(`Минимальная сумма пополнения: ${MIN_TOPUP}₽`);
    return;
  }

  const amountKopecks = amount * 100;

  // Чек для ЮKassa (54-ФЗ)
  const providerData = JSON.stringify({
    receipt: {
      items: [
        {
          description: `Пополнение баланса на ${amount}₽`,
          quantity: "1.00",
          amount: { value: `${amount}.00`, currency: "RUB" },
          vat_code: 2,
          payment_mode: "full_payment",
          payment_subject: "service",
        },
      ],
    },
  });

  await ctx.api.sendInvoice(
    ctx.from.id,
    "Пополнение баланса",
    `Пополнение баланса на ${amount}₽ для генерации изображений.\n\n` +
    "Сейчас откроется приложение для оплаты. " +
    "Бот не имеет доступа к нему и не может управлять или сохранять ваши персональные данные.",
    `topup_${amount}_${ctx.from.id}`,
    "RUB",
    [{ label: `Пополнение ${amount}₽`, amount: amountKopecks }],
    {
      provider_token: YOOKASSA_TOKEN,
      start_parameter: "topup",
      need_email: true,
      send_email_to_provider: true,
      provider_data: providerData,
    },
  );
});

paymentRouter.on("pre_checkout_query", async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

paymentRouter.on("message:successful_payment", async (ctx) => {
  const payment = ctx.message.successful_payment;
  const amountRub = payment.total_amount / 100;
  const userId = ctx.from.id;

  await addBalance(userId, amountRub);
  await savePayment({
    userId,
    amount: amountRub,
    telegramChargeId: payment.telegram_payment_charge_id,
    ...(payment.provider_payment_charge_id ? { providerChargeId: payment.provider_payment_charge_id } : {}),
    ...(ctx.from.username ? { username: ctx.from.username } : {}),
  });

  const dbUser = await getUser(userId);
  const newBalance = dbUser?.balance ?? amountRub;

  await ctx.reply(
    `✅ Оплата прошла успешно!\n\n` +
    `Зачислено: <b>${amountRub.toFixed(0)}₽</b>\n` +
    `Ваш баланс: <b>${newBalance.toFixed(0)}₽</b>`,
    { reply_markup: mainMenuKb(), parse_mode: "HTML" },
  );

  const usernameStr = ctx.from.username ?? String(userId);
  await ctx.api.sendMessage(
    ADMIN_ID,
    `💳 ОПЛАТА\n` +
    `👤 @${usernameStr} (${userId})\n` +
    `💰 Сумма: ${amountRub.toFixed(0)}₽\n` +
    `🆔 Telegram charge: ${payment.telegram_payment_charge_id}\n` +
    `🆔 Provider charge: ${payment.provider_payment_charge_id ?? "—"}`,
  );
});

// Validate topup amounts from callback
export function isValidTopupAmount(amount: number): boolean {
  return (TOPUP_OPTIONS as readonly number[]).includes(amount);
}
