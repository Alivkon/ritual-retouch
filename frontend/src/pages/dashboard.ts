import type { User, Generation } from "../types.js";
import { getGenerations } from "../api.js";

function parseDisplayPrompt(raw: string): string {
  const match = raw.match(/Дополнительно:\s*(.+)/s);
  const text = match ? match[1].trim() : raw;
  return text.length > 40 ? text.slice(0, 40) + "…" : text;
}

type Navigate = (page: string) => void;

function renderRecentGallery(gens: Generation[], navigate: Navigate): void {
  const grid = document.getElementById("recent-gallery");
  if (!grid) return;

  if (gens.length === 0) {
    grid.innerHTML = `
      <div class="gallery-empty">
        <p>📷 У вас ещё нет обработанных фотографий</p>
        <p>Начните с загрузки фото</p>
      </div>`;
    return;
  }

  grid.innerHTML = gens
    .slice(0, 6)
    .map((g) => {
      const label = parseDisplayPrompt(g.prompt);
      if (g.status !== "completed" || !g.result_file_id) {
        return `
          <div class="gallery-item gallery-item-${g.status}">
            <div class="gallery-status">${g.status === "processing" ? "⏳" : "❌"}</div>
            <div class="gallery-prompt">${label}</div>
          </div>`;
      }
      return `
        <div class="gallery-item">
          <img src="${g.result_file_id}" alt="Result" loading="lazy">
          <div class="gallery-prompt">${label}</div>
        </div>`;
    })
    .join("");

  grid.querySelectorAll(".gallery-item").forEach((item, idx) => {
    item.addEventListener("click", () => {
      const gen = gens[idx];
      if (gen && gen.status === "completed") navigate("results");
    });
  });
}

export async function initDashboard(user: User, navigate: Navigate): Promise<void> {
  const balance = document.getElementById("balance");
  const freeGens = document.getElementById("free-generations");
  const totalGens = document.getElementById("total-generations");

  if (balance) balance.textContent = `${user.balance.toFixed(0)}₽`;
  if (freeGens) freeGens.textContent = String(user.free_generations);
  if (totalGens) totalGens.textContent = String(user.total_generations);

  const showExtra = user.free_generations > 0;
  freeGens?.closest(".info-card")?.toggleAttribute("hidden", !showExtra);
  totalGens?.closest(".info-card")?.toggleAttribute("hidden", !showExtra);
  const balanceCard = balance?.closest<HTMLElement>(".info-card");
  if (balanceCard) balanceCard.style.gridColumn = showExtra ? "" : "1 / -1";

  const howToBtn = document.getElementById("how-to-btn");
  const howToSection = document.getElementById("how-to-section");
  howToBtn?.addEventListener("click", () => {
    if (!howToSection) return;
    howToSection.style.display = howToSection.style.display === "none" ? "block" : "none";
  });

  // Nav button on the dashboard to go to wallet
  document.querySelector<HTMLButtonElement>('[data-page="wallet"]')
    ?.addEventListener("click", () => navigate("wallet"));

  try {
    const gens = await getGenerations(0, 6);
    renderRecentGallery(gens, navigate);
  } catch {
    // non-critical
  }
}
