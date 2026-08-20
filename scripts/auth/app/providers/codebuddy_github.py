"""
CodeBuddy GitHub OAuth Provider - Login to CodeBuddy using an existing GitHub account.

Flow:
1. Navigate to CodeBuddy login page
2. Click "Sign in with GitHub" button
3. Authenticate with the user's existing GitHub account
4. Authorize CodeBuddy access
5. Capture session/access tokens (NO API key creation per user request)

Input format: github_email|github_password

Note: Per user request "jangan bikin akun github tapi oauth pakai github" — this
adapter does NOT create a GitHub account. It uses the user's existing GitHub
credentials to log into CodeBuddy via GitHub OAuth. The result is stored as a
CodeBuddy token (access_token, refresh_token, web_cookie) WITHOUT creating an API key.
"""

import asyncio
import email as email_lib
import imaplib
import json
import os
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter
from app.providers.browser_utils import (
    OAUTH_FIREFOX_PREFS,
    build_camoufox_kwargs,
    is_browser_crash,
)

COOKIES_DIR = Path(__file__).parent.parent.parent.parent / "cookies"
COOKIES_DIR.mkdir(exist_ok=True)

GITHUB_BASE_URL = os.getenv("BATCHER_GITHUB_BASE_URL", "https://github.com")
CODEBUDDY_BASE_URL = os.getenv("BATCHER_CODEBUDDY_BASE_URL", "https://www.codebuddy.ai")
CODEBUDDY_PLATFORM = os.getenv("BATCHER_CODEBUDDY_PLATFORM", "IDE").upper() or "IDE"
CODEBUDDY_STATE_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_STATE_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/v2/plugin/auth/state?platform={CODEBUDDY_PLATFORM}",
)

# GitHub device-verification OTP is fetched via IMAP. Gmail requires an App
# Password (2FA must be on): https://support.google.com/accounts/answer/185833
GITHUB_IMAP_HOST = os.getenv("BATCHER_GITHUB_IMAP_HOST", "imap.gmail.com")
GITHUB_IMAP_PORT = int(os.getenv("BATCHER_GITHUB_IMAP_PORT", "993"))
GITHUB_IMAP_EMAIL = os.getenv("BATCHER_GITHUB_IMAP_EMAIL", "").strip()
GITHUB_IMAP_APP_PASSWORD = os.getenv("BATCHER_GITHUB_IMAP_APP_PASSWORD", "").strip()
GITHUB_IMAP_MAILBOX = os.getenv("BATCHER_GITHUB_IMAP_MAILBOX", "INBOX")
GITHUB_OTP_TIMEOUT_S = int(os.getenv("BATCHER_GITHUB_OTP_TIMEOUT_S", "180"))
GITHUB_OTP_POLL_INTERVAL_S = float(os.getenv("BATCHER_GITHUB_OTP_POLL_INTERVAL_S", "5.0"))

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def _debug(message: str):
    if os.getenv("BATCHER_CODEBUDDY_GITHUB_DEBUG", "false").lower() == "true":
        print(f"[codebuddy-github] {message}")


def _emit_oauth_progress(message: str):
    """Emit progress event visible to the TypeScript runner during OAuth flow."""
    try:
        print(json.dumps({"type": "progress", "provider": "codebuddy-github", "step": "oauth", "message": message}), flush=True)
    except Exception:
        pass


_GITHUB_OTP_RE = re.compile(r"\b(\d{6,8})\b")
_GITHUB_IMAP_FROM = "noreply@github.com"
_GITHUB_IMAP_SUBJECT_HINTS = (
    "verification code",
    "please verify",
    "verify your device",
    "sign-in verification",
    "sign in code",
    "device verification",
)


def _extract_github_otp_from_message(msg: Any) -> str | None:
    """Return the first 6-8 digit OTP found in a parsed email.message.

    GitHub sometimes puts the code directly in the subject line
    ("[GitHub] 123456 is your verification code"), other times only in the
    body. Scans subject, then text/plain, then text/html parts.
    """
    subject = str(msg.get("Subject") or "")
    m = _GITHUB_OTP_RE.search(subject)
    if m:
        return m.group(1)
    for part in msg.walk():
        if part.get_content_type() not in ("text/plain", "text/html"):
            continue
        try:
            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            body = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        except Exception:
            continue
        m = _GITHUB_OTP_RE.search(body)
        if m:
            return m.group(1)
    return None


def _imap_fetch_github_otp_once() -> str | None:
    """Single blocking IMAP roundtrip. Returns OTP or None if no match yet.

    Filters UNSEEN messages FROM noreply@github.com whose subject contains one
    of _GITHUB_IMAP_SUBJECT_HINTS, scans newest-first (up to 20), and marks the
    winning message \\Seen so a retry won't reuse an expired code.
    """
    conn: imaplib.IMAP4_SSL | None = None
    try:
        conn = imaplib.IMAP4_SSL(host=GITHUB_IMAP_HOST, port=GITHUB_IMAP_PORT)
        conn.login(GITHUB_IMAP_EMAIL, GITHUB_IMAP_APP_PASSWORD)
        conn.select(GITHUB_IMAP_MAILBOX, readonly=False)
        typ, data = conn.search(None, "UNSEEN", "FROM", f'"{_GITHUB_IMAP_FROM}"')
        if typ != "OK" or not data or not data[0]:
            return None
        ids = data[0].split()
        for msg_id in reversed(ids[-20:]):
            typ, msg_data = conn.fetch(msg_id, "(RFC822)")
            if typ != "OK" or not msg_data or not msg_data[0]:
                continue
            raw_bytes = msg_data[0][1]
            if not isinstance(raw_bytes, (bytes, bytearray)):
                continue
            msg = email_lib.message_from_bytes(bytes(raw_bytes))
            subject_lower = str(msg.get("Subject") or "").lower()
            if not any(h in subject_lower for h in _GITHUB_IMAP_SUBJECT_HINTS):
                continue
            otp = _extract_github_otp_from_message(msg)
            if otp:
                try:
                    conn.store(msg_id, "+FLAGS", "\\Seen")
                except Exception:
                    pass
                return otp
        return None
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            try:
                conn.logout()
            except Exception:
                pass


async def _fetch_github_otp_via_imap(timeout_s: int = GITHUB_OTP_TIMEOUT_S) -> str:
    """Poll IMAP inbox for the newest GitHub device-verification OTP.

    Requires BATCHER_GITHUB_IMAP_EMAIL + BATCHER_GITHUB_IMAP_APP_PASSWORD env
    vars. For Gmail: enable 2FA, then create an App Password at
    https://support.google.com/accounts/answer/185833.

    Each poll runs on a worker thread (imaplib is blocking). Raises
    NonRetryableBatcherError on missing config, RetryableBatcherError on IMAP
    auth/search failure or timeout so the outer retry loop can restart.
    """
    if not GITHUB_IMAP_EMAIL or not GITHUB_IMAP_APP_PASSWORD:
        raise NonRetryableBatcherError(
            ErrorCode.input_missing_required_field,
            "GitHub device-verification OTP needs BATCHER_GITHUB_IMAP_EMAIL and "
            "BATCHER_GITHUB_IMAP_APP_PASSWORD env vars (Gmail App Password)",
        )
    _debug(
        f"otp via imap: host={GITHUB_IMAP_HOST}:{GITHUB_IMAP_PORT} "
        f"user={GITHUB_IMAP_EMAIL} mailbox={GITHUB_IMAP_MAILBOX} timeout={timeout_s}s"
    )
    deadline = time.monotonic() + timeout_s
    last_err = ""
    while time.monotonic() < deadline:
        otp: str | None = None
        try:
            otp = await asyncio.to_thread(_imap_fetch_github_otp_once)
        except imaplib.IMAP4.error as exc:
            _debug(f"otp imap4 error: {exc}")
            raise RetryableBatcherError(
                ErrorCode.auth_temporary_failure,
                f"GitHub OTP IMAP login/search failed: {exc}",
            ) from exc
        except Exception as exc:
            last_err = f"{type(exc).__name__}: {exc}"
            _debug(f"otp imap poll error: {last_err}")
        if otp:
            _debug(f"otp via imap: found len={len(otp)}")
            return otp
        await asyncio.sleep(GITHUB_OTP_POLL_INTERVAL_S)
    raise RetryableBatcherError(
        ErrorCode.auth_temporary_failure,
        f"GitHub OTP not received via IMAP within {timeout_s}s"
        + (f" (last: {last_err})" if last_err else ""),
    )


def _get_proxy_url() -> str | None:
    """Proxy URL injected by the TS runner (BATCHER_PROXY_URL) or the shell env.

    CodeBuddy is not reachable directly from every host, so the browser must go
    through the same proxy pool the rest of the CodeBuddy flow uses.
    """
    return (
        os.getenv("BATCHER_PROXY_URL")
        or os.getenv("HTTPS_PROXY")
        or os.getenv("HTTP_PROXY")
        or None
    )


def _playwright_proxy() -> dict[str, str] | None:
    """Translate the proxy URL into a Playwright/camoufox proxy config.

    Kept as a helper for callers that need the parsed form; camoufox itself is
    configured through build_camoufox_kwargs(proxy_url=...).
    """
    url = _get_proxy_url()
    if not url:
        return None
    parsed = urlparse(url)
    if not parsed.hostname:
        return None
    server = f"{parsed.scheme or 'http'}://{parsed.hostname}"
    if parsed.port:
        server += f":{parsed.port}"
    cfg: dict[str, str] = {"server": server}
    if parsed.username:
        cfg["username"] = unquote(parsed.username)
    if parsed.password:
        cfg["password"] = unquote(parsed.password)
    return cfg


async def _launch_camoufox() -> tuple[Any, Any]:
    """Launch camoufox (Firefox) through the proxy pool.

    Chromium/Playwright crashes ("Target crashed", ERR_INSUFFICIENT_RESOURCES)
    on CodeBuddy's Keycloak page on this VPS, even with --disable-dev-shm-usage
    and JS disabled. Camoufox with OAUTH_FIREFOX_PREFS (fission off, COOP/COEP
    off) loads the same page reliably, so every other CodeBuddy-family provider
    in this repo uses it — this one does too.

    Returns (manager, browser); the caller must call
    ``await manager.__aexit__(None, None, None)``.
    """
    try:
        from camoufox.async_api import AsyncCamoufox
    except Exception as exc:
        raise RetryableBatcherError(
            ErrorCode.browser_start_failed,
            f"camoufox import failed: {exc}",
        ) from exc

    kwargs = build_camoufox_kwargs(
        proxy_url=_get_proxy_url() or "",
        headless_default="true",
        default_timeout=60000,
        disable_coop=True,
        firefox_user_prefs=OAUTH_FIREFOX_PREFS,
    )
    default_timeout = kwargs.pop("_default_timeout")

    try:
        manager = AsyncCamoufox(**kwargs)
        browser = await manager.__aenter__()
    except Exception as exc:
        raise RetryableBatcherError(
            ErrorCode.browser_start_failed,
            f"camoufox launch failed: {exc}",
        ) from exc

    _debug(f"camoufox launched (proxy={'yes' if kwargs.get('proxy') else 'no'})")
    return manager, browser, default_timeout


class CodeBuddyGitHubProviderAdapter(ProviderAdapter):
    """Adapter for logging into CodeBuddy via GitHub OAuth with an existing GitHub account."""

    name = "codebuddy-github"

    def __init__(self):
        super().__init__()

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        """Parse input line: github_email|github_password"""
        parts = [part.strip() for part in raw_line.split("|")]

        if len(parts) != 2:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "codebuddy-github account requires github_email|github_password",
            )

        github_email, github_password = parts

        if not github_email or not github_password:
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "Both github_email and github_password are required",
            )

        # Validate email format
        EMAIL_PATTERN = r'^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$'
        if not re.match(EMAIL_PATTERN, github_email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "GitHub email format is invalid",
            )

        metadata = {
            "github_email": github_email,
            "github_password": github_password,
            "created_via": "github_oauth",
        }

        return NormalizedAccount(
            provider=self.name,
            identifier=github_email,
            secret=github_password,
            metadata=metadata,
            raw=raw_line,
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> dict[str, Any]:
        """No separate bootstrap needed — OAuth login happens in authenticate()."""
        return {}

    async def authenticate(self, account: NormalizedAccount, session: Any) -> dict[str, Any]:
        """Login to CodeBuddy using GitHub OAuth. Returns tokens dict."""
        _debug("Starting CodeBuddy authentication via GitHub OAuth")

        github_email = account.metadata.get("github_email") or account.identifier
        github_password = account.metadata.get("github_password") or account.secret

        if not github_email or not github_password:
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "codebuddy-github requires a GitHub email and password",
            )

        manager, browser, default_timeout = await _launch_camoufox()
        tokens: dict[str, str] = {}
        try:
            page = await browser.new_page()
            page.set_default_timeout(default_timeout)
            context = page.context

            # ── Step 1: get device-flow state so the token can be claimed later ──
            _emit_oauth_progress("Requesting CodeBuddy auth state")
            state = ""
            try:
                resp = await page.request.post(CODEBUDDY_STATE_ENDPOINT, data="{}")
                if resp.status == 200:
                    payload = await resp.json()
                    state = str((payload.get("data") or {}).get("state") or "")
            except Exception as exc:
                _debug(f"state request failed: {exc}")

            if not state:
                raise RetryableBatcherError(
                    ErrorCode.auth_temporary_failure,
                    "codebuddy auth/state did not return a state",
                )
            _debug(f"state acquired: {state[:8]}…")

            # ── Step 2: open Keycloak login directly ─────────────────────────
            # The /login page renders the Keycloak form inside an iframe via a
            # heavy SPA bundle. Navigating straight to the Keycloak endpoint
            # skips the SPA entirely — it is plain server-rendered HTML that
            # carries the social-login (broker) links.
            redirect_uri = f"{CODEBUDDY_BASE_URL}/login?platform={CODEBUDDY_PLATFORM}&state={state}"
            keycloak_url = (
                f"{CODEBUDDY_BASE_URL}/auth/realms/copilot/protocol/openid-connect/auth"
                f"?client_id=console&response_type=code"
                f"&redirect_uri={quote(redirect_uri, safe='')}"
                f"&v=2210&product=codebuddy"
            )
            _emit_oauth_progress("Opening CodeBuddy (Keycloak) login")
            _debug("Navigating to Keycloak auth endpoint")
            await page.goto(keycloak_url, wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_timeout(2500)

            # ── Step 3: follow the GitHub identity-provider (broker) link ────
            # Clicking is unreliable: Keycloak renders two #social-github links
            # (sign-up pane + login pane) and gates the click behind a policy
            # checkbox whose own JS handler never fires headless. Reading the
            # href and navigating to it directly carries the same session_code
            # and lands on github.com.
            broker_href = await page.evaluate(
                """() => {
                    const links = [...document.querySelectorAll(
                        'a#social-github, a[href*="broker/github/login"]')];
                    const visible = links.find(a => a.offsetParent !== null);
                    return (visible || links[0] || {}).href || null;
                }"""
            )

            if not broker_href:
                raise NonRetryableBatcherError(
                    ErrorCode.browser_element_not_found,
                    "No GitHub broker link found on CodeBuddy Keycloak login page",
                )

            _debug(f"Following GitHub broker link: {broker_href[:70]}…")
            await page.goto(broker_href, wait_until="domcontentloaded", timeout=90000)
            await page.wait_for_timeout(3000)

            # Wait for GitHub's own login form (github.com)
            _emit_oauth_progress("GitHub login page")
            try:
                await page.wait_for_selector("input[name='login']", timeout=30000)
            except Exception:
                current = page.url
                raise NonRetryableBatcherError(
                    ErrorCode.browser_unexpected_state,
                    f"GitHub login page did not appear (at {current[:120]})",
                )

            await page.fill("input[name='login']", github_email)
            await page.fill("input[name='password']", github_password)

            signin_btn = await page.query_selector("input[type='submit'][name='commit']") or await page.query_selector("button[type='submit']")
            if signin_btn:
                await signin_btn.click()
                _debug("Submitted GitHub login credentials")

            # Wait for redirect back to CodeBuddy
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=30000)
            except Exception:
                pass

            # Wrong password fails immediately — surface it clearly.
            body_text = ""
            try:
                body_text = (await page.inner_text("body"))[:400].lower()
                if "incorrect username or password" in body_text:
                    raise NonRetryableBatcherError(
                        ErrorCode.auth_invalid_credentials,
                        "GitHub rejected the credentials",
                    )
            except NonRetryableBatcherError:
                raise
            except Exception:
                pass

            # GitHub device verification (new IP/device) — OTP from IMAP.
            # TOTP 2FA cannot be automated without the secret; only the
            # emailed device-verification code is handled here.
            if "/sessions/verified-device" in page.url or "verify your device" in body_text:
                _emit_oauth_progress("GitHub device verification — fetching code via IMAP")
                _debug(f"device-verify page at {page.url[:120]}")
                otp = await _fetch_github_otp_via_imap()
                _debug(f"submitting device-verify OTP (len={len(otp)})")
                await page.fill("input[name='otp'], input#otp", otp)
                verify_btn = await page.query_selector(
                    "button[type='submit'], input[type='submit']"
                )
                if verify_btn:
                    await verify_btn.click()
                _emit_oauth_progress("GitHub device verification — code submitted")
                try:
                    await page.wait_for_load_state("domcontentloaded", timeout=30000)
                except Exception:
                    pass
                try:
                    after = (await page.inner_text("body"))[:400].lower()
                    if "incorrect" in after or "expired" in after:
                        raise RetryableBatcherError(
                            ErrorCode.auth_temporary_failure,
                            f"GitHub device-verify code rejected (at {page.url[:120]})",
                        )
                except RetryableBatcherError:
                    raise
                except Exception:
                    pass

            if "/sessions/two-factor" in page.url or "two-factor" in body_text:
                raise NonRetryableBatcherError(
                    ErrorCode.auth_invalid_credentials,
                    "GitHub asked for TOTP 2FA — not automatable (device verification via IMAP is)",
                )

            # Handle potential "Authorize" screen on GitHub OAuth
            _emit_oauth_progress("Authorizing CodeBuddy")
            for sel in (
                "button[type='submit'][name='authorize']",
                "button[type='submit']:has-text('Authorize')",
                "input[type='submit'][value*='Authorize']",
            ):
                try:
                    authorize_btn = await page.query_selector(sel)
                    if authorize_btn:
                        await authorize_btn.click()
                        _debug(f"Clicked Authorize via {sel}")
                        await page.wait_for_load_state("domcontentloaded", timeout=30000)
                        break
                except Exception:
                    continue

            # Wait for CodeBuddy session to be established
            await page.wait_for_timeout(5000)

            # Extract tokens
            try:
                cookies = await context.cookies()
                for cookie in cookies:
                    name = cookie.get("name", "")
                    if name in ["connect.sid", "__session", "session", "session_token", "web_cookie"] or name.startswith("session_"):
                        tokens[name] = cookie.get("value", "")
                tokens["web_cookie"] = "; ".join(
                    [f"{c['name']}={c['value']}" for c in cookies if c.get("value")]
                )
            except Exception as e:
                _debug(f"Cookie extraction error: {e}")

            # Claim the device-flow token using the state minted in Step 1.
            # The browser is now an authenticated CodeBuddy session, so the
            # poll endpoint returns the accessToken bound to that state.
            _emit_oauth_progress("Claiming access token")
            for attempt in range(12):
                try:
                    token_resp = await page.request.get(
                        f"{CODEBUDDY_BASE_URL}/v2/plugin/auth/token?state={state}"
                    )
                    if token_resp.status == 200:
                        tdata = await token_resp.json()
                        t = tdata.get("data") or {}
                        if t.get("accessToken"):
                            tokens["access_token"] = t["accessToken"]
                            if t.get("refreshToken"):
                                tokens["refresh_token"] = t["refreshToken"]
                            if t.get("expiresIn"):
                                tokens["expires_in"] = str(t["expiresIn"])
                            _debug(f"access_token claimed on attempt {attempt + 1}")
                            break
                except Exception as e:
                    _debug(f"token poll error: {e}")
                await page.wait_for_timeout(2500)

            # Fallback: some builds stash the token in web storage
            if not tokens.get("access_token"):
                try:
                    storage_token = await page.evaluate(
                        """() => localStorage.getItem('access_token')
                            || sessionStorage.getItem('access_token')
                            || localStorage.getItem('codebuddy_access_token')
                            || ''"""
                    )
                    if storage_token:
                        tokens["access_token"] = storage_token
                        _debug("access_token recovered from web storage")
                except Exception:
                    pass

        except NonRetryableBatcherError:
            raise
        except Exception as exc:
            if is_browser_crash(exc):
                raise RetryableBatcherError(
                    ErrorCode.browser_start_failed,
                    f"camoufox crashed during GitHub OAuth: {exc}",
                ) from exc
            raise
        finally:
            try:
                await manager.__aexit__(None, None, None)
            except Exception:
                pass

        if not tokens.get("access_token"):
            raise NonRetryableBatcherError(
                ErrorCode.auth_token_extraction_failed,
                "Failed to capture access_token from CodeBuddy GitHub OAuth",
            )

        if isinstance(session, dict):
            session["tokens"] = tokens
        _debug(f"Tokens captured: {list(tokens.keys())}")
        return {"authenticated": True, "state": "complete", "tokens": tokens}

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        """Return the CodeBuddy tokens captured during authenticate() (NO API key creation)."""
        _debug("Fetching CodeBuddy tokens (NO API KEY CREATION)")
        tokens = dict((auth_state or {}).get("tokens") or {})
        if not tokens and isinstance(session, dict):
            tokens = dict(session.get("tokens") or {})

        if not tokens:
            raise RetryableBatcherError(
                ErrorCode.provider_token_exchange_failed,
                "No tokens captured from CodeBuddy GitHub OAuth",
            )

        _debug(f"Tokens captured: {list(tokens.keys())}")
        return tokens

    async def fetch_quota(self, account: NormalizedAccount, tokens: dict[str, str], session: Any) -> dict[str, Any] | None:
        """Fetch user quota information from CodeBuddy."""
        _debug("Fetching user quota")

        quota = {
            "quotaLimit": 0,
            "quotaRemaining": 0,
            "plan": "Community",
            "isQuotaExceeded": False,
        }

        access_token = tokens.get("access_token")
        if not access_token:
            return None

        manager = None
        try:
            manager, browser, default_timeout = await _launch_camoufox()
            page = await browser.new_page()
            page.set_default_timeout(default_timeout)
            try:
                resp = await page.request.post(
                    f"{CODEBUDDY_BASE_URL}/v2/billing/meter/get-user-resource",
                    headers={
                        "Content-Type": "application/json",
                        "Accept": "application/json, text/plain, */*",
                        "X-Requested-With": "XMLHttpRequest",
                        "X-Domain": "www.codebuddy.ai",
                        "Authorization": f"Bearer {access_token}",
                    },
                    data="{}",
                )
                if resp.status == 200:
                    data = await resp.json()
                    dd = data.get("data", {}).get("Response", {}).get("Data", {})
                    quota = {
                        "quotaLimit": dd.get("CapacitySize", 0) or dd.get("TotalDosage", 0),
                        "quotaRemaining": dd.get("CapacityRemain", 0),
                        "plan": dd.get("PackageName", "Community"),
                        "isQuotaExceeded": (dd.get("CapacityRemain", 0) or 0) <= 0,
                    }
            except Exception as e:
                _debug(f"Quota fetch error: {e}")
        except Exception as e:
            _debug(f"Quota fetch failed: {e}")
        finally:
            if manager is not None:
                try:
                    await manager.__aexit__(None, None, None)
                except Exception:
                    pass

        return quota

    async def cleanup_session(self, session: Any) -> None:
        """Cleanup browser session resources."""
        if not session or not isinstance(session, dict):
            return

        browser = session.get("browser")
        context = session.get("context")

        if context:
            try:
                await context.close()
            except Exception:
                pass

        if browser:
            try:
                await browser.close()
            except Exception:
                pass
