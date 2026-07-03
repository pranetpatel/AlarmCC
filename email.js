/**
 * email.js — Resend email module for AlarmCC
 *
 * Usage:
 *   const { sendEmail, templates } = require('./email');
 *   await sendEmail({ to: 'client@example.com', ...templates.callSummary(conv) });
 */

const { Resend } = require("resend");

let resend;

function getBlockedDomains() {
  const raw = process.env.RESEND_BLOCKED_DOMAINS || "nssalarms.com,nssalarms";
  return raw.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
}

function validateFromAddress(from) {
  const lower = String(from).toLowerCase();
  for (const blocked of getBlockedDomains()) {
    if (lower.includes(blocked)) {
      throw new Error(
        `Blocked sender domain "${blocked}" in RESEND_FROM_EMAIL. ` +
        `Use onboarding@resend.dev for testing instead.`
      );
    }
  }
}

function getClient() {
  if (!resend) {
    if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY.startsWith("re_your_")) {
      throw new Error("RESEND_API_KEY is not configured. Add it to your .env file.");
    }
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

const FROM = process.env.RESEND_FROM_EMAIL || "AlarmCC Dispatch <onboarding@resend.dev>";

// ─────────────────────────────────────────────────────────────────────────────
// Core send function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send an email via Resend.
 * @param {{ to: string|string[], subject: string, html: string, text?: string }} opts
 * @returns {Promise<{ id: string }>}
 */
async function sendEmail({ to, subject, html, text }) {
  validateFromAddress(FROM);

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
  high:       "background:#fff3e0;color:#e65100",
  medium:     "background:#fff8e1;color:#f57f17",
  low:        "background:#e8f5e9;color:#2e7d32",
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

function listItems(items) {
  if (!items || !items.length) return '<p style="color:#999;font-size:14px;margin:0">None recorded</p>';
  return `<ul style="margin:0;padding-left:20px;font-size:14px;color:#333;line-height:1.6">
    ${items.map((i) => `<li>${escHtml(String(i))}</li>`).join("")}
  </ul>`;
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

/**
 * templates.postCallReport(report, meta)
 * Post-call incident report — sent when a phone call ends (any outcome).
 * @param {object} report — extracted call report JSON
 * @param {{ customerId: string, callerPhone?: string, duration?: number, timestamp?: string }} meta
 */
function postCallReportTemplate(report = {}, meta = {}) {
  const outcome  = (report.outcome || "unknown").toLowerCase();
  const panel    = report.panel || {};
  const risk     = (report.risk_level || "low").toLowerCase();
  const steps    = Array.isArray(report.steps_tried) ? report.steps_tried : [];
  const duration = meta.duration ? `${Math.round(meta.duration / 60)}m ${meta.duration % 60}s` : "Unknown";

  const OUTCOME_COLORS = {
    resolved:   { bg: "#1b5e20", label: "Resolved" },
    dispatched: { bg: "#bf360c", label: "Dispatched" },
    unresolved: { bg: "#4a148c", label: "Unresolved" },
    dropped:    { bg: "#37474f", label: "Dropped" },
  };
  const RISK_LABELS = {
    none: "None", low: "Low", medium: "Medium", high: "HIGH", life_safety: "⚠ LIFE SAFETY",
  };
  const oc = OUTCOME_COLORS[outcome] || { bg: "#37474f", label: outcome };

  const stepsHtml = steps.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr style="background:#f5f5f5">
          <th style="padding:8px 12px;text-align:left;color:#555;font-weight:600;width:60%">Step</th>
          <th style="padding:8px 12px;text-align:left;color:#555;font-weight:600">Result</th>
        </tr>
        ${steps.map((s, i) => `
        <tr style="background:${i % 2 ? "#fafafa" : "#fff"}">
          <td style="padding:8px 12px;border-top:1px solid #eee">${escHtml(s.step || "")}</td>
          <td style="padding:8px 12px;border-top:1px solid #eee;color:${s.result?.toLowerCase().includes("fail") ? "#c62828" : "#2e7d32"}">${escHtml(s.result || "—")}</td>
        </tr>`).join("")}
      </table>`
    : '<p style="font-size:14px;color:#999;margin:0">No steps attempted</p>';

  const subject = `Post-Call Report — ${oc.label} — ${panel.brand || "Unknown Panel"} ${panel.error_code ? `(${panel.error_code})` : ""}`.trim();

  const html = `
    <div style="${BASE_STYLE}">
      <div style="${CARD_STYLE}">
        <div style="background:${oc.bg};color:#fff;padding:28px 32px">
          <div style="font-size:11px;font-weight:700;letter-spacing:1px;opacity:.8;margin-bottom:4px">POST-CALL INCIDENT REPORT</div>
          <div style="font-size:24px;font-weight:700">${oc.label}</div>
          <div style="margin-top:6px;font-size:14px;opacity:.85">${escHtml(report.call_summary || "")}</div>
        </div>
        <div style="${BODY_STYLE}">
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            ${row("Call ID", meta.customerId)}
            ${row("Caller", meta.callerPhone || "Unknown")}
            ${row("Duration", duration)}
            ${row("Time", new Date(meta.timestamp || Date.now()).toLocaleString())}
            ${row("Risk Level", badge(RISK_LABELS[risk] || risk, risk === "life_safety" || risk === "high" ? "critical" : risk === "medium" ? "medium" : "low"))}
          </table>

          <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#111">Panel</div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            ${row("Brand", panel.brand)}
            ${row("Model", panel.model)}
            ${row("Error Code", panel.error_code)}
            ${row("Root Cause", report.root_cause)}
          </table>

          <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#111">Troubleshooting Steps</div>
          <div style="margin-bottom:24px">${stepsHtml}</div>

          ${outcome === "dispatched" ? `
          <div style="background:#fff3e0;border-radius:8px;padding:16px;margin-top:4px">
            <div style="font-size:12px;font-weight:700;color:#e65100;margin-bottom:6px">DISPATCH</div>
            <table style="width:100%;border-collapse:collapse">
              ${row("Type", report.dispatch_type)}
              ${row("Site", report.site_address)}
              ${row("Appointment", report.appointment_time)}
            </table>
            <p style="font-size:13px;color:#777;margin:8px 0 0">Full contractor brief sent separately.</p>
          </div>` : ""}
        </div>
        <div style="${FOOTER_STYLE}">AlarmCC — Post-Call Report &nbsp;|&nbsp; ${escHtml(meta.customerId || "")}</div>
      </div>
    </div>`;

  return { subject, html };
}

/**
 * templates.contractorDispatch(brief, meta)
 * On-call contractor dispatch brief — sent when dispatch is confirmed.
 * @param {object} brief — extracted dispatch JSON
 * @param {{ customerId: string, callerPhone?: string, timestamp?: string }} meta
 */
function contractorDispatchTemplate(brief = {}, meta = {}) {
  const customer = brief.customer || {};
  const system = brief.system || {};
  const issue = brief.issue || {};
  const dispatch = brief.dispatch_decision || {};
  const urgency = (dispatch.urgency || "medium").toLowerCase();
  const dispatchType = brief.dispatch_type || dispatch.dispatch_type || "immediate";
  const siteLabel = customer.address || customer.name || meta.customerId || "Unknown site";

  const subject = `ON CALL — Fire Alarm Dispatch — ${siteLabel} — ${urgency.toUpperCase()}`;

  const html = `
    <div style="${BASE_STYLE}">
      <div style="${CARD_STYLE}">
        <div style="background:#1a237e;color:#fff;padding:28px 32px">
          <div style="font-size:22px;font-weight:700">⚡ On-Call Dispatch</div>
          <div style="margin-top:8px;font-size:14px;opacity:.9">
            ${badge(urgency.toUpperCase(), urgency)} &nbsp;
            ${badge(dispatchType === "scheduled" ? "Scheduled" : "Immediate", "dispatched")}
          </div>
        </div>
        <div style="${BODY_STYLE}">
          ${brief.tech_brief ? `
          <div style="background:#e8eaf6;border-radius:8px;padding:16px;margin-bottom:24px">
            <div style="font-size:12px;font-weight:700;color:#1a237e;margin-bottom:6px">TECH BRIEF</div>
            <p style="font-size:15px;color:#111;margin:0;line-height:1.5">${escHtml(brief.tech_brief)}</p>
          </div>` : ""}

          <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#111">Site &amp; Contact</div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            ${row("Property", customer.name)}
            ${row("Address", customer.address)}
            ${row("Building Type", customer.building_type)}
            ${row("On-Site Contact", customer.name)}
            ${row("Contact Phone", customer.phone || meta.callerPhone)}
            ${row("Caller Phone", meta.callerPhone)}
          </table>

          <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#111">System</div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            ${row("Type", system.type)}
            ${row("Brand / Model", system.brand_model)}
            ${row("System ID", system.system_id_if_known)}
          </table>

          <div style="font-size:15px;font-weight:700;margin-bottom:12px;color:#111">Issue</div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            ${row("Description", issue.customer_description)}
            ${row("Error Code", issue.detected_error_code)}
            ${row("Likely Diagnosis", issue.likely_diagnosis)}
            ${row("Confidence", issue.confidence != null ? `${issue.confidence}%` : "")}
            ${row("Critical", issue.is_critical ? "YES" : "No")}
          </table>

          <div style="font-size:15px;font-weight:700;margin-bottom:8px;color:#111">Troubleshooting Already Attempted</div>
          <p style="font-size:13px;color:#666;margin:0 0 8px">Outcome: <strong>${escHtml(brief.troubleshooting_outcome || "not_attempted")}</strong></p>
          ${listItems(brief.troubleshooting_attempted)}

          <div style="font-size:15px;font-weight:700;margin:24px 0 12px;color:#111">Technician Prep</div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            ${row("Est. On-Site Time", dispatch.estimated_time_on_site ? `${dispatch.estimated_time_on_site} min` : "")}
            ${row("Est. Total Cost", dispatch.estimated_total_cost)}
            ${row("Appointment", brief.appointment_time)}
          </table>
          <div style="font-size:13px;font-weight:600;color:#555;margin-bottom:6px">Likely Parts Needed</div>
          ${listItems(dispatch.parts_likely_needed)}

          ${brief.customer_notes ? `
          <div style="background:#fff8e1;border-radius:8px;padding:16px;margin-top:16px">
            <div style="font-size:12px;font-weight:700;color:#f57f17;margin-bottom:6px">ACCESS &amp; NOTES</div>
            <p style="font-size:14px;color:#333;margin:0">${escHtml(brief.customer_notes)}</p>
          </div>` : ""}
        </div>
        <div style="${FOOTER_STYLE}">
          Ref: ${escHtml(meta.customerId || "")} &nbsp;|&nbsp;
          ${new Date(meta.timestamp || Date.now()).toLocaleString()} &nbsp;|&nbsp;
          AlarmCC Dispatch
        </div>
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
    contractorDispatch: contractorDispatchTemplate,
    postCallReport: postCallReportTemplate,
  },
};
