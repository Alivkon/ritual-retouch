import { Bot } from "grammy";
import { BOT_TOKEN } from "./config.js";
import { initDb } from "./database.js";
import { adminNotifyMiddleware } from "./middlewares/adminNotify.js";
import { paymentRouter } from "./handlers/payment.js";
import { startRouter } from "./handlers/start.js";
import { generateRouter } from "./handlers/generate.js";
import { startWebServer } from "./webServer.js";

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

  console.log("Starting bot...");

  await startWebServer(bot);
  await bot.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
