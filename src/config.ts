import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export const BOT_TOKEN = required("BOT_TOKEN");
export const KIE_API_KEY = required("KIE_API_KEY");
export const YOOKASSA_TOKEN = required("YOOKASSA_TOKEN");
export const ADMIN_ID = parseInt(required("ADMIN_ID"), 10);

export const GENERATION_COST = parseInt(optional("GENERATION_COST", "20"), 10);
export const DISCOUNTED_COST = parseInt(optional("DISCOUNTED_COST", "5"), 10);
export const DISCOUNTED_USER_IDS: Set<number> = new Set(
  (optional("DISCOUNTED_USER_IDS", ""))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
);
export const MIN_TOPUP = parseInt(optional("MIN_TOPUP", "100"), 10);
export const DATABASE_URL = required("DATABASE_URL");
export const FREE_GENERATIONS = parseInt(optional("FREE_GENERATIONS", "3"), 10);

export const TOPUP_OPTIONS = [100, 500, 1000, 2000] as const;

export const YOOKASSA_SHOP_ID = required("YOOKASSA_SHOP_ID");
export const YOOKASSA_SECRET_KEY = required("YOOKASSA_SECRET_KEY");
export const WEBAPP_URL = optional("WEBAPP_URL", "https://ritual-retouch.ru");
export const WEB_SERVER_PORT = parseInt(optional("WEB_SERVER_PORT", "8080"), 10);

export const SMTP_HOST = optional("SMTP_HOST", "smtp.beget.com");
export const SMTP_PORT = parseInt(optional("SMTP_PORT", "465"), 10);
export const SMTP_USER = optional("SMTP_USER", "");
export const SMTP_PASS = optional("SMTP_PASS", "");
export const SMTP_FROM = optional("SMTP_FROM", "");
