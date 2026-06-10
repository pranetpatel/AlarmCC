require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const db = require("../database");

async function main() {
  const [calls, convs] = await Promise.all([db.getAllCalls(), db.getAllConversations()]);

  const phoneConvs = convs.filter((c) => c.customerId.startsWith("phone-"));
  const webConvs = convs.filter((c) => !c.customerId.startsWith("phone-"));

  console.log("=== Phone calls (calls table) ===");
  for (const c of calls.filter((x) => x.customerId?.startsWith("phone-")).slice(0, 10)) {
    console.log(`${c.createdAt} | ${c.status} | msgs via conv: ${phoneConvs.find((p) => p.customerId === c.customerId)?.messageCount ?? "?"}`);
    console.log(`  ${c.customerId} | ${c.phoneNumber}`);
  }

  console.log("\n=== Phone conversations (with messages) ===");
  for (const c of phoneConvs.filter((x) => x.messageCount > 0).slice(0, 10)) {
    console.log(`${c.updatedAt} | ${c.messageCount} msgs | ${c.status} | ${c.customerId}`);
  }

  console.log("\n=== Web/test conversations (with messages) ===");
  for (const c of webConvs.filter((x) => x.messageCount > 0).slice(0, 10)) {
    console.log(`${c.updatedAt} | ${c.messageCount} msgs | ${c.status} | ${c.customerId}`);
  }
}

main().catch(console.error);
