import { domainToASCII } from "node:url";
import disposableEmailDomains from "../data/disposable-email-domains.json";

const blockedDomains = new Set(disposableEmailDomains);

export function isDisposableEmail(email: string): boolean {
  const separator = email.lastIndexOf("@");
  if (separator < 0) return false;

  let domain = domainToASCII(email.slice(separator + 1).trim().toLowerCase()).replace(/\.$/, "");
  while (domain.includes(".")) {
    if (blockedDomains.has(domain)) return true;
    domain = domain.slice(domain.indexOf(".") + 1);
  }
  return false;
}
