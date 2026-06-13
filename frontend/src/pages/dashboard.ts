import type { User, Generation } from "../types.js";
import { getGenerations, linkTelegramAccount } from "../api.js";

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

  if (balance) balance.textContent = user.package_title ?? "Пакет не выбран";
  if (freeGens) freeGens.textContent = String(user.package_generations_remaining);
  if (totalGens) totalGens.textContent = String(user.total_generations);

  freeGens?.closest(".info-card")?.toggleAttribute("hidden", false);
  totalGens?.closest(".info-card")?.toggleAttribute("hidden", false);
  const balanceCard = balance?.closest<HTMLElement>(".info-card");
  if (balanceCard) balanceCard.style.gridColumn = "";

  const linkTgBtn = document.getElementById("link-telegram-btn") as HTMLButtonElement | null;
  const linkTgResult = document.getElementById("link-telegram-result");

  if (user.username) {
    if (linkTgBtn) linkTgBtn.style.display = "none";
    if (linkTgResult) {
      linkTgResult.innerHTML = `<p style="color:var(--text-secondary);font-size:13px">✅ Telegram <b>@${user.username}</b> привязан к боту <a href="https://t.me/RitualRetouch_bot" target="_blank" style="color:inherit"><b>@RitualRetouch_bot</b></a></p>`;
      linkTgResult.style.display = "block";
    }
  } else {
    linkTgBtn?.addEventListener("click", () => {
      if (linkTgBtn.disabled) return;
      linkTgBtn.disabled = true;
      void linkTelegramAccount()
        .then(({ bot_url }) => {
          if (!linkTgResult) return;
          linkTgResult.innerHTML =
            `<a href="${bot_url}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">Открыть @RitualRetouch_bot</a>` +
            `<p style="font-size:12px;color:var(--text-secondary);margin:4px 0 0">Ссылка действует 15 минут. Откройте бота и он привяжет ваш Telegram к аккаунту.</p>`;
          linkTgResult.style.display = "block";
          linkTgBtn.style.display = "none";
        })
        .catch(() => {
          linkTgBtn.disabled = false;
        });
    });
  }

  const howToBtn = document.getElementById("how-to-btn");
  const howToSection = document.getElementById("how-to-section");
  howToBtn?.addEventListener("click", () => {
    if (!howToSection) return;
    howToSection.style.display = howToSection.style.display === "none" ? "block" : "none";
  });

  try {
    const gens = await getGenerations(0, 6);
    renderRecentGallery(gens, navigate);
  } catch {
    // non-critical
  }
}
