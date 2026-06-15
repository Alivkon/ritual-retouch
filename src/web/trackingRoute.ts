import type { FastifyInstance } from "fastify";
import nodemailer from "nodemailer";
import { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, WEBAPP_URL } from "../config.js";
import {
  addEmailRecipient,
  logEmailOpen,
  logEmailClick,
  getCampaignStats,
  getCampaignDetails,
  getAllCampaignsStats,
} from "../database.js";
import { buildEmailHtml } from "../utils/emailCampaign.js";
import { resolveGeoIps } from "../utils/geoip.js";
import { parseUserAgent } from "../utils/userAgent.js";

// 1×1 transparent GIF
const PIXEL_BUF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

const ALLOWED_REDIRECT_HOST = new URL(WEBAPP_URL).hostname;

function clientIp(req: { headers: Record<string, string | string[] | undefined>; ip: string }): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = typeof fwd === "string" ? fwd.split(",")[0]?.trim() : req.ip;
  return raw ?? req.ip;
}

export function registerTrackingRoutes(fastify: FastifyInstance): void {
  // Pixel — tracks email open
  fastify.get<{ Querystring: { c?: string; e?: string } }>(
    "/t/pixel",
    async (req, reply) => {
      const campaign = (req.query.c ?? "").slice(0, 50);
      const mdKey = (req.query.e ?? "").slice(0, 32);
      if (campaign && mdKey) {
        await logEmailOpen(
          campaign,
          mdKey,
          clientIp(req as Parameters<typeof clientIp>[0]),
          (req.headers["user-agent"] as string | undefined) ?? "",
        ).catch(() => undefined);
      }
      return reply
        .header("Content-Type", "image/gif")
        .header("Cache-Control", "no-store, no-cache, must-revalidate")
        .header("Pragma", "no-cache")
        .send(PIXEL_BUF);
    },
  );

  // Click — tracks click, then redirects
  fastify.get<{ Querystring: { c?: string; e?: string; url?: string } }>(
    "/t/click",
    async (req, reply) => {
      const campaign = (req.query.c ?? "").slice(0, 50);
      const mdKey = (req.query.e ?? "").slice(0, 32);
      const rawUrl = req.query.url ?? "";

      // Validate redirect target — only our own domain allowed
      let target = WEBAPP_URL;
      try {
        const parsed = new URL(rawUrl);
        if (parsed.hostname === ALLOWED_REDIRECT_HOST) target = rawUrl;
      } catch {
        // keep default
      }

      if (campaign && mdKey) {
        await logEmailClick(
          campaign,
          mdKey,
          clientIp(req as Parameters<typeof clientIp>[0]),
          (req.headers["user-agent"] as string | undefined) ?? "",
        ).catch(() => undefined);
      }

      return reply.redirect(target, 302);
    },
  );

  // Admin: send campaign
  fastify.post<{ Body: { campaign?: string; emails?: string[] } }>(
    "/api/admin/send-campaign",
    async (req, reply) => {
      const campaign = (req.body.campaign ?? "").trim().slice(0, 50);
      const emails = req.body.emails;

      if (!campaign || !Array.isArray(emails) || emails.length === 0) {
        return reply.code(400).send({ error: "campaign and emails[] required" });
      }

      const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      });

      let sent = 0;
      let failed = 0;

      for (const email of emails) {
        const normalized = email.trim().toLowerCase();
        if (!normalized || !normalized.includes("@")) { failed++; continue; }
        try {
          const mdKey = await addEmailRecipient(normalized);
          const html = buildEmailHtml(campaign, mdKey);
          await transporter.sendMail({
            from: `"Ritual Retouch" <${SMTP_FROM}>`,
            to: normalized,
            subject: "3 бесплатные ретуши для вашего агентства",
            html,
          });
          sent++;
        } catch {
          failed++;
        }
      }

      return reply.send({ sent, failed });
    },
  );

  // Admin: campaign stats
  fastify.get<{ Querystring: { campaign?: string } }>(
    "/api/admin/campaign-stats",
    async (req, reply) => {
      const campaign = (req.query.campaign ?? "").trim().slice(0, 50);
      if (!campaign) return reply.code(400).send({ error: "campaign required" });
      const stats = await getCampaignStats(campaign);
      return reply.send(stats);
    },
  );

  // Admin: all campaigns stats
  fastify.get("/api/admin/all-campaign-stats", async (_req, reply) => {
    const stats = await getAllCampaignsStats();
    return reply.send(stats);
  });

  // Admin: per-recipient details for one campaign
  fastify.get<{ Querystring: { campaign?: string } }>(
    "/api/admin/campaign-details",
    async (req, reply) => {
      const campaign = (req.query.campaign ?? "").trim().slice(0, 50);
      if (!campaign) return reply.code(400).send({ error: "campaign required" });

      const rows = await getCampaignDetails(campaign);

      // Geo lookup for all unique IPs
      const ips = rows.map(r => r.ip).filter(Boolean) as string[];
      const geo = await resolveGeoIps(ips);

      // Detect suspicious IPs: same IP across >2 recipients = mail scanner
      const ipFreq = new Map<string, number>();
      for (const r of rows) if (r.ip) ipFreq.set(r.ip, (ipFreq.get(r.ip) ?? 0) + 1);

      const enriched = rows.map(r => {
        const { device, os, client } = parseUserAgent(r.user_agent ?? '');
        const location = r.ip ? geo.get(r.ip) : null;
        const suspicious = r.open_count > 3 || (r.ip ? (ipFreq.get(r.ip) ?? 0) > 2 : false);
        return {
          email: r.email,
          opened_at: r.opened_at,
          clicked_at: r.clicked_at,
          open_count: r.open_count,
          ip: r.ip,
          user_agent: r.user_agent,
          country: location?.country ?? '',
          city: location?.city ?? '',
          device,
          os,
          client,
          suspicious,
        };
      });

      return reply.send(enriched);
    },
  );
}
