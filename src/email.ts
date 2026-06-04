import nodemailer from "nodemailer";
import { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, WEBAPP_URL } from "./config.js";

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
        <p style="color:#888;font-size:13px;margin-top:24px">
          Ссылка действует 24 часа. Если вы не регистрировались — просто проигнорируйте письмо.
        </p>
      </div>
    `,
  });
}
