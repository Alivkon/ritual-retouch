import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { MEDIA_URL_SECRET } from "../config.js";

export const UPLOADS_DIR = path.resolve(__dirname, "../../uploads");
const MEDIA_TTL_SECONDS = 15 * 60;
const MAX_MEDIA_TTL_SECONDS = 60 * 60;
const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]+$/;
export const STRICT_MEDIA_PAIR_RE =
  /^(\d{8}_\d{6}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(src|result)\.(?:jpe?g|png|webp)$/i;

export function isSafeMediaFilename(filename: string): boolean {
  if (!filename || filename.includes("\0") || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return false;
  }
  if (path.basename(filename) !== filename) return false;
  if (!SAFE_FILENAME_RE.test(filename)) return false;
  return ALLOWED_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export function normalizeMediaFilename(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  let pathname = raw;
  try {
    pathname = new URL(raw, "http://local").pathname;
  } catch {
    pathname = raw.split("?")[0] ?? raw;
  }
  const parts = pathname.split("/").filter(Boolean);
  const filename = parts.length > 0 ? parts[parts.length - 1] : pathname;
  if (!filename || !isSafeMediaFilename(filename)) return null;
  return filename;
}

export function createMediaUrl(filename: string, ttlSeconds = MEDIA_TTL_SECONDS): string {
  if (!isSafeMediaFilename(filename)) throw new Error("Unsafe media filename");
  const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), MAX_MEDIA_TTL_SECONDS);
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const sig = signMediaUrl(filename, expires);
  return `/media/${encodeURIComponent(filename)}?expires=${expires}&sig=${sig}`;
}

export function mediaPath(filename: string): string {
  if (!isSafeMediaFilename(filename)) throw new Error("Unsafe media filename");
  return path.join(UPLOADS_DIR, filename);
}

export async function assertMediaFileInsideUploads(filename: string): Promise<string | null> {
  let realUploads: string;
  try {
    realUploads = await fs.promises.realpath(UPLOADS_DIR);
  } catch {
    return null;
  }
  const candidate = mediaPath(filename);
  let realFile: string;
  try {
    realFile = await fs.promises.realpath(candidate);
  } catch {
    return null;
  }
  const relative = path.relative(realUploads, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const stat = await fs.promises.stat(realFile);
  if (!stat.isFile()) return null;
  return realFile;
}

function signMediaUrl(filename: string, expires: number): string {
  return crypto
    .createHmac("sha256", MEDIA_URL_SECRET)
    .update(`${filename}\n${expires}`)
    .digest("hex");
}

function isValidSignature(filename: string, expires: number, sig: string): boolean {
  const expected = signMediaUrl(filename, expires);
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
}

function contentTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

export function registerMediaRoute(fastify: FastifyInstance): void {
  fastify.get<{ Params: { filename: string }; Querystring: { expires?: string; sig?: string } }>(
    "/media/:filename",
    async (req, reply) => {
      let filename: string;
      try {
        filename = decodeURIComponent(req.params.filename);
      } catch {
        return reply.code(403).send({ error: "Forbidden" });
      }
      const expires = Number(req.query.expires);
      const sig = String(req.query.sig ?? "");
      const now = Math.floor(Date.now() / 1000);

      reply
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer");

      if (!isSafeMediaFilename(filename) || !Number.isInteger(expires) || !/^[0-9a-f]{64}$/i.test(sig)) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (expires < now || expires > now + MAX_MEDIA_TTL_SECONDS) {
        return reply.code(403).send({ error: "Forbidden" });
      }
      if (!isValidSignature(filename, expires, sig)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      const filePath = await assertMediaFileInsideUploads(filename);
      if (!filePath) return reply.code(404).send({ error: "Not found" });
      return reply.type(contentTypeFor(filename)).send(fs.createReadStream(filePath));
    },
  );
}
