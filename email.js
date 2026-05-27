/**
 * email.js — Resend email module for AlarmCC
 *
 * Usage:
 *   const { sendEmail, templates } = require('./email');
 *   await sendEmail({ to: 'client@example.com', ...templates.callSummary(conv) });
 */

const { Resend } = require("resend");

let resend;

function getClient() {
  if (!resend) {
    if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY.startsWith("re_your_")) {
      throw new Error("RESEND_API_KEY is not configured. Add it to your .env file.");
    }
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

const FROM = process.env.RESEND_FROM_EMAIL || "AlarmCC Support <support@alarmcc.app>";

// ─────────────────────────────────────────────────────────────────────────────
// Core send function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send an email via Resend.
 * @param {{ to: string|string[], subject: string, html: string, text?: string }} opts
 * @returns {Promise<{ id: string }>}
 */
async function sendEmail({ to, subject, html, text }) {
  try {
    const client = getClient();
    const { data, error } = await client.emails.send({
      from: FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text: text || stripHtml(html),
    });

    if (error) {
      console.error("[Email] Resend error:", error);
      throw new Error(error.message);
    }

    console.log(`[Email] Sent → ${to} | subject: "${subject}" | id: ${data.id}`);
    return data;
  } catch (err) {
    console.error("[Email] Failed to send email:", err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

/** Shared base styles */
const BASE_STYLE = `
  font-family: -apple-system, 'Segoe UI', sans-serif;
  background: #f5f5f5;
  padding: 32px 0;
`;

const CARD_STYLE = `
  max-width: 600px;
  margin: 0 auto;
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0,0,0,.08);
`;

const HEADER_STYLE = `
  background: #ff4c2b;
  color: #fff;
  padding: 28px 32px;
`;

const BODY_STYLE = `padding: 28px 32px;`;
const FOOTER_STYLE = `
  padding: 16px 32px;
  background: #f9f9f9;
  border-top: 1px solid #eee;
  font-size: 12px;
  color: #999;
`;

const BADGE_STYLES = {
  active:     "background:#e3f2fd;color:#1565c0",
  resolved:   "background:#e8f5e9;color:#2e7d32",
  dispatched: "background:#fff3e0;color:#e65100",
  critical:   "background:#fce4ec;color:#c62828",
};

function badge(text, type = "active") {
  const s = BADGE_STYLES[type] || BADGE_STYLES.active;
  return `<span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;${s}">${text}</span>`;
}

function row(label, value) {
  if (!value) return "";
  return `
    <tr>
      <td style="padding:8px 0;color:#666;font-size:14px;width:40%;vertical-align:top">${label}</td>
      <td style="padding:8px 0;font-size:14px;color:#111;font-weight:500">${value}</td>
    </tr>`;
}

/**
 * templates.callSummary(conversation)
 * conversation = { customerId, status, messages: [{role, content}], createdAt }
 */
function callSummaryTemplate(conversation) {
  const { customerId, status, messages = [], createdAt } = conversation;
  const nonSystem = messages.filter((m) => m.role !== "system");
  const msgRows = nonSystem
    .map(
      (m) => `
      <div style="margin-bottom:12px">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;color:${
          m.role === "user" ? "#1565c0" : "#2e7d32"
        }">${m.role === "user" ? "Customer" : "AI Agent"}</span>
        <p style="margin:4px 0;font-size:14px;color:#333;line-height:1.5">${escHtml(m.content)}</p>
      </div>`
    )
    .join('<hr style="border:none;border-top:1px solid #eee;margin:8px 0">');

  const subject = `Call Summary — ${customerId}`;
  const html = `
    <div style="${BASE_STYLE}">
      <div style="${CARD_STYLE}">
        <div style="${HEADER_STYLE}">
          <div style="font-size:22px;font-weight:700">🔥 Fire Alarm AI Agent</div>
          <div style="margin-top:4px;font-size:14px;opacity:.9">Call Summary Report</div>
        </div>
        <div style="${BODY_STYLE}">
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            ${row("Call ID", customerId)}
            ${row("Status", badge(status, status))}
            ${row("Date", new Date(createdAt).toLocaleString())}
            ${row("Messages", String(nonSystem.length))}
          </table>
          <div style="margin-top:20px">
            <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#111">Conversation Transcript</div>
            ${msgRows || '<p style="color:#999;font-size:14px">No messages recorded.</p>'}
          </div>
        </div>
        <div style="${FOOTER_STYLE}">AlarmCC — Automated Fire Alarm Support System</div>
      </div>
    </div>`;

  return { subject, html };
}

/**
 * templates.escalationAlert(conversation)
 */
function escalationAlertTemplate(conversation) {
  const { customerId, status, messages = [] } = conversation;
  const lastMsg = messages.filter((m) => m.role !== "system").at(-1);

  const subject = `🚨 ESCALATION ALERT — ${customerId}`;
  const html = `
    <div style="${BASE_STYLE}">
      <div style="${CARD_STYLE}">
        <div style="background:#c62828;color:#fff;padding:28px 32px">
          <div style="font-size:22px;font-weight:700">🚨 Escalation Alert</div>
          <div style="margin-top:4px;font-size:14px;opacity:.9">Immediate attention required</div>
        </div>
        <div style="${BODY_STYLE}">
          <p style="font-size:15px;color:#c62828;font-weight:700;margin-bottom:20px">
            A call has been flagged for immediate escalation.
          </p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            ${row("Call ID", customerId)}
            ${row("Status", badge(status, "critical"))}
            ${row("Time", new Date().toLocaleString())}
          </table>
          ${lastMsg ? `
          <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:16px;margin-top:12px">
            <div style="font-size:12px;font-weight:700;color:#856404;margin-bottom:6px">LAST MESSAGE</div>
            <p style="font-size:14px;color:#333;margin:0">${escHtml(lastMsg.content)}</p>
          </div>` : ""}
          <p style="margin-top:20px;font-size:14px;color:#555">
            Please review this call immediately in the AlarmCC dashboard.
          </p>
        </div>
        <div style="${FOOTER_STYLE}">AlarmCC — Automated Fire Alarm Support System</div>
      </div>
    </div>`;

  return { subject, html };
}

/**
 * templates.confirmation(conversation)
 * Sent after dispatch is confirmed
 */
function confirmationTemplate(conversation) {
  const { customerId, status } = conversation;
  const subject = `Confirmation — Technician Dispatched for ${customerId}`;
  const html = `
    <div style="${BASE_STYLE}">
      <div style="${CARD_STYLE}">
        <div style="${HEADER_STYLE}">
          <div style="font-size:22px;font-weight:700">✅ Dispatch Confirmed</div>
          <div style="margin-top:4px;font-size:14px;opacity:.9">A technician is on the way</div>
        </div>
        <div style="${BODY_STYLE}">
          <p style="font-size:15px;color:#333;margin-bottom:20px">
            Your service request has been confirmed. A certified technician will visit your location.
          </p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            ${row("Reference ID", customerId)}
            ${row("Status", badge("Dispatched", "dispatched"))}
            ${row("Confirmed", new Date().toLocaleString())}
          </table>
          <div style="background:#e8f5e9;border-radius:8px;padding:16px;margin-top:8px">
            <p style="font-size:14px;color:#2e7d32;margin:0">
              📞 You will receive a call from the technician before arrival.
              Please have access to the alarm panel ready.
            </p>
          </div>
        </div>
        <div style="${FOOTER_STYLE}">AlarmCC — Automated Fire Alarm Support System</div>
      </div>
    </div>`;

  return { subject, html };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function escHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHtml(html = "") {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  sendEmail,
  templates: {
    callSummary: callSummaryTemplate,
    escalationAlert: escalationAlertTemplate,
    confirmation: confirmationTemplate,
  },
};
