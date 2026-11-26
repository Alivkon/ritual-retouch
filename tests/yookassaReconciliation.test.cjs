const assert = require("node:assert/strict");
const { test } = require("node:test");

process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.NODE_ENV = "test";
process.env.BOT_TOKEN = "test";
process.env.KIE_API_KEY = "test";
process.env.YOOKASSA_TOKEN = "test";
process.env.YOOKASSA_SHOP_ID = "test";
process.env.YOOKASSA_SECRET_KEY = "test";
process.env.ADMIN_ID = "1";
process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
process.env.MEDIA_URL_SECRET = "test-media-url-secret-with-at-least-32-bytes";

const database = require("../dist/database.js");
const { reconcileYookassaPayments } = require("../dist/services/yookassaReconciliation.js");

test("alerts admin only for succeeded YooKassa payments missing from the database", async (t) => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const cursor = url.searchParams.get("cursor");
    const body = cursor
      ? { items: [{ id: "known-payment", status: "succeeded", amount: { value: "500.00" } }] }
      : {
          items: [
            {
              id: "missing-payment",
              status: "succeeded",
              amount: { value: "1500.00" },
              metadata: { user_id: "42" },
            },
            { id: "pending-payment", status: "pending", amount: { value: "500.00" } },
          ],
          next_cursor: "next-page",
        };
    return { ok: true, json: async () => body };
  };
  t.after(() => { global.fetch = originalFetch; });

  const hasPayment = t.mock.method(database, "hasYookassaPayment", async (id) => id === "known-payment");
  const claimAlert = t.mock.method(database, "claimMissingYookassaPaymentAlert", async (id) => id === "missing-payment");
  const markAlert = t.mock.method(database, "markMissingYookassaPaymentAlertNotified", async () => undefined);
  const resolveAlert = t.mock.method(database, "resolveMissingYookassaPaymentAlert", async () => undefined);
  const messages = [];
  const bot = { api: { sendMessage: async (chatId, text) => messages.push({ chatId, text }) } };

  await reconcileYookassaPayments(bot);

  assert.equal(requests.length, 2);
  assert.equal(requests[1].searchParams.get("cursor"), "next-page");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].chatId, 1);
  assert.match(messages[0].text, /missing-payment/);
  assert.match(messages[0].text, /1500\.00₽/);
  assert.equal(hasPayment.mock.callCount(), 2);
  assert.equal(claimAlert.mock.callCount(), 1);
  assert.equal(markAlert.mock.callCount(), 1);
  assert.equal(resolveAlert.mock.callCount(), 1);
});
