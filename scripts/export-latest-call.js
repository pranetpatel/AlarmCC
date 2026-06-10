/**
 * Export the latest inbound phone call transcript from Supabase.
 * Usage: node scripts/export-latest-call.js [--json] [--full]
 *
 * --json  Output raw JSON instead of script lines
 * --full  Include agent replies in output
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const db = require("../database");

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const full = args.has("--full");

async function main() {
  const [calls, convSummaries] = await Promise.all([
    db.getAllCalls(),
    db.getAllConversations(),
  ]);

  const phoneCalls = calls.filter((c) => c.customerId?.startsWith("phone-"));
  const convById = new Map(convSummaries.map((c) => [c.customerId, c]));

  // Prefer newest call that actually has transcript messages
  let latest = null;
  let conv = null;
  for (const call of phoneCalls) {
    const c = await db.getConversation(call.customerId);
    if (c?.messages?.length) {
      latest = call;
      conv = c;
      break;
    }
  }

  if (!latest || !conv) {
    console.error("No phone calls with transcript messages found.");
    process.exit(1);
  }

  const meta = {
    callId: latest.callId,
    customerId: latest.customerId,
    phoneNumber: latest.phoneNumber,
    status: latest.status,
    duration: latest.duration,
    createdAt: latest.createdAt,
    conversationStatus: conv.status,
    messageCount: conv.messages.length,
  };

  if (asJson) {
    console.log(JSON.stringify({ meta, messages: conv.messages }, null, 2));
    return;
  }

  console.error(`# Latest phone call`);
  console.error(`# ${meta.customerId} | ${meta.phoneNumber || "unknown"} | ${meta.createdAt}`);
  console.error(`# status: ${meta.status} | ${meta.messageCount} messages`);
  console.error("");

  const lines = conv.messages
    .filter((m) => full || m.role === "user")
    .map((m) => {
      const text = m.content
        .replace(/\[END_CALL\]/g, "")
        .replace(/\[DISPATCH_CONFIRMED\]/g, "")
        .trim();
      if (full) return `${m.role === "user" ? "CUSTOMER" : "AGENT"}: ${text}`;
      return `  "${text.replace(/"/g, '\\"')}",`;
    });

  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error("Failed:", err.message);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
  }
  process.exit(1);
});
