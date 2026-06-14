import { getBalance, createYookassaPayment, confirmYookassaPayment, getPayments } from "../api.js";
import { notifications } from "../components/notifications.js";
import type { User } from "../types.js";

declare global {
  interface Window {
    YooMoneyCheckoutWidget: new (opts: {
      confirmation_token: string;
      return_url: string;
      error_callback: (err: unknown) => void;
    }) => {
      render: (containerId: string) => void;
      destroy: () => void;
      on: (event: "success" | "fail", cb: () => void) => void;
    };
  }
}

let selectedAmount: number | null = null;
let activeWidget: { destroy: () => void; on?: (event: "success" | "fail", cb: () => void) => void } | null = null;

export async function updateWalletBalance(user: User): Promise<void> {
  try {
    const stats = await getBalance();
    const walletBalance = document.getElementById("wallet-balance");
    if (walletBalance) walletBalance.textContent = stats.package_title ?? "Пакет не выбран";
  } catch {
    // non-critical
  }
}

export async function initWallet(user: User): Promise<void> {
  selectedAmount = null;
  if (activeWidget) { activeWidget.destroy(); activeWidget = null; }

  const walletBalance = document.getElementById("wallet-balance");
  if (walletBalance) walletBalance.textContent = user.package_title ?? "Пакет не выбран";

  // Remove all previous topup card listeners
  document.querySelectorAll<HTMLButtonElement>(".topup-card").forEach((btn) => {
    const newBtn = btn.cloneNode(true) as HTMLButtonElement;
    btn.parentNode?.replaceChild(newBtn, btn);
  });

  // Register new listeners
  document.querySelectorAll<HTMLButtonElement>(".topup-card").forEach((btn) => {
    btn.classList.remove("active");
    btn.addEventListener("click", () => {
      document.querySelectorAll(".topup-card").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedAmount = parseInt(btn.dataset["amount"] ?? "0", 10);
    });
  });

  document.getElementById("pay-btn")?.addEventListener("click", () => {
    void handlePay();
  });

  try {
    const stats = await getBalance();
    if (walletBalance) walletBalance.textContent = stats.package_title ?? "Пакет не выбран";
    if (stats.has_package) {
      notifications.info(`Текущий пакет: ${stats.package_title}. Осталось обработок: ${stats.package_generations_remaining}. Можно докупить пакет, генерации прибавятся к текущему остатку.`);
    }
  } catch {
    // non-critical
  }

  void loadPaymentHistory();
}

async function loadPaymentHistory(): Promise<void> {
  const container = document.getElementById("payment-history");
  if (!container) return;

  try {
    const payments = await getPayments();
    if (!payments.length) return;

    container.innerHTML = payments.map((p) => {
      const date = new Date(p.created_at).toLocaleDateString("ru-RU", {
        day: "2-digit", month: "2-digit", year: "numeric",
      });
      return `<div class="history-item">
        <span class="history-amount">${p.package_title ?? "Пакет"} — ${p.amount.toFixed(0)}₽</span>
        <span class="history-date">${date}</span>
      </div>`;
    }).join("");
  } catch {
    // non-critical
  }
}

async function handlePay(): Promise<void> {
  if (!selectedAmount || selectedAmount < 500) {
    notifications.error("Пожалуйста, выберите пакет");
    return;
  }

  const btn = document.getElementById("pay-btn") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  try {
    await handleYookassa(selectedAmount);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Ошибка";
    notifications.error(`Ошибка оплаты: ${msg}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleYookassa(amount: number): Promise<void> {
  const { confirmation_token, payment_id } = await createYookassaPayment(amount);

  if (!confirmation_token || !payment_id) {
    notifications.error("Не удалось создать платёж YooKassa");
    return;
  }

  await loadYookassaScript();

  let container = document.getElementById("yookassa-widget-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "yookassa-widget-container";
    document.getElementById("pay-btn")?.insertAdjacentElement("afterend", container);
  }
  container.innerHTML = "";

  const returnUrl = new URL(window.location.origin);
  returnUrl.searchParams.set("payment_success", "true");
  returnUrl.searchParams.set("payment_id", payment_id);

  const widget = new window.YooMoneyCheckoutWidget({
    confirmation_token,
    return_url: returnUrl.toString(),
    error_callback: (err) => notifications.error(`YooKassa ошибка: ${String(err)}`),
  });
  activeWidget = widget;
  widget.render("yookassa-widget-container");

  setTimeout(() => {
    const modal = document.getElementById("wallet-modal");
    if (modal) modal.scrollTo({ top: modal.scrollHeight, behavior: "smooth" });
  }, 150);
  widget.on("success", () => {
    void (async () => {
      try {
        const result = await confirmYookassaPayment(payment_id);
        const walletBalance = document.getElementById("wallet-balance");
        const headerBalance = document.getElementById("balance");
        if (walletBalance) walletBalance.textContent = result.package_title ?? "Пакет оплачен";
        if (headerBalance) headerBalance.textContent = result.package_title ?? "Пакет оплачен";
        const remaining = document.getElementById("free-generations");
        if (remaining) remaining.textContent = String(result.package_generations_remaining);
        notifications.success(result.credited ? "Пакет успешно оплачен. Обработки зачислены." : "Платёж уже был зачислен.");
      } catch {
        notifications.info("Платёж обрабатывается. Пакет обновится в ближайшее время.");
      }
    })();
  });
}

function loadYookassaScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.YooMoneyCheckoutWidget) { resolve(); return; }
    const script = document.createElement("script");
    script.src = "https://yookassa.ru/checkout-widget/v1/checkout-widget.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Не удалось загрузить виджет YooKassa"));
    document.head.appendChild(script);
  });
}
