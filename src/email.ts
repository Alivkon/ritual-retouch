import nodemailer from "nodemailer";
import { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, WEBAPP_URL, TELEGRAM_BOT_USERNAME } from "./config.js";

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const link = `${WEBAPP_URL}/api/auth/verify?token=${token}`;
  await transporter.sendMail({
    from: `"Memorial Retouch AI" <${SMTP_FROM}>`,
    to: email,
    bcc: SMTP_FROM,
    subject: "Подтвердите email — Memorial Retouch AI",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#333">Подтверждение email</h2>
        <p>Для завершения регистрации нажмите кнопку:</p>
        <a href="${link}"
           style="display:inline-block;padding:12px 24px;background:#6366f1;color:#fff;
                  text-decoration:none;border-radius:8px;font-weight:bold">
          Подтвердить email
        </a>
        <p style="color:#555;font-size:14px;margin-top:20px">
          Telegram-бот сервиса: <a href="https://t.me/${TELEGRAM_BOT_USERNAME}">@${TELEGRAM_BOT_USERNAME}</a>
        </p>
        <p style="color:#888;font-size:13px;margin-top:24px">
          Ссылка действует 24 часа. Если вы не регистрировались — просто проигнорируйте письмо.
        </p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const link = `${WEBAPP_URL}/?reset_token=${token}`;
  await transporter.sendMail({
    from: `"Memorial Retouch AI" <${SMTP_FROM}>`,
    to: email,
    bcc: SMTP_FROM,
    subject: "Восстановление пароля — Memorial Retouch AI",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#333">Восстановление пароля</h2>
        <p>Чтобы задать новый пароль, нажмите кнопку:</p>
        <a href="${link}"
           style="display:inline-block;padding:12px 24px;background:#6366f1;color:#fff;
                  text-decoration:none;border-radius:8px;font-weight:bold">
          Сбросить пароль
        </a>
        <p style="color:#555;font-size:14px;margin-top:20px">
          Telegram-бот сервиса: <a href="https://t.me/${TELEGRAM_BOT_USERNAME}">@${TELEGRAM_BOT_USERNAME}</a>
        </p>
        <p style="color:#888;font-size:13px;margin-top:24px">
          Ссылка действует 1 час. Если вы не запрашивали восстановление пароля — просто проигнорируйте письмо.
        </p>
      </div>
    `,
  });
}
