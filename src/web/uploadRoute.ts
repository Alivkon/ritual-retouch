import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { saveUpload } from "../database.js";
import { requireAuth } from "./auth.js";
import { createMediaUrl, mediaPath, UPLOADS_DIR } from "./mediaRoute.js";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export function registerUploadRoute(fastify: FastifyInstance): void {
  fastify.post("/api/web/upload", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;

    let filename: string | undefined;
    let originalName: string | undefined;

    const data = await req.file({ limits: { fileSize: MAX_FILE_SIZE } });
    if (!data) {
      return reply.code(400).send({ error: "No file provided" });
    }

    const extension = MIME_EXTENSIONS[data.mimetype];
    if (!extension) {
      return reply.code(400).send({ error: "Only JPG, PNG and WebP files are allowed" });
    }

    originalName = data.filename;
    const now = new Date();
    const dt = now.toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/(\d{8})(\d{6})/, "$1_$2");
    filename = `${dt}_${crypto.randomUUID()}_src${extension}`;
    const filePath = mediaPath(filename);

    try {
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      await pipeline(data.file, fs.createWriteStream(filePath));
    } catch {
      fs.unlink(filePath, () => undefined);
      return reply.code(500).send({ error: "Failed to save file" });
    }

    if (data.file.truncated) {
      fs.unlink(filePath, () => undefined);
      return reply.code(413).send({ error: "File too large (max 10 MB)" });
    }

    try {
      await saveUpload(user.user_id, filename, originalName);
    } catch (err) {
      fs.unlink(filePath, () => undefined);
      throw err;
    }

    return reply.send({ url: createMediaUrl(filename), filename });
  });
}
