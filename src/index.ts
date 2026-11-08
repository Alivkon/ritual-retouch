import { Bot } from "grammy";
import { ADMIN_ID, BOT_TOKEN } from "./config.js";
import { initDb } from "./database.js";
import { adminNotifyMiddleware } from "./middlewares/adminNotify.js";
import { paymentRouter } from "./handlers/payment.js";
import { startRouter } from "./handlers/start.js";
import { generateRouter } from "./handlers/generate.js";
import { startWebServer } from "./webServer.js";
import { escapeTelegramHtml } from "./utils/telegramHtml.js";

let activeBot: Bot | null = null;

// Уведомление администратора о служебных событиях бота (остановка, ошибки).
async function notifyAdmin(text: string): Promise<void> {
  if (!activeBot) return;
  try {
    await activeBot.api.sendMessage(ADMIN_ID, escapeTelegramHtml(text));
  } catch (err) {
    console.warn("Failed to notify admin about bot status:", err);
  }
}

// Запуск polling'а с уведомлениями админу об ошибках.
async function runPolling(bot: Bot): Promise<void> {
  let conflictNotifiedAt = 0;
  for (;;) {
    try {
      await bot.start();
      return; // Штатная остановка через bot.stop()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("409: Conflict")) {
        console.warn("Telegram polling conflict (another bot instance active), retrying in 30s");
        // О конфликте сообщаем не чаще раза в час, чтобы не заспамить админа.
        const now = Date.now();
        if (now - conflictNotifiedAt > 3_600_000) {
          conflictNotifiedAt = now;
          await notifyAdmin(
            "⚠️ Ошибка polling (409 Conflict): похоже, запущен другой инстанс бота с этим токеном. Повторные попытки каждые 30 секунд.",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        continue;
      }
      console.error("Telegram polling stopped:", err);
      await notifyAdmin(`🚨 Бот остановил приём сообщений из-за ошибки polling: ${message}`);
      return;
    }
  }
}

// Обработка остановки и критических сбоев процесса с уведомлением админа.
function registerLifecycleHandlers(bot: Bot): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async (): Promise<void> => {
      await notifyAdmin(`🛑 Бот останавливается (сигнал ${signal})`);
      try {
        await bot.stop();
      } catch {
        // Бот мог быть ещё не запущен — игнорируем.
      }
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    void (async (): Promise<void> => {
      await notifyAdmin(`🚨 Критическая ошибка (uncaughtException): ${err.message}`);
      process.exit(1);
    })();
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
    const message = reason instanceof Error ? reason.message : String(reason);
    void notifyAdmin(`🚨 Необработанное отклонение промиса (unhandledRejection): ${message}`);
  });
}

async function main(): Promise<void> {
  await initDb();

  const bot = new Bot(BOT_TOKEN, {
    client: { buildUrl: (root, token, method) => `${root}/bot${token}/${method}` },
  });

  // Parse mode HTML by default via transformers
  bot.api.config.use((prev, method, payload, signal) => {
    if (payload && typeof payload === "object" && !("parse_mode" in payload)) {
      (payload as Record<string, unknown>)["parse_mode"] = "HTML";
    }
    return prev(method, payload, signal);
  });

  bot.use(adminNotifyMiddleware);
  bot.use(paymentRouter);
  bot.use(startRouter);
  bot.use(generateRouter);

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  activeBot = bot;
  registerLifecycleHandlers(bot);

  console.log("Starting bot...");

  await startWebServer(bot);
  // При 409 Conflict (параллельный инстанс с тем же токеном) не останавливаем
  // polling навсегда, а повторяем попытку с задержкой.
  void runPolling(bot);
}

main().catch(async (err) => {
  console.error(err);
  const message = err instanceof Error ? err.message : String(err);
  await notifyAdmin(`🚨 Критическая ошибка запуска бота: ${message}`);
  process.exit(1);
});
