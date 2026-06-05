const { createClient } = require("@supabase/supabase-js");

// Lazy init — dotenv must be loaded before first DB call
let _supabase;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _supabase;
}

// Proxy so all existing code using `supabase.from(...)` still works
const supabase = new Proxy({}, {
  get(_, prop) {
    return getSupabase()[prop];
  },
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function assertNoError(error, context) {
  if (error) {
    console.error(`[DB] ${context}:`, error.message);
    throw new Error(error.message);
  }
}

// ─────────────────────────────────────────────
// Public API  (all async)
// ─────────────────────────────────────────────

/**
 * Create a new conversation row. Returns the row.
 * If one already exists for this customerId, returns the existing row.
 */
async function createConversation(customerId) {
  // Try to fetch existing first
  const { data: existing } = await supabase
    .from("conversations")
    .select("*")
    .eq("customerId", customerId)
    .maybeSingle();

  if (existing) return existing;

  const { data, error } = await supabase
    .from("conversations")
    .insert({ customerId })
    .select()
    .single();

  assertNoError(error, "createConversation");
  return data;
}

/**
 * Add a single message to a conversation.
 * @param {number} conversationId - numeric PK from the conversations table
 * @param {'system'|'user'|'assistant'} role
 * @param {string} content
 */
async function addMessage(conversationId, role, content) {
  const { error } = await supabase
    .from("messages")
    .insert({ conversationId, role, content });

  assertNoError(error, "addMessage");
  // updatedAt is handled automatically by the DB trigger
}

/**
 * Get conversation metadata + messages (excluding system prompt) for a customerId.
 */
async function getConversation(customerId) {
  const { data: conv } = await supabase
    .from("conversations")
    .select("*")
    .eq("customerId", customerId)
    .maybeSingle();

  if (!conv) return null;

  const { data: messages, error } = await supabase
    .from("messages")
    .select("role, content, timestamp")
    .eq("conversationId", conv.id)
    .neq("role", "system")
    .order("id", { ascending: true });

  assertNoError(error, "getConversation.messages");
  return { ...conv, messages: messages || [] };
}

/**
 * Get ALL messages for a customerId including the system prompt.
 * Used internally to reconstruct the OpenAI messages array.
 */
async function getFullHistory(customerId) {
  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("customerId", customerId)
    .maybeSingle();

  if (!conv) return null;

  const { data: messages, error } = await supabase
    .from("messages")
    .select("role, content, timestamp")
    .eq("conversationId", conv.id)
    .order("id", { ascending: true });

  assertNoError(error, "getFullHistory.messages");
  return { conversationId: conv.id, messages: messages || [] };
}

/**
 * List all conversations with summary stats.
 */
async function getAllConversations() {
  // Fetch conversations + their messages in one query via join
  const { data, error } = await supabase
    .from("conversations")
    .select(`id, customerId, status, createdAt, updatedAt,
             messages(id, role, timestamp)`)
    .order("updatedAt", { ascending: false });

  assertNoError(error, "getAllConversations");

  return (data || []).map((conv) => {
    const nonSystem = (conv.messages || []).filter((m) => m.role !== "system");
    const timestamps = nonSystem.map((m) => m.timestamp).sort();
    return {
      id: conv.id,
      customerId: conv.customerId,
      status: conv.status,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      messageCount: nonSystem.length,
      lastMessageAt: timestamps.at(-1) ?? null,
    };
  });
}

/**
 * Delete a conversation and all its messages (CASCADE).
 */
async function deleteConversation(customerId) {
  const { data, error } = await supabase
    .from("conversations")
    .delete()
    .eq("customerId", customerId)
    .select("id");

  assertNoError(error, "deleteConversation");
  return data && data.length > 0;
}

/**
 * Update the status of a conversation.
 * @param {string} customerId
 * @param {'active'|'resolved'|'dispatched'} status
 */
async function setConversationStatus(customerId, status) {
  const { error } = await supabase
    .from("conversations")
    .update({ status })
    .eq("customerId", customerId);

  assertNoError(error, "setConversationStatus");
}

/**
 * Mark that a contractor dispatch email was sent for this conversation.
 * @param {string} customerId
 */
async function setContractorEmailSent(customerId) {
  const { error } = await supabase
    .from("conversations")
    .update({ contractorEmailSentAt: new Date().toISOString() })
    .eq("customerId", customerId);

  assertNoError(error, "setContractorEmailSent");
}

/**
 * Fetch a call record by customerId (e.g. phone-{uuid}).
 * @param {string} customerId
 */
async function getCallByCustomerId(customerId) {
  const { data, error } = await supabase
    .from("calls")
    .select("*")
    .eq("customerId", customerId)
    .order("createdAt", { ascending: false })
    .limit(1)
    .maybeSingle();
  assertNoError(error, "getCallByCustomerId");
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Calls (Vonage phone calls)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create or update a call record.
 * @param {{ callId: string, customerId?: string, phoneNumber?: string, direction?: string, status?: string }} callData
 */
async function upsertCall(callData) {
  const { data: existing } = await supabase
    .from("calls")
    .select("id")
    .eq("callId", callData.callId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("calls")
      .update(callData)
      .eq("callId", callData.callId);
    assertNoError(error, "upsertCall.update");
  } else {
    const { error } = await supabase
      .from("calls")
      .insert(callData);
    assertNoError(error, "upsertCall.insert");
  }
}

/**
 * Fetch a call record by Vonage UUID.
 * @param {string} callId
 */
async function getCall(callId) {
  const { data, error } = await supabase
    .from("calls")
    .select("*")
    .eq("callId", callId)
    .maybeSingle();
  assertNoError(error, "getCall");
  return data;
}

/**
 * List all calls, newest first.
 */
async function getAllCalls() {
  const { data, error } = await supabase
    .from("calls")
    .select("*")
    .order("createdAt", { ascending: false });
  assertNoError(error, "getAllCalls");
  return data || [];
}

module.exports = {
  createConversation,
  addMessage,
  getConversation,
  getFullHistory,
  getAllConversations,
  deleteConversation,
  setConversationStatus,
  setContractorEmailSent,
  upsertCall,
  getCall,
  getCallByCustomerId,
  getAllCalls,
};
