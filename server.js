const express = require("express");
const path    = require("path");
const dotenv  = require("dotenv");
const { OpenAI } = require("openai");

const db     = require("./database");
const { sendEmail, templates } = require("./email");
const { sendSMS, makeVoiceCall, buildGreetingNcco, buildResponseNcco, isCallEnding } = require("./phone");

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

const PHONE_MODE_SUFFIX = `\n\nPHONE MODE RULES — follow these strictly:
- You are a real human dispatcher named Alex. Never say you are AI.
- Talk the way a real person would on the phone: natural, relaxed, direct. Use contractions (don't, I'll, that's, let's).
- Use natural filler and acknowledgment phrases like "Got it", "Okay", "Sure thing", "Yeah that makes sense", "Alright", "No worries" — but only one per turn, naturally.
- Max 1-2 short sentences per reply. One question at a time only.
- Never list steps — say them one at a time as a follow-up.
- No markdown, no bullet points, no JSON, no asterisks.
- Say "error two" not "*2", "error five" not "*5", etc.
- If the customer seems stressed, acknowledge it briefly before helping: "Yeah, I get it — let's sort this out."
- Sound like you've handled this exact problem a hundred times before.`;

// Minimum user turns before the agent is allowed to end a phone call.
const MIN_PHONE_TURNS_BEFORE_END = 3;

/**
 * Run a message through the AI agent for a given customerId.
 * @param {string} customerId
 * @param {string} message
 * @param {{ channel?: 'phone' | 'web' }} [opts]
 * @returns {Promise<string>} agentResponse text
 */
async function processWithAI(customerId, message, opts = {}) {
  const channel = opts.channel || "web";
  const conv = await db.createConversation(customerId);

  let history = await db.getFullHistory(customerId);
  let openaiMessages = history ? history.messages : [];

  if (openaiMessages.length === 0) {
    const systemContent = channel === "phone"
      ? SYSTEM_PROMPT + PHONE_MODE_SUFFIX
      : SYSTEM_PROMPT;
    await db.addMessage(conv.id, "system", systemContent);
    openaiMessages = [{ role: "system", content: systemContent }];
  }

  await db.addMessage(conv.id, "user", message);
  openaiMessages.push({ role: "user", content: message });

  const model     = channel === "phone" ? "gpt-4o-mini" : "gpt-4-turbo";
  const maxTokens = channel === "phone" ? 90 : 1000;

  const response = await openai.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: openaiMessages,
  });

  let agentResponse = response.choices[0].message.content;

  // Guard: never end the call too early — the AI must troubleshoot first.
  const userTurns = openaiMessages.filter((m) => m.role === "user").length;
  if (userTurns < MIN_PHONE_TURNS_BEFORE_END && agentResponse.includes("[END_CALL]")) {
    agentResponse = agentResponse.replace(/\[END_CALL\]/g, "").trim();
    console.warn("[AI] Stripped premature [END_CALL] on turn", userTurns);
  }

  await db.addMessage(conv.id, "assistant", agentResponse);

  // Auto-detect status
  const lower = agentResponse.toLowerCase();
  if (lower.includes('"needs_dispatch": true') || lower.includes("technician will visit")) {
    await db.setConversationStatus(customerId, "dispatched");
  } else if (agentResponse.includes("[END_CALL]")) {
    await db.setConversationStatus(customerId, "resolved");
  }

  return agentResponse;
}

/** Count how many user messages exist for a phone/web customer. */
async function getUserTurnCount(customerId) {
  const history = await db.getFullHistory(customerId);
  if (!history) return 0;
  return history.messages.filter((m) => m.role === "user").length;
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
    status: "Fire Alarm Agent is running",
    timestamp: new Date().toISOString(),
    services: {
      openai:  !!process.env.OPENAI_API_KEY,
      resend:  !!(process.env.RESEND_API_KEY && !process.env.RESEND_API_KEY.startsWith("re_your_")),
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
 * Body: { to: string, customerId: string, emailType: "callSummary"|"escalationAlert"|"confirmation" }
 */
app.post("/send-email", async (req, res) => {
  const { to, customerId, emailType = "callSummary" } = req.body;

  if (!to || !customerId) {
    return res.status(400).json({ error: "to and customerId are required" });
  }

  const validTypes = ["callSummary", "escalationAlert", "confirmation"];
  if (!validTypes.includes(emailType)) {
    return res.status(400).json({ error: `emailType must be one of: ${validTypes.join(", ")}` });
  }

  try {
    const conv = await db.getConversation(customerId);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

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
 * Called after the caller finishes speaking.
 * We process the transcription with the AI and return a new NCCO.
 */
app.post("/phone/speech-input", async (req, res) => {
  const { uuid, speech } = req.body;

  console.log(`[Phone] 🎙  Speech input for UUID: ${uuid}`);

  const customerId   = `phone-${uuid}`;
  const rawText      = speech?.results?.[0]?.text;
  const transcript   = rawText && rawText !== "undefined" ? rawText.trim() : "";
  const confidence   = speech?.results?.[0]?.confidence || 0;

  console.log(`[Phone] Transcription (${Math.round(confidence * 100)}%): "${transcript}"`);

  // If call already completed, return a silent hangup NCCO — don't reprompt
  if (completedCallUUIDs.has(uuid)) {
    console.log(`[Phone] UUID ${uuid} already completed — ignoring stale speech-input`);
    return res.json([{ action: "talk", text: "", language: "en-US" }]);
  }

  const webhookBase = getRequestWebhookBase(req);

  // Handle no speech / low confidence / "undefined" transcript
  if (!transcript) {
    const timeoutReason = speech?.timeout_reason || "none";
    console.log(`[Phone] No usable transcript (timeout: ${timeoutReason})`);
    return res.json(buildResponseNcco(
      "Sorry, I didn't catch that. Could you repeat?",
      uuid,
      false,
      webhookBase
    ));
  }

  // Process with the shared AI function
  let agentResponse;
  let userTurns = 0;
  try {
    agentResponse = await processWithAI(customerId, transcript, { channel: "phone" });
    userTurns = await getUserTurnCount(customerId);
  } catch (err) {
    console.error("[Phone] AI/DB error:", err.message);
    agentResponse = "I'm having a brief technical issue. Please tell me again what's happening with your system.";
  }

  let ending = isCallEnding(agentResponse);

  // Vonage hangs up when we return talk without a following input action.
  // Block premature hangups until the caller has had a real back-and-forth.
  if (userTurns < MIN_PHONE_TURNS_BEFORE_END && ending) {
    console.warn(`[Phone] Blocked early hangup on turn ${userTurns} — keeping call open`);
    agentResponse = agentResponse.replace(/\[END_CALL\]/g, "").trim();
    ending = false;
  }

  const ncco = buildResponseNcco(agentResponse, uuid, ending, webhookBase);
  console.log(`[Phone] Turn ${userTurns} | ending=${ending} | NCCO: ${ncco.map((a) => a.action).join(" → ")}`);

  // Mark call completed if conversation is ending (non-blocking)
  if (ending) {
    db.upsertCall({ callId: uuid, status: "completed" })
      .catch((e) => console.error("[Phone] Failed to update call status:", e.message));
  }

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
    if (status === "completed") completedCallUUIDs.add(uuid);

    const update = { callId: uuid, status };
    if (duration != null) update.duration = parseInt(duration, 10);

    await db.upsertCall(update)
      .catch((e) => console.error("[Phone] Failed to log event:", e.message));
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
    console.log(`\n🔥 Fire Alarm Agent API  →  http://localhost:${PORT}`);
    console.log(`\n── Web Testing UI ──────────────────────────────────────`);
    console.log(`   GET  /                     — chat UI (web testing)`);
    console.log(`   POST /process-call         — send message (web)`);
    console.log(`   GET  /conversations        — list all conversations`);
    console.log(`   GET  /conversation/:id     — view conversation`);
    console.log(`   DELETE /conversation/:id   — delete conversation`);
    console.log(`\n── Email (Resend) ──────────────────────────────────────`);
    console.log(`   POST /send-email           — { to, customerId, emailType }`);
    console.log(`\n── Phone (Vonage) ──────────────────────────────────────`);
    console.log(`   POST /phone/send-sms       — { phoneNumber, message }`);
    console.log(`   POST /phone/make-call      — { phoneNumber, message }`);
    console.log(`   POST /phone/incoming-call  — Vonage answer webhook`);
    console.log(`   POST /phone/speech-input   — Vonage ASR webhook`);
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
