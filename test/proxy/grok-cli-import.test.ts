import { afterEach, describe, expect, test } from "bun:test";
import type { Account } from "../../src/db/schema";
import {
  exchangeGrokCliRefreshToken,
  GrokCliProvider,
  parseGrokCliImportEntries,
} from "../../src/proxy/providers/grok-cli";

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.sig`;
}

describe("parseGrokCliImportEntries — g2a JSON formats", () => {
  test("parses the canonical g2a export document", () => {
    const access = jwt({ sub: "user-1", email: "a@example.com" });
    const res = parseGrokCliImportEntries(
      JSON.stringify({
        accounts: [
          {
            provider: "grok_build",
            name: "acc-1",
            access_token: access,
            refresh_token: "rt-alpha",
            token_type: "Bearer",
            expires_at: "2030-01-01T00:00:00Z",
            email: "a@example.com",
          },
        ],
      }),
    );

    expect(res.errors).toEqual([]);
    expect(res.entries).toHaveLength(1);
    const entry = res.entries[0]!;
    expect(entry.accessToken).toBe(access);
    expect(entry.refreshToken).toBe("rt-alpha");
    expect(entry.email).toBe("a@example.com");
    expect(entry.name).toBe("acc-1");
    expect(entry.expiresAt).toBe(new Date("2030-01-01T00:00:00Z").toISOString());
  });

  test("accepts a JSON array and a single object", () => {
    const array = parseGrokCliImportEntries(
      JSON.stringify([{ refresh_token: "rt-1" }, { refresh_token: "rt-2" }]),
    );
    expect(array.errors).toEqual([]);
    expect(array.entries.map((e) => e.refreshToken)).toEqual(["rt-1", "rt-2"]);

    const single = parseGrokCliImportEntries(JSON.stringify({ refresh_token: "rt-3" }));
    expect(single.errors).toEqual([]);
    expect(single.entries).toHaveLength(1);
  });

  test("accepts NDJSON with BOM and CRLF", () => {
    const ndjson = `\uFEFF{"refresh_token":"rt-1"}\r\n\r\n{"refresh_token":"rt-2"}\r\n`;
    const res = parseGrokCliImportEntries(ndjson);
    expect(res.errors).toEqual([]);
    expect(res.entries.map((e) => e.refreshToken)).toEqual(["rt-1", "rt-2"]);
  });

  test("falls back to JWT claims for email, userId and expiry", () => {
    const access = jwt({ sub: "sub-9", email: "claims@example.com", exp: 1_800_000_000 });
    const res = parseGrokCliImportEntries(JSON.stringify({ access_token: access }));
    expect(res.errors).toEqual([]);
    expect(res.entries[0]!.email).toBe("claims@example.com");
    expect(res.entries[0]!.userId).toBe("sub-9");
    expect(res.entries[0]!.expiresAt).toBe(new Date(1_800_000_000 * 1000).toISOString());
    expect(res.entries[0]!.name).toBe("claims@example.com");
  });

  test("expires_in seconds become a future ISO timestamp", () => {
    const before = Date.now();
    const res = parseGrokCliImportEntries(JSON.stringify({ refresh_token: "rt", expires_in: 3600 }));
    expect(res.errors).toEqual([]);
    const ms = new Date(res.entries[0]!.expiresAt!).getTime();
    expect(ms).toBeGreaterThanOrEqual(before + 3_599_000);
  });
});

describe("parseGrokCliImportEntries — plain text", () => {
  test("bare non-JWT lines are refresh tokens, JWT lines are access tokens", () => {
    const access = jwt({ sub: "s" });
    const res = parseGrokCliImportEntries(`grok2api-refresh-token\n${access}`);
    expect(res.errors).toEqual([]);
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]!.refreshToken).toBe("grok2api-refresh-token");
    expect(res.entries[0]!.accessToken).toBe("");
    expect(res.entries[1]!.accessToken).toBe(access);
    expect(res.entries[1]!.refreshToken).toBe("");
  });

  test("strips rt=, refresh_token= and at= prefixes", () => {
    const access = jwt({ sub: "s" });
    const res = parseGrokCliImportEntries(`rt=token-a\nrefresh_token=token-b\nat=${access}`);
    expect(res.errors).toEqual([]);
    expect(res.entries[0]!.refreshToken).toBe("token-a");
    expect(res.entries[1]!.refreshToken).toBe("token-b");
    expect(res.entries[2]!.accessToken).toBe(access);
  });

  test("skips comment lines", () => {
    const res = parseGrokCliImportEntries("# comment\nrt=token-a");
    expect(res.errors).toEqual([]);
    expect(res.entries).toHaveLength(1);
  });

  test("collects per-entry errors and keeps valid entries flowing", () => {
    const res = parseGrokCliImportEntries(
      JSON.stringify([
        { refresh_token: "rt-ok" },
        { refresh_token: "" },
        { provider: "grok_web", refresh_token: "rt-x" },
        { token_type: "Basic", refresh_token: "rt-y" },
        { access_token: "short" },
        { refresh_token: "has space" },
      ]),
    );
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]!.refreshToken).toBe("rt-ok");
    expect(res.errors).toHaveLength(5);
  });

  test("rejects invalid expires_at and oversized tokens", () => {
    const badDate = parseGrokCliImportEntries(
      JSON.stringify([{ refresh_token: "rt", expires_at: "not-a-date" }]),
    );
    expect(badDate.entries).toHaveLength(0);
    expect(badDate.errors[0]).toContain("RFC3339");

    const oversized = parseGrokCliImportEntries("r".repeat((16 << 10) + 1));
    expect(oversized.entries).toHaveLength(0);
    expect(oversized.errors[0]).toContain("exceeds");
  });

  test("empty input yields no entries and no errors", () => {
    expect(parseGrokCliImportEntries("").entries).toHaveLength(0);
    expect(parseGrokCliImportEntries("").errors).toEqual([]);
    expect(parseGrokCliImportEntries("   \n  ").entries).toHaveLength(0);
    expect(parseGrokCliImportEntries('{"accounts":[]}').errors).toEqual([]);
  });
});

describe("exchangeGrokCliRefreshToken", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("exchanges a refresh token and returns the rotated one", async () => {
    let capturedBody = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", id_token: "id-new", expires_in: 3600 }),
        { status: 200 },
      );
    }) as typeof fetch;

    const res = await exchangeGrokCliRefreshToken("rt-old");
    expect(res.success).toBe(true);
    expect(res.accessToken).toBe("at-new");
    expect(res.refreshToken).toBe("rt-new");
    expect(res.idToken).toBe("id-new");
    expect(res.expiresIn).toBe(3600);
    expect(capturedBody).toContain("grant_type=refresh_token");
    expect(capturedBody).toContain("refresh_token=rt-old");
  });

  test("maps invalid_grant to an expired error", async () => {
    globalThis.fetch = (async () =>
      new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch;

    const res = await exchangeGrokCliRefreshToken("rt-dead");
    expect(res.success).toBe(false);
    expect(res.error).toContain("expired:");
  });

  test("GrokCliProvider.refreshToken delegates and persists the rotated token", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 600 }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = new GrokCliProvider();
    const account = {
      id: 1,
      provider: "grok-cli",
      email: "e@test.local",
      tokens: { access_token: "at-1", refresh_token: "rt-1", email: "e@test.local" },
    } as Account;

    const res = await provider.refreshToken(account);
    expect(res.success).toBe(true);
    const tokens = JSON.parse(res.tokens!) as Record<string, string | undefined>;
    expect(tokens.access_token).toBe("at-2");
    expect(tokens.refresh_token).toBe("rt-2");
    expect(tokens.email).toBe("e@test.local");
    expect(tokens.expires_at).toBeTruthy();
  });
});
