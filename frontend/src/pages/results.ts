import type { GenerationResult } from "./generate.js";
import { notifications } from "../components/notifications.js";

type Navigate = (page: string) => void;

let resultsInitialized = false;
function normalizeImageUrl(url: string | undefined | null): string {
  if (!url) return "";
  if (url.startsWith("data:") || url.startsWith("blob:") || /^https?:\/\//i.test(url)) return url;
  return url.startsWith("/") ? url : `/uploads/${url}`;
}


export function initResults(result: GenerationResult | null, navigate: Navigate): void {
  const originalImg = document.getElementById("result-original") as HTMLImageElement | null;
  const generatedImg = document.getElementById("result-generated") as HTMLImageElement | null;

  if (result) {
    if (originalImg) originalImg.src = normalizeImageUrl(result.originalDataUrl || result.sourceUrl);
    if (generatedImg) generatedImg.src = normalizeImageUrl(result.resultUrl);

    const timeEl = document.getElementById("result-time");
    const infoEl = document.getElementById("generation-info");
    if (timeEl) timeEl.textContent = `${result.elapsedSeconds} сек`;
    if (infoEl) infoEl.style.display = "none";
  }

  if (resultsInitialized) return;
  resultsInitialized = true;

  function downloadGenerated(): void {
    const src = (document.getElementById("result-generated") as HTMLImageElement | null)?.src;
    if (!src) return;
    const filename = src.split("/").pop() || "memorial_retouch_result.jpg";
    const link = document.createElement("a");
    link.href = src;
    link.download = filename;
    link.click();
  }

  document.getElementById("download-btn")?.addEventListener("click", downloadGenerated);
  document.getElementById("download-result-btn")?.addEventListener("click", downloadGenerated);

  document.getElementById("generate-another-btn")?.addEventListener("click", () => navigate("generate"));
  document.getElementById("back-dashboard-btn")?.addEventListener("click", () => navigate("dashboard"));

  document.getElementById("grayscale-toggle")?.addEventListener("click", () => {
    const img = document.getElementById("result-generated") as HTMLImageElement | null;
    if (!img) return;
    img.style.filter = img.style.filter === "grayscale(100%)" ? "" : "grayscale(100%)";
  });
}
