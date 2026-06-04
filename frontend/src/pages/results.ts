import type { GenerationResult } from "./generate.js";
import { notifications } from "../components/notifications.js";

type Navigate = (page: string) => void;

let resultsInitialized = false;

export function initResults(result: GenerationResult | null, navigate: Navigate): void {
  const originalImg = document.getElementById("result-original") as HTMLImageElement | null;
  const generatedImg = document.getElementById("result-generated") as HTMLImageElement | null;

  if (result) {
    if (originalImg) originalImg.src = result.originalDataUrl;
    if (generatedImg) generatedImg.src = result.resultUrl;

    const timeEl = document.getElementById("result-time");
    const infoEl = document.getElementById("generation-info");
    if (timeEl) timeEl.textContent = `${result.elapsedSeconds} сек`;
    if (infoEl) infoEl.style.display = "none";
  }

  if (resultsInitialized) return;
  resultsInitialized = true;

  document.getElementById("download-btn")?.addEventListener("click", () => {
    if (!generatedImg?.src) return;
    const link = document.createElement("a");
    link.href = generatedImg.src;
    link.download = "memorial_retouch_result.jpg";
    link.click();
  });

  document.getElementById("download-result-btn")?.addEventListener("click", () => {
    const src = (document.getElementById("result-generated") as HTMLImageElement | null)?.src;
    if (!src) return;
    const link = document.createElement("a");
    link.href = src;
    link.download = "memorial_retouch_result.jpg";
    link.click();
  });

  document.getElementById("generate-another-btn")?.addEventListener("click", () => navigate("generate"));
  document.getElementById("back-dashboard-btn")?.addEventListener("click", () => navigate("dashboard"));

  document.getElementById("grayscale-toggle")?.addEventListener("click", () => {
    const img = document.getElementById("result-generated") as HTMLImageElement | null;
    if (!img) return;
    img.style.filter = img.style.filter === "grayscale(100%)" ? "" : "grayscale(100%)";
  });
}
