// In-memory OAuth session store for the Kiro provider. Mirrors
// `oauth-codex-session.ts` almost 1:1 so the frontend can share polling
// semantics with Codex.

type KiroOAuthStatus =
  | "pending"
  | "waiting_callback"
  | "exchanging"
  | "done"
  | "error"
  | "cancelled";

export interface KiroOAuthSession {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  appPort?: string;
  status: KiroOAuthStatus;
  createdAt: number;
  updatedAt: number;
  consumedAt?: number;
  connection?: {
    id: number;
    provider: string;
    email: string;
    displayName: string;
    workspace?: string | null;
    plan?: string | null;
  };
  error?: string;
  /** Last authorization code we attempted to exchange (for single-use dedup). */
  consumedCode?: string;
}

const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map<string, KiroOAuthSession>();

function now() {
  return Date.now();
}

function pruneExpiredSessions() {
  const cutoff = now() - SESSION_TTL_MS;
  for (const [state, session] of sessions) {
    if (session.updatedAt < cutoff || session.createdAt < cutoff) {
      sessions.delete(state);
    }
  }
}

export function createKiroOAuthSession(input: {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  appPort?: string;
}) {
  pruneExpiredSessions();
  const ts = now();
  const session: KiroOAuthSession = {
    state: input.state,
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
    appPort: input.appPort,
    status: "pending",
    createdAt: ts,
    updatedAt: ts,
  };
  sessions.set(input.state, session);
  return session;
}

export function getKiroOAuthSession(state: string) {
  pruneExpiredSessions();
  return sessions.get(state) || null;
}

export function updateKiroOAuthSession(state: string, patch: Partial<KiroOAuthSession>) {
  const current = getKiroOAuthSession(state);
  if (!current) return null;
  const next: KiroOAuthSession = {
    ...current,
    ...patch,
    updatedAt: now(),
  };
  sessions.set(state, next);
  return next;
}

export function consumeKiroOAuthSession(state: string) {
  const session = getKiroOAuthSession(state);
  if (!session) return null;
  const consumedAt = now();
  if (["done", "error", "cancelled"].includes(session.status)) {
    sessions.delete(state);
    return { ...session, consumedAt };
  }
  return { ...session, consumedAt };
}

export function deleteKiroOAuthSession(state: string) {
  return sessions.delete(state);
}
