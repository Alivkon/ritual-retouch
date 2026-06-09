import { Composer, InputFile } from "grammy";
import {
  getUser,
  getOrCreateUser,
  deductBalance,
  deductFreeGeneration,
  incrementTotalGenerations,
  createGeneration,
  completeGeneration,
  failGeneration,
  addBalance,
} from "../database.js";
import { generateImage, KieError } from "../services/kieai.js";
import { mainMenuKb, paywallKb } from "../keyboards/inline.js";
import { BOT_TOKEN, GENERATION_COST, ADMIN_ID, DISCOUNTED_COST, DISCOUNTED_USER_IDS } from "../config.js";

export const generateRouter = new Composer();

const HOW_TO_TEXT =
  "📷 <b>Как подготовить фотографию</b>\n\n" +
  "Сервис принимает:\n" +
  "• Старые бумажные фотографии (сканы)\n" +
  "• Выцветшие или повреждённые снимки\n" +
  "• Фото любого качества и возраста\n\n" +
  "<b>Что сервис делает:</b>\n" +
  "• Восстанавливает чёткость и детали портрета\n" +
  "• Удаляет царапины, пятна, шум и дефекты\n" +
  "• Готовит фото для гравировки или фотокерамики\n" +
  "• Стремится сохранить портретное сходство и основные черты лица\n\n" +
  "<b>Как отправить фото:</b>\n" +
  "Прикрепите фото и в подписи укажите желаемую обработку:\n" +
  "— «Восстановить фото, очистить фон»\n" +
  "— «Подготовить под гравировку, черно-белый»\n" +
  "— «Улучшить качество, деловой портрет»\n\n" +
  "<i>💡 Для более сложных задач используйте веб-интерфейс</i>";

generateRouter.callbackQuery("how_to", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(HOW_TO_TEXT, { parse_mode: "HTML", reply_markup: mainMenuKb() });
});

generateRouter.callbackQuery("generate", async (ctx) => {
  await ctx.answerCallbackQuery();
  await getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name ?? "");
  await ctx.reply(
    "📷 Отправьте фото с подписью.\n\n" +
    "Опишите необходимую обработку:\n" +
    "«Восстановить», «подготовить под гравировку», «очистить фон», «черно-белый».\n\n" +
    "<b>Пример:</b> «Восстановить старое фото, убрать царапины, серый фон»",
    { parse_mode: "HTML" },
  );
});

// Photo with caption — main generation handler
generateRouter.on("message:photo").filter(
  (ctx) => ctx.message.caption !== undefined,
  async (ctx) => {
    const user = ctx.from;
    const dbUser = await getOrCreateUser(user.id, user.username, user.first_name ?? "");

    const photos = ctx.message.photo;
    const photoFileId = photos[photos.length - 1]!.file_id;
    const prompt = ctx.message.caption!;

    const isAdmin = user.id === ADMIN_ID;
    const isDiscounted = DISCOUNTED_USER_IDS.has(user.id);
    const effectiveCost = isDiscounted ? DISCOUNTED_COST : GENERATION_COST;

    let isFree = 0;
    let cost = effectiveCost;

    if (isAdmin) {
      isFree = 1;
      cost = 0;
    } else if (dbUser.free_generations > 0) {
      isFree = 1;
      cost = 0;
    } else if (dbUser.balance < effectiveCost) {
      await ctx.reply(
        `⚠️ Недостаточно средств.\n\n` +
        `Стоимость генерации: <b>${effectiveCost}₽</b>\n` +
        `Ваш баланс: <b>${dbUser.balance.toFixed(0)}₽</b>\n\n` +
        "Пополните баланс, чтобы продолжить.",
        { reply_markup: paywallKb(), parse_mode: "HTML" },
      );
      return;
    }

    const processingMsg = await ctx.reply("⏳ Обрабатываю фотографию, подождите...");

    const generationId = await createGeneration(user.id, prompt, photoFileId, cost, isFree);

    if (isFree && !isAdmin) {
      await deductFreeGeneration(user.id);
    } else if (!isFree) {
      await deductBalance(user.id, cost);
    }
    await incrementTotalGenerations(user.id);

    let resultBytes: Buffer;
    try {
      const file = await ctx.api.getFile(photoFileId);
      const imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

      resultBytes = await generateImage(imageUrl, prompt);
    } catch (err) {
      await failGeneration(generationId);
      if (!isFree) await addBalance(user.id, cost);
      await ctx.api.deleteMessage(ctx.chat!.id, processingMsg.message_id).catch(() => undefined);

      const errMsg = err instanceof KieError ? String(err.message) : String(err);
      await ctx.reply(
        `❌ Ошибка при генерации: ${errMsg}\n\nСредства возвращены на баланс.`,
        { reply_markup: mainMenuKb() },
      );
      return;
    }

    try {
      const inputFile = new InputFile(resultBytes, "result.jpg");
      const sent = await ctx.replyWithPhoto(inputFile, {
        caption: "✅ Готово! Отправьте новое фото с подписью, чтобы сделать ещё одну.",
        reply_markup: mainMenuKb(),
      });
      const resultFileId = sent.photo[sent.photo.length - 1]!.file_id;
      await completeGeneration(generationId, resultFileId);

      if (!isAdmin) {
        const usernameStr = user.username ? `@${user.username}` : `id:${user.id}`;
        await ctx.api
          .sendPhoto(ADMIN_ID, resultFileId, {
            caption: `🖼 Результат обработки\n👤 ${user.first_name ?? ""} ${usernameStr}\n📝 ${prompt}`,
          })
          .catch(() => undefined);
      }
    } catch (err) {
      await failGeneration(generationId);
      await ctx.reply(
        `❌ Изображение сгенерировано, но не удалось отправить: ${String(err)}`,
        { reply_markup: mainMenuKb() },
      );
      return;
    }

    await ctx.api.deleteMessage(ctx.chat!.id, processingMsg.message_id).catch(() => undefined);
  },
);

// Photo without caption
generateRouter.on("message:photo").filter(
  (ctx) => ctx.message.caption === undefined,
  async (ctx) => {
    await ctx.reply(
      "📝 Фото получено, но нет подписи.\n\n" +
      "Отправьте фото ещё раз <b>с подписью</b> — опишите желаемую обработку.\n\n" +
      "<b>Пример:</b> «Восстановить фото, подготовить под гравировку»",
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  },
);

generateRouter.callbackQuery("balance", async (ctx) => {
  await ctx.answerCallbackQuery();
  const dbUser = await getUser(ctx.from.id);
  if (!dbUser) {
    await ctx.reply("Нажмите /start для начала.");
    return;
  }
  await ctx.reply(
    `💰 Ваш баланс: <b>${dbUser.balance.toFixed(0)}₽</b>\n` +
    `🎨 Всего генераций: <b>${dbUser.total_generations}</b>\n` +
    `🎁 Бесплатных генераций: <b>${dbUser.free_generations}</b>`,
    { reply_markup: mainMenuKb(), parse_mode: "HTML" },
  );
});

generateRouter.callbackQuery("back_to_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Главное меню:", { reply_markup: mainMenuKb() });
});
