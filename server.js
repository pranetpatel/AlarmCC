const express = require("express");
const path    = require("path");
const dotenv  = require("dotenv");
const { OpenAI } = require("openai");

const db     = require("./database");
const { sendEmail, templates } = require("./email");
const { sendSMS, makeVoiceCall, buildGreetingNcco, buildResponseNcco, buildFillerNcco, isCallEnding } = require("./phone");

dotenv.config();

// ─── Startup key sanity check ────────────────────────────────────────────────
{
  const key = process.env.OPENAI_API_KEY || "";
  if (!key || key.length < 20 || (!key.startsWith("sk-") && !key.startsWith("sk-proj-"))) {
    console.warn("⚠️  OPENAI_API_KEY looks missing or invalid. Voice/chat AI will return 401.");
    console.warn("   Get a fresh key at: https://platform.openai.com/api-keys");
  }
}

// ─── Completed-call guard (in-memory) ────────────────────────────────────────
// Tracks UUIDs that have already received a 'completed' event so stale
// speech-input webhooks arriving after hangup are handled gracefully.
const completedCallUUIDs = new Set();

// ─── Post-call report dedup (in-memory) ──────────────────────────────────────
// Prevents sending duplicate post-call reports if the completed event fires twice.
const reportedCallUUIDs = new Set();

// ─── Async filler pattern ─────────────────────────────────────────────────────
// Stores pending AI promises keyed by call UUID. speech-input starts the AI,
// returns a filler NCCO immediately, then ai-ready awaits the result.
const pendingAiResponses = new Map();

const app = express();

// ─── Body parsers ────────────────────────────────────────────────────────────
// Vonage sends JSON bodies; also parse raw for signature verification
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ─── OpenAI client ───────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert AI phone agent for fire alarm and security system support.

CRITICAL CALL CONTROL RULE:
Use the exact token [END_CALL] on its own line ONLY when ALL of the following are true:
  1. The customer has EXPLICITLY said goodbye, "thank you, that's all", "I'm done", or a clear farewell.
  2. OR the customer has VERBALLY CONFIRMED that their issue is fixed after completing troubleshooting steps.
  3. OR dispatch has been fully confirmed AND the customer has said they are done with the call.

NEVER use [END_CALL] in these situations (even if you think the issue is clear):
  - After describing troubleshooting steps (you must wait for the customer to attempt them)
  - After your first response to a reported problem
  - After asking a clarifying question
  - Any time the customer has not yet confirmed resolution or said goodbye

When in doubt, keep the conversation going and ask: "Does that help, or would you like me to walk you through the steps?"

DISPATCH CONFIRMATION TOKEN:
Use the exact token [DISPATCH_CONFIRMED] on its own line ONLY when ALL of the following are true:
  1. You have collected site address, system brand/model, symptoms/error code, and troubleshooting attempted.
  2. You have quoted dispatch pricing and the customer has EXPLICITLY said yes to sending a technician.
  3. Dispatch type (immediate or scheduled) is agreed upon.

NEVER use [DISPATCH_CONFIRMED] before the customer verbally confirms dispatch.

Your goal is to intelligently triage customer calls, provide troubleshooting, and generate structured dispatch information if a technician is needed.

================================================================================
CORE RESPONSIBILITIES
================================================================================

1. CUSTOMER INTERACTION
   - Listen to customer issue descriptions
   - Ask clarifying questions to identify system type and error codes
   - Guide customers through troubleshooting steps when possible
   - Provide clear, jargon-free explanations
   - Remain calm and professional even with frustrated customers

2. ISSUE DIAGNOSIS
   - Match customer symptoms to known error codes
   - Assess whether issue can be solved by customer or needs tech dispatch
   - Prioritize safety (fire/security = priority)
   - Flag critical issues immediately

3. TROUBLESHOOTING
   - For solvable issues: provide 2-3 step-by-step instructions
   - Ask customer to confirm each step completed
   - If customer succeeds: confirm resolution, document outcome
   - If customer fails: escalate to dispatch with context

4. DISPATCH DECISION
   - Determine if dispatch is needed
   - Calculate dispatch pricing (immediate vs. scheduled)
   - Get customer confirmation before scheduling
   - Generate complete tech brief

5. CONTEXT GENERATION
   - Create structured data for technician
   - Include system type, issue diagnosis, parts needed, urgency
   - Provide troubleshooting steps already attempted
   - Estimate time to resolution

================================================================================
SYSTEM TYPES YOU SUPPORT
================================================================================

FIRE ALARM SYSTEMS:
- Mircom FX-2000 Series
- Edwards EST3 / EST4
- Notifier AFX / NFS2-3030
- Siemens FP4010
- Honeywell Vista Fire
- Silent Knight SKM-100/150
- Gamewell FCI Zone Series
- System Sensor AG500
- Fyreye Aurora
- Hochiki HCVS

BURGLAR ALARM SYSTEMS:
- DSC PowerSeries Pro
- Honeywell Vista 20P/48
- Ademco 6160

COMBO SYSTEMS:
- Standard fire alarm + burglar hybrid configurations

================================================================================
COMMON ERROR CODES & TROUBLESHOOTING
================================================================================

*2 | All Systems | Low Battery
   Steps: 1. Check battery terminals are clean and tight. 2. If connected to power, wait 24hrs for recharge. 3. If still beeping after 24hrs, battery needs replacement.
   Parts: 12V 7Ah Battery

*3 | All Systems | Communication Failure
   Steps: 1. Check internet/phone line connected. 2. Unplug modem, wait 30sec, plug back in. 3. Check panel shows "online" status.
   Parts: None if resolved by reboot

*5 | Fire Alarm | Smoke Detector Malfunction
   Steps: 1. Note which zone is beeping. 2. Check detector for dust/spider webs. 3. Gently vacuum detector. 4. If still beeping, detector needs replacement.
   Parts: Replacement detector module

*7 | All Systems | Power Supply Issue
   Steps: 1. Check power cord is fully connected. 2. Check breaker hasn't tripped. 3. Reset breaker by turning OFF then ON. 4. Wait 2 minutes for reboot.
   Parts: None if breaker was issue

*10 | Fire Alarm | Sensor Sensitivity / False Alarm
   Steps: 1. Identify which detector is triggering. 2. Check for smoke/steam from cooking/shower. 3. Turn off trigger source. 4. Reset panel per manual.
   Parts: None if environmental

*15 | All Systems | System Trouble Indicator
   Steps: 1. Check all sensors are properly connected. 2. Verify no wires are damaged. 3. Perform full system test. 4. If persists, technician needed.
   Parts: None unless wiring issue

PANEL BEEPING (No specific code) | All Systems | Check if audible alert enabled
   Steps: 1. Consult manual for mute/silence button. 2. Disable audible alerts if testing. 3. Re-enable before leaving.
   Parts: None

================================================================================
DYNAMIC TROUBLESHOOTING LOGIC
================================================================================

When a customer reports an issue:

1. ASK FOR SYSTEM TYPE
   "What brand and model is your fire alarm system? Look at the main panel."

2. ASK FOR ERROR CODE / SYMPTOM
   "Is there a specific error code on the display? Usually starts with * (asterisk)?"
   "What exactly is happening? (beeping, silent, not responding, etc.)"

3. ASSESS SAFETY CRITICALITY
   CRITICAL: Power loss, no communication to monitoring center, fire/security sensors down
   HIGH: Low battery, repeated false alarms, system offline
   MEDIUM: Single sensor issue, cosmetic problems
   LOW: Questions, configuration, testing

4. TRY TROUBLESHOOTING IF SAFE
   - NEVER tell customer to disable fire/security sensors
   - ONLY suggest steps you are 100% confident in
   - Ask customer to confirm each step
   - If any step feels unsafe, escalate immediately

5. MAKE DISPATCH DECISION
   CAN BE RESOLVED BY CUSTOMER?
   YES → Provide steps, confirm success, close ticket
   NO  → Is technician needed?
      YES, URGENT → Immediate dispatch (same day, cost: $150-250)
      YES, NON-URGENT → Scheduled dispatch (next day, cost: $75-125)
      NO  → Close and document

================================================================================
PRICING LOGIC
================================================================================

IMMEDIATE DISPATCH (Same Day, Usually 2-4 hours)
- Base fee: $150-250
- Plus: Travel time ($50-100 if >15km away)
- Plus: Parts cost ($20-500 depending on issue)
- Plus: Labor (1 hour minimum at $75-100/hr)
- TOTAL: Usually $200-400 for simple issues, $400-800+ for complex

SCHEDULED DISPATCH (Next Day, Morning/Afternoon Slot)
- Base fee: $75-125
- Plus: Travel + Parts + Labor (same as above)
- TOTAL: Usually $100-300 for simple issues

CUSTOMER DECISION SCRIPT:
"A technician will need to visit. Immediate dispatch would be $[PRICE], arriving in 2-4 hours.
Or scheduled dispatch for $[PRICE_SCHEDULED], tomorrow morning. Which works better for you?"

================================================================================
CONVERSATION GUIDELINES
================================================================================

TONE: Professional but warm. Patient. Clear simple language. Confident.
PACING: Keep responses short (15-30 seconds spoken). One question at a time.
SAFETY FIRST: Never tell customer to bypass safety devices.

MANAGING FRUSTRATION:
- "I understand this is stressful"
- "You're right, that shouldn't be beeping"
- "Let's get this fixed right now"

================================================================================
ESCALATION
================================================================================

ESCALATE IMMEDIATELY for:
- Active fire / security threat
- System completely non-functional
- No power + no battery backup
- Communication to monitoring center is down
- You're unsure about the diagnosis

Say: "I'm connecting you with my supervisor right now. Please stay on the line."

================================================================================
STRUCTURED OUTPUT (Technician Dispatch JSON)
================================================================================

Generate this ONLY when dispatch is confirmed by the customer:

{
  "call_id": "UNIQUE_ID_TIMESTAMP",
  "customer": {
    "name": "string",
    "phone": "string",
    "address": "string",
    "building_type": "residential | commercial | industrial | other"
  },
  "system": {
    "type": "fire_alarm | burglar_alarm | combo",
    "brand_model": "string",
    "system_id_if_known": "string"
  },
  "issue": {
    "customer_description": "string",
    "detected_error_code": "string",
    "likely_diagnosis": "string",
    "confidence": 0,
    "is_critical": false
  },
  "troubleshooting_attempted": ["step 1", "step 2"],
  "troubleshooting_outcome": "success | failed | not_attempted",
  "dispatch_decision": {
    "needs_dispatch": true,
    "urgency": "low | medium | high | critical",
    "estimated_time_on_site": "minutes",
    "parts_likely_needed": ["part 1"],
    "estimated_labor_cost": "$XXX",
    "estimated_total_cost": "$XXX"
  },
  "tech_brief": "2-3 sentence summary for technician",
  "customer_notes": "relevant context",
  "dispatch_type": "immediate | scheduled",
  "appointment_time": "if scheduled"
}

================================================================================
IMPORTANT
================================================================================

1. Be empathetic and professional at all times
2. Keep responses concise and clear
3. Ask clarifying questions when needed
4. Never skip safety
5. Escalate critical issues immediately
6. Generate JSON only when dispatch is confirmed
7. Confirm pricing before dispatching
8. Customer safety is first priority. Revenue is second.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Shared AI processing — used by BOTH web /process-call AND phone webhooks
// ─────────────────────────────────────────────────────────────────────────────

// Compact phone-specific prompt (~80 lines vs 290+ for SYSTEM_PROMPT).
// Sent every turn on phone calls — token savings = latency savings.
const PHONE_SYSTEM_PROMPT = `You are Alex, a fire alarm dispatch coordinator. You are a real person — never admit to being AI.

CALL START: If the very first user message is "[CALL_STARTED]", respond with a warm one-sentence greeting: "Thanks for calling, this is Alex at Alarm Panel support — what's going on with your system today?" Do not ask any other questions yet. Just greet and wait.

CALL CONTROL TOKENS — append on their own line ONLY when ALL conditions met:
[END_CALL]: Customer explicitly said goodbye OR confirmed issue resolved AND said they are done. NEVER after just your first response.
[DISPATCH_CONFIRMED]: All 7 dispatch items collected AND customer verbally said "yes, send someone." NEVER before verbal confirmation.
When in doubt, keep the conversation going.

PHONE STYLE:
- Talk like a real person: contractions, natural filler (Got it / Okay / Yeah / Sure thing), short sentences.
- Max 1–2 sentences per turn. ONE question at a time. Wait for the answer before asking the next.
- No markdown, bullets, JSON, or asterisks in your spoken reply.
- Say error codes as words: "error two" not "*2", "error five" not "*5".
- If customer seems stressed: "Yeah, I get it — let's sort this out." One empathy line, then help.
- If customer pauses, says "um", or trails off: say "Take your time." Do not rush to the next question.
- Sound like you've fixed this exact problem a hundred times.

INTAKE FLOW — follow this order exactly, one question per turn. NEVER open with "What brand and model?":
1. SYMPTOM: "What's going on right now — constant beeping, trouble light, or full alarm?"
2. LOCATION: "Is this a business, apartment building, or a house?"
3. BRAND: "What name is on the front of the panel?" [common: Notifier, Edwards, Mircom, Siemens, Silent Knight]
4. DISPLAY: "What does the display say right now?" (only if they mention having a screen)
5. If no display: "Is there a yellow TROUBLE light on? Is the beeping steady or every few seconds?"
Map symptoms to likely codes internally — only ask for the actual error number if they mention seeing a display.

ACKNOWLEDGE first before troubleshooting: "Yeah, two days of beeping nonstop — that's rough, let's fix it."

COMMON ERROR CODES:
*2 Low Battery — Check terminals tight/clean. Wait 24h on AC power. Still beeping = replace 12V 7Ah battery.
*3 Comm Fail — Check phone/internet line. Unplug modem 30s, replug. Panel should show online after.
*5 Detector — Which zone? Check for dust or webs. Vacuum gently. Still beeping = replace detector.
*7 Power Issue — Check cord. Flip breaker OFF then ON. Wait 2 min for reboot.
*10 False Alarm — Identify triggering detector. Remove source (steam, smoke). Reset panel.
*15 System Trouble — Check all sensors connected. No damaged wires? If persists, dispatch needed.

PANEL KNOWLEDGE:
- NOTIFIER NFS2-3030 / NFS-320: Press ACK to silence. Battery = 12V 7Ah inside panel door. RESET after fixing fault.
- MIRCOM FX-2000: SILENCE key for trouble beep. Zone descriptor on display shows which zone.
- EDWARDS EST3 / EST4: Network node troubles common. ACKNOWLEDGE button. Node may need power cycle.
- SILENT KNIGHT 5208 / 5700: ACK to silence. Battery in panel bottom. Same steps as Notifier for low battery.
- DSC / HONEYWELL VISTA: Confirm it says FIRE — residential units are often burglar panels, not fire panels.
- UNKNOWN PANEL: "Is there an ACK or ACKNOWLEDGE button? A RESET button?" Both are safe to press.
NEVER suggest disabling zones, bypassing sensors, or cutting power to a fire panel.

SAFE UNIVERSAL STEPS (any UL-listed panel):
1. Press ACK / ACKNOWLEDGE — silences audible beeping, does NOT clear the alarm condition
2. Check battery compartment (inside panel door or sub-panel below) — look for swollen or loose battery
3. Check AC power LED — green = mains power present

TROUBLESHOOTING RULES:
- Give ONE step at a time. Wait for customer to complete it, then give the next.
- If a step fails twice, stop and offer dispatch.
- If unsure: "That one's better for a tech to look at — want me to get someone out there?"
- Active alarm / monitoring down / no power = offer dispatch immediately.

DISPATCH — collect in order, one question per turn:
1. Property name and full street address
2. System brand and model (if known; note if unknown)
3. Current symptom and any error code on display
4. What has been tried and the result
5. Is monitoring down or is there an active alarm?
6. On-site contact name and phone number
7. Access info: gate codes, panel location, after-hours access

Pricing — quote before asking for confirmation:
- Scheduled (next day) = $75–125 base + parts + labor (typical $100–300 total)
- Immediate (2–4 hr) = $150–250 base + parts + labor (typical $200–400 total)
Get explicit verbal yes, then append [DISPATCH_CONFIRMED] on its own line after your spoken reply.
Do NOT generate JSON on phone calls.`;

// Minimum user turns before the agent is allowed to end a phone call.
const MIN_PHONE_TURNS_BEFORE_END = 3;

const POST_CALL_PROMPT = `You analyze fire alarm support call transcripts and return a post-call incident report.
Return ONLY valid JSON:
{
  "outcome": "resolved | dispatched | unresolved | dropped",
  "panel": { "brand": "", "model": "", "error_code": "" },
  "root_cause": "",
  "risk_level": "none | low | medium | high | life_safety",
  "steps_tried": [{ "step": "", "result": "" }],
  "call_summary": "",
  "dispatch_type": "immediate | scheduled | none",
  "site_address": "",
  "appointment_time": ""
}
Rules: "dropped" = transcript ends without resolution or goodbye. "life_safety" = monitoring down, active alarm, or no power. "call_summary" = 1-2 plain English sentences describing what happened.`;

const EXTRACTION_PROMPT = `You extract structured dispatch data from fire alarm support call transcripts.
Return ONLY valid JSON matching this schema (use null or empty strings for unknown fields):
{
  "customer": { "name": "", "phone": "", "address": "", "building_type": "" },
  "system": { "type": "", "brand_model": "", "system_id_if_known": "" },
  "issue": { "customer_description": "", "detected_error_code": "", "likely_diagnosis": "", "confidence": 0, "is_critical": false },
  "troubleshooting_attempted": [],
  "troubleshooting_outcome": "success | failed | not_attempted",
  "dispatch_decision": { "needs_dispatch": true, "urgency": "low|medium|high|critical", "estimated_time_on_site": "", "parts_likely_needed": [], "estimated_total_cost": "" },
  "tech_brief": "2-3 sentence summary for on-call technician",
  "customer_notes": "access codes, panel location, on-site contact details",
  "dispatch_type": "immediate | scheduled",
  "appointment_time": ""
}`;

/** Detect whether the agent confirmed a technician dispatch. */
function isDispatchConfirmed(agentResponse, channel) {
  if (agentResponse.includes("[DISPATCH_CONFIRMED]")) return true;
  if (channel === "web") {
    const lower = agentResponse.toLowerCase();
    if (lower.includes('"needs_dispatch": true') || lower.includes('"needs_dispatch":true')) return true;
    const jsonMatch = agentResponse.match(/\{[\s\S]*"needs_dispatch"\s*:\s*true[\s\S]*\}/i);
    if (jsonMatch) return true;
  }
  return false;
}

/** Build a minimal brief when LLM extraction fails. */
function fallbackTechBrief(customerId, history) {
  const msgs = (history?.messages || []).filter((m) => m.role !== "system");
  const lastUser = msgs.filter((m) => m.role === "user").at(-1);
  const lastAgent = msgs.filter((m) => m.role === "assistant").at(-1);
  return {
    customer: { name: "", phone: "", address: "", building_type: "" },
    system: { type: "fire_alarm", brand_model: "", system_id_if_known: "" },
    issue: {
      customer_description: lastUser?.content || "See transcript",
      detected_error_code: "",
      likely_diagnosis: "Dispatch confirmed — review transcript for details",
      confidence: 0,
      is_critical: false,
    },
    troubleshooting_attempted: [],
    troubleshooting_outcome: "not_attempted",
    dispatch_decision: {
      needs_dispatch: true,
      urgency: "medium",
      estimated_time_on_site: "60",
      parts_likely_needed: [],
      estimated_total_cost: "",
    },
    tech_brief: lastAgent?.content?.replace(/\[DISPATCH_CONFIRMED\]/g, "").replace(/\[END_CALL\]/g, "").trim()
      || `Dispatch confirmed for ${customerId}. Review full transcript.`,
    customer_notes: "",
    dispatch_type: "immediate",
    appointment_time: "",
  };
}

/** Extract structured dispatch brief from conversation transcript. */
async function extractTechBrief(customerId) {
  const history = await db.getFullHistory(customerId);
  if (!history?.messages?.length) return fallbackTechBrief(customerId, history);

  const transcript = history.messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "Customer" : "Agent"}: ${m.content}`)
    .join("\n");

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 800,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: transcript },
      ],
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (err) {
    console.error("[Brief] Extraction failed:", err.message);
    return fallbackTechBrief(customerId, history);
  }
}

/** Send on-call contractor dispatch email (deduped per conversation). */
async function sendContractorDispatchEmail(customerId, { force = false } = {}) {
  const conv = await db.getConversation(customerId);
  if (!conv) throw new Error(`Conversation not found: ${customerId}`);

  if (conv.contractorEmailSentAt && !force) {
    console.log(`[Email] Contractor dispatch already sent for ${customerId}`);
    return null;
  }

  const to = process.env.CONTRACTOR_TEST_EMAIL;
  if (!to || to.includes("your-account-email") || to.includes("example.com")) {
    throw new Error("CONTRACTOR_TEST_EMAIL is not configured. Set your Resend account email in .env");
  }

  const brief = await extractTechBrief(customerId);
  const call = await db.getCallByCustomerId(customerId);
  const meta = {
    customerId,
    callerPhone: call?.phoneNumber || brief.customer?.phone || "Unknown",
    timestamp: new Date().toISOString(),
  };

  const template = templates.contractorDispatch(brief, meta);
  const result = await sendEmail({ to, ...template });
  await db.setContractorEmailSent(customerId);
  console.log(`[Email] Contractor dispatch sent for ${customerId} → ${to}`);
  return result;
}

/** Extract lightweight post-call report from transcript. */
async function extractCallReport(customerId) {
  const history = await db.getFullHistory(customerId);
  const msgs = (history?.messages || []).filter((m) => m.role !== "system");
  if (msgs.length < 2) return null; // nothing meaningful happened

  const transcript = msgs
    .map((m) => `${m.role === "user" ? "Customer" : "Agent"}: ${m.content}`)
    .join("\n");

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: POST_CALL_PROMPT },
        { role: "user", content: transcript },
      ],
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (err) {
    console.error("[Report] Extraction failed:", err.message);
    return {
      outcome: "unresolved",
      panel: { brand: "", model: "", error_code: "" },
      root_cause: "Extraction failed — review transcript",
      risk_level: "low",
      steps_tried: [],
      call_summary: `Call ended for ${customerId}. Manual review required.`,
      dispatch_type: "none",
      site_address: "",
      appointment_time: "",
    };
  }
}

/** Send post-call incident report email. Deduped per call UUID via reportedCallUUIDs. */
async function sendPostCallReportEmail(callUUID) {
  if (reportedCallUUIDs.has(callUUID)) {
    console.log(`[Report] Already sent for ${callUUID}`);
    return;
  }
  reportedCallUUIDs.add(callUUID);

  const to = process.env.CONTRACTOR_TEST_EMAIL;
  if (!to || to.includes("your-account-email") || to.includes("example.com")) {
    console.warn("[Report] CONTRACTOR_TEST_EMAIL not configured — skipping post-call report");
    return;
  }

  const customerId = `phone-${callUUID}`;
  const report = await extractCallReport(customerId);
  if (!report) {
    console.log(`[Report] No meaningful transcript for ${callUUID} — skipping`);
    return;
  }

  const call = await db.getCall(callUUID);
  const meta = {
    customerId,
    callerPhone: call?.phoneNumber || "Unknown",
    duration: call?.duration || 0,
    timestamp: new Date().toISOString(),
  };

  const template = templates.postCallReport(report, meta);
  await sendEmail({ to, ...template });
  console.log(`[Report] Post-call report sent for ${callUUID} → ${to}`);
}

/**
 * Run a message through the AI agent for a given customerId.
 * @param {string} customerId
 * @param {string} message
 * @param {{ channel?: 'phone' | 'web' }} [opts]
 * @returns {Promise<string>} agentResponse text
 */
async function processWithAI(customerId, message, opts = {}) {
  const channel = opts.channel || "web";
  const t0 = Date.now();

  // Parallelize conversation fetch + conversation creation (cheap if already exists)
  const [conv, history] = await Promise.all([
    db.createConversation(customerId),
    db.getFullHistory(customerId),
  ]);

  let openaiMessages = history ? history.messages : [];

  if (openaiMessages.length === 0) {
    // Phone uses compact PHONE_SYSTEM_PROMPT; web uses full SYSTEM_PROMPT
    const systemContent = channel === "phone" ? PHONE_SYSTEM_PROMPT : SYSTEM_PROMPT;
    await db.addMessage(conv.id, "system", systemContent);
    openaiMessages = [{ role: "system", content: systemContent }];
  }

  // Push user message into in-memory array synchronously before firing both ops
  openaiMessages.push({ role: "user", content: message });

  const model     = channel === "phone" ? "gpt-4o-mini" : "gpt-4-turbo";
  const maxTokens = channel === "phone" ? 100 : 1000;

  if (channel === "phone") {
    console.log(`[Phone] ⏱ t+${Date.now() - t0}ms → OpenAI start (${openaiMessages.length} msgs, ${model})`);
  }

  // Parallelize: DB write of user message + OpenAI call run concurrently
  const [, response] = await Promise.all([
    db.addMessage(conv.id, "user", message),
    openai.chat.completions.create({ model, max_tokens: maxTokens, messages: openaiMessages }),
  ]);

  if (channel === "phone") {
    console.log(`[Phone] ⏱ t+${Date.now() - t0}ms → OpenAI done`);
  }

  let agentResponse = response.choices[0].message.content;

  // Guard: never end the call too early — the AI must troubleshoot first.
  const userTurns = openaiMessages.filter((m) => m.role === "user").length;
  if (userTurns < MIN_PHONE_TURNS_BEFORE_END && agentResponse.includes("[END_CALL]")) {
    agentResponse = agentResponse.replace(/\[END_CALL\]/g, "").trim();
    console.warn("[AI] Stripped premature [END_CALL] on turn", userTurns);
  }

  await db.addMessage(conv.id, "assistant", agentResponse);

  if (channel === "phone") {
    console.log(`[Phone] ⏱ t+${Date.now() - t0}ms → DB saved, total processWithAI done`);
  }

  // Auto-detect status and trigger contractor email on dispatch
  if (isDispatchConfirmed(agentResponse, channel)) {
    await db.setConversationStatus(customerId, "dispatched");
    sendContractorDispatchEmail(customerId)
      .catch((e) => console.error("[Email] Dispatch email failed:", e.message));
  } else if (agentResponse.includes("[END_CALL]")) {
    await db.setConversationStatus(customerId, "resolved");
  }

  return agentResponse;
}

/** Derive public webhook base from the incoming request (falls back to env). */
function getRequestWebhookBase(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host  = req.get("x-forwarded-host") || req.get("host");
  if (host) return `${proto}://${host}`.replace(/\/$/, "");
  return (process.env.VONAGE_WEBHOOK_URL || "").replace(/\/$/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// ── HEALTH ──────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({
    status: "Alarm Panel Agent is running",
    timestamp: new Date().toISOString(),
    services: {
      openai:  !!process.env.OPENAI_API_KEY,
      resend:  !!(process.env.RESEND_API_KEY && !process.env.RESEND_API_KEY.startsWith("re_your_")),
      contractorEmail: !!(process.env.CONTRACTOR_TEST_EMAIL && !process.env.CONTRACTOR_TEST_EMAIL.includes("your-account-email")),
      vonage:  !!(process.env.VONAGE_API_KEY && process.env.VONAGE_API_SECRET),
      webhook: !!(process.env.VONAGE_WEBHOOK_URL && !process.env.VONAGE_WEBHOOK_URL.includes("your-ngrok")),
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── WEB CHAT (existing — keep working) ──────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

app.get("/conversations", async (req, res) => {
  try {
    const all = await db.getAllConversations();
    res.json({ success: true, conversations: all });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Full transcript for a specific customer — useful for call review
app.get("/conversations/:customerId", async (req, res) => {
  try {
    const conv = await db.getConversation(req.params.customerId);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    res.json({ success: true, ...conv });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/process-call", async (req, res) => {
  const { customerId, message } = req.body;
  if (!customerId || !message) {
    return res.status(400).json({ error: "customerId and message are required" });
  }

  try {
    const agentResponse = await processWithAI(customerId, message);
    res.json({
      success: true,
      agentResponse,
      conversationId: customerId,
    });
  } catch (error) {
    console.error("OpenAI API error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /tts
 * Body: { text: string }
 * Returns audio/mpeg — used by the web UI to avoid device-dependent speechSynthesis.
 */
app.post("/tts", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });

  const cleaned = text
    .replace(/```[\s\S]*?```/g, "A dispatch brief has been generated.")
    .replace(/\{[\s\S]*?\}/g, "Dispatch details have been recorded.")
    .replace(/\[END_CALL\]/g, "")
    .replace(/\[DISPATCH_CONFIRMED\]/g, "")
    .replace(/\*(\d+)/g, (_, n) => `error ${n}`)
    .replace(/[*_]{1,2}([^*_\n]+)[*_]{1,2}/g, "$1")
    .replace(/\*+/g, "")
    .replace(/#{1,6}\s*/g, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .trim();

  try {
    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: "nova",
      input: cleaned,
      response_format: "mp3",
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.set("Content-Type", "audio/mpeg");
    res.send(buffer);
  } catch (err) {
    console.error("[TTS] Error:", err.message);
    res.status(500).json({ error: "TTS failed" });
  }
});

app.get("/conversation/:customerId", async (req, res) => {
  try {
    const conv = await db.getConversation(req.params.customerId);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    res.json({ success: true, ...conv });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete("/conversation/:customerId", async (req, res) => {
  try {
    const deleted = await db.deleteConversation(req.params.customerId);
    if (!deleted) return res.status(404).json({ error: "Conversation not found" });
    res.json({ success: true, message: `Conversation ${req.params.customerId} deleted.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── EMAIL (Resend) ───────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /send-email
 * Body: { to: string, customerId: string, emailType: "callSummary"|"escalationAlert"|"confirmation"|"contractorDispatch", force?: boolean }
 */
app.post("/send-email", async (req, res) => {
  const { to, customerId, emailType = "callSummary", force = false } = req.body;

  if (!customerId) {
    return res.status(400).json({ error: "customerId is required" });
  }

  const validTypes = ["callSummary", "escalationAlert", "confirmation", "contractorDispatch"];
  if (!validTypes.includes(emailType)) {
    return res.status(400).json({ error: `emailType must be one of: ${validTypes.join(", ")}` });
  }

  try {
    const conv = await db.getConversation(customerId);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    if (emailType === "contractorDispatch") {
      const recipient = to || process.env.CONTRACTOR_TEST_EMAIL;
      if (!recipient) {
        return res.status(400).json({ error: "to or CONTRACTOR_TEST_EMAIL is required for contractorDispatch" });
      }
      const brief = await extractTechBrief(customerId);
      const call = await db.getCallByCustomerId(customerId);
      const meta = {
        customerId,
        callerPhone: call?.phoneNumber || brief.customer?.phone || "Unknown",
        timestamp: new Date().toISOString(),
      };
      const template = templates.contractorDispatch(brief, meta);
      const result = await sendEmail({ to: recipient, ...template });
      if (!force) await db.setContractorEmailSent(customerId);
      return res.json({ success: true, emailId: result.id, emailType, to: recipient });
    }

    if (!to) {
      return res.status(400).json({ error: "to is required" });
    }

    const template = templates[emailType](conv);
    const result = await sendEmail({ to, ...template });

    res.json({ success: true, emailId: result.id, emailType, to });
  } catch (error) {
    console.error("[/send-email] Error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── PHONE — SMS ──────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /phone/send-sms
 * Body: { phoneNumber: string, message: string }
 */
app.post("/phone/send-sms", async (req, res) => {
  const { phoneNumber, message } = req.body;
  if (!phoneNumber || !message) {
    return res.status(400).json({ error: "phoneNumber and message are required" });
  }

  try {
    const result = await sendSMS(phoneNumber, message);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── PHONE — OUTBOUND CALL ─────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /phone/make-call
 * Body: { phoneNumber: string, message: string }
 */
app.post("/phone/make-call", async (req, res) => {
  const { phoneNumber, message } = req.body;
  if (!phoneNumber || !message) {
    return res.status(400).json({ error: "phoneNumber and message are required" });
  }

  try {
    const result = await makeVoiceCall(phoneNumber, message);
    res.json({ success: true, callId: result.uuid });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── PHONE — VONAGE VOICE WEBHOOKS ────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /phone/incoming-call   ← Vonage Answer URL
 *
 * Vonage calls this when someone dials your Vonage number.
 * We respond with an NCCO that greets the caller and starts speech recognition.
 */
app.post("/phone/incoming-call", async (req, res) => {
  // Vonage sends: uuid, conversation_uuid, to, from, status, direction, timestamp
  const { uuid, from: callerNumber } = req.body;

  console.log(`[Phone] 📞 Incoming call from ${callerNumber} | UUID: ${uuid}`);

  // Log the call to Supabase
  await db.upsertCall({
    callId:      uuid,
    customerId:  `phone-${uuid}`,
    phoneNumber: callerNumber,
    direction:   "inbound",
    status:      "active",
  }).catch((e) => console.error("[Phone] Failed to log call:", e.message));

  // Return NCCO — greet caller and wait for speech
  const webhookBase = getRequestWebhookBase(req);
  const ncco = buildGreetingNcco(uuid, webhookBase);
  const eventUrl = ncco.find((a) => a.action === "input")?.eventUrl?.[0];
  console.log(`[Phone] Webhook base: ${webhookBase} | speech-input: ${eventUrl}`);
  res.json(ncco);
});

/**
 * POST /phone/speech-input   ← Vonage speech input event URL
 *
 * Returns a filler NCCO immediately while AI processes in the background.
 * The filler (e.g. "Got it, one sec.") + notify action means the caller hears
 * something within ~100ms. The notify fires ai-ready once the filler finishes.
 */
app.post("/phone/speech-input", async (req, res) => {
  const t0 = Date.now();
  const { uuid, speech } = req.body;

  console.log(`[Phone] 🎙  Speech input received | UUID: ${uuid} | t+0ms`);

  const customerId = `phone-${uuid}`;
  const rawText    = speech?.results?.[0]?.text;
  const transcript = rawText && rawText !== "undefined" ? rawText.trim() : "";
  const confidence = speech?.results?.[0]?.confidence || 0;

  console.log(`[Phone] Transcription (${Math.round(confidence * 100)}%): "${transcript}"`);

  // If call already completed, return a silent no-op — don't reprompt
  if (completedCallUUIDs.has(uuid)) {
    console.log(`[Phone] UUID ${uuid} already completed — ignoring stale speech-input`);
    return res.json([{ action: "talk", text: "", language: "en-US" }]);
  }

  const webhookBase = getRequestWebhookBase(req);

  // No speech received
  if (!transcript) {
    const timeoutReason = speech?.timeout_reason || "none";
    console.log(`[Phone] No usable transcript (timeout: ${timeoutReason})`);
    return res.json(buildResponseNcco(
      "Sorry, I didn't catch that. Could you say that again?",
      uuid, false, webhookBase
    ));
  }

  // Low-confidence transcript — asking to repeat is better than processing garbage
  if (confidence < 0.6) {
    console.log(`[Phone] Low confidence (${Math.round(confidence * 100)}%) — asking repeat`);
    return res.json(buildResponseNcco(
      "Sorry, I missed that last part — could you say that again?",
      uuid, false, webhookBase
    ));
  }

  // Start AI processing in background immediately (don't await here)
  const aiPromise = (async () => {
    try {
      const agentResponse = await processWithAI(customerId, transcript, { channel: "phone" });
      const ending = isCallEnding(agentResponse);
      console.log(`[Phone] ⏱ AI total: ${Date.now() - t0}ms | ending=${ending}`);
      return { agentResponse, ending };
    } catch (err) {
      console.error("[Phone] AI/DB error:", err.message);
      return {
        agentResponse: "I'm having a brief technical issue. Can you tell me again what's happening with your system?",
        ending: false,
      };
    }
  })();

  pendingAiResponses.set(uuid, aiPromise);
  // Clean up stale promises after 90s in case ai-ready never fires
  setTimeout(() => pendingAiResponses.delete(uuid), 90000);

  // Respond immediately with filler + notify — caller hears something in <200ms
  const ncco = buildFillerNcco(uuid, webhookBase);
  console.log(`[Phone] ⏱ t+${Date.now() - t0}ms → filler NCCO sent`);
  res.json(ncco);
});

/**
 * POST /phone/ai-ready   ← Vonage notify action fires this after filler plays
 *
 * Awaits the pending AI promise and returns the real response NCCO.
 * By the time this fires (~1.5s after speech-input), the AI is often done
 * or nearly done, so the caller hears the response with minimal silence.
 */
app.post("/phone/ai-ready", async (req, res) => {
  const t0 = Date.now();
  // Vonage sends notify payload under the 'payload' key
  const payload = req.body?.payload || req.body;
  const uuid = payload?.uuid;
  const webhookBase = payload?.webhookBase || getRequestWebhookBase(req);

  console.log(`[Phone] 🔔 ai-ready for UUID: ${uuid} | t+0ms`);

  const aiPromise = pendingAiResponses.get(uuid);

  if (!aiPromise) {
    console.warn(`[Phone] No pending AI for UUID: ${uuid} — sending fallback`);
    return res.json(buildResponseNcco(
      "Sorry, something went wrong on my end. What were you saying about your system?",
      uuid, false, webhookBase
    ));
  }

  const { agentResponse, ending } = await aiPromise;
  pendingAiResponses.delete(uuid);

  console.log(`[Phone] ⏱ ai-ready waited ${Date.now() - t0}ms | ending=${ending}`);

  if (ending) {
    db.upsertCall({ callId: uuid, status: "completed" })
      .catch((e) => console.error("[Phone] Failed to update call status:", e.message));
  }

  const ncco = buildResponseNcco(agentResponse, uuid, ending, webhookBase);
  console.log(`[Phone] NCCO: ${ncco.map((a) => a.action).join(" → ")}`);
  res.json(ncco);
});

/**
 * POST /phone/event   ← Vonage Event URL
 *
 * Called for all call lifecycle events: ringing, answered, completed, failed, etc.
 * We just log them to Supabase.
 */
app.post("/phone/event", async (req, res) => {
  const { uuid, status, duration } = req.body;

  const durStr = duration != null ? ` | duration: ${duration}s` : "";
  console.log(`[Phone] 📋 Event — UUID: ${uuid} | status: ${status}${durStr}`);

  if (uuid && status) {
    if (status === "completed") {
      completedCallUUIDs.add(uuid);

      const update = { callId: uuid, status };
      if (duration != null) update.duration = parseInt(duration, 10);
      await db.upsertCall(update)
        .catch((e) => console.error("[Phone] Failed to log event:", e.message));

      // Fire post-call report after DB is updated so duration is available
      sendPostCallReportEmail(uuid)
        .catch((e) => console.error("[Report] Post-call report failed:", e.message));
    } else {
      const update = { callId: uuid, status };
      if (duration != null) update.duration = parseInt(duration, 10);
      await db.upsertCall(update)
        .catch((e) => console.error("[Phone] Failed to log event:", e.message));
    }
  }

  res.status(200).json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── CALLS LOG ────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /calls — list all call records
 */
app.get("/calls", async (req, res) => {
  try {
    const calls = await db.getAllCalls();
    res.json({ success: true, calls });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

// Only bind a port when running directly (local dev). On Vercel the export below is used.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\nAlarm Panel Agent API  →  http://localhost:${PORT}`);
    console.log(`\n── Web Testing UI ──────────────────────────────────────`);
    console.log(`   GET  /                     — chat UI (web testing)`);
    console.log(`   POST /process-call         — send message (web)`);
    console.log(`   GET  /conversations        — list all conversations`);
    console.log(`   GET  /conversations/:id    — full transcript for one customer`);
    console.log(`   GET  /conversation/:id     — view conversation (legacy alias)`);
    console.log(`   DELETE /conversation/:id   — delete conversation`);
    console.log(`\n── Email (Resend) ──────────────────────────────────────`);
    console.log(`   POST /send-email           — { to, customerId, emailType }`);
    console.log(`\n── Phone (Vonage) ──────────────────────────────────────`);
    console.log(`   POST /phone/send-sms       — { phoneNumber, message }`);
    console.log(`   POST /phone/make-call      — { phoneNumber, message }`);
    console.log(`   POST /phone/incoming-call  — Vonage answer webhook`);
    console.log(`   POST /phone/speech-input   — Vonage ASR webhook (returns filler immediately)`);
    console.log(`   POST /phone/ai-ready       — Vonage notify webhook (delivers real AI response)`);
    console.log(`   POST /phone/event          — Vonage event webhook`);
    console.log(`   GET  /calls                — list all call records`);
    console.log(`\n── Other ───────────────────────────────────────────────`);
    console.log(`   GET  /health               — service status`);

    const webhookUrl = process.env.VONAGE_WEBHOOK_URL || "";
    if (!webhookUrl || webhookUrl.includes("your-ngrok")) {
      console.log(`\n⚠️  VONAGE_WEBHOOK_URL not set — voice webhooks disabled.`);
      console.log(`   Run: ngrok http ${PORT}`);
      console.log(`   Then update VONAGE_WEBHOOK_URL in .env\n`);
    } else {
      console.log(`\n✅ Vonage webhook base: ${webhookUrl}\n`);
    }
  });
}

module.exports = app;
