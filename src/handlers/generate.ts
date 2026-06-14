import { Composer, InputFile } from "grammy";
import {
  getUser,
  getOrCreateUser,
  deductFreeGeneration,
  incrementTotalGenerations,
  createGeneration,
  completeGeneration,
  failGeneration,
  setFreeGenerations,
} from "../database.js";
import { generateImage, KieError } from "../services/kieai.js";
import { mainMenuKb, paywallKb } from "../keyboards/inline.js";
import { BOT_TOKEN, ADMIN_ID } from "../config.js";

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
    const isFree = isAdmin ? 1 : 0;
    const cost = 0;

    if (!isAdmin && dbUser.package_generations_remaining <= 0) {
      await ctx.reply(
        `⚠️ Нет доступных обработок.

` +
        "Купите пакет, чтобы продолжить.",
        { reply_markup: paywallKb(), parse_mode: "HTML" },
      );
      return;
    }

    const processingMsg = await ctx.reply("⏳ Обрабатываю фотографию, подождите...");

    const generationId = await createGeneration(user.id, prompt, photoFileId, cost, isFree);

    if (!isAdmin) {
      await deductFreeGeneration(user.id);
    }

    let resultBytes: Buffer;
    try {
      const file = await ctx.api.getFile(photoFileId);
      const imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

      resultBytes = await generateImage(imageUrl, prompt);
    } catch (err) {
      await failGeneration(generationId);
      if (!isAdmin) await setFreeGenerations(user.id, dbUser.package_generations_remaining);
      await ctx.api.deleteMessage(ctx.chat!.id, processingMsg.message_id).catch(() => undefined);

      const errMsg = err instanceof KieError ? String(err.message) : String(err);
      await ctx.reply(
        `❌ Ошибка при генерации: ${errMsg}\n\nСписанная обработка возвращена в пакет.`,
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
      await incrementTotalGenerations(user.id);

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
    `📦 Пакет: <b>${dbUser.package_title ?? "не выбран"}</b>\n` +
    `🎨 Всего обработок: <b>${dbUser.total_generations}</b>\n` +
    `✅ Доступно обработок: <b>${dbUser.package_generations_remaining}</b>`,
    { reply_markup: mainMenuKb(), parse_mode: "HTML" },
  );
});

generateRouter.callbackQuery("back_to_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Главное меню:", { reply_markup: mainMenuKb() });
});
