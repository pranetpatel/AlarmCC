/**
 * phone.js — Vonage SMS + Voice module for AlarmCC
 *
 * SMS:   needs only VONAGE_API_KEY + VONAGE_API_SECRET
 * Voice: same credentials used for NCCO webhooks
 *        (outbound calls also need VONAGE_APPLICATION_ID + VONAGE_PRIVATE_KEY
 *         — set these up in the Vonage dashboard under Applications)
 */

const { Vonage } = require("@vonage/server-sdk");

// ─────────────────────────────────────────────────────────────────────────────
// Client init (lazy so missing env vars don't crash at boot)
// ─────────────────────────────────────────────────────────────────────────────

let vonage;

function getClient() {
  if (!vonage) {
    if (!process.env.VONAGE_API_KEY || !process.env.VONAGE_API_SECRET) {
      throw new Error("VONAGE_API_KEY and VONAGE_API_SECRET must be set in .env");
    }

    const opts = {
      apiKey: process.env.VONAGE_API_KEY,
      apiSecret: process.env.VONAGE_API_SECRET,
    };

    // Optional: Application credentials for outbound calls
    if (process.env.VONAGE_APPLICATION_ID && process.env.VONAGE_PRIVATE_KEY) {
      opts.applicationId = process.env.VONAGE_APPLICATION_ID;
      opts.privateKey    = process.env.VONAGE_PRIVATE_KEY;
    }

    vonage = new Vonage(opts);
  }
  return vonage;
}

function getWebhookBase() {
  const base = process.env.VONAGE_WEBHOOK_URL || "";
  if (!base || base.includes("your-ngrok")) {
    console.warn("[Phone] ⚠️  VONAGE_WEBHOOK_URL is not configured. Voice webhooks won't work.");
  }
  return base.replace(/\/$/, ""); // strip trailing slash
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send an SMS via Vonage.
 * @param {string} to   Destination phone number (E.164 format, e.g. +14155551234)
 * @param {string} text Message text
 */
async function sendSMS(to, text) {
  const client = getClient();
  const from   = process.env.VONAGE_PHONE_NUMBER || "AlarmCC";

  // Vonage SDK v3 returns a promise
  const resp = await client.sms.send({ to, from, text });
  const msg  = resp.messages?.[0];

  if (msg?.status !== "0") {
    const errText = msg?.["error-text"] || "Unknown SMS error";
    console.error(`[Phone] SMS failed to ${to}: ${errText}`);
    throw new Error(`SMS failed: ${errText}`);
  }

  console.log(`[Phone] SMS sent → ${to} | messageId: ${msg["message-id"]}`);
  return { messageId: msg["message-id"] };
}

// ─────────────────────────────────────────────────────────────────────────────
// NCCO builders (Vonage Call Control Objects for Voice API)
// ─────────────────────────────────────────────────────────────────────────────

// Maps numeric error codes to spoken words for TTS clarity
const ERROR_CODE_WORDS = {
  1:'one', 2:'two', 3:'three', 4:'four', 5:'five',
  6:'six', 7:'seven', 8:'eight', 9:'nine', 10:'ten', 15:'fifteen',
};

/** Strip markdown/JSON/tokens from text before TTS */
function cleanSpokenText(raw) {
  return raw
    .replace(/```[\s\S]*?```/g, "A dispatch brief has been generated.")
    .replace(/\{[\s\S]*?\}/g, "Dispatch details have been recorded.")
    .replace(/\[END_CALL\]/g, "")
    .replace(/\[DISPATCH_CONFIRMED\]/g, "")
    .replace(/\*(\d+)/g, (_, n) => {
      const word = ERROR_CODE_WORDS[parseInt(n)];
      return word ? `error ${word}` : `error ${n}`;
    })
    .replace(/[*_]{1,2}([^*_\n]+)[*_]{1,2}/g, "$1")
    .replace(/\*+/g, "")
    .replace(/#{1,6}\s*/g, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .trim();
}

/**
 * Limit phone TTS to first 2 sentences or 300 chars, whichever is shorter.
 * Logs when truncated so we can tune.
 */
function capPhoneText(text, maxChars = 300) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const twoSent = sentences.length > 0
    ? sentences.slice(0, 2).join(" ").trim()
    : text;

  const result = twoSent.length <= maxChars ? twoSent : twoSent.slice(0, maxChars).trim();
  if (result.length < text.length) {
    console.log(`[Phone] TTS truncated: ${text.length} → ${result.length} chars`);
  }
  return result || text.slice(0, maxChars);
}

/** Escape characters that break Vonage SSML */
function escapeSSML(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Wrap cleaned text in SSML with sentence-break pauses */
function toSSML(text) {
  const safe = escapeSSML(text);
  const sentences = safe.match(/[^.!?]+[.!?]+/g);
  if (!sentences || sentences.length <= 1) {
    return `<speak>${safe}</speak>`;
  }
  return `<speak>${sentences.join('<break time="300ms"/>')}</speak>`;
}

/**
 * Build a Vonage NCCO talk action.
 * Premier mode (VONAGE_TTS_VOICE set): uses Google provider + providerOptions, plain text.
 * Legacy mode (VONAGE_TTS_VOICE unset): uses en-US style 6 premium + SSML.
 */
function buildTalkAction(text, opts = {}) {
  const voiceName = process.env.VONAGE_TTS_VOICE;
  if (voiceName) {
    return {
      action: "talk",
      text,
      provider: "google",
      providerOptions: { name: voiceName, language_code: "en-US" },
      ...opts,
    };
  }
  return {
    action: "talk",
    text,
    language: "en-US",
    style: 6,
    premium: true,
    ...opts,
  };
}

/**
 * Build the initial NCCO returned when someone calls your Vonage number.
 * @param {string} callUuid     Vonage call UUID (used so speech results route back)
 * @param {string} [webhookBase] Public base URL for speech-input webhooks (defaults to env)
 */
function buildGreetingNcco(callUuid, webhookBase) {
  webhookBase = webhookBase || getWebhookBase();
  const greetingText = process.env.VONAGE_TTS_VOICE
    ? "Hey, thanks for calling fire alarm support. What's going on?"
    : "<speak>Hey, thanks for calling fire alarm support. What's going on?</speak>";
  return [
    buildTalkAction(greetingText, { bargeIn: true }),
    buildInputAction(callUuid, webhookBase),
  ];
}

/**
 * Build the NCCO to speak an AI response and then listen again.
 * @param {string} text        Text to speak aloud
 * @param {string} callUuid    Vonage call UUID
 * @param {boolean} end        If true, no follow-up input (ends the call politely)
 * @param {string} [webhookBase] Public base URL for speech-input webhooks (defaults to env)
 */
function buildResponseNcco(text, callUuid, end = false, webhookBase) {
  webhookBase = webhookBase || getWebhookBase();

  const cleaned = cleanSpokenText(text);
  const capped  = capPhoneText(cleaned) || "I didn't get a response. Please hold.";
  const spokenText = process.env.VONAGE_TTS_VOICE ? capped : toSSML(capped);

  const talkAction = buildTalkAction(spokenText);

  // Vonage ends the call when the NCCO runs out of actions. Always follow
  // a response with an input action unless we are deliberately hanging up.
  if (end) {
    return [talkAction];
  }

  return [talkAction, buildInputAction(callUuid, webhookBase)];
}

/** Shared input/speech action */
function buildInputAction(callUuid, webhookBase) {
  return {
    action: "input",
    type: ["speech"],
    speech: {
      endOnSilence: 1,
      startTimeout: 15,
      maxDuration: 30,
      language: "en-US",
      sensitivity: 50,
    },
    eventUrl: [`${webhookBase}/phone/speech-input`],
    eventMethod: "POST",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound voice call
// (Requires VONAGE_APPLICATION_ID + VONAGE_PRIVATE_KEY in .env)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initiate an outbound voice call that speaks a message.
 * @param {string} to      Destination phone number (E.164)
 * @param {string} message Text to speak when customer answers
 */
async function makeVoiceCall(to, message) {
  if (!process.env.VONAGE_APPLICATION_ID || !process.env.VONAGE_PRIVATE_KEY) {
    throw new Error(
      "Outbound voice calls require VONAGE_APPLICATION_ID and VONAGE_PRIVATE_KEY. " +
        "Create a Vonage Application at https://dashboard.nexmo.com/applications"
    );
  }

  const client  = getClient();
  const from    = process.env.VONAGE_PHONE_NUMBER;
  const webhookBase = getWebhookBase();

  const cleaned = cleanSpokenText(message);
  const spokenText = process.env.VONAGE_TTS_VOICE ? cleaned : toSSML(cleaned);
  const ncco = [
    buildTalkAction(spokenText, { bargeIn: true }),
    buildInputAction(null, webhookBase),
  ];

  const resp = await client.voice.createOutboundCall({
    to:   [{ type: "phone", number: to }],
    from: { type: "phone", number: from },
    ncco,
  });

  console.log(`[Phone] Outbound call initiated → ${to} | uuid: ${resp.uuid}`);
  return resp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether the AI signalled end-of-call with the explicit [END_CALL] token.
 */
function isCallEnding(agentResponse = "") {
  return agentResponse.includes("[END_CALL]");
}

module.exports = {
  sendSMS,
  makeVoiceCall,
  buildGreetingNcco,
  buildResponseNcco,
  isCallEnding,
};
