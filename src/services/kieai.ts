import fs from "node:fs";
import path from "node:path";
import { KIE_API_KEY } from "../config.js";

const API_URL = "https://api.kie.ai/api/v1/jobs/createTask";
const TASK_STATUS_URL = "https://api.kie.ai/api/v1/jobs/recordInfo";
const FILE_UPLOAD_URL = "https://kieai.redpandaai.co/api/file-base64-upload";

const POLL_INTERVAL_MS = 4000;
const POLL_MAX_ATTEMPTS = 45;

export class KieError extends Error {}

interface KieUploadResponse {
  success: boolean;
  code: number;
  msg?: string;
  data?: { downloadUrl: string };
}

export async function uploadLocalFileToKie(localPath: string): Promise<string> {
  const buf = fs.readFileSync(localPath);
  const ext = path.extname(localPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const base64Data = `data:${mime};base64,${buf.toString("base64")}`;

  const resp = await fetch(FILE_UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KIE_API_KEY.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ base64Data, uploadPath: "memorial-retouch" }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await resp.json()) as KieUploadResponse;
  if (!data.success || data.code !== 200) {
    throw new KieError(`KIE upload failed: ${data.msg ?? JSON.stringify(data)}`);
  }
  const url = data.data?.downloadUrl;
  if (!url) throw new KieError("KIE upload returned no downloadUrl");
  return url;
}

interface KieCreateResponse {
  code: number;
  msg?: string;
  message?: string;
  data?: { taskId: string };
}

interface KieStatusResponse {
  data?: {
    state?: string;
    resultJson?: string;
    failMsg?: string;
  };
}

const CREATE_TASK_MAX_ATTEMPTS = 3;
const CREATE_TASK_RETRY_DELAYS_MS = [1000, 2000];

async function createKieTask(
  headers: Record<string, string>,
  payload: unknown,
): Promise<string> {
  let lastError: Error = new KieError("KIE.ai: задача не создана");

  for (let attempt = 0; attempt < CREATE_TASK_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = CREATE_TASK_RETRY_DELAYS_MS[attempt - 1] ?? 2000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const createResp = await fetch(API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await createResp.json()) as KieCreateResponse;

      if (data.code !== 200) {
        const msg = data.msg ?? data.message ?? JSON.stringify(data);
        lastError = new KieError(`KIE.ai вернул ошибку ${data.code}: ${msg}`);
        continue;
      }

      const taskId = data.data?.taskId;
      if (!taskId) {
        lastError = new KieError("KIE.ai не вернул taskId");
        continue;
      }
      return taskId;
    } catch (err) {
      lastError = err instanceof Error ? err : new KieError(String(err));
    }
  }

  throw lastError;
}

export async function generateImage(imageUrl: string, prompt: string): Promise<Buffer> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${KIE_API_KEY.trim()}`,
    "Content-Type": "application/json",
  };
  const payload = {
    model: "google/nano-banana",
    input: { prompt, imageUrls: [imageUrl], resolution: "1K" },
  };

  const taskId = await createKieTask(headers, payload);

  let resultUrl: string | undefined;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    let statusData: KieStatusResponse;
    try {
      const statusResp = await fetch(`${TASK_STATUS_URL}?taskId=${taskId}`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!statusResp.ok) continue;
      statusData = (await statusResp.json()) as KieStatusResponse;
    } catch {
      continue;
    }

    const taskData = statusData.data ?? {};
    const state = taskData.state ?? "";

    if (state === "success") {
      const resultJsonStr = taskData.resultJson ?? "{}";
      const resultJson = JSON.parse(resultJsonStr) as { resultUrls?: string[] };
      resultUrl = resultJson.resultUrls?.[0];
      if (!resultUrl) throw new KieError("Задача завершена, но resultUrls отсутствует");
      break;
    }

    if (state === "fail") {
      const errMsg = taskData.failMsg ?? "неизвестная ошибка генерации";
      throw new KieError(`Генерация не удалась: ${errMsg}`);
    }
  }

  if (!resultUrl) throw new KieError("Превышено время ожидания генерации (3 минуты)");

  const imgResp = await fetch(resultUrl, { signal: AbortSignal.timeout(60_000) });
  if (!imgResp.ok) throw new KieError(`Не удалось скачать результат: HTTP ${imgResp.status}`);

  const resultBytes = Buffer.from(await imgResp.arrayBuffer());
  if (resultBytes.length === 0) throw new KieError("Получен пустой файл изображения");

  return resultBytes;
}
