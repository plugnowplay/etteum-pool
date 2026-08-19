/**
 * One-off: import 10 CodeBuddy Intl access tokens directly into the DB,
 * mirroring the POST /api/accounts device-code handler shape:
 *   provider: "codebuddy", status: "active", quota -1,
 *   password = encrypt(accessToken), tokens = {access_token, refresh_token:"", method:"device_code"}
 * Email comes from the JWT claims (email / preferred_username).
 */
import { db } from "../src/db/index";
import { accounts } from "../src/db/schema";
import { encrypt } from "../src/utils/crypto";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";

const TOKEN_FILE = "/home/m1k0l4/.hermes/cache/documents/doc_583d8859b95d_message.txt";

function emailFromJwt(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const payload = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf-8"));
    const email = String(payload.email || "").trim();
    if (email && email.includes("@")) return email;
    return null;
  } catch {
    return null;
  }
}

async function main() {
  const lines = readFileSync(TOKEN_FILE, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  console.log(`Found ${lines.length} tokens`);
  let created = 0, updated = 0, skipped = 0;

  for (const token of lines) {
    const email = emailFromJwt(token);
    if (!email) {
      console.log(`SKIP (no email in JWT): ${token.slice(0, 40)}...`);
      skipped++;
      continue;
    }

    const tokens = {
      access_token: token,
      refresh_token: "",
      method: "device_code",
    };

    const existing = await db.select().from(accounts).where(eq(accounts.email, email));
    const row = existing.find((r) => r.provider === "codebuddy");

    if (row) {
      await db.update(accounts).set({
        password: encrypt(token),
        status: "active",
        tokens,
        errorMessage: null,
        lastLoginAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(accounts.id, row.id));
      console.log(`UPDATED ${email} (id=${row.id})`);
      updated++;
    } else {
      const inserted = await db.insert(accounts).values({
        provider: "codebuddy",
        email,
        password: encrypt(token),
        status: "active",
        tokens,
        quotaLimit: -1,
        quotaRemaining: -1,
        lastLoginAt: new Date(),
      }).returning();
      console.log(`CREATED ${email} (id=${inserted[0]!.id})`);
      created++;
    }
  }

  console.log(`\nDone: ${created} created, ${updated} updated, ${skipped} skipped`);
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
