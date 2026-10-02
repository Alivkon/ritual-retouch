import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getGenerationsByMediaFilenames,
  getReviewGenerationsForAccount,
  markMediaPairDeleted,
} from "../database.js";
import { requireAuth, requireMediaReviewer } from "./auth.js";
import {
  assertMediaFileInsideUploads,
  createMediaUrl,
  mediaPath,
  normalizeMediaFilename,
  STRICT_MEDIA_PAIR_RE,
  UPLOADS_DIR,
} from "./mediaRoute.js";

type DbRow = Record<string, unknown>;

interface DiskPair {
  key: string;
  sourceFilename: string;
  resultFilename: string;
  createdAt: string;
  mtimeMs: number;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function signedUrlFromStored(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const filename = normalizeMediaFilename(value);
  return filename ? createMediaUrl(filename) : null;
}

function serializeGeneration(row: DbRow): DbRow {
  return {
    ...row,
    source_url: signedUrlFromStored(row["source_file_id"]),
    result_url: signedUrlFromStored(row["result_file_id"]),
    created_at: toIso(row["created_at"]),
    completed_at: toIso(row["completed_at"]),
  };
}

function parsePage(query: { page?: string; limit?: string }): { page: number; limit: number; offset: number } {
  const page = Math.max(0, parseInt(query.page ?? "0", 10) || 0);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit ?? "20", 10) || 20));
  return { page, limit, offset: page * limit };
}

async function scanMediaPairs(): Promise<DiskPair[]> {
  await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
  const entries = await fs.promises.readdir(UPLOADS_DIR, { withFileTypes: true });
  const partial = new Map<string, { source?: string; result?: string; mtimeMs: number }>();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(STRICT_MEDIA_PAIR_RE);
    if (!match) continue;
    const key = match[1];
    const kind = match[2]?.toLowerCase();
    if (!key || (kind !== "src" && kind !== "result")) continue;
    const realPath = await assertMediaFileInsideUploads(entry.name);
    if (!realPath) continue;
    const stat = await fs.promises.stat(realPath);
    const current = partial.get(key) ?? { mtimeMs: 0 };
    if (kind === "src") current.source = entry.name;
    else current.result = entry.name;
    current.mtimeMs = Math.max(current.mtimeMs, stat.mtimeMs);
    partial.set(key, current);
  }

  const pairs: DiskPair[] = [];
  for (const [key, pair] of partial) {
    if (!pair.source || !pair.result) continue;
    const stamp = key.slice(0, 15);
    pairs.push({
      key,
      sourceFilename: pair.source,
      resultFilename: pair.result,
      createdAt: stamp,
      mtimeMs: pair.mtimeMs,
    });
  }
  return pairs.sort((a, b) => b.mtimeMs - a.mtimeMs || b.key.localeCompare(a.key));
}

function generationKey(row: DbRow): string | null {
  const source = typeof row["source_file_id"] === "string" ? normalizeMediaFilename(row["source_file_id"]) : null;
  const result = typeof row["result_file_id"] === "string" ? normalizeMediaFilename(row["result_file_id"]) : null;
  return source ?? result;
}

async function quarantineFile(filename: string, suffix: string): Promise<string> {
  const realPath = await assertMediaFileInsideUploads(filename);
  if (!realPath) throw new Error(`Media file not found: ${filename}`);
  const quarantineDir = path.join(UPLOADS_DIR, ".quarantine");
  await fs.promises.mkdir(quarantineDir, { recursive: true });
  const quarantinePath = path.join(quarantineDir, `${filename}.${suffix}`);
  await fs.promises.rename(realPath, quarantinePath);
  return quarantinePath;
}

export function registerReviewRoute(fastify: FastifyInstance): void {
  fastify.get<{ Querystring: { page?: string; limit?: string } }>("/api/web/review-generations", async (req, reply) => {
    const user = await requireAuth(req, reply);
    if (!user) return;
    const { limit, offset, page } = parsePage(req.query);
    const rows = await getReviewGenerationsForAccount(user.user_id, limit, offset);
    return reply.send({ page, limit, items: rows.map(serializeGeneration) });
  });

  fastify.get<{ Querystring: { page?: string; limit?: string } }>("/api/internal/generations", async (req, reply) => {
    const reviewer = await requireMediaReviewer(req, reply);
    if (!reviewer) return;
    const { page, limit, offset } = parsePage(req.query);
    const pairs = (await scanMediaPairs()).slice(offset, offset + limit);
    const filenames = pairs.flatMap((pair) => [pair.sourceFilename, pair.resultFilename]);
    const rows = await getGenerationsByMediaFilenames(filenames);
    const byFilename = new Map<string, DbRow>();
    for (const row of rows) {
      const key = generationKey(row);
      if (key) byFilename.set(key, row);
    }

    const items = pairs.map((pair) => {
      const generation = byFilename.get(pair.sourceFilename) ?? byFilename.get(pair.resultFilename) ?? null;
      return {
        source_filename: pair.sourceFilename,
        result_filename: pair.resultFilename,
        source_url: createMediaUrl(pair.sourceFilename),
        result_url: createMediaUrl(pair.resultFilename),
        created_at: pair.createdAt,
        orphan: generation === null,
        generation: generation ? serializeGeneration(generation) : null,
      };
    });

    req.log.info({ reviewerId: reviewer.user_id, count: items.length }, "Media reviewer listed generations");
    return reply.send({ page, limit, items });
  });

  fastify.delete<{ Params: { sourceFilename: string } }>("/api/internal/media-pairs/:sourceFilename", async (req, reply) => {
    const reviewer = await requireMediaReviewer(req, reply);
    if (!reviewer) return;

    const sourceFilename = decodeURIComponent(req.params.sourceFilename);
    const match = sourceFilename.match(STRICT_MEDIA_PAIR_RE);
    if (!match || match[2]?.toLowerCase() !== "src") {
      return reply.code(400).send({ error: "Invalid source filename" });
    }
    const resultFilename = sourceFilename.replace(/_src\.(?:jpe?g|png|webp)$/i, "_result.jpg");
    const sourcePath = mediaPath(sourceFilename);
    const resultPath = mediaPath(resultFilename);
    const sourceExists = await fs.promises.stat(sourcePath).then((s) => s.isFile(), () => false);
    const resultExists = await fs.promises.stat(resultPath).then((s) => s.isFile(), () => false);

    if (!sourceExists && !resultExists) {
      await markMediaPairDeleted(sourceFilename, resultFilename);
      return reply.code(204).send();
    }
    if (!sourceExists || !resultExists) {
      return reply.code(409).send({ error: "Media pair is incomplete" });
    }

    const suffix = `deleted-${Date.now()}-${crypto.randomUUID()}`;
    const quarantined: string[] = [];
    try {
      quarantined.push(await quarantineFile(sourceFilename, suffix));
      quarantined.push(await quarantineFile(resultFilename, suffix));
      await markMediaPairDeleted(sourceFilename, resultFilename);
      await Promise.all(quarantined.map((file) => fs.promises.unlink(file).catch((err: unknown) => {
        req.log.warn({ err, file }, "Failed to remove quarantined media file");
      })));
      req.log.info({ reviewerId: reviewer.user_id, sourceFilename }, "Media reviewer deleted pair");
      return reply.code(204).send();
    } catch (err) {
      req.log.error({ err, sourceFilename }, "Failed to delete media pair");
      return reply.code(500).send({ error: "Failed to delete media pair" });
    }
  });
}
