import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { InputFile, type Bot } from "grammy";
import { WEBAPP_URL } from "../config.js";
import {
  getUser,
  deductBalance,
  deductFreeGeneration,
  incrementTotalGenerations,
  createGeneration,
  completeGeneration,
  failGeneration,
  addBalance,
  getGenerationById,
  getUserGenerations,
  getUserPayments,
} from "../database.js";
import { generateImage, KieError } from "../services/kieai.js";
import { GENERATION_COST, ADMIN_ID, DISCOUNTED_COST, DISCOUNTED_USER_IDS } from "../config.js";
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
    if (prompt.length > 1000) {
      return reply.code(400).send({ error: "Prompt too long (max 500 chars)" });
    }

    const dbUser = await getUser(user.user_id);
    if (!dbUser) return reply.code(404).send({ error: "User not found" });

    const isDiscounted = DISCOUNTED_USER_IDS.has(dbUser.user_id);
    const effectiveCost = isDiscounted ? DISCOUNTED_COST : GENERATION_COST;
    let isFree = 0;
    let cost = effectiveCost;

    if (dbUser.free_generations > 0) {
      isFree = 1;
      cost = 0;
    } else if (dbUser.balance < effectiveCost) {
      return reply.code(402).send({
        error: `Insufficient balance. Cost: ${effectiveCost}₽, balance: ${dbUser.balance.toFixed(0)}₽`,
      });
    }

    // Derive absolute file path from URL like "/uploads/abc.jpg"
    const filename = path.basename(uploadUrl);
    const localFilePath = path.join(UPLOADS_DIR, filename);
    // Public URL for KIE.ai to fetch the uploaded image
    const publicImageUrl = `${WEBAPP_URL}${uploadUrl}`;

    const generationId = await createGeneration(dbUser.user_id, prompt, filename, cost, isFree);

    if (isFree) {
      await deductFreeGeneration(dbUser.user_id);
    } else {
      await deductBalance(dbUser.user_id, cost);
    }
    await incrementTotalGenerations(dbUser.user_id);

    // Run generation asynchronously — client polls /status
    setImmediate(async () => {
      try {
        const resultBytes = await generateImage(publicImageUrl, prompt);

        const resultFilename = `${filename.replace(/_src\.jpg$/, "")}_result.jpg`;
        const resultPath = path.join(UPLOADS_DIR, resultFilename);
        fs.writeFileSync(resultPath, resultBytes);

        await completeGeneration(generationId, `/uploads/${resultFilename}`);

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
        if (!isFree) await addBalance(dbUser.user_id, cost);
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
      balance: dbUser.balance,
      free_generations: dbUser.free_generations,
      total_generations: dbUser.total_generations,
    });
  });
}
