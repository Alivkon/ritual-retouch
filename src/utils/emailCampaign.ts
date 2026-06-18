import crypto from "node:crypto";
import { WEBAPP_URL } from "../config.js";

export function makeKey(email: string): string {
  return crypto.createHash("md5").update(email.toLowerCase()).digest("hex");
}

export function pixelTag(campaign: string, mdKey: string): string {
  return `<img src="${WEBAPP_URL}/t/pixel?c=${encodeURIComponent(campaign)}&e=${mdKey}" width="1" height="1" style="display:none" alt="" />`;
}

export function ctaUrl(campaign: string, mdKey: string): string {
  const target = encodeURIComponent(WEBAPP_URL);
  return `${WEBAPP_URL}/t/click?c=${encodeURIComponent(campaign)}&e=${mdKey}&url=${target}`;
}

export function buildEmailHtml(campaign: string, mdKey: string): string {
  const cta = ctaUrl(campaign, mdKey);
  const pixel = pixelTag(campaign, mdKey);

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>3 бесплатные ретуши для вашего агентства</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0"
           style="background:#ffffff;border-radius:16px;padding:40px 36px;max-width:560px">
      <tr><td>
        <p style="margin:0 0 8px;font-size:13px;color:#999">ritual-retouch.ru</p>
        <h1 style="margin:0 0 24px;font-size:22px;font-weight:700;color:#111;line-height:1.3">
          3 бесплатные ретуши для вашего агентства
        </h1>

        <p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.6">
          Добрый день.
        </p>
        <p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.6">
          Коротко: мы сделали сервис, который восстанавливает и ретуширует портреты
          автоматически&nbsp;— за 1–3 минуты.
        </p>
        <p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.6">
          Загружаете фото&nbsp;→ получаете результат. Без дизайнеров, без ожидания, 24/7.
        </p>
        <p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.6">
          Работаем с агентствами пакетами&nbsp;— удобно планировать бюджет.
        </p>
        <p style="margin:0 0 28px;font-size:15px;color:#333;line-height:1.6">
          Выписываем счета для бухгалтерии.
        </p>

        <p style="margin:0 0 20px;font-size:15px;color:#333;line-height:1.6">
          Чтобы оценить качество&nbsp;— <strong>первые 3 обработки бесплатно</strong>
          по ссылке ниже.
        </p>

        <table cellpadding="0" cellspacing="0" style="margin:0 0 32px">
          <tr><td>
            <a href="${cta}"
               style="display:inline-block;padding:14px 28px;background:#2563eb;color:#ffffff;
                      text-decoration:none;border-radius:10px;font-size:15px;font-weight:600">
              Получить 3 бесплатные обработки →
            </a>
          </td></tr>
        </table>

        <p style="margin:0;font-size:13px;color:#999;line-height:1.5">
          С уважением,<br>
          Команда <a href="${WEBAPP_URL}" style="color:#2563eb;text-decoration:none">ritual-retouch.ru</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
${pixel}
</body>
</html>`;
}
