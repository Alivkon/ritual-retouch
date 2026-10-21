import disposableEmailDomains from "../../../src/data/disposable-email-domains.json";

const blockedDomains = new Set(disposableEmailDomains);
const RU_DOMAIN_MESSAGE = "Это российский сервис — Вы можете использовать только почту из зоны «.ru» (КоАП РФ ст. 13,55)";
const DISPOSABLE_EMAIL_MESSAGE = "Этот домен относится к сервису временной почты. Для регистрации используйте постоянный почтовый ящик.";

export function getRegistrationEmailError(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  if (!email.endsWith(".ru")) return RU_DOMAIN_MESSAGE;

  let domain: string;
  try {
    domain = new URL(`http://${email.slice(email.lastIndexOf("@") + 1)}`).hostname;
  } catch {
    return null;
  }

  while (domain.includes(".")) {
    if (blockedDomains.has(domain)) return DISPOSABLE_EMAIL_MESSAGE;
    domain = domain.slice(domain.indexOf(".") + 1);
  }
  return null;
}
