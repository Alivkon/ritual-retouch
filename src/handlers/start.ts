import { Composer } from "grammy";
import { getOrCreateUser, linkTelegramAccount } from "../database.js";
import { mainMenuKb } from "../keyboards/inline.js";
import { WEBAPP_URL } from "../config.js";

export const startRouter = new Composer();

startRouter.command("start", async (ctx) => {
  const user = ctx.from!;
  const payload = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (payload.startsWith("link_")) {
    const linked = await linkTelegramAccount({
      token: payload.slice(5),
      telegramUserId: user.id,
      username: user.username ?? null,
      firstName: user.first_name ?? null,
    });
    if (!linked) {
      await ctx.reply("Ссылка для привязки аккаунта недействительна или устарела.");
      return;
    }
    await ctx.reply(
      "Telegram привязан к вашему аккаунту Ritual Retouch. Теперь в боте и на сайте используется один счёт обработок.",
      { reply_markup: mainMenuKb(user.id) },
    );
    return;
  }

  const dbUser = await getOrCreateUser(user.id, user.username, user.first_name ?? "");

  const free = dbUser.free_generations;
  let freeText = "";
  if (free > 0) {
    const word = free === 1 ? "бесплатная генерация" : free <= 4 ? "бесплатных генерации" : "бесплатных генераций";
    freeText = `У вас есть <b>${free} ${word}</b>!\n`;
  }

  await ctx.reply(
    `Здравствуйте, ${user.first_name}! 👋\n\n` +
    "Это <b>Memorial Retouch AI</b> — профессиональная ретушь и восстановление фотографий " +
    "для памятников, гравировки и фотокерамики.\n\n" +
    "Бережно обрабатываем мемориальные портреты, сохраняем черты лица.\n\n" +
    `${freeText}` +
    `📦 Доступно обработок: <b>${dbUser.package_generations_remaining}</b>\n\n` +
    "Нажмите <b>«Обработать фото»</b>, чтобы загрузить фотографию.\n\n" +
    `📄 <a href="${WEBAPP_URL}/oferta">Публичная оферта</a>`,
    { reply_markup: mainMenuKb(user.id), parse_mode: "HTML" },
  );
});
