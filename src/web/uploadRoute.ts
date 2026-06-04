import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { saveUpload } from "../database.js";
import { requireAuth } from "./auth.js";

const UPLOADS_DIR = path.resolve(__dirname, "../../uploads");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

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

    if (!data.mimetype.startsWith("image/")) {
      return reply.code(400).send({ error: "Only image files are allowed" });
    }

    originalName = data.filename;
    const now = new Date();
    const dt = now.toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/(\d{8})(\d{6})/, "$1_$2");
    filename = `${dt}_${crypto.randomUUID()}_src.jpg`;
    const filePath = path.join(UPLOADS_DIR, filename);

    try {
      await pipeline(data.file, fs.createWriteStream(filePath));
    } catch {
      return reply.code(500).send({ error: "Failed to save file" });
    }

    if (data.file.truncated) {
      fs.unlink(filePath, () => undefined);
      return reply.code(413).send({ error: "File too large (max 10 MB)" });
    }

    await saveUpload(user.user_id, filename, originalName);

    return reply.send({ url: `/uploads/${filename}` });
  });
}
