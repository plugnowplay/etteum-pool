import { db } from "./src/db/index";
import { accounts } from "./src/db/schema";
import { eq, count } from "drizzle-orm";

const grokCount = await db.select({ c: count() }).from(accounts).where(eq(accounts.provider, "grok-cli"));
console.log("Grok-CLI accounts:", grokCount[0]?.c || 0);
