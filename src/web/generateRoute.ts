import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { InputFile, type Bot } from "grammy";
import {
  getUser,
  reserveGenerationCredit,
  refundGenerationCredit,
  incrementTotalGenerations,
  createGeneration,
  completeGeneration,
  failGeneration,
  getGenerationById,
  getUserGenerations,
  getUserPayments,
  findUploadForAccount,
  getTelegramIdForAccount,
} from "../database.js";
import { generateImage, uploadLocalFileToKie, KieError } from "../services/kieai.js";
import { ADMIN_ID } from "../config.js";
import { requireAuth } from "./auth.js";
import { assertMediaFileInsideUploads, createMediaUrl, mediaPath, normalizeMediaFilename } from "./mediaRoute.js";

function signedUrlFromStored(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const filename = normalizeMediaFilename(value);
  if (!filename) return null;
  return createMediaUrl(filename);
}


async function notifyAdminWebGeneration(
  bot: Bot,
  userId: number,
  email: string | null,
  prompt: string,
  sourcePath: string,
  resultPath: string,
  resultFilename: string,
  packageTitle: string | null,
  packageCode: string | null,
  packageRemaining: number,
): Promise<void> {
  const paidRemaining = packageCode === "free_start" ? 0 : packageRemaining;
  const caption =
    `🌐 Веб-обработка\n` +
    `👤 ${email ?? `web:${userId}`}\n` +
    `📧 Email: ${email ?? "—"}\n` +
    `📦 Пакет: ${packageTitle ?? "—"}\n` +
    `💳 Оплаченных осталось: ${paidRemaining}\n` +
    `🎨 Доступно в пакете: ${packageRemaining}\n` +
    `📝 ${prompt}`;

  const sourceCaption =
    `🌐 Веб-обработка\n` +
    `👤 ${email ?? `web:${userId}`}\n` +
    `📧 Email: ${email ?? "—"}\n` +
    `📦 Пакет: ${packageTitle ?? "—"}\n` +
    `💳 Оплаченных осталось: ${paidRemaining}\n` +
    `🎨 Доступно в пакете: ${packageRemaining}`;

  const sourceFilename = normalizeMediaFilename(sourcePath) ?? sourcePath.split("/").pop() ?? "";
  try {
    const sourceMessage = await bot.api.sendPhoto(ADMIN_ID, new InputFile(sourcePath, sourceFilename), {
      caption: `${sourceCaption}\n\n📥 Исходное изображение`,
    });
    console.log("Admin web source photo sent", {
      userId,
      email,
      sourcePath,
      sourceFilename,
      messageId: sourceMessage.message_id,
    });
  } catch (photoErr) {
    console.warn("Failed to send admin web source photo, falling back to document", {
      userId,
      email,
      sourcePath,
      sourceFilename,
      err: photoErr,
    });
    try {
      const sourceDocument = await bot.api.sendDocument(ADMIN_ID, new InputFile(sourcePath, sourceFilename), {
        caption: `${sourceCaption}\n\n📥 Исходное изображение`,
      });
      console.log("Admin web source document sent", {
        userId,
        email,
        sourcePath,
        sourceFilename,
        messageId: sourceDocument.message_id,
      });
    } catch (documentErr) {
      console.warn("Failed to send admin web source document", {
        userId,
        email,
        sourcePath,
        sourceFilename,
        err: documentErr,
      });
    }
  }

  try {
    const resultMessage = await bot.api.sendPhoto(ADMIN_ID, new InputFile(resultPath), {
      caption: `${caption}\n\n✅ Сгенерированное изображение`,
    });
    console.log("Admin web result sent", {
      userId,
      email,
      resultPath,
      resultFilename,
      messageId: resultMessage.message_id,
    });
  } catch (err) {
    console.warn("Failed to send admin web result photo", {
      userId,
      email,
      resultPath,
      resultFilename,
      err,
    });
  }
}

async function notifyLinkedTelegramWebGeneration(
  bot: Bot,
  userId: number,
  email: string | null,
  prompt: string,
  resultPath: string,
  resultFilename: string,
): Promise<void> {
  const telegramId = await getTelegramIdForAccount(userId);
  if (!telegramId) {
    console.log("Web generation has no linked Telegram account", {
      userId,
      email,
      resultFilename,
    });
    return;
  }

  try {
    const message = await bot.api.sendPhoto(telegramId, new InputFile(resultPath), {
      caption:
        `✅ Ваш результат готов\n\n` +
        `📧 Аккаунт: ${email ?? "—"}\n` +
        `📝 ${prompt}`,
    });
    console.log("Linked Telegram web result sent", {
      userId,
      email,
      telegramId,
      resultFilename,
      messageId: message.message_id,
    });
  } catch (err) {
    console.warn("Failed to send web result to linked Telegram account", {
      userId,
      email,
      telegramId,
      resultFilename,
      err,
    });
  }
}

export function registerGenerateRoute(fastify: FastifyInstance, bot: Bot): void {

  // Start generation (async — returns generation_id immediately)
  fastify.post("/api/web/generate", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const body = req.body as { upload_url?: unknown; prompt?: unknown };
    const uploadUrl = String(body.upload_url ?? "").trim();
    const prompt = String(body.prompt ?? "").trim();

    if (!uploadUrl || !prompt) {
      return reply.code(400).send({ error: "upload_url and prompt are required" });
    }
    if (prompt.length > 5000) {
      return reply.code(400).send({ error: "Запрос слишком длинный (максимум 5000 символов)" });
    }

    const filename = normalizeMediaFilename(uploadUrl);
    if (!filename || !/_src\.(?:jpe?g|png|webp)$/i.test(filename)) {
      return reply.code(400).send({ error: "Invalid upload reference" });
    }

    const dbUser = await getUser(user.user_id);
    if (!dbUser) return reply.code(404).send({ error: "User not found" });

    const upload = await findUploadForAccount(dbUser.user_id, filename);
    if (!upload) return reply.code(403).send({ error: "Upload does not belong to this account" });

    const localFilePath = await assertMediaFileInsideUploads(filename);
    if (!localFilePath) return reply.code(404).send({ error: "Uploaded file not found" });

    const reservation = await reserveGenerationCredit(dbUser.user_id);
    if (!reservation) {
      return reply.code(402).send({
        error: "Нет доступных обработок. Купите пакет, чтобы продолжить.",
      });
    }

    const generationId = await createGeneration(dbUser.user_id, prompt, filename, 0, 0, reservation.userPackageId, 1);

    // Run generation asynchronously — client polls /status
    setImmediate(async () => {
      try {
        const kieImageUrl = await uploadLocalFileToKie(localFilePath);
        const resultBytes = await generateImage(kieImageUrl, prompt);

        const resultFilename = `${filename.replace(/_src\.(?:jpe?g|png|webp)$/i, "")}_result.jpg`;
        const resultPath = mediaPath(resultFilename);
        fs.writeFileSync(resultPath, resultBytes);

        await completeGeneration(generationId, resultFilename);
        await incrementTotalGenerations(dbUser.user_id);

        // Notify admin and the linked Telegram account, when the web account is linked.
        await notifyAdminWebGeneration(
          bot,
          dbUser.user_id,
          dbUser.email,
          prompt,
          localFilePath,
          resultPath,
          resultFilename,
          dbUser.package_title,
          dbUser.package_code,
          dbUser.package_generations_remaining,
        ).catch((notifyErr) => {
          fastify.log.warn("Failed to notify admin about web generation %d: %s", generationId, notifyErr);
        });
        await notifyLinkedTelegramWebGeneration(
          bot,
          dbUser.user_id,
          dbUser.email,
          prompt,
          resultPath,
          resultFilename,
        ).catch((notifyErr) => {
          fastify.log.warn("Failed to notify linked Telegram about web generation %d: %s", generationId, notifyErr);
        });

      } catch (err) {
        await failGeneration(generationId);
        await refundGenerationCredit(reservation.userPackageId);
        fastify.log.error("Web generation error for gen %d: %s", generationId, err);
      }
    });

    return reply.code(202).send({ generation_id: generationId, status: "processing" });
  });

  // Poll generation status
  fastify.get<{ Params: { id: string } }>("/api/web/generation/:id/status", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const genId = parseInt(req.params.id, 10);
    if (isNaN(genId)) return reply.code(400).send({ error: "Invalid id" });

    const gen = await getGenerationById(genId, user.user_id);
    if (!gen) return reply.code(404).send({ error: "Not found" });

    return reply.send({
      status: gen["status"],
      source_url: signedUrlFromStored(gen["source_file_id"]),
      result_url: signedUrlFromStored(gen["result_file_id"]),
    });
  });

  // Generation history
  fastify.get<{ Querystring: { page?: string; limit?: string } }>(
    "/api/web/generations",
    async (req, reply) => {
      const user = await requireAuth(req, reply);
      if (!user) return;

      const page = Math.max(0, parseInt(req.query.page ?? "0", 10));
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? "20", 10)));
      const rows = await getUserGenerations(user.user_id, limit, page * limit);

      return reply.send(
        rows.map((r) => ({
          ...r,
          source_url: signedUrlFromStored(r["source_file_id"]),
          result_url: signedUrlFromStored(r["result_file_id"]),
          created_at: r["created_at"] instanceof Date ? (r["created_at"] as Date).toISOString() : r["created_at"],
          completed_at: r["completed_at"] instanceof Date ? (r["completed_at"] as Date).toISOString() : r["completed_at"],
        })),
      );
    },
  );

  // User payment history
  fastify.get("/api/web/payments", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const rows = await getUserPayments(user.user_id, 20);
    return reply.send(rows);
  });

  // User balance + stats
  fastify.get("/api/web/balance", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    const dbUser = await getUser(user.user_id);
    if (!dbUser) return reply.code(404).send({ error: "User not found" });

    return reply.send({
      balance: 0,
      free_generations: dbUser.package_generations_remaining,
      total_generations: dbUser.total_generations,
      has_package: dbUser.package_code !== null,
      package_code: dbUser.package_code,
      package_title: dbUser.package_title,
      package_generations_total: dbUser.package_generations_total,
      package_generations_remaining: dbUser.package_generations_remaining,
    });
  });
}
