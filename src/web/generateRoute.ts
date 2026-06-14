import fs from "node:fs";
import path from "node:path";
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
} from "../database.js";
import { generateImage, uploadLocalFileToKie, KieError } from "../services/kieai.js";
import { ADMIN_ID } from "../config.js";
import { requireAuth } from "./auth.js";

const UPLOADS_DIR = path.resolve(__dirname, "../../uploads");

async function notifyAdminWebGeneration(
  bot: Bot,
  userId: number,
  prompt: string,
  sourcePath: string,
  resultPath: string,
): Promise<void> {
  const caption =
    `🌐 Веб-обработка\n` +
    `👤 web:${userId}\n` +
    `📝 ${prompt}`;

  await bot.api.sendPhoto(ADMIN_ID, new InputFile(sourcePath), {
    caption: `${caption}\n\n📥 Исходное изображение`,
  });

  await bot.api.sendPhoto(ADMIN_ID, new InputFile(resultPath), {
    caption: `${caption}\n\n✅ Сгенерированное изображение`,
  });
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

    const dbUser = await getUser(user.user_id);
    if (!dbUser) return reply.code(404).send({ error: "User not found" });

    const reservation = await reserveGenerationCredit(dbUser.user_id);
    if (!reservation) {
      return reply.code(402).send({
        error: "Нет доступных обработок. Купите пакет, чтобы продолжить.",
      });
    }

    // Derive absolute file path from URL like "/uploads/abc.jpg"
    const filename = path.basename(uploadUrl);
    const localFilePath = path.join(UPLOADS_DIR, filename);

    const generationId = await createGeneration(dbUser.user_id, prompt, filename, 0, 0, reservation.userPackageId, 1);

    // Run generation asynchronously — client polls /status
    setImmediate(async () => {
      try {
        const kieImageUrl = await uploadLocalFileToKie(localFilePath);
        const resultBytes = await generateImage(kieImageUrl, prompt);

        const resultFilename = `${filename.replace(/_src\.jpg$/, "")}_result.jpg`;
        const resultPath = path.join(UPLOADS_DIR, resultFilename);
        fs.writeFileSync(resultPath, resultBytes);

        await completeGeneration(generationId, `/uploads/${resultFilename}`);
        await incrementTotalGenerations(dbUser.user_id);

        // Notify admin
        await notifyAdminWebGeneration(
          bot,
          dbUser.user_id,
          prompt,
          localFilePath,
          resultPath,
        ).catch((notifyErr) => {
          fastify.log.warn("Failed to notify admin about web generation %d: %s", generationId, notifyErr);
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
      result_url: gen["result_file_id"] ?? null,
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
