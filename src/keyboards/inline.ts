import { InlineKeyboard } from "grammy";
import { ADMIN_ID, TOPUP_OPTIONS, WEBAPP_URL } from "../config.js";

export function mainMenuKb(userId = 0): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("📷 Обработать фото", "generate")
    .row()
    .text("📦 Мой пакет", "balance")
    .text("➕ Пополнить", "topup")
    .row()
    .text("❓ Как это работает", "how_to");

  if (userId === ADMIN_ID) {
    kb.row().webApp("⚙️ Панель администратора", `${WEBAPP_URL}/admin`);
  }

  return kb;
}

export function topupAmountsKb(): InlineKeyboard {
  const kb = new InlineKeyboard();

  const options = [...TOPUP_OPTIONS];
  for (let i = 0; i < options.length; i += 2) {
    const a = options[i]!;
    const b = options[i + 1];
    if (b !== undefined) {
      kb.text(`${a}₽`, `topup_${a}`).text(`${b}₽`, `topup_${b}`).row();
    } else {
      kb.text(`${a}₽`, `topup_${a}`).row();
    }
  }

  kb.webApp("🌐 ЮMoney", `${WEBAPP_URL}/pay_yookassa`)
    .row()
    .text("◀️ Назад", "back_to_menu");

  return kb;
}

export function paywallKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Купить пакет", "topup")
    .row()
    .text("◀️ В меню", "back_to_menu");
}

export function backToMenuKb(): InlineKeyboard {
  return new InlineKeyboard().text("◀️ В меню", "back_to_menu");
}
