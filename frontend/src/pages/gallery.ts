import { getGenerations } from "../api.js";
import type { Generation } from "../types.js";
import { notifications } from "../components/notifications.js";

export function initCompare(): void {
  const overlay = document.getElementById("compare-overlay");
  const container = document.getElementById("compare-container") as HTMLElement;
  const imgBefore = document.getElementById("compare-img-before") as HTMLImageElement;
  const imgAfter = document.getElementById("compare-img-after") as HTMLImageElement;
  const divider = document.getElementById("compare-divider") as HTMLElement;
  const closeBtn = document.getElementById("compare-close-btn") as HTMLElement;
  if (!overlay) return;

  let isDragging = false;

  function setSplit(pct: number): void {
    pct = Math.max(2, Math.min(98, pct));
    imgBefore.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    divider.style.left = `${pct}%`;
  }

  function clientXToPct(clientX: number): number {
    const rect = container.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * 100;
  }

  function loadImg(img: HTMLImageElement, src: string): Promise<void> {
    return new Promise(resolve => {
      if (img.src.endsWith(src) && img.complete && img.naturalWidth > 0) { resolve(); return; }
      img.onload = () => { img.onload = null; img.onerror = null; resolve(); };
      img.onerror = () => { img.onload = null; img.onerror = null; resolve(); };
      img.src = src;
    });
  }

  async function open(beforeSrc: string, afterSrc: string): Promise<void> {
    await Promise.all([loadImg(imgBefore, beforeSrc), loadImg(imgAfter, afterSrc)]);

    const w = imgBefore.naturalWidth || 800;
    const h = imgBefore.naturalHeight || 600;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = Math.min(vw / w, vh / h);
    container.style.width = `${Math.round(w * scale)}px`;
    container.style.height = `${Math.round(h * scale)}px`;

    setSplit(50);
    overlay.setAttribute("aria-hidden", "false");
    overlay.classList.add("active");
    document.body.style.overflow = "hidden";
  }

  function close(): void {
    overlay.classList.remove("active");
    overlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  container.addEventListener("mousedown", (e) => { isDragging = true; setSplit(clientXToPct(e.clientX)); e.preventDefault(); });
  window.addEventListener("mousemove", (e) => { if (isDragging) setSplit(clientXToPct(e.clientX)); });
  window.addEventListener("mouseup", () => { isDragging = false; });

  container.addEventListener("touchstart", (e) => { isDragging = true; setSplit(clientXToPct(e.touches[0].clientX)); }, { passive: true });
  window.addEventListener("touchmove", (e) => { if (isDragging) setSplit(clientXToPct(e.touches[0].clientX)); }, { passive: true });
  window.addEventListener("touchend", () => { isDragging = false; });

  document.querySelectorAll<HTMLElement>(".before-after-card").forEach(card => {
    card.addEventListener("click", () => {
      const imgs = card.querySelectorAll<HTMLImageElement>(".case-img");
      if (imgs.length >= 2) void open(imgs[0].src, imgs[1].src);
    });
  });
}

let currentPage = 0;
let allLoaded = false;

export async function initGallery(): Promise<void> {
  currentPage = 0;
  allLoaded = false;

  const grid = document.getElementById("gallery-grid");
  if (grid) grid.innerHTML = "";

  await loadPage();

  document.getElementById("gallery-search")?.addEventListener("input", (e) => {
    const q = (e.target as HTMLInputElement).value.toLowerCase();
    filterItems(q);
  });
}

async function loadPage(): Promise<void> {
  const grid = document.getElementById("gallery-grid");
  if (!grid || allLoaded) return;

  try {
    const gens = await getGenerations(currentPage, 20);
    if (gens.length < 20) allLoaded = true;
    if (gens.length === 0 && currentPage === 0) {
      grid.innerHTML = `
        <div class="gallery-empty">
          <p>📸 Ваши обработанные фотографии появятся здесь</p>
          <button class="btn btn-primary" data-page="generate">Загрузить фотографию</button>
        </div>`;
      return;
    }

    gens.forEach((g) => grid.appendChild(buildCard(g)));
    currentPage++;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Ошибка";
    notifications.error(`Не удалось загрузить галерею: ${msg}`);
  }
}

function buildCard(g: Generation): HTMLElement {
  const card = document.createElement("div");
  card.className = "gallery-item";
  card.dataset["status"] = g.status;
  card.dataset["prompt"] = g.prompt.toLowerCase();

  const displayPrompt = parseDisplayPrompt(g.prompt);

  if (g.status === "completed" && g.result_file_id && g.result_file_id.startsWith("/uploads/")) {
    card.innerHTML = `
      <img src="${g.result_file_id}" alt="Result" loading="lazy">
      <div class="gallery-overlay">
        <div class="gallery-prompt">${escapeHtml(displayPrompt)}</div>
        <div class="gallery-meta">${formatDate(g.created_at)}</div>
      </div>`;
  } else {
    const icon = g.status === "processing" ? "⏳" : "❌";
    card.innerHTML = `
      <div class="gallery-status-card">
        <div class="gallery-status-icon">${icon}</div>
        <div class="gallery-prompt">${escapeHtml(displayPrompt)}</div>
        <div class="gallery-meta">${formatDate(g.created_at)}</div>
      </div>`;
  }

  return card;
}

function filterItems(query: string): void {
  document.querySelectorAll<HTMLElement>(".gallery-item").forEach((item) => {
    const prompt = item.dataset["prompt"] ?? "";
    item.style.display = prompt.includes(query) ? "" : "none";
  });
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

function parseDisplayPrompt(raw: string): string {
  const match = raw.match(/Дополнительно:\s*(.+)/s);
  const text = match ? match[1].trim() : raw;
  return text.length > 60 ? text.slice(0, 60) + "…" : text;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c] ?? c));
}
