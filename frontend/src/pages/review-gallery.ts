import { deleteInternalMediaPair, getInternalGenerations } from "../api.js";
import type { InternalMediaPair } from "../types.js";
import { notifications } from "../components/notifications.js";
import { openImagePreview } from "../components/image-preview.js";

let initialized = false;
let page = 0;
let allLoaded = false;
let loading = false;
const PAGE_SIZE = 30;

export async function initReviewGallery(): Promise<void> {
  page = 0;
  allLoaded = false;
  const grid = document.getElementById("review-gallery-grid");
  if (grid) grid.innerHTML = "";
  setupOnce();
  await loadReviewPage();
}

function setupOnce(): void {
  if (initialized) return;
  initialized = true;
  document.getElementById("review-gallery-refresh")?.addEventListener("click", () => void initReviewGallery());
  document.getElementById("review-gallery-more")?.addEventListener("click", () => void loadReviewPage());
}

async function loadReviewPage(): Promise<void> {
  if (loading || allLoaded) return;
  loading = true;
  const grid = document.getElementById("review-gallery-grid");
  const more = document.getElementById("review-gallery-more") as HTMLButtonElement | null;
  const empty = document.getElementById("review-gallery-empty");
  if (more) more.disabled = true;
  try {
    const resp = await getInternalGenerations(page, PAGE_SIZE);
    if (resp.items.length < PAGE_SIZE) allLoaded = true;
    if (empty) empty.style.display = resp.items.length === 0 && page === 0 ? "block" : "none";
    resp.items.forEach((item) => grid?.appendChild(buildPairCard(item)));
    page += 1;
    if (more) more.style.display = allLoaded ? "none" : "inline-flex";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Ошибка";
    notifications.error(`Не удалось загрузить служебную галерею: ${msg}`);
  } finally {
    loading = false;
    if (more) more.disabled = false;
  }
}

function buildPairCard(item: InternalMediaPair): HTMLElement {
  const card = document.createElement("article");
  card.className = "review-card";
  const prompt = item.generation?.prompt ? parseDisplayPrompt(item.generation.prompt) : "Файл без записи в БД";
  const user = item.generation?.email ?? item.generation?.username ?? (item.orphan ? "orphan" : "web");
  card.innerHTML = `
    <div class="review-card-images">
      ${imageButton(item.source_url, "До")}
      ${imageButton(item.result_url, "После")}
    </div>
    <div class="review-card-body">
      <div class="review-card-title">${escapeHtml(prompt)}</div>
      <div class="review-card-meta">${escapeHtml(String(user))}</div>
      <div class="review-card-meta">${escapeHtml(item.source_filename)}</div>
      ${item.orphan ? '<span class="badge badge-warning">orphan</span>' : ''}
    </div>
    <div class="review-card-actions">
      <button type="button" class="btn btn-sm btn-danger" data-action="delete">Удалить пару</button>
    </div>`;

  card.querySelectorAll<HTMLButtonElement>("[data-preview]").forEach((button) => {
    button.addEventListener("click", () => openImagePreview(button.dataset["preview"] ?? "", button.dataset["label"] ?? ""));
    const img = button.querySelector("img");
    img?.addEventListener("error", () => {
      button.classList.add("review-image-expired");
      button.setAttribute("title", "Ссылка устарела, обновите галерею");
    });
  });
  card.querySelector<HTMLButtonElement>('[data-action="delete"]')?.addEventListener("click", () => {
    void deletePair(item, card);
  });
  return card;
}

function imageButton(src: string, label: string): string {
  return `
    <button type="button" class="review-image-btn" data-preview="${escapeHtml(src)}" data-label="${escapeHtml(label)}">
      <img src="${escapeHtml(src)}" alt="${escapeHtml(label)}" loading="lazy">
      <span>${escapeHtml(label)}</span>
    </button>`;
}

async function deletePair(item: InternalMediaPair, card: HTMLElement): Promise<void> {
  if (!window.confirm("Удалить исходное и итоговое изображение?")) return;
  const button = card.querySelector<HTMLButtonElement>('[data-action="delete"]');
  if (button) button.disabled = true;
  try {
    await deleteInternalMediaPair(item.source_filename);
    card.remove();
    notifications.success("Пара изображений удалена");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Ошибка";
    notifications.error(`Не удалось удалить пару: ${msg}`);
    if (button) button.disabled = false;
  }
}

function parseDisplayPrompt(raw: string): string {
  const match = raw.match(/Дополнительно:\s*(.+)/s);
  const text = match ? match[1].trim() : raw;
  return text.length > 120 ? text.slice(0, 120) + "..." : text;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c] ?? c));
}
