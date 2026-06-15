import { initTheme } from "./components/theme.js";
import { notifications } from "./components/notifications.js";
import { initDashboard } from "./pages/dashboard.js";
import { initGenerate } from "./pages/generate.js";
import type { GenerationResult } from "./pages/generate.js";
import { initResults } from "./pages/results.js";
import { initGallery, initCompare } from "./pages/gallery.js";
import { initWallet, updateWalletBalance } from "./pages/wallet.js";
import { getMe, login, register, logout, setToken, resendVerification, sleep, getBalance, confirmYookassaPayment } from "./api.js";
import type { User } from "./types.js";

// ── State ──────────────────────────────────────────────────────────────────

let currentUser: User | null = null;
let currentPage = "dashboard";
let lastGenerationResult: GenerationResult | null = null;
let pendingAfterAuth: (() => void) | null = null;
let appReady = false;

// ── Navigation ─────────────────────────────────────────────────────────────

const PAGES = ["dashboard", "generate", "gallery", "results"] as const;
type Page = (typeof PAGES)[number];

async function refreshUserStats(): Promise<void> {
  if (!currentUser) return;

  const stats = await getBalance();
  currentUser = { ...currentUser, ...stats };

  const balance = document.getElementById("balance");
  const freeGens = document.getElementById("free-generations");
  const totalGens = document.getElementById("total-generations");
  const walletBalance = document.getElementById("wallet-balance");

  if (balance) balance.textContent = stats.package_title ?? "Пакет не выбран";
  if (freeGens) freeGens.textContent = String(stats.package_generations_remaining);
  if (totalGens) totalGens.textContent = String(stats.total_generations);
  if (walletBalance) walletBalance.textContent = stats.package_title ?? "Пакет не выбран";

  freeGens?.closest(".info-card")?.toggleAttribute("hidden", false);
  totalGens?.closest(".info-card")?.toggleAttribute("hidden", false);
  const balanceCard = balance?.closest<HTMLElement>(".info-card");
  if (balanceCard) balanceCard.style.gridColumn = "";
}

function navigate(page: string, data?: GenerationResult): void {
  if (data) lastGenerationResult = data;

  // Hide all pages
  PAGES.forEach((p) => {
    const el = document.getElementById(`page-${p}`);
    if (el) el.classList.remove("active");
  });

  // Show target page
  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.add("active");
  else { navigate("dashboard"); return; }

  // Update nav items (desktop + mobile)
  document.querySelectorAll(".nav-item, .mobile-nav-item").forEach((item) => {
    item.classList.remove("active");
    if ((item as HTMLElement).dataset["page"] === page) item.classList.add("active");
  });

  currentPage = page;
  window.scrollTo(0, 0);

  if (page === "generate") {
    initGenerate(navigate, (cb) => showAuthOverlay(cb), refreshUserStats);
    return;
  }

  if (page === "results") {
    initResults(lastGenerationResult, navigate);
    return;
  }

  if (!currentUser) return;

  const user = currentUser;
  if (page === "dashboard") {
    void initDashboard(user, navigate);
    void refreshUserStats();
  }
  if (page === "gallery") void initGallery();
}

function openWalletModal(): void {
  if (!currentUser) {
    showAuthOverlay(() => openWalletModal());
    return;
  }
  const backdrop = document.getElementById("wallet-modal-backdrop");
  const modal = document.getElementById("wallet-modal");
  if (backdrop) backdrop.classList.add("show");
  if (modal) modal.classList.add("show");
  void initWallet(currentUser);
}

function closeWalletModal(): void {
  const backdrop = document.getElementById("wallet-modal-backdrop");
  const modal = document.getElementById("wallet-modal");
  if (backdrop) backdrop.classList.remove("show");
  if (modal) modal.classList.remove("show");
}

// ── Auth overlay ───────────────────────────────────────────────────────────

function showAuthOverlay(onSuccess?: () => void): void {
  if (onSuccess !== undefined) pendingAfterAuth = onSuccess;
  const overlay = document.getElementById("auth-overlay");
  const app = document.getElementById("app");
  const header = document.getElementById("header");
  if (overlay) overlay.style.display = "flex";
  if (app) app.style.display = "none";
  if (header) header.style.display = "none";
}

function hideAuthOverlay(): void {
  const overlay = document.getElementById("auth-overlay");
  const app = document.getElementById("app");
  const header = document.getElementById("header");
  if (overlay) overlay.style.display = "none";
  if (app) app.style.display = "";
  if (header) header.style.display = "";
}

function showAuthInfo(msg: string, showResend = false): void {
  const infoEl = document.getElementById("auth-info");
  if (infoEl) { infoEl.textContent = msg; infoEl.style.display = "block"; }
  const resendBtn = document.getElementById("auth-resend") as HTMLButtonElement | null;
  if (resendBtn) resendBtn.style.display = showResend ? "block" : "none";
}

function hideAuthInfo(): void {
  const infoEl = document.getElementById("auth-info");
  if (infoEl) infoEl.style.display = "none";
  const resendBtn = document.getElementById("auth-resend") as HTMLButtonElement | null;
  if (resendBtn) resendBtn.style.display = "none";
}

function showRuDomainModal(): void {
  document.getElementById("ru-domain-modal-backdrop")?.classList.add("show");
  document.getElementById("ru-domain-modal")?.classList.add("show");
}

function hideRuDomainModal(): void {
  document.getElementById("ru-domain-modal-backdrop")?.classList.remove("show");
  document.getElementById("ru-domain-modal")?.classList.remove("show");
}

function setupAuthForm(): void {
  const overlay = document.getElementById("auth-overlay");
  if (!overlay) return;

  const tabLogin = document.getElementById("tab-login");
  const tabRegister = document.getElementById("tab-register");
  const submitBtn = document.getElementById("auth-submit") as HTMLButtonElement | null;
  const errorEl = document.getElementById("auth-error");
  const emailInput = document.getElementById("auth-email") as HTMLInputElement | null;
  let isRegister = false;
  let lastEmail = "";

  tabLogin?.addEventListener("click", () => {
    isRegister = false;
    tabLogin.classList.add("active");
    tabRegister?.classList.remove("active");
    if (submitBtn) { submitBtn.textContent = "Войти"; submitBtn.disabled = false; }
    if (errorEl) errorEl.style.display = "none";
    hideAuthInfo();
  });

  tabRegister?.addEventListener("click", () => {
    isRegister = true;
    tabRegister.classList.add("active");
    tabLogin?.classList.remove("active");
    if (submitBtn) {
      submitBtn.textContent = "Зарегистрироваться";
      const val = emailInput?.value.trim() ?? "";
      submitBtn.disabled = val.length > 0 && !val.toLowerCase().endsWith(".ru");
    }
    if (errorEl) errorEl.style.display = "none";
    hideAuthInfo();
  });

  emailInput?.addEventListener("input", () => {
    if (!isRegister || !submitBtn) return;
    const val = emailInput.value.trim();
    submitBtn.disabled = val.length > 0 && !val.toLowerCase().endsWith(".ru");
  });

  document.getElementById("auth-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = (document.getElementById("auth-email") as HTMLInputElement).value.trim();
    if (isRegister && !email.toLowerCase().endsWith(".ru")) {
      showRuDomainModal();
      if (submitBtn) submitBtn.disabled = true;
      return;
    }
    lastEmail = email;
    const password = (document.getElementById("auth-password") as HTMLInputElement).value;
    void handleAuthSubmit(email, password, isRegister, errorEl, submitBtn);
  });

  document.getElementById("auth-resend")?.addEventListener("click", () => {
    if (!lastEmail) return;
    void resendVerification(lastEmail).then((r) => showAuthInfo(r.message)).catch(() => undefined);
  });

  document.getElementById("ru-domain-modal-close")?.addEventListener("click", hideRuDomainModal);
  document.getElementById("ru-domain-modal-backdrop")?.addEventListener("click", hideRuDomainModal);
}

async function handleAuthSubmit(
  email: string,
  password: string,
  isRegister: boolean,
  errorEl: HTMLElement | null,
  submitBtn: HTMLButtonElement | null,
): Promise<void> {
  if (submitBtn) submitBtn.disabled = true;
  if (errorEl) errorEl.style.display = "none";
  hideAuthInfo();

  try {
    if (isRegister) {
      const resp = await register(email, password);
      showAuthInfo(resp.message, true);
    } else {
      const resp = await login(email, password);
      currentUser = resp.user;
      hideAuthOverlay();
      setupApp();
      const cb = pendingAfterAuth;
      pendingAfterAuth = null;
      if (cb) cb();
      else navigate("dashboard");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Ошибка авторизации";
    if (errorEl) { errorEl.textContent = msg; errorEl.style.display = "block"; }
    // Если email не подтверждён — показываем кнопку повторной отправки
    if (msg.includes("не подтверждён")) showAuthInfo("", true);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ── Profile menu ───────────────────────────────────────────────────────────

function setupProfileMenu(): void {
  const handleLogout = () => {
    const confirmed = window.confirm("Выйти из аккаунта?");
    if (!confirmed) return;
    void logout().then(() => {
      currentUser = null;
      showAuthOverlay();
    });
  };
  document.getElementById("profile-menu")?.addEventListener("click", handleLogout);
  document.getElementById("mobile-profile-menu")?.addEventListener("click", handleLogout);
}

// ── Nav ────────────────────────────────────────────────────────────────────

function setupNav(): void {
  document.querySelectorAll<HTMLElement>("[data-page]").forEach((item) => {
    if (item.classList.contains("page")) return;
    const page = item.dataset["page"];
    if (page === "wallet") {
      item.addEventListener("click", () => openWalletModal());
    } else if (page) {
      item.addEventListener("click", () => navigate(page));
    }
  });
}

function setupWalletModal(): void {
  document.getElementById("wallet-modal-close")?.addEventListener("click", () => closeWalletModal());
  document.getElementById("wallet-modal-backdrop")?.addEventListener("click", () => closeWalletModal());
}

// ── App init ───────────────────────────────────────────────────────────────

function setupApp(): void {
  if (appReady) return;
  appReady = true;
  setupNav();
  setupProfileMenu();
  setupWalletModal();
}

async function main(): Promise<void> {
  initTheme();
  setupAuthForm();

  // После перехода по ссылке верификации сервер редиректит на /?session=TOKEN
  const params = new URLSearchParams(window.location.search);
  const sessionToken = params.get("session");
  if (sessionToken) {
    setToken(sessionToken);
    window.history.replaceState({}, "", "/");
  }

  // После успешного платежа обновляем пакет
  const paymentSuccess = params.has("payment_success");
  const paymentId = params.get("payment_id");
  if (paymentSuccess) {
    window.history.replaceState({}, "", "/");
  }

  try {
    currentUser = await getMe();
    hideAuthOverlay();
    setupApp();
    
    if (paymentSuccess && currentUser) {
      const oldRemaining = currentUser.package_generations_remaining;
      void initWallet(currentUser);
      openWalletModal();

      if (paymentId) {
        try {
          const result = await confirmYookassaPayment(paymentId);
          currentUser = {
            ...currentUser,
            has_package: true,
            package_title: result.package_title,
            package_generations_remaining: result.package_generations_remaining,
            free_generations: result.package_generations_remaining,
          };
          await refreshUserStats();
          void initWallet(currentUser);
          notifications.success(result.credited ? "Пакет успешно оплачен. Обработки зачислены." : "Платёж уже был зачислен.");
          return;
        } catch {
          // Fall through to webhook polling below.
        }
      }

      // Poll in background until webhook arrives and credits the package (up to 30s)
      void (async () => {
        for (let i = 0; i < 10; i++) {
          await sleep(3000);
          try {
            const stats = await getBalance();
            if (stats.package_generations_remaining > oldRemaining) {
              currentUser = { ...currentUser!, ...stats };
              await refreshUserStats();
              void initWallet(currentUser!);
              notifications.success("Пакет успешно оплачен. Обработки зачислены.");
              return;
            }
          } catch { /* non-critical */ }
        }
        notifications.info("Платёж обрабатывается. Пакет обновится в ближайшее время.");
      })();
    } else {
      navigate("dashboard");
    }
  } catch {
    hideAuthOverlay();
    setupApp();
    navigate("generate");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initCompare();
  void main();
});

// Suppress TS unused warning
void notifications;
