const assert = require("node:assert/strict");
const { test } = require("node:test");
const Fastify = require("fastify");

// Keep registration tests independent of production credentials and services.
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.NODE_ENV = "test";
for (const name of ["BOT_TOKEN", "KIE_API_KEY", "YOOKASSA_TOKEN", "YOOKASSA_SHOP_ID", "YOOKASSA_SECRET_KEY"]) {
  process.env[name] = "test";
}
process.env.ADMIN_ID = "1";
process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
process.env.MEDIA_URL_SECRET = "test-media-url-secret-with-at-least-32-bytes";

const database = require("../dist/database.js");
const emailService = require("../dist/email.js");
const bcrypt = require("bcrypt");
const { registerAuthRoutes } = require("../dist/web/auth.js");
const { isDisposableEmail } = require("../dist/utils/disposableEmail.js");
const domains = require("../dist/data/disposable-email-domains.json");

test("blocks listed domains, subdomains and normalized variants without matching unrelated domains", () => {
  assert.ok(domains.length > 0);
  assert.ok(domains.every((domain) => domain.endsWith(".ru")));
  for (const domain of domains) {
    assert.equal(isDisposableEmail(`user@${domain}`), true, domain);
  }
  for (const email of [
    "user@mailgu.ru", " user@MAILGU.RU ", "user@sub.mailgu.ru",
    "user@mailgu.ru.", "user@ｍａｉｌｇｕ.ru",
  ]) {
    assert.equal(isDisposableEmail(email), true, email);
  }
  for (const domain of [
    "mail.ru", "inbox.ru", "list.ru", "bk.ru", "yandex.ru", "ya.ru", "rambler.ru",
    "gmail.com", "outlook.com", "icloud.com", "proton.me", "protonmail.com", "tuta.com",
    "notmailgu.ru", "mailgu.ru.example.org", "maxxspace.com", "yopmail.com",
  ]) {
    assert.equal(isDisposableEmail(`user@${domain}`), false, domain);
  }
  assert.equal(isDisposableEmail("mailgu.ru"), false);
});

test("registration rejects disposable, non-.ru and malformed emails before database, hashing or mail calls", async (t) => {
  const calls = [
    t.mock.method(database, "findUserByEmail"),
    t.mock.method(database, "createWebUser"),
    t.mock.method(database, "createEmailVerification"),
    t.mock.method(bcrypt, "hash"),
    t.mock.method(emailService, "sendVerificationEmail"),
  ];
  const app = Fastify();
  registerAuthRoutes(app);
  t.after(() => app.close());

  for (const email of [
    "user@mailgu.ru", " USER@MAILGU.RU ", "user@sub.mailgu.ru",
    "user@mailgu.ru.", "user@ｍａｉｌｇｕ.ru",
    "user@mailgu.ru@", "user@@mailgu.ru", "user@ mailgu.ru", "user@", "@mail.ru",
  ]) {
    const response = await app.inject({
      method: "POST", url: "/api/auth/register", payload: { email, password: "password123" },
    });
    assert.equal(response.statusCode, 400, email);
    assert.equal(typeof response.json().error, "string");
  }
  for (const email of [
    "user@gmail.com", " USER@GMAIL.COM ", "user@yopmail.com", "user@example.org",
    "user@example.su", "user@example.ru.com", "user@ru", "user@example.рф",
  ]) {
    const response = await app.inject({
      method: "POST", url: "/api/auth/register", payload: { email, password: "password123" },
    });
    assert.equal(response.statusCode, 400, email);
    const expectedError = email === "user@ru"
      ? "Неверный email или пароль слишком короткий (минимум 6 символов)"
      : "Это российский сервис — Вы можете использовать только почту из зоны «.ru» (КоАП РФ ст. 13,55)";
    assert.equal(response.json().error, expectedError, email);
  }
  for (const call of calls) assert.equal(call.mock.callCount(), 0);
});

test("registration accepts a permanent email and sends verification for the normalized address", async (t) => {
  const findUser = t.mock.method(database, "findUserByEmail", async () => null);
  t.mock.method(bcrypt, "hash", async () => "test-password-hash");
  const createUser = t.mock.method(database, "createWebUser", async () => ({ user_id: 42 }));
  t.mock.method(database, "createEmailVerification", async () => "test-verification-token");
  const sendEmail = t.mock.method(emailService, "sendVerificationEmail", async () => {});
  const app = Fastify();
  registerAuthRoutes(app);
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { email: " User@Mail.Ru ", password: "password123" },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(findUser.mock.calls[0].arguments, ["user@mail.ru"]);
  assert.deepEqual(createUser.mock.calls[0].arguments, ["user@mail.ru", "test-password-hash"]);
  assert.deepEqual(sendEmail.mock.calls[0].arguments, ["user@mail.ru", "test-verification-token"]);
});
