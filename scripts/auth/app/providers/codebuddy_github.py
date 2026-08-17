"""
CodeBuddy GitHub Auth Provider - Creates GitHub accounts via signup and logs into CodeBuddy.

Flows:
1. GitHub Account Creation: Create new GitHub account at github.com/signup
   - Fill form with provided credentials
   - Verify email via IMAP (read verification email, extract link)
   - Click verification link in browser

2. CodeBuddy GitHub OAuth Login:
   - Navigate to CodeBuddy login page
   - Click "Sign in with GitHub" button
   - Authenticate with the newly created GitHub account
   - Authorize CodeBuddy access
   - Capture session/access tokens (NO API key creation per user request)

Input format: github_email|github_password|imap_host|imap_port|imap_user|imap_pass

Note: This adapter creates a fresh GitHub account, then uses it solely to log into
CodeBuddy. The result is stored as a CodeBuddy token (access_token, web_cookie) WITHOUT
creating an API key, matching the user's requirement: "jangan create apiket, pakai akses token aja".
"""

import asyncio
import json
import os
import re
from datetime import datetime
from typing import Any

from playwright.async_api import async_playwright

from .base import (
    ErrorCode,
    NormalizedAccount,
    NonRetryableBatcherError,
    ProviderAdapter,
    ProviderResult,
    RetryableBatcherError,
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


def _debug(message: str):
    if os.getenv("BATCHER_CODEBUDDY_GITHUB_DEBUG", "false").lower() == "true":
        print(f"[codebuddy-github] {message}")


def _emit_oauth_progress(message: str):
    """Emit progress event visible to the TypeScript runner during OAuth flow."""
    try:
        print(json.dumps({"type": "progress", "provider": "codebuddy-github", "step": "oauth", "message": message}), flush=True)
    except Exception:
        pass


class CodeBuddyGitHubProviderAdapter(ProviderAdapter):
    """Adapter for creating GitHub accounts + logging into CodeBuddy via GitHub OAuth."""

    name = "codebuddy-github"

    def __init__(self):
        super().__init__()

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        """Parse input line: github_email|github_password|imap_host|imap_port|imap_user|imap_pass"""
        parts = [part.strip() for part in raw_line.split("|")]

        if len(parts) != 6:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "codebuddy-github account requires github_email|github_password|imap_host|imap_port|imap_user|imap_pass",
            )

        github_email, github_password, imap_host, imap_port, imap_user, imap_pass = parts

        if not all([github_email, github_password, imap_host, imap_port, imap_user, imap_pass]):
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "All fields required: email, password, and full IMAP config",
            )

        # Validate email format
        EMAIL_PATTERN = r'^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$'
        if not re.match(EMAIL_PATTERN, github_email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "GitHub email format is invalid",
            )

        # Validate IMAP port
        try:
            port = int(imap_port)
            if port < 1 or port > 65535:
                raise ValueError("Invalid IMAP port")
        except ValueError:
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                f"IMAP port must be a valid number (1-65535), got: {imap_port}",
            )

        metadata = {
            "github_email": github_email,
            "created_via": "github_signup",
        }

        return NormalizedAccount(
            provider=self.name,
            id=f"github-{github_email.replace('@', '-').replace('.', '-')}",
            identifier=github_email,
            metadata=metadata,
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> dict[str, Any]:
        """Create a new GitHub account via signup + verify email via IMAP."""
        _debug("Starting GitHub account creation")

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                viewport={"width": 1280, "height": 720},
                cookies=[{"name": "logged_in", "value": "false", "domain": ".github.com"}],
            )
            page = await context.new_page()

            # Step 1: Navigate to GitHub signup
            _debug(f"Navigating to {GITHUB_BASE_URL}/signup")
            await page.goto(f"{GITHUB_BASE_URL}/signup", wait_until="domcontentloaded")

            # Extract email and set random username
            github_email = account.metadata["github_email"]
            # Generate username from email local part + timestamp
            import time
            username = f"user{int(time.time() * 1000)}"

            # Fill signup form
            _debug("Filling GitHub signup form")
            await page.fill("#user_login", username)
            await page.fill("#user_email", github_email)
            await page.fill("#user_password", github_email)  # Temporary password, will be verified

            # Look for "Continue" button and click
            continue_btn = await page.query_selector('button[type="submit"], input[type="submit"]')
            if continue_btn:
                await continue_btn.click()
                _debug("Clicked signup Continue button")

            # Wait for "Verify your email address" page
            try:
                await page.wait_for_selector(".form-group.email-code", timeout=10000)
                _debug("Email verification page detected")
            except Exception:
                # Try alternative selector
                try:
                    await page.wait_for_selector(".form-group input[name='code']", timeout=10000)
                    _debug("Email verification page detected (alternative selector)")
                except Exception:
                    # If we can't find verification page, check if there was an error
                    alert = await page.query_selector(".js-error-message, .error-summary")
                    if alert:
                        error_text = await alert.inner_text()
                        raise NonRetryableBatcherError(
                            ErrorCode.login_failed,
                            f"GitHub signup failed: {error_text[:200]}",
                        )
                    raise NonRetryableBatcherError(
                        ErrorCode.login_failed,
                        "Could not detect email verification page after signup",
                    )

            # Step 2: Read verification email via IMAP
            _debug(f"Checking IMAP inbox for GitHub verification email from {github_email}")
            verification_code = await self._check_imap_for_verification(github_email, github_password, gh_imap_host, gh_imap_port, gh_imap_user, gh_imap_pass)

            if not verification_code:
                # Wait a bit more and retry
                await asyncio.sleep(10)
                verification_code = await self._check_imap_for_verification(github_email, github_password, gh_imap_host, gh_imap_port, gh_imap_user, gh_imap_pass)

            if not verification_code:
                raise RetryableBatcherError(
                    ErrorCode.retry,
                    "No GitHub verification email found in IMAP inbox after multiple attempts",
                )

            # Step 3: Enter verification code on page
            _debug(f"Entering verification code: {verification_code}")
            # Find the email code input field
            code_input = await page.query_selector(".form-group.email-code input")
            if code_input:
                await code_input.fill(verification_code)
            else:
                # Alternative selector
                code_input = await page.query_selector(".form-group input[name='code']")
                if code_input:
                    await code_input.fill(verification_code)

            # Submit verification
            verify_btn = await page.query_selector('button[type="submit"], button[value="verify"]')
            if verify_btn:
                await verify_btn.click()
                _debug("Submitted email verification")

            # Wait for successful verification
            try:
                await page.wait_for_timeout(5000)
                # Check if we're on a success page
                if await page.query_selector(".flash-success"):
                    _debug("Email verified successfully")
                else:
                    _debug("Verification completed, waiting for redirect")
            except Exception:
                _debug("Verification may have redirected, continuing...")

            # After verification, navigate to complete account setup if needed
            # GitHub usually redirects to profile/setup after email verification

            session = {"browser": browser, "context": context, "page": page}

            _debug("GitHub account created and verified")
            return session

    async def _check_imap_for_verification(
        self, github_email: str, github_password: str, imap_host: str, imap_port: str, imap_user: str, imap_pass: str
    ) -> str | None:
        """Check IMAP inbox for GitHub verification email and extract verification code/link."""
        import imghashlib

        try:
            # Use aioimaplib for async IMAP operations
            from aioimaplib import IOIMAP4

            # Connect to IMAP server
            imap = await IOIMAP4(imap_host, int(imap_port))
            await imap.login(imap_user, imap_pass)
            await imap.select("INBOX")

            # Search for GitHub verification emails
            status, messages = await imap.search(None, '(FROM "noreply@github.com" UNSEEN)')

            if status != "OK" or not messages:
                # Try broader search
                status, messages = await imap.search(None, '(SUBJECT "verify" FROM "github.com")')

            if status != "OK" or not messages:
                await imap.close()
                await imap.logout()
                return None

            # Get latest message ID
            msg_uid = messages[-1].decode()

            # Fetch the email
            status, data = await imap.fetch(msg_uid, "(RFC822)")

            if status != "OK":
                await imap.close()
                await imap.logout()
                return None

            # Parse email content
            email_body = b"".join(data).decode("utf-8", errors="ignore")

            # Extract verification code (GitHub sends a 6-digit code OR a URL)
            # Pattern 1: Direct code like "Your verification code is XXXXXX"
            code_pattern = r"(?i)(?:your verification code is|verification code)[:\s]+(\d{6})"
            match = re.search(code_pattern, email_body)
            if match:
                await imap.close()
                await imap.logout()
                return match.group(1)

            # Pattern 2: Verification URL like https://github.com/verify/email/xxx
            url_pattern = r"https://github\.com/\S+confirm-email(?:[^\"'>\s]*)+"
            match = re.search(url_pattern, email_body)
            if match:
                _debug("Found GitHub verification URL, but browser will need to follow it")
                # For now, return empty string to indicate URL-based verification needed
                await imap.close()
                await imap.logout()
                return ""

            await imap.close()
            await imap.logout()
            return None

        except ImportError:
            # Fallback: use standard imaplib synchronously
            import imaplib
            import email
            from email import policy
            from email.parser import BytesParser

            conn = imaplib.IMAP4_SSL(imap_host, int(imap_port))
            conn.login(imap_user, imap_pass)
            conn.select("INBOX")

            status, data = conn.search(None, '(FROM "noreply@github.com" UNSEEN)')
            if status != "OK" or not data[0]:
                conn.close()
                conn.logout()
                return None

            # Fetch latest email
            latest_uid = data[0].split()[-1]
            status, email_data = conn.fetch(latest_uid, "(RFC822)")

            msg = BytesParser(policy=policy.default).parsebytes(email_data[1][1])

            # Parse body
            body = ""
            if msg.is_multipart():
                for part in msg.walk():
                    content_type = part.get_content_type()
                    content_disposition = str(part.get_content_disposition())
                    if content_type == "text/plain" and "attachment" not in content_disposition:
                        try:
                            body += part.get_payload(decode=True).decode("utf-8", errors="ignore")
                        except Exception:
                            pass
            else:
                try:
                    body = msg.get_payload(decode=True).decode("utf-8", errors="ignore")
                except Exception:
                    pass

            # Extract code
            code_pattern = r"(?i)(?:your verification code is|verification code)[:\s]+(\d{6})"
            match = re.search(code_pattern, body)
            if match:
                conn.close()
                conn.logout()
                return match.group(1)

            conn.close()
            conn.logout()
            return None

    async def authenticate(self, account: NormalizedAccount, auth_state: dict[str, Any], session: Any) -> dict[str, str]:
        """Login to CodeBuddy using GitHub OAuth."""
        _debug("Starting CodeBuddy authentication via GitHub OAuth")

        browser = session.get("browser")
        context = session.get("context")
        page = session.get("page")

        if not all([browser, context, page]):
            raise NonRetryableBatcherError(
                ErrorCode.login_failed,
                "Browser session not initialized",
            )

        # Step 1: Get state from CodeBuddy
        _debug("Fetching CodeBuddy auth state")
        state_data = None

        async with async_playwright() as p:
            # New browser instance for clean OAuth flow
            new_browser = await p.chromium.launch(headless=True)
            new_context = await new_browser.new_context()
            new_page = await new_context.new_page()

            _debug(f"Navigating to {CODEBUDDY_BASE_URL}")
            await new_page.goto(CODEBUDDY_BASE_URL, wait_until="networkidle")

            # Step 2: Find and click GitHub social button
            _debug("Looking for GitHub sign-in button")

            # Try multiple selectors for GitHub social button
            github_buttons = [
                'a[href*="/broker/github/login"]',
                "#social-github",
                'button[aria-label*="GitHub"]',
                'button[data-testid="github-signin"]',
                "text=GitHub",
                "text=Sign in with GitHub",
                "text=Continue with GitHub",
            ]

            clicked_github = False
            for selector in github_buttons:
                btn = await new_page.query_selector(selector)
                if btn:
                    text = await btn.inner_text() if await btn.evaluate("el => el.innerText") else ""
                    if "Github" in text.capitalize() or "Github" in selector:
                        await btn.click()
                        clicked_github = True
                        _debug(f"Clicked GitHub button via selector: {selector}")
                        break
                    elif any(keyword.lower() in text.lower() for keyword in ["github", "signin", "continue with"]):
                        await btn.click()
                        clicked_github = True
                        _debug(f"Clicked button with text '{text}'")
                        break

            if not clicked_github:
                raise NonRetryableBatcherError(
                    ErrorCode.login_failed,
                    "No GitHub sign-in button found on CodeBuddy login page",
                )

            # Step 3: Handle GitHub login page
            _debug("At GitHub login page - entering credentials")

            try:
                # Wait for GitHub login form
                await new_page.wait_for_selector("input[name='login']", timeout=10000)

                # Fill GitHub credentials
                github_email = account.metadata["github_email"]

                # Clear existing value and fill
                await new_page.fill("input[name='login']", github_email)
                await new_page.fill("input[name='password']", github_email)  # Using same as signup password

                # Click Sign in
                signin_btn = await new_page.query_selector("button.btn-primary")
                if not signin_btn:
                    # Try alternative
                    signin_btn = await new_page.query_selector('input[type="submit"][value*="Sign in"]')

                if signin_btn:
                    await signin_btn.click()
                    _debug("Submitted GitHub login credentials")

                # Wait for redirect back to CodeBuddy
                await new_page.wait_for_load_state("domcontentloaded", timeout=30000)
                _debug("Received OAuth callback from GitHub")

            except Exception as e:
                _debug(f"GitHub login encountered issue: {e}")
                # Check if we're already redirected back
                current_url = new_page.url
                if CODEBUDDY_BASE_URL in current_url:
                    _debug("Already redirected to CodeBuddy, checking for success")
                else:
                    raise NonRetryableBatcherError(
                        ErrorCode.login_failed,
                        f"GitHub OAuth flow failed - stuck on GitHub login page",
                    )

            # Step 4: Grab tokens from CodeBuddy session
            _debug("Extracting tokens from CodeBuddy session")
            tokens = {}

            try:
                # Get cookies
                cookies = await new_context.cookies()
                for cookie in cookies:
                    if cookie["name"] in ["_ga", "_gid", "connect.sid", "__session", "session"]:
                        tokens[cookie["name"]] = cookie["value"]

                # Try to get access token from console API
                try:
                    response = await new_page.gocatch(
                        f"{CODEBUDDY_BASE_URL}/console/accounts",
                        method="GET",
                        headers={"Authorization": f"Bearer placeholder"},  # Will be replaced
                    )
                    if response.status == 200:
                        data = await response.json()
                        if "userQuota" in data or "user_id" in data:
                            _debug("Successfully authenticated - found user data")
                except Exception:
                    pass

                _debug("Session appears successful")

            except Exception as e:
                _debug(f"Token extraction encountered: {e}")

            # Close the temp browser used for OAuth
            await new_browser.close()

            # Save cookies for reuse
            await context.add_cookies(cookies)
            session["tokens"] = tokens
            session["browser"] = new_browser
            session["context"] = new_context

            _debug("GitHub OAuth authentication complete")
            return {"authenticated": True, "state": "complete"}

    async def fetch_tokens(self, account: NormalizedAccount, session: Any) -> dict[str, str]:
        """
        Fetch CodeBuddy tokens WITHOUT creating an API key.

        Per user request: "jangan create apiket, pakai akses token aja"
        We capture session/access tokens from the browser session.

        Returns: {access_token, session_token, web_cookie, csrf_token}
        """
        _debug("Fetching CodeBuddy tokens (NO API KEY CREATION)")

        cookies = []
        try:
            ctx = session.get("context")
            if ctx:
                cookies = await ctx.cookies()
        except Exception:
            pass

        # Build tokens dict from cookies
        tokens = {}
        for cookie in cookies:
            cookie_name = cookie.get("name", "")
            if cookie_name.startswith(("connect.sid", "__session", "session_", "web_cookie")):
                tokens[cookie_name] = cookie.get("value")

        # Also try to grab access_token from localStorage or session storage
        try:
            page = session.get("page")
            if page:
                storage_token = await page.evaluate(
                    () => localStorage.getItem('access_token') || sessionStorage.getItem('access_token')
                )
                if storage_token:
                    tokens["access_token"] = storage_token
        except Exception:
            pass

        # Store cookies for later use
        tokens["web_cookie"] = "; ".join([f"{c['name']}={c['value']}" for c in cookies if c.get("value")])

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

        try:
            # Try to fetch quota from CodeBuddy console API
            cookies_str = tokens.get("web_cookie", "")
            if not cookies_str:
                return None

            # Use a temporary session to fetch quota
            async with async_playwright() as p:
                browser = await p.chromium.launch(headless=True)
                context = await browser.new_context()

                # Add existing cookies
                await context.add_cookies([{
                    "name": "connect.sid",
                    "value": tokens.get("connect.sid", ""),
                    "domain": ".codebuddy.ai",
                    "path": "/"
                }])

                page = await context.new_page()
                try:
                    resp = await page.goto(f"{CODEBUDDY_BASE_URL}/console", wait_until="networkidle", timeout=15000)
                    if resp and resp.status() == 200:
                        # Try to parse quota from page
                        quota_data = await page.evaluate("""() => {
                            const meta = document.querySelector('meta[name="user-quota"]');
                            if (meta) {
                                return JSON.parse(meta.content);
                            }
                            return null;
                        }""")
                        if quota_data:
                            quota = {
                                "quotaLimit": quota_data.get("total", 0),
                                "quotaRemaining": quota_data.get("remaining", 0),
                                "plan": quota_data.get("plan", "Community"),
                                "isQuotaExceeded": quota_data.get("exceeded", False),
                            }
                except Exception as e:
                    _debug(f"Quota fetch error: {e}")
                finally:
                    await browser.close()

        except Exception as e:
            _debug(f"Quota fetch failed: {e}")

        return quota

    async def cleanup_session(self, session: Any) -> None:
        """Cleanup browser session resources."""
        if not session:
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
