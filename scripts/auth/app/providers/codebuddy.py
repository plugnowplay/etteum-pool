from __future__ import annotations

import asyncio
import hashlib
import json
import os
import random
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import aiohttp

from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError
from app.providers.base import NormalizedAccount, ProviderAdapter
from app.providers.browser_utils import (
    OAUTH_FIREFOX_PREFS,
    build_camoufox_kwargs,
    is_browser_crash,
)

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

COOKIES_DIR = Path(__file__).parent.parent.parent.parent / "cookies"
COOKIES_DIR.mkdir(exist_ok=True)

CODEBUDDY_BASE_URL = os.getenv("BATCHER_CODEBUDDY_BASE_URL", "https://www.codebuddy.ai")
CODEBUDDY_PLATFORM = (
    os.getenv("BATCHER_CODEBUDDY_PLATFORM", "IDE").strip().upper() or "IDE"
)
CODEBUDDY_STATE_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_STATE_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/v2/plugin/auth/state?platform={CODEBUDDY_PLATFORM}",
)
CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/console/login/account",
)
CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/console/accounts",
)
CODEBUDDY_USER_RESOURCE_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_USER_RESOURCE_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/billing/meter/get-user-resource",
)
CODEBUDDY_API_KEYS_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_API_KEYS_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/console/api/client/v1/api-keys",
)
CODEBUDDY_REDIRECT_SCHEME = os.getenv(
    "BATCHER_CODEBUDDY_REDIRECT_SCHEME", "codebuddy://"
)
# Keep native CodeBuddy flow by default:
# after Google login, CodeBuddy should route to region page when needed.
CODEBUDDY_FORCE_REGION_POST_AUTH = (
    os.getenv("BATCHER_CODEBUDDY_FORCE_REGION_POST_AUTH", "false").lower() == "true"
)

CLI_HEADERS = {
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "CLI/2.54.0 CodeBuddy/2.54.0",
}


def _get_proxy_url() -> str | None:
    return (
        os.getenv("BATCHER_PROXY_URL")
        or os.getenv("HTTPS_PROXY")
        or os.getenv("HTTP_PROXY")
        or None
    )


def _make_proxy_connector() -> Any:
    url = _get_proxy_url()
    if not url:
        return None
    if url.startswith("socks"):
        try:
            from aiohttp_socks import ProxyConnector

            return ProxyConnector.from_url(url)
        except ImportError:
            return None
    return None


def _make_session(timeout: Any, headers: dict[str, str]) -> "aiohttp.ClientSession":
    connector = _make_proxy_connector()
    proxy_url = _get_proxy_url()
    kwargs: dict[str, Any] = {"timeout": timeout, "headers": headers}
    if connector:
        kwargs["connector"] = connector
    session = aiohttp.ClientSession(**kwargs)
    session._proxy_url = proxy_url if not connector else None  # type: ignore[attr-defined]
    return session


def _req_proxy(session: "aiohttp.ClientSession") -> str | None:
    return getattr(session, "_proxy_url", None)


WEB_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "X-Domain": urlparse(CODEBUDDY_BASE_URL).netloc,
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
    ),
}

EMAIL_SELECTORS = [
    "#identifierId",
    'input[name="identifier"]',
    'input[type="email"]',
    'input[name="email"]',
    'input[autocomplete="username"]',
]

PASSWORD_SELECTORS = [
    'input[type="password"]',
    'input[name="password"]',
    'input[name="Passwd"]',
    'input[autocomplete="current-password"]',
]


def _codebuddy_auth_debug_enabled() -> bool:
    return os.getenv("BATCHER_CODEBUDDY_AUTH_DEBUG", "false").lower() == "true"


def _codebuddy_auth_debug(message: str) -> None:
    if _codebuddy_auth_debug_enabled():
        print(f"[codebuddy-auth] {message}", flush=True)


def _emit_oauth_progress(message: str) -> None:
    """Emit a progress event visible to the TypeScript runner during OAuth flow."""
    try:
        print(
            json.dumps(
                {
                    "type": "progress",
                    "provider": "codebuddy",
                    "step": "oauth",
                    "message": message,
                }
            ),
            flush=True,
        )
    except Exception:
        pass


async def _target_url(target: Any) -> str:
    try:
        return str(target.url)
    except Exception:
        return ""


async def _active_element_snapshot(target: Any) -> str:
    try:
        return str(
            await target.evaluate(
                """() => {
                    const el = document.activeElement;
                    if (!el) return 'none';
                    const tag = (el.tagName || '').toLowerCase();
                    const id = el.id ? `#${el.id}` : '';
                    const name = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : '';
                    return `${tag}${id}${name}`;
                }"""
            )
        )
    except Exception:
        return "unknown"


async def _fill_google_email_step(target: Any, email: str) -> bool:
    selectors = ["#identifierId"]
    for selector in selectors:
        try:
            target_url = await _target_url(target)
            _codebuddy_auth_debug(
                f"email step target={target_url or 'n/a'} selector={selector}"
            )

            try:
                await target.wait_for_selector(selector, state="visible", timeout=3000)
            except Exception:
                _codebuddy_auth_debug(
                    f"selector not visible target={target_url or 'n/a'} selector={selector}"
                )
                pass

            locator = target.locator(selector).first
            if await locator.count() == 0:
                _codebuddy_auth_debug(
                    f"selector missing target={target_url or 'n/a'} selector={selector}"
                )
                continue

            if not await locator.is_visible():
                _codebuddy_auth_debug(
                    f"selector hidden target={target_url or 'n/a'} selector={selector}"
                )
                continue

            await locator.scroll_into_view_if_needed()
            await locator.click(force=True)
            await asyncio.sleep(0.2)
            _codebuddy_auth_debug(
                f"after click target={target_url or 'n/a'} active={await _active_element_snapshot(target)}"
            )

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(email, delay=60)
            except Exception as exc:
                _codebuddy_auth_debug(
                    f"press_sequentially failed target={target_url or 'n/a'} err={exc}"
                )
                continue

            await asyncio.sleep(0.5)
            val = await locator.input_value()
            _codebuddy_auth_debug(
                f"typed value target={target_url or 'n/a'} value={val!r}"
            )

            if email.lower() == str(val).lower().strip():
                # Human-ish think time before pressing Enter on email step.
                # Shorter than password (users don't second-guess their own
                # email) but still enough to look natural.
                _email_delay = random.uniform(1.5, 3.0)
                _codebuddy_auth_debug(
                    f"human-idle pause {_email_delay:.1f}s before submitting email"
                )
                await asyncio.sleep(_email_delay)
                # Prefer Enter on the email field — more human-like than
                # clicking Next, and it avoids Google's bot heuristics that
                # flag rapid button clicks. The email transition waiter
                # will click Next ONCE more if Enter doesn't advance.
                try:
                    await locator.press("Enter")
                    _codebuddy_auth_debug("email submitted via Enter key")
                except Exception as _exc:
                    _codebuddy_auth_debug(f"Enter on email failed: {_exc}; falling back to Next click")
                    await _click_google_next(target)
                await _wait_for_google_email_transition(target)
                _codebuddy_auth_debug(f"email accepted target={target_url or 'n/a'}")
                return True

        except Exception as exc:
            _codebuddy_auth_debug(f"email fill error selector={selector} err={exc}")
            continue
    return False


async def _fill_google_password_step(target: Any, password: str) -> bool:
    selectors = ['input[name="Passwd"]', 'input[type="password"]']
    for selector in selectors:
        try:
            target_url = await _target_url(target)
            _codebuddy_auth_debug(
                f"password step target={target_url or 'n/a'} selector={selector}"
            )

            try:
                await target.wait_for_selector(selector, state="visible", timeout=3000)
            except Exception:
                _codebuddy_auth_debug(
                    f"selector not visible target={target_url or 'n/a'} selector={selector}"
                )
                pass

            locator = target.locator(selector).first
            if await locator.count() == 0:
                _codebuddy_auth_debug(
                    f"selector missing target={target_url or 'n/a'} selector={selector}"
                )
                continue
            if not await locator.is_visible():
                _codebuddy_auth_debug(
                    f"selector hidden target={target_url or 'n/a'} selector={selector}"
                )
                continue

            await locator.scroll_into_view_if_needed()
            await locator.click(force=True)
            await asyncio.sleep(0.2)
            _codebuddy_auth_debug(
                f"after click target={target_url or 'n/a'} active={await _active_element_snapshot(target)}"
            )

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(password, delay=70)
            except Exception as exc:
                _codebuddy_auth_debug(
                    f"press_sequentially failed target={target_url or 'n/a'} err={exc}"
                )
                continue

            await asyncio.sleep(0.5)
            typed_len = 0
            try:
                val = await locator.input_value()
                typed_len = len(str(val))
            except Exception:
                pass
            if typed_len == 0:
                try:
                    typed_len = int(
                        await target.evaluate(
                            "(sel) => { const el = document.querySelector(sel); return el ? el.value.length : 0; }",
                            selector,
                        )
                    )
                except Exception:
                    typed_len = 0
            _codebuddy_auth_debug(
                f"typed password length target={target_url or 'n/a'} length={typed_len}"
            )
            if typed_len >= len(password):
                # Human-ish idle pause: real users glance at the password
                # they just typed / their password manager confirmation
                # before pressing Enter. 4-8 seconds of think time is
                # believable and significantly reduces Google's "new device
                # first-login" defensive block on fresh accounts.
                _think_delay = random.uniform(4.0, 8.0)
                _codebuddy_auth_debug(
                    f"human-idle pause {_think_delay:.1f}s before submitting password"
                )
                await asyncio.sleep(_think_delay)

                # Prefer Enter on the password field itself — it's more
                # human-like than a button click and avoids Google's
                # "bot clicked Next too fast" heuristics. The password
                # transition waiter will click Next ONCE more if Enter
                # doesn't advance the flow.
                try:
                    await locator.press("Enter")
                    _codebuddy_auth_debug("password submitted via Enter key")
                except Exception as _exc:
                    _codebuddy_auth_debug(f"Enter on password failed: {_exc}; falling back to Next click")
                    await _click_google_next(target)
                await _wait_for_google_password_transition(target)
                _codebuddy_auth_debug(f"password accepted target={target_url or 'n/a'}")
                return True

        except Exception as exc:
            _codebuddy_auth_debug(f"password fill error selector={selector} err={exc}")
            continue
    return False


async def _wait_for_google_email_transition(target: Any) -> bool:
    """Wait for the email step to disappear WITHOUT spam-clicking.

    Mirrors _wait_for_google_password_transition: passive wait first, then
    at most ONE additional Next click. Prevents Google's bot detection from
    flagging our session on the login flow.
    """
    async def _still_on_email() -> bool:
        try:
            return bool(await target.evaluate(
                """() => {
                    const host = window.location.host || '';
                    const path = window.location.pathname || '';
                    const hasEmail = Array.from(
                        document.querySelectorAll('#identifierId, input[name="identifier"], input[type="email"]')
                    ).some(el => el.offsetParent !== null);
                    const hasPassword = Array.from(
                        document.querySelectorAll('input[name="Passwd"], input[type="password"]')
                    ).some(el => el.offsetParent !== null);
                    if (!host.includes('accounts.google.com')) return false;
                    if (hasPassword) return false;
                    if (path.includes('/signin/challenge/pwd')) return false;
                    return hasEmail || path.includes('/signin/identifier');
                }"""
            ))
        except Exception:
            return False

    # Phase 1: passive wait — Enter was pressed by caller
    phase1_deadline = time.monotonic() + 6.0
    while time.monotonic() < phase1_deadline:
        if not await _still_on_email():
            return True
        await asyncio.sleep(0.4)

    _codebuddy_auth_debug("email transition: phase-1 wait exhausted, clicking Next once")
    try:
        await _click_google_next(target)
    except Exception as exc:
        _codebuddy_auth_debug(f"email transition: single retry-click failed: {exc}")

    phase2_deadline = time.monotonic() + 6.0
    while time.monotonic() < phase2_deadline:
        if not await _still_on_email():
            return True
        await asyncio.sleep(0.4)

    _codebuddy_auth_debug("email transition: deadline exceeded (12s, 1 retry-click)")
    return False


async def _wait_for_google_password_transition(target: Any) -> bool:
    """Wait for the password step to disappear WITHOUT spam-clicking.

    Google detects rapid multi-clicks as bot behavior and can trigger
    "wrong password" false-negatives, CAPTCHA, or device challenges.

    Strategy (mirrors budy-pc `_submit_near_field`):
      - Passive wait 8s first (Enter/Next was pressed before this call).
      - If still on password step, click Next ONCE more (some SPA re-mounts).
      - Passive wait 6s.
      - Give up (return False) — caller retries the whole password step.

    Max total: ~14s, at most 1 extra click.
    """
    async def _still_on_password() -> bool:
        try:
            return bool(await target.evaluate(
                """() => {
                    const host = window.location.host || '';
                    const path = window.location.pathname || '';
                    const hasPassword = Array.from(
                        document.querySelectorAll('input[name="Passwd"], input[type="password"]')
                    ).some(el => el.offsetParent !== null);
                    if (!host.includes('accounts.google.com')) return false;
                    if (!path.includes('/challenge/pwd')) return false;
                    return hasPassword;
                }"""
            ))
        except Exception:
            # If evaluate fails (page navigated), transition happened
            return False

    # Phase 1: passive wait — Enter was already pressed by the caller
    phase1_deadline = time.monotonic() + 8.0
    while time.monotonic() < phase1_deadline:
        if not await _still_on_password():
            return True
        await asyncio.sleep(0.4)

    # Phase 2: still stuck — click Next ONCE more (form may have re-mounted)
    _codebuddy_auth_debug("password transition: phase-1 wait exhausted, clicking Next once")
    try:
        await _click_google_next(target)
    except Exception as exc:
        _codebuddy_auth_debug(f"password transition: single retry-click failed: {exc}")

    phase2_deadline = time.monotonic() + 6.0
    while time.monotonic() < phase2_deadline:
        if not await _still_on_password():
            return True
        await asyncio.sleep(0.4)

    _codebuddy_auth_debug("password transition: deadline exceeded (14s, 1 retry-click)")
    return False


async def _is_password_step(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    for (const el of document.querySelectorAll('input[type="password"], input[name="Passwd"]')) {
                        if (el.offsetParent !== null) return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _is_email_step(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    for (const el of document.querySelectorAll('input[type="email"], input[name="identifier"], #identifierId')) {
                        if (el.offsetParent !== null) return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _is_google_account_picker(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    // If a password field is visible, we're on the password step, not the picker
                    const hasPassword = Array.from(
                        document.querySelectorAll('input[type="password"], input[name="Passwd"]')
                    ).some(el => el.offsetParent !== null);
                    if (hasPassword) return false;
                    // If an email/identifier input is visible, we're on the email step, not the picker
                    const hasEmailInput = Array.from(
                        document.querySelectorAll('#identifierId, input[name="identifier"], input[type="email"]')
                    ).some(el => el.offsetParent !== null);
                    if (hasEmailInput) return false;
                    // Check for actual account picker elements (specific selectors only)
                    const selectors = [
                        'div[data-identifier]',
                        'div[data-email]',
                        'li[data-identifier]',
                        'div.BHzsHc'
                    ];
                    for (const sel of selectors) {
                        const els = document.querySelectorAll(sel);
                        for (const el of els) {
                            const text = (el.textContent || '').toLowerCase();
                            if (text.includes('@') && el.offsetParent !== null) {
                                return true;
                            }
                        }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _click_google_account_in_picker(target: Any, email: str) -> bool:
    try:
        clicked = bool(
            await target.evaluate(
                """(email) => {
                    const lowerEmail = email.toLowerCase();
                    const selectors = [
                        'div[data-identifier]',
                        'div[data-email]',
                        'li[data-identifier]',
                        'div.BHzsHc'
                    ];
                    
                    for (const sel of selectors) {
                        const els = document.querySelectorAll(sel);
                        for (const el of els) {
                            const identifier = (el.getAttribute('data-identifier') || el.getAttribute('data-email') || '').toLowerCase();
                            const textContent = (el.textContent || '').toLowerCase();
                            
                            if (identifier === lowerEmail || textContent.includes(lowerEmail)) {
                                if (el.offsetParent !== null) {
                                    el.click();
                                    return true;
                                }
                                const parent = el.closest('div[role="link"], li, button');
                                if (parent && parent.offsetParent !== null) {
                                    parent.click();
                                    return true;
                                }
                            }
                        }
                    }
                    return false;
                }""",
                email,
            )
        )
        if clicked:
            await asyncio.sleep(1.0)
        return clicked
    except Exception:
        return False


async def _click_google_next(target: Any) -> bool:
    try:
        return bool(
            await target.evaluate(
                """() => {
                    // Only click the specific Next buttons Google provides — never generic buttons
                    const btn = document.querySelector(
                        '#identifierNext button, #passwordNext button, #identifierNext, #passwordNext'
                    );
                    if (btn && btn.offsetParent !== null) {
                        btn.click();
                        return true;
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _click_continue_button(target: Any) -> None:
    await target.evaluate(
        """() => {
            const keywords = ['next', 'continue', 'accept', 'i understand', 'agree', 'ok', 'got it', 'login', 'sign in'];
            for (const btn of document.querySelectorAll('button, div[role="button"], input[type="submit"]')) {
                const txt = (btn.textContent || btn.value || '').toLowerCase().trim();
                if (!txt) continue;
                if (keywords.some((k) => txt.includes(k)) && btn.offsetParent !== null) {
                    btn.click();
                    return;
                }
            }
        }"""
    )


async def _get_codebuddy_login_iframe(page: Any) -> Any | None:
    """Return the Frame for CodeBuddy's login-iframe (Keycloak), or None."""
    handle_frame = await _get_codebuddy_login_iframe_with_handle(page)
    return handle_frame[1] if handle_frame else None


async def _get_codebuddy_login_iframe_with_handle(page: Any) -> tuple[Any, Any] | None:
    """Return (iframe_element_handle, frame) for CodeBuddy's login-iframe.

    We need the ElementHandle to compute absolute coordinates in the parent
    document for real mouse events.
    """
    selectors = [
        'iframe[title="login-iframe"]',
        'iframe[src*="/auth/realms/copilot/protocol/openid-connect/auth"]',
    ]
    for selector in selectors:
        try:
            iframe_el = await page.query_selector(selector)
            if not iframe_el:
                continue
            frame = await iframe_el.content_frame()
            if frame is not None:
                return iframe_el, frame
        except Exception:
            continue
    return None


# JS snippet: scroll target into view inside a frame and return its rect
# relative to the frame's document. Selector-based version.
_RECT_IN_FRAME_JS = r"""(selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    try { el.scrollIntoView({block: 'center', inline: 'center'}); } catch (e) {}
    const rect = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0
        && cs.visibility !== 'hidden' && cs.display !== 'none'
        && parseFloat(cs.opacity || '1') > 0.05;
    return {
        x: rect.x, y: rect.y, w: rect.width, h: rect.height,
        visible, tag: el.tagName, id: el.id || null,
    };
}"""


async def _real_mouse_click_in_frame(
    page: Any,
    iframe_el: Any,
    frame: Any,
    selector: str,
    *,
    settle_ms: int = 150,
    hold_ms: int = 60,
    steps: int = 18,
) -> dict[str, Any] | None:
    """Physically move the mouse and click a selector inside an iframe.

    Uses page.mouse.move (with intermediate steps) + mouse.down/up to generate
    native input events. This is required for Camoufox/anti-detect environments
    where synthetic DOM .click() may not trigger navigation on OAuth links.
    Returns dict with click info on success, None on failure.
    """
    try:
        # Rect of the element inside the frame document
        rect = await frame.evaluate(_RECT_IN_FRAME_JS, selector)
    except Exception as exc:
        _codebuddy_auth_debug(f"real-click: rect eval failed selector={selector!r}: {exc}")
        return None
    if not rect or not rect.get("visible"):
        return None

    try:
        # Bounding box of the iframe element in parent document
        iframe_box = await iframe_el.bounding_box()
    except Exception as exc:
        _codebuddy_auth_debug(f"real-click: iframe bounding_box failed: {exc}")
        return None
    if not iframe_box:
        return None

    # Absolute coords in the page viewport
    target_x = iframe_box["x"] + rect["x"] + rect["w"] / 2
    target_y = iframe_box["y"] + rect["y"] + rect["h"] / 2

    # Origin: start from a reasonable neutral point (top-right of viewport
    # or last known mouse pos — Playwright doesn't expose last pos, so use
    # a small random-ish offset from target as a starting point).
    try:
        vp = await page.evaluate("() => ({w: window.innerWidth, h: window.innerHeight})")
        origin_x = min(vp.get("w", 1200) - 20, max(20, target_x - 200))
        origin_y = min(vp.get("h", 800) - 20, max(20, target_y - 150))
    except Exception:
        origin_x, origin_y = max(20.0, target_x - 200), max(20.0, target_y - 150)

    try:
        # Move to origin instantly (avoid a "flash" from previous position),
        # then move to target with human-like intermediate steps.
        await page.mouse.move(origin_x, origin_y, steps=1)
        await asyncio.sleep(0.04)
        await page.mouse.move(target_x, target_y, steps=max(4, steps))
        await asyncio.sleep(settle_ms / 1000.0)
        await page.mouse.down()
        await asyncio.sleep(hold_ms / 1000.0)
        await page.mouse.up()
    except Exception as exc:
        _codebuddy_auth_debug(f"real-click: mouse events failed selector={selector!r}: {exc}")
        return None

    _codebuddy_auth_debug(
        f"real-click OK selector={selector!r} at=({target_x:.0f},{target_y:.0f}) "
        f"iframe=({iframe_box['x']:.0f},{iframe_box['y']:.0f}) rect=({rect['x']:.0f},{rect['y']:.0f},"
        f"{rect['w']:.0f}x{rect['h']:.0f}) tag={rect.get('tag')} id={rect.get('id')}"
    )
    return {"x": target_x, "y": target_y, "selector": selector, "rect": rect}


_LANDING_TICK_JS = r"""() => {
    const out = { checkbox: null, google: null, hasSocialContainer: false, url: location.href };

    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const cs = window.getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.05) return false;
        return true;
    }
    function clickLike(el) {
        try { el.scrollIntoView({block: 'center'}); } catch (e) {}
        const opts = { bubbles: true, cancelable: true, view: window };
        try { el.dispatchEvent(new MouseEvent('pointerover', opts)); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mouseover', opts)); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
        try { el.click(); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (e) {}
    }

    // -- Checkbox: tick agreement checkbox (both Keycloak native + CodeBuddy custom UI) --
    const cbSelectors = [
        'input[type="checkbox"]#login-agree',
        'input[type="checkbox"][name*="agree" i]',
        'input[type="checkbox"][id*="agree" i]',
        'input[type="checkbox"]',
        'div.checkmark',
        'span.checkmark',
        '[class*="checkbox" i]:not(input)',
    ];
    for (const sel of cbSelectors) {
        for (const el of document.querySelectorAll(sel)) {
            if (!isVisible(el)) continue;
            // Skip if already checked
            if (el.tagName === 'INPUT' && el.checked) { out.checkbox = 'already-checked'; break; }
            // Try to check
            try {
                if (el.tagName === 'INPUT') {
                    el.checked = true;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } catch (e) {}
            clickLike(el);
            out.checkbox = sel;
            break;
        }
        if (out.checkbox) break;
    }

    // -- Detect Google button presence (visible OR container present) --
    const googleSelectors = [
        'a#social-google',
        '#social-google',
        'a[href*="/broker/google/"]',
        'a[href*="google"][id^="social"]',
        'button[data-provider="google" i]',
        '[data-social="google" i]',
    ];
    for (const sel of googleSelectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        out.hasSocialContainer = true;
        if (!isVisible(el)) continue;
        clickLike(el);
        out.google = sel;
        break;
    }

    // -- Fallback: search by visible text (Google/腾讯) --
    if (!out.google) {
        const googlePhrases = ['google', '谷歌'];
        for (const btn of document.querySelectorAll('a, button, div[role="button"], [role="button"]')) {
            if (!isVisible(btn)) continue;
            const txt = (btn.textContent || '').toLowerCase().trim();
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            const title = (btn.getAttribute('title') || '').toLowerCase();
            if (googlePhrases.some(p => txt.includes(p) || aria.includes(p) || title.includes(p))) {
                // Heuristic: prefer buttons whose text is short (icon button)
                if (txt.length < 40) {
                    clickLike(btn);
                    out.google = 'text-fallback';
                    break;
                }
            }
        }
    }

    return out;
}"""


_LANDING_TICK_HREF_JS = r"""() => {
    // Variant of _LANDING_TICK_JS that ticks the checkbox but returns the
    // Google button's href instead of clicking it. Caller does a TOP-LEVEL
    // page.goto(href) to avoid the iframe-only navigation problem.
    const out = { checkbox: null, googleHref: null, googleSel: null, url: location.href };

    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const cs = window.getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.05) return false;
        return true;
    }
    function clickLike(el) {
        try { el.scrollIntoView({block: 'center'}); } catch (e) {}
        const opts = { bubbles: true, cancelable: true, view: window };
        try { el.dispatchEvent(new MouseEvent('pointerover', opts)); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mouseover', opts)); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
        try { el.click(); } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (e) {}
    }

    // -- Tick agreement checkbox --
    const cbSelectors = [
        'input[type="checkbox"]#login-agree',
        'input[type="checkbox"][name*="agree" i]',
        'input[type="checkbox"][id*="agree" i]',
        'input[type="checkbox"]',
        'div.checkmark',
        'span.checkmark',
        '[class*="checkbox" i]:not(input)',
    ];
    for (const sel of cbSelectors) {
        for (const el of document.querySelectorAll(sel)) {
            if (!isVisible(el)) continue;
            if (el.tagName === 'INPUT' && el.checked) { out.checkbox = 'already-checked'; break; }
            try {
                if (el.tagName === 'INPUT') {
                    el.checked = true;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } catch (e) {}
            clickLike(el);
            out.checkbox = sel;
            break;
        }
        if (out.checkbox) break;
    }

    // -- Extract Google button href (do NOT click) --
    const googleSelectors = [
        'a#social-google',
        '#social-google',
        'a[href*="/broker/google/"]',
        'a[href*="google"][id^="social"]',
    ];
    for (const sel of googleSelectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        if (!isVisible(el)) continue;
        const href = el.getAttribute('href');
        if (href) {
            out.googleHref = href;
            out.googleSel = sel;
            break;
        }
    }
    return out;
}"""


# ─── ACCOUNT ACCESS RESTRICTED DETECTION ─────────────────────────────────────
# Adopted from budy-pc/src/core/failure.py + browser.py.
#
# CodeBuddy/Keycloak show "Account Access Restricted" in TWO very different
# situations, and we MUST distinguish them:
#
#   1. REAL refusal — CodeBuddy actually blocks the account/exit IP. This is
#      permanent for THIS identity and should short-circuit with a non-retryable
#      error so the caller marks the account as blocked.
#
#   2. Keycloak generic error page — cookie dropped mid-flow, OAuth state
#      expired, invalid callback, session lost. The Keycloak template ALWAYS
#      renders "Account Access Restricted" here regardless of the real cause.
#      Treating this as a block would misclassify every dropped callback as a
#      permanent ban. This must be retried (fresh state).
#
# Detection order:
#   - Explicit session-lost markers → RETRYABLE (fresh callback fixes it)
#   - "login attempt timed out" → RETRYABLE (state expired, retry gets fresh)
#   - Strong block markers on ANY page → NON-RETRYABLE ban
#   - Weak block markers only on codebuddy.ai host AND not first-broker-login
#     → NON-RETRYABLE ban

_CODEBUDDY_BLOCK_STRONG_MARKERS = (
    "temporarily unavailable due to security policy",
    "security policy restrictions",
    "account access restricted",
    "request illegal",
)

_CODEBUDDY_BLOCK_WEAK_MARKERS = (
    "access restricted",
    "service is not available in your region",
    "not available in your country",
)

# When any of these appear alongside "account access restricted", the page is a
# generic Keycloak error, NOT a real ban. Retry with a fresh state.
_KEYCLOAK_SESSION_LOST_MARKERS = (
    "cookie not found",
    "please make sure cookies are enabled",
    "you took too long to login",
    "you are already logged in",
    "unknown login requester",
    "expired code",
    "invalid parameter",
    "login attempt timed out",
)


def _codebuddy_looks_blocked(text: str, *, strong_only: bool) -> bool:
    """Return True if page text signals a real security-policy refusal.

    ``strong_only=True`` is required on pages that legitimately contain
    restriction-like copy (Google interstitials, keycloak first-broker-login).
    """
    if not text:
        return False
    lowered = text.casefold()
    # Session-lost error pages are NEVER real refusals, even though Keycloak
    # pins "Account Access Restricted" into the info slot.
    if any(m in lowered for m in _KEYCLOAK_SESSION_LOST_MARKERS):
        return False
    if any(m in lowered for m in _CODEBUDDY_BLOCK_STRONG_MARKERS):
        return True
    if strong_only:
        return False
    return any(m in lowered for m in _CODEBUDDY_BLOCK_WEAK_MARKERS)


async def _check_codebuddy_access_restricted(page: Any) -> tuple[bool, str, str]:
    """Sniff the current page for "Account Access Restricted" & related copy.

    Returns ``(is_blocked, kind, snippet)``:
      * ``is_blocked=True, kind='blocked'`` — real refusal (non-retryable)
      * ``is_blocked=False, kind='session-lost'`` — Keycloak session-lost page
        (retryable, caller should restart auth with fresh state)
      * ``is_blocked=False, kind='timed-out'`` — "login attempt timed out"
        (retryable, state expired)
      * ``is_blocked=False, kind=''`` — nothing detected
      * ``snippet`` — first ~200 chars of matched text for debug/logging
    """
    try:
        url = page.url or ""
    except Exception:
        url = ""
    try:
        text = await page.text_content("body")
    except Exception:
        text = ""
    text = str(text or "")
    if not text:
        return (False, "", "")

    lowered = text.casefold()
    host = urlparse(url).netloc.casefold() if url else ""
    on_codebuddy = host.endswith("codebuddy.ai") or "codebuddy.ai" in host
    on_first_broker = "first-broker-login" in url.casefold()

    # Timed-out: retryable
    if "login attempt timed out" in lowered:
        return (False, "timed-out", "login attempt timed out")

    # Session-lost: retryable
    for m in _KEYCLOAK_SESSION_LOST_MARKERS:
        if m in lowered:
            return (False, "session-lost", m)

    # Real block detection
    # Strong markers on any page + weak markers only on codebuddy.ai host
    # and not first-broker-login (which legitimately contains restriction copy).
    strong_only = on_first_broker or not on_codebuddy
    if _codebuddy_looks_blocked(text, strong_only=strong_only):
        # Extract a short snippet around the marker for logging
        snippet = ""
        for m in (*_CODEBUDDY_BLOCK_STRONG_MARKERS, *_CODEBUDDY_BLOCK_WEAK_MARKERS):
            idx = lowered.find(m)
            if idx >= 0:
                start = max(0, idx - 40)
                end = min(len(text), idx + len(m) + 120)
                snippet = text[start:end].strip().replace("\n", " ")[:200]
                break
        return (True, "blocked", snippet or "account access restricted")

    return (False, "", "")


# ---------------------------------------------------------------------------
# Google "Something went wrong" detection
# ---------------------------------------------------------------------------
# Google shows this transient error on fresh accounts logging in for the first
# time from an untrusted device / new IP. It looks like:
#     "Sorry, something went wrong there. Try again."
# It is NOT a real refusal - the account is fine. The remedy is either a
# retry with back-nav, or (better) warming up the account by logging in to
# accounts.google.com directly first so Google marks the device as trusted.

_GOOGLE_SOMETHING_WRONG_MARKERS = (
    "sorry, something went wrong there",
    "something went wrong there. try again",
)


async def _check_google_something_went_wrong(page: Any) -> tuple[bool, str]:
    """Detect Google's transient "Something went wrong" error page.

    Only reports True when we are on a Google host (accounts.google.com or
    similar) - otherwise the "try again" copy might come from Keycloak or
    CodeBuddy itself.

    Returns ``(is_error, snippet)``.
    """
    try:
        url = page.url or ""
    except Exception:
        url = ""
    host = urlparse(url).netloc.casefold() if url else ""
    if "google" not in host:
        return (False, "")

    try:
        text = await page.text_content("body")
    except Exception:
        text = ""
    text = str(text or "")
    if not text:
        return (False, "")

    lowered = text.casefold()
    for m in _GOOGLE_SOMETHING_WRONG_MARKERS:
        idx = lowered.find(m)
        if idx >= 0:
            start = max(0, idx - 40)
            end = min(len(text), idx + len(m) + 120)
            snippet = text[start:end].strip().replace("\n", " ")[:200]
            return (True, snippet or m)
    return (False, "")


# ---------------------------------------------------------------------------
# Google account warm-up
# ---------------------------------------------------------------------------
# Fresh accounts fail their first OAuth login from a new device with the
# "Something went wrong" screen. If we log in to accounts.google.com directly
# FIRST, Google trusts the device/IP, then the follow-up OAuth broker flow
# proceeds normally. This mirrors what a human user would naturally do.


async def _warmup_google_session(
    page: Any,
    email: str,
    password: str,
    *,
    debug: bool = False,
) -> bool:
    """Log in to accounts.google.com directly to establish a trusted session.

    Returns True if warm-up succeeded (or was skipped as unnecessary), False if
    warm-up hit a hard error (caller should still attempt the OAuth flow).

    This function is intentionally forgiving - a failed warm-up should not
    abort the main OAuth attempt.
    """
    def _log(msg: str) -> None:
        if debug:
            try:
                print(f"[codebuddy][warmup] {msg}", flush=True)
            except Exception:
                pass

    try:
        _log("navigating to accounts.google.com/signin")
        try:
            await page.goto(
                "https://accounts.google.com/signin",
                wait_until="domcontentloaded",
                timeout=45000,
            )
        except Exception as exc:
            _log(f"initial goto failed: {exc}")
            return False

        # Small settle so any redirect (to /v3/signin/identifier) finishes.
        await asyncio.sleep(random.uniform(1.5, 2.5))

        # If we are already signed in, Google redirects to myaccount.google.com
        # (or accounts.google.com/ManageAccount). Bail out early - warm-up done.
        try:
            cur = page.url or ""
        except Exception:
            cur = ""
        low = cur.casefold()
        if "myaccount.google.com" in low or "manageaccount" in low:
            _log(f"already signed in ({cur}) - warm-up done")
            return True

        # Fill email step
        try:
            await _fill_google_email_step(page, email)
        except Exception as exc:
            _log(f"email step failed: {exc}")
            return False

        # Wait for password field to appear (Google transition can be slow)
        try:
            await _wait_for_google_password_transition(page)
        except Exception as exc:
            _log(f"transition to password step failed: {exc}")
            return False

        # Human-ish pause before password
        await asyncio.sleep(random.uniform(2.5, 4.0))

        try:
            await _fill_google_password_step(page, password)
        except Exception as exc:
            _log(f"password step failed: {exc}")
            return False

        # After password: Google either lands on myaccount, or asks for
        # phone confirmation / recovery / "protect your account" prompts.
        # We wait up to ~25s for something recognizable.
        deadline = time.time() + 25.0
        while time.time() < deadline:
            try:
                cur = page.url or ""
            except Exception:
                cur = ""
            low = cur.casefold()
            if "myaccount.google.com" in low or "manageaccount" in low:
                _log(f"warm-up landed on {cur}")
                return True
            # "Something went wrong" during warm-up = fresh-account block.
            # Nothing we can do here - report failure so caller can decide.
            is_err, snippet = await _check_google_something_went_wrong(page)
            if is_err:
                _log(f"'Something went wrong' during warm-up: {snippet}")
                return False
            # Skip common post-login prompts by clicking "Not now" / "Skip"
            try:
                for label in (
                    "Not now",
                    "Skip",
                    "Cancel",
                    "Nanti saja",
                    "Lewati",
                ):
                    btn = page.get_by_role("button", name=label)
                    try:
                        if await btn.count() > 0 and await btn.first.is_visible():
                            _log(f"clicking post-login prompt: {label}")
                            await btn.first.click(timeout=3000)
                            await asyncio.sleep(1.0)
                            break
                    except Exception:
                        continue
            except Exception:
                pass
            await asyncio.sleep(1.2)

        # Timed out waiting for a recognizable post-login state, but no
        # explicit error - assume we are signed in enough to proceed.
        _log("warm-up deadline reached without myaccount redirect - proceeding anyway")
        return True
    except Exception as exc:
        _log(f"unexpected warmup exception: {exc}")
        return False


async def _handle_codebuddy_landing(page: Any) -> bool:
    """Tick agreement checkbox and TRIGGER top-level nav to Google broker URL.

    CodeBuddy embeds the Keycloak login form in an <iframe title="login-iframe">.
    Clicking the Google button INSIDE the iframe often only navigates the iframe
    (leaves the top page stuck), so instead we:
      1. Search top document + every frame for the checkbox and Google anchor
      2. Tick the checkbox in the frame that contains it
      3. Read the Google anchor's `href` (usually `/auth/realms/.../broker/google/login?...`)
      4. Resolve to absolute URL + do TOP-LEVEL `page.goto(href)` so the parent
         page navigates to Google's OAuth screen.

    Returns True if we successfully triggered nav (or clicked when href missing).
    """

    # Enumerate frames: main + login-iframe + any subframe on codebuddy.ai
    targets: list[tuple[str, Any]] = [("page", page)]
    try:
        iframe_frame = await _get_codebuddy_login_iframe(page)
        if iframe_frame is not None:
            targets.append(("login-iframe", iframe_frame))
    except Exception as exc:
        _codebuddy_auth_debug(f"landing: get login-iframe failed: {exc}")
    try:
        for fr in list(getattr(page, "frames", []) or []):
            if fr is page.main_frame:
                continue
            if any(fr is t[1] for t in targets):
                continue
            try:
                url = fr.url or ""
            except Exception:
                url = ""
            if "codebuddy.ai" in url or "/auth/realms/" in url:
                targets.append((f"frame:{url[:60]}", fr))
    except Exception:
        pass

    checkbox_hit: str | None = None
    google_href: str | None = None
    google_sel: str | None = None
    frame_url: str = ""
    for label, target in targets:
        try:
            res = await target.evaluate(_LANDING_TICK_HREF_JS)
        except Exception as exc:
            _codebuddy_auth_debug(f"landing[{label}] evaluate failed: {exc}")
            continue
        if not isinstance(res, dict):
            continue
        cb = res.get("checkbox")
        gh = res.get("googleHref")
        gs = res.get("googleSel")
        furl = str(res.get("url") or "")
        _codebuddy_auth_debug(
            f"landing[{label}] url={furl[:80]} checkbox={cb!r} googleSel={gs!r} "
            f"hasHref={bool(gh)}"
        )
        if cb and not checkbox_hit:
            checkbox_hit = cb
        if gh and not google_href:
            google_href = str(gh)
            google_sel = str(gs or "")
            frame_url = furl

    if not google_href:
        # Fallback: neither frame surfaced an anchor href. Fall back to legacy
        # click-based flow (dispatchEvent inside the frame). Better than
        # returning False and killing the run entirely.
        for label, target in targets:
            try:
                res = await target.evaluate(_LANDING_TICK_JS)
            except Exception:
                continue
            if isinstance(res, dict) and res.get("google"):
                _codebuddy_auth_debug(f"landing[{label}] fallback-click google={res.get('google')!r}")
                return True
        return False

    # Resolve relative href against the frame it lives on so /broker/google/login
    # from Keycloak realm URL becomes the full https://... URL.
    abs_url = google_href
    if not abs_url.startswith("http"):
        try:
            from urllib.parse import urljoin
            base = frame_url or (page.url if hasattr(page, "url") else "")
            abs_url = urljoin(base or CODEBUDDY_BASE_URL, google_href)
        except Exception:
            abs_url = CODEBUDDY_BASE_URL.rstrip("/") + "/" + google_href.lstrip("/")

    _codebuddy_auth_debug(
        f"landing: top-level goto Google broker sel={google_sel!r} url={abs_url[:120]}"
    )
    try:
        # wait_until='commit' returns as soon as the navigation is committed —
        # Google's SPA doesn't need to fully load for the OAuth handshake to
        # begin. This mirrors budy-pc's proven pattern.
        await page.goto(abs_url, wait_until="commit", timeout=60_000)
    except Exception as exc:
        # If the redirect already reached Google before timeout, it's harmless.
        try:
            cur = page.url or ""
        except Exception:
            cur = ""
        if "google.com" in cur or "accounts.google" in cur:
            _codebuddy_auth_debug(f"landing: goto raised but already on Google ({cur[:60]}) — OK")
        else:
            _codebuddy_auth_debug(f"landing: goto failed ({exc!r}), url={cur[:60]}")
            # Last resort — click via legacy JS click
            for label, target in targets:
                try:
                    res = await target.evaluate(_LANDING_TICK_JS)
                except Exception:
                    continue
                if isinstance(res, dict) and res.get("google"):
                    return True
            return False
    # Small settle after navigation commit
    try:
        await asyncio.sleep(1.2)
    except Exception:
        pass
    return True


async def _handle_codebuddy_agreement_modal(page: Any) -> bool:
    """Detect & confirm CodeBuddy 'Service Agreement / User Agreement' popup.

    After Google OAuth completes, CodeBuddy sometimes shows a modal:
        "Service Agreement" / "User Agreement" / "服务协议"
        [ ] I have read and agree to the Service Agreement and Privacy Policy
        [Cancel]  [Confirm]

    This handler ONLY acts on elements inside a real modal container (role=dialog
    or common modal classes) so it can't accidentally click generic buttons on
    the page. Uses REAL page.mouse for the confirm click (Camoufox blocks
    synthetic .click() in some contexts). Returns True if it clicked Confirm.
    """
    dump_enabled = os.getenv("BATCHER_CODEBUDDY_MODAL_DUMP", "").strip() in {"1", "true", "yes"}

    async def _dump(label: str) -> None:
        if not dump_enabled:
            return
        try:
            ts = int(time.time() * 1000)
            base = f"/tmp/codebuddy-modal-{ts}-{label}"
            try:
                await page.screenshot(path=f"{base}.png", full_page=True)
            except Exception as exc:
                _codebuddy_auth_debug(f"modal dump screenshot failed: {exc}")
            try:
                html = await page.evaluate(
                    r"""() => {
                        const sels = ['.ant-modal-wrap:not(.ant-modal-hidden)', '.ant-modal:not(.ant-modal-hidden)',
                                      '[role="dialog"]', '[aria-modal="true"]', '.el-dialog', '.arco-modal',
                                      '.arco-dialog', '.n-modal', '.van-dialog', '.modal.show', '.MuiDialog-root',
                                      '[class*="Modal_" i]', '[class*="Dialog_" i]'];
                        const parts = [];
                        for (const s of sels) {
                            for (const el of document.querySelectorAll(s)) {
                                const rect = el.getBoundingClientRect();
                                if (rect.width <= 0 || rect.height <= 0) continue;
                                parts.push(`<!-- selector=${s} -->\n` + el.outerHTML);
                            }
                        }
                        if (parts.length === 0) return '<!-- no modal found on page -->\n' + document.title + '\n' + location.href;
                        return parts.join('\n\n');
                    }"""
                )
                with open(f"{base}.html", "w", encoding="utf-8") as fh:
                    fh.write(html or "")
                _codebuddy_auth_debug(f"modal dump saved: {base}.png + {base}.html")
            except Exception as exc:
                _codebuddy_auth_debug(f"modal dump html failed: {exc}")
        except Exception:
            pass

    # JS: detect the agreement modal and click its Confirm button directly
    # via DOM .click() + dispatched mouse events. We DO NOT tick any checkbox
    # here — the user has already ticked the agreement on the landing page
    # before pressing the Google button, so the Confirm button should be
    # enabled by default.
    click_js = r"""() => {
        const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const cs = window.getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.display === 'none') return false;
            if (parseFloat(cs.opacity || '1') === 0) return false;
            return true;
        };
        const clickLike = (el) => {
            try { el.scrollIntoView({block: 'center'}); } catch (_) {}
            const opts = { bubbles: true, cancelable: true, view: window };
            try { el.dispatchEvent(new MouseEvent('pointerover', opts)); } catch (_) {}
            try { el.dispatchEvent(new MouseEvent('mouseover', opts)); } catch (_) {}
            try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_) {}
            try { el.dispatchEvent(new MouseEvent('mouseup',   opts)); } catch (_) {}
            try { el.click(); } catch (_) {}
            try { el.dispatchEvent(new MouseEvent('click', opts)); } catch (_) {}
        };

        const confirmRx = /^(\s*)(confirm|agree|accept|ok|okay|continue|proceed|yes|setuju|konfirmasi|lanjut(kan)?|同意|确认|确定)(\s*)$/i;
        const cancelRx  = /(cancel|close|batal|tutup|取消|关闭|dismiss|later|nanti)/i;

        // -- PATH A: direct hunt — CodeBuddy popup uses <button class="ui-button" data-type="success">Confirm</button> --
        const directSelectors = [
            'button.ui-button[data-type="success"]',
            'button.ui-button[data-type="primary"]',
            'button.ui-button',
            '.ui-button[data-type="success"]',
            '.ui-button[data-type="primary"]',
        ];
        for (const sel of directSelectors) {
            for (const btn of document.querySelectorAll(sel)) {
                if (!isVisible(btn)) continue;
                if (btn.disabled) continue;
                const txt = (btn.textContent || btn.value || '').trim();
                if (!txt) continue;
                if (cancelRx.test(txt)) continue;
                if (confirmRx.test(txt)) {
                    clickLike(btn);
                    return { ok: true, text: txt.slice(0, 60), why: 'direct:' + sel };
                }
            }
        }

        // -- PATH B: text-only hunt over ALL buttons/role=button in document --
        const allBtns = [
            ...document.querySelectorAll('button'),
            ...document.querySelectorAll('[role="button"]'),
            ...document.querySelectorAll('a.ui-button'),
        ];
        for (const btn of allBtns) {
            if (!isVisible(btn)) continue;
            if (btn.disabled) continue;
            const txt = (btn.textContent || btn.value || '').trim();
            if (!txt) continue;
            if (cancelRx.test(txt)) continue;
            if (confirmRx.test(txt)) {
                clickLike(btn);
                return { ok: true, text: txt.slice(0, 60), why: 'text-hunt' };
            }
        }

        // -- PATH C: fallback via modal container (legacy Ant/Element/etc.) --
        const modalSelectors = [
            '.ant-modal:not(.ant-modal-hidden)',
            '.ant-modal-wrap',
            '[role="dialog"]',
            '[aria-modal="true"]',
            '.el-dialog',
            '.arco-modal',
            '.arco-dialog',
            '.n-modal',
            '.van-dialog',
            '.modal.show',
            '.MuiDialog-root',
            '[class*="Modal_" i]',
            '[class*="Dialog_" i]',
        ];
        const modals = [];
        for (const sel of modalSelectors) {
            for (const m of document.querySelectorAll(sel)) {
                if (isVisible(m)) modals.push(m);
            }
        }
        for (const modal of modals) {
            const cands = [
                ...modal.querySelectorAll('button.ant-btn-primary'),
                ...modal.querySelectorAll('button[type="submit"]'),
                ...modal.querySelectorAll('.ant-modal-footer button'),
                ...modal.querySelectorAll('button'),
                ...modal.querySelectorAll('[role="button"]'),
            ];
            for (const btn of cands) {
                if (!isVisible(btn)) continue;
                if (btn.disabled) continue;
                const txt = (btn.textContent || btn.value || '').trim();
                if (!txt) continue;
                if (cancelRx.test(txt)) continue;
                if (confirmRx.test(txt)) {
                    clickLike(btn);
                    return { ok: true, text: txt.slice(0, 60), why: 'modal-fallback' };
                }
            }
        }

        return { ok: false, reason: 'no-confirm-button', modals: modals.length };
    }"""

    # Enumerate targets: top page + all frames on codebuddy.ai
    click_targets: list[tuple[str, Any]] = [("page", page)]
    try:
        for fr in list(getattr(page, "frames", []) or []):
            if fr is page.main_frame:
                continue
            try:
                url = fr.url or ""
            except Exception:
                url = ""
            if "codebuddy.ai" in url or "/auth/realms/" in url:
                click_targets.append((f"frame:{url[:60]}", fr))
    except Exception:
        pass

    try:
        for label, tgt in click_targets:
            try:
                res = await tgt.evaluate(click_js)
            except Exception:
                continue
            if isinstance(res, dict) and res.get("ok"):
                _codebuddy_auth_debug(
                    f"agreement modal confirmed [{label}] text={res.get('text')!r} "
                    f"why={res.get('why')}"
                )
                await _dump("confirmed")
                return True
            if isinstance(res, dict) and res.get("reason") not in (None, "no-modal"):
                _codebuddy_auth_debug(f"agreement modal [{label}] {res}")

        if dump_enabled:
            # Periodic dump when nothing detected — but only if a modal-like
            # container is actually present on the page (avoid spamming).
            try:
                has_modal = await page.evaluate(
                    r"""() => {
                        const sels = ['.ant-modal-wrap:not(.ant-modal-hidden)', '[role="dialog"]', '[aria-modal="true"]',
                                      '.el-dialog', '.arco-modal', '.n-modal', '.van-dialog', '.modal.show',
                                      '.MuiDialog-root', '[class*="Modal_" i]', '[class*="Dialog_" i]'];
                        for (const s of sels) {
                            for (const el of document.querySelectorAll(s)) {
                                const rect = el.getBoundingClientRect();
                                if (rect.width > 0 && rect.height > 0) return true;
                            }
                        }
                        return false;
                    }"""
                )
                if has_modal:
                    await _dump("visible-no-match")
            except Exception:
                pass
        return False
    except Exception as exc:
        _codebuddy_auth_debug(f"agreement modal handler error: {exc}")
        return False


async def _handle_codebuddy_email_verification(page: Any) -> bool:
    _codebuddy_auth_debug("starting email verification via Gmail (same tab)")

    verify_page_url = page.url
    _codebuddy_auth_debug(f"saved verification page URL: {verify_page_url[:100]}")

    try:
        _codebuddy_auth_debug("navigating to Gmail inbox in same tab")
        await page.goto("https://mail.google.com/mail/u/0/#inbox", wait_until="domcontentloaded", timeout=45000)
        await asyncio.sleep(5)

        gmail_url = page.url
        _codebuddy_auth_debug(f"Gmail page URL: {gmail_url[:100]}")

        if "accounts.google.com" in gmail_url:
            _codebuddy_auth_debug("Gmail redirected to Google login — session not shared, going back")
            await page.goto(verify_page_url, wait_until="domcontentloaded", timeout=15000)
            return False

        email_found = False
        for attempt in range(15):
            _codebuddy_auth_debug(f"searching for verification email (attempt {attempt+1}/15)")

            email_selectors = [
                'tr:has-text("codebuddy")',
                'tr:has-text("Verify email")',
                'tr:has-text("verify your email")',
                'span:has-text("codebuddy")',
                '[data-message-id]:has-text("codebuddy")',
                'div[role="main"] tr:has-text("copilot")',
            ]

            for sel in email_selectors:
                try:
                    el = page.locator(sel).first
                    if await el.count() > 0 and await el.is_visible():
                        _codebuddy_auth_debug(f"found email via: {sel}")
                        await el.click()
                        await asyncio.sleep(3)
                        email_found = True
                        break
                except Exception:
                    continue

            if email_found:
                break

            if attempt >= 5 and attempt % 2 == 0:
                _codebuddy_auth_debug("refreshing Gmail inbox")
                try:
                    await page.reload(wait_until="domcontentloaded", timeout=15000)
                except Exception:
                    pass
            await asyncio.sleep(4)

        if not email_found:
            _codebuddy_auth_debug("verification email not found after 15 attempts, going back")
            await page.goto(verify_page_url, wait_until="domcontentloaded", timeout=15000)
            return False

        _codebuddy_auth_debug("email thread opened, expanding latest message and extracting link")
        await asyncio.sleep(2)

        try:
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await asyncio.sleep(1)
        except Exception:
            pass

        try:
            collapsed = page.locator('div.kv, [data-message-id], div.gs')
            count = await collapsed.count()
            if count > 1:
                _codebuddy_auth_debug(f"thread has {count} messages, clicking last one to expand")
                await collapsed.nth(count - 1).click()
                await asyncio.sleep(2)
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(1)
        except Exception as e:
            _codebuddy_auth_debug(f"expand latest message failed: {e}")

        verify_link = None

        try:
            import re
            body_html = await page.content()
            patterns = [
                r'href="(https?://[^"]*callback\.cloudses\.com/api/webhook\?upn=[^"]*)"',
                r'href="(https?://[^"]*login-actions/required-action\?session_code=[^"]*)"',
                r'href="(https?://[^"]*session_code=[^"]*)"',
                r'href="(https?://[^"]*login-actions/required-action[^"]*)"',
                r'href="(https?://www\.codebuddy\.ai/auth/[^"]*verification[^"]*)"',
            ]
            all_links = []
            for pat in patterns:
                urls = re.findall(pat, body_html)
                for u in urls:
                    cleaned = u.replace("&amp;", "&")
                    if cleaned not in all_links:
                        all_links.append(cleaned)

            if all_links:
                verify_link = all_links[-1]
                _codebuddy_auth_debug(f"found {len(all_links)} verification links, using latest")
        except Exception as e:
            _codebuddy_auth_debug(f"regex search failed: {e}")

        if not verify_link:
            link_selectors = [
                'a:has-text("Link to e-mail address verification")',
                'a:has-text("verification")',
                'a:has-text("verify")',
                'a[href*="login-actions"]',
                'a[href*="session_code"]',
            ]
            for sel in link_selectors:
                try:
                    links = page.locator(sel)
                    count = await links.count()
                    if count > 0:
                        href = await links.nth(count - 1).get_attribute("href")
                        if href and ("login-actions" in href or "session_code" in href or "webhook" in href):
                            verify_link = href.replace("&amp;", "&")
                            _codebuddy_auth_debug(f"found link via selector (last of {count}): {sel}")
                            break
                except Exception:
                    continue

        if not verify_link:
            _codebuddy_auth_debug("could not find verification link, going back")
            await page.goto(verify_page_url, wait_until="domcontentloaded", timeout=15000)
            return False

        _codebuddy_auth_debug(f"navigating to verification link: {verify_link[:80]}...")
        await page.goto(verify_link, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)

        final_url = page.url
        _codebuddy_auth_debug(f"verification landed at: {final_url[:100]}")

        for _ in range(5):
            try:
                page_text = await page.text_content("body")
            except Exception:
                page_text = ""

            if page_text and "click here to proceed" in page_text.lower():
                _codebuddy_auth_debug("found 'Click here to proceed' confirmation page, clicking")
                proceed_selectors = [
                    'a:has-text("Click here to proceed")',
                    'a:has-text("click here")',
                    'a:has-text("proceed")',
                    'a[href*="login-actions"]',
                ]
                clicked = False
                for sel in proceed_selectors:
                    try:
                        btn = page.locator(sel).first
                        if await btn.count() > 0 and await btn.is_visible():
                            await btn.click()
                            _codebuddy_auth_debug(f"clicked proceed via: {sel}")
                            clicked = True
                            await asyncio.sleep(3)
                            break
                    except Exception:
                        continue
                if not clicked:
                    try:
                        all_links = page.locator("a")
                        for i in range(await all_links.count()):
                            link_text = await all_links.nth(i).text_content()
                            if link_text and "proceed" in link_text.lower():
                                await all_links.nth(i).click()
                                _codebuddy_auth_debug("clicked proceed link by text scan")
                                clicked = True
                                await asyncio.sleep(3)
                                break
                    except Exception:
                        pass
                if clicked:
                    continue
            break

        final_url2 = page.url
        _codebuddy_auth_debug(f"after proceed: {final_url2[:100]}")
        _codebuddy_auth_debug("email verification complete, auth flow should continue")
        return True

    except Exception as e:
        _codebuddy_auth_debug(f"email verification failed: {e}")
        try:
            await page.goto(verify_page_url, wait_until="domcontentloaded", timeout=15000)
        except Exception:
            pass
        return False


async def _handle_google_gaplustos(page: Any) -> bool:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "/speedbump/gaplustos" not in current_url:
        return False

    try:
        _codebuddy_auth_debug("gaplustos detected")
        try:
            await page.wait_for_selector(
                '#confirm, input[name="confirm"], input[type="submit"]',
                state="visible",
                timeout=5000,
            )
        except Exception:
            pass
        selectors = ["#confirm", 'input[name="confirm"]', 'input[type="submit"]']
        for selector in selectors:
            locator = page.locator(selector).first
            try:
                if await locator.count() == 0:
                    continue
                if not await locator.is_visible():
                    continue
                value = ""
                try:
                    value = str(await locator.input_value())
                except Exception:
                    value = ""
                _codebuddy_auth_debug(
                    f"gaplustos clicking selector={selector} value={value!r}"
                )
                await locator.click(force=True)
                return True
            except Exception as exc:
                _codebuddy_auth_debug(
                    f"gaplustos click failed selector={selector} err={exc}"
                )

        clicked = bool(
            await page.evaluate(
                """() => {
                    const candidates = [
                        document.querySelector('#confirm'),
                        document.querySelector('input[name="confirm"]'),
                        ...Array.from(document.querySelectorAll('input[type="submit"], button'))
                    ];
                    const keywords = [
                        'confirm', 'understand', 'accept', 'agree', 'continue', 'ok',
                        'mengerti', 'terima',
                        'понятно', 'принимаю', 'принять', 'продолжить',
                        'entendido', 'aceptar', 'continuar',
                        'compris', 'accepter',
                        '了解', '同意', '确认', '接受',
                        '理解', '同意する', '確認',
                        '동의', '확인',
                        'verstanden', 'akzeptieren', 'zustimmen',
                        'anladım', 'kabul',
                        'entendi', 'aceitar',
                        'capisco', 'accetta',
                        'rozumiem', 'akceptuję',
                        'begrijpen', 'accepteren',
                        'เข้าใจ', 'ยอมรับ',
                        'hiểu', 'chấp nhận',
                        'فهمت', 'قبول',
                        'समझ गया', 'स्वीकार',
                    ];
                    for (const el of candidates) {
                        if (!el || el.offsetParent === null) continue;
                        const txt = (el.value || el.textContent || '').toLowerCase().trim();
                        if (keywords.some(k => txt.includes(k))) {
                            el.click();
                            return true;
                        }
                    }
                    // Last resort: click any visible submit button on gaplustos page
                    const submits = document.querySelectorAll('input[type="submit"], button[type="submit"]');
                    for (const el of submits) {
                        if (el.offsetParent !== null) {
                            el.click();
                            return true;
                        }
                    }
                    return false;
                }"""
            )
        )
        _codebuddy_auth_debug(f"gaplustos fallback clicked={clicked}")
        return clicked
    except Exception as exc:
        _codebuddy_auth_debug(f"gaplustos handler error={exc}")
        return False


async def _handle_google_consent_continue(page: Any) -> bool:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    if "accounts.google.com" not in current_url:
        return False

    try:
        if "signin/oauth/consent" in current_url:
            _codebuddy_auth_debug("google consent detected")
        return bool(
            await page.evaluate(
                """() => {
                    for (const btn of document.querySelectorAll('button, div[role="button"]')) {
                        const txt = (btn.textContent || '').trim().toLowerCase();
                        if (!txt || btn.offsetParent === null) continue;
                        if (txt === 'continue' || txt.includes('allow') || txt.includes('lanjut')) {
                            btn.click();
                            return true;
                        }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _handle_codebuddy_region_select(page: Any) -> bool:
    try:
        current_url = page.url
    except Exception:
        current_url = ""
    parsed_url = urlparse(current_url) if current_url else None
    current_host = parsed_url.netloc if parsed_url else ""
    current_path = parsed_url.path if parsed_url else ""
    if current_host != urlparse(
        CODEBUDDY_BASE_URL
    ).netloc or not current_path.startswith("/register/user/complete"):
        return False

    try:
        try:
            await page.wait_for_selector(
                'div.t-input input[placeholder="Registration location"]',
                state="visible",
                timeout=2000,
            )
        except Exception:
            return False

        region_value = str(
            await page.evaluate(
                """() => {
                    const box = document.querySelector('div.t-input input[placeholder="Registration location"]');
                    if (!box || box.offsetParent === null) return '';
                    return box.value || '';
                }"""
            )
        ).strip()
        _codebuddy_auth_debug(f"region page value={region_value!r} url={current_url}")

        if region_value.lower() != "singapore":
            opened = bool(
                await page.evaluate(
                    """() => {
                        const box = document.querySelector('div.t-input input[placeholder="Registration location"]');
                        if (!box || box.offsetParent === null) return false;
                        box.click();
                        return true;
                    }"""
                )
            )
            if not opened:
                return False
            await asyncio.sleep(0.3)

            try:
                overlay_search = page.locator(
                    '.dropdown-overlay input[placeholder="Search countries"], .dropdown-search input[placeholder="Search countries"]'
                ).first
                if (
                    await overlay_search.count() > 0
                    and await overlay_search.is_visible()
                ):
                    await overlay_search.click(force=True)
                    await overlay_search.fill("Singapore")
                    await asyncio.sleep(0.25)
            except Exception:
                pass

            selected_visible = False
            option_locators = [
                page.locator(".dropdown-overlay")
                .get_by_text("Singapore", exact=True)
                .first,
                page.locator(".dropdown-overlay")
                .get_by_text("Current region Singapore", exact=False)
                .first,
                page.get_by_text("Current region Singapore", exact=False).first,
                page.get_by_text("Singapore", exact=True).first,
            ]
            for locator in option_locators:
                try:
                    if await locator.count() == 0:
                        continue
                    if not await locator.is_visible():
                        continue
                    await locator.click(force=True)
                    selected_visible = True
                    break
                except Exception:
                    continue

            if not selected_visible:
                selected_visible = bool(
                    await page.evaluate(
                        """() => {
                            const selectors = [
                                '.dropdown-overlay [role="option"]',
                                '.dropdown-overlay .dropdown-item',
                                '.dropdown-overlay li',
                                '.dropdown-overlay div',
                            ];
                            for (const sel of selectors) {
                                for (const el of document.querySelectorAll(sel)) {
                                    const txt = (el.textContent || '').toLowerCase().trim();
                                    if (!txt || el.offsetParent === null) continue;
                                    if (
                                        txt === 'singapore' ||
                                        txt.includes('singapore') ||
                                        txt.includes('current region singapore')
                                    ) {
                                        el.click();
                                        return true;
                                    }
                                }
                            }
                            return false;
                        }"""
                    )
                )
            await asyncio.sleep(0.3)

            try:
                await page.wait_for_function(
                    """() => {
                        const box = document.querySelector('div.t-input input[placeholder="Registration location"]');
                        const value = (box?.value || '').trim().toLowerCase();
                        const text = (document.body?.innerText || '').toLowerCase();
                        return value === 'singapore' || text.includes('current region singapore');
                    }""",
                    timeout=4000,
                )
            except Exception:
                pass

            region_value = str(
                await page.evaluate(
                    """() => {
                        const box = document.querySelector('div.t-input input[placeholder="Registration location"]');
                        const inputValue = box && box.offsetParent !== null ? (box.value || '') : '';
                        if (inputValue) return inputValue;
                        const text = (document.body?.innerText || '').toLowerCase();
                        if (text.includes('current region singapore')) return 'Singapore';
                        return '';
                    }"""
                )
            ).strip()
            _codebuddy_auth_debug(f"region selected value={region_value!r}")

        if region_value.lower() != "singapore":
            return False

        submitted = False
        submit_locators = [
            page.locator('button:has-text("Submit")').first,
            page.locator('[role="button"]:has-text("Submit")').first,
            page.locator('div[class*="cursor-pointer"]:has-text("Submit")').first,
            page.get_by_text("Submit", exact=True).first,
        ]
        for locator in submit_locators:
            try:
                if await locator.count() == 0:
                    continue
                if not await locator.is_visible():
                    continue
                await locator.click(force=True)
                submitted = True
                break
            except Exception:
                continue

        if not submitted:
            submitted = bool(
                await page.evaluate(
                    """() => {
                        for (const el of document.querySelectorAll('button, [role="button"], div[class*="cursor-pointer"]')) {
                            const txt = (el.textContent || '').trim().toLowerCase();
                            if (!txt || el.offsetParent === null) continue;
                            if (txt === 'submit' || txt.includes('submit')) {
                                el.click();
                                return true;
                            }
                        }
                        return false;
                    }"""
                )
            )
        _codebuddy_auth_debug(f"region submit clicked={submitted}")
        if submitted:
            redirect_uri = ""
            try:
                redirect_uri = parse_qs(urlparse(current_url).query).get(
                    "redirect_uri", [""]
                )[0]
            except Exception:
                redirect_uri = ""
            try:
                await page.wait_for_function(
                    """() => {
                        const path = window.location.pathname || '';
                        return path === '/started' || !path.startsWith('/register/user/complete');
                    }""",
                    timeout=4000,
                )
            except Exception:
                redirect_uri = str(redirect_uri or "").strip()
                if redirect_uri.startswith(CODEBUDDY_BASE_URL):
                    try:
                        _codebuddy_auth_debug(
                            f"region redirect fallback goto={redirect_uri}"
                        )
                        await page.goto(redirect_uri, wait_until="domcontentloaded")
                    except Exception as exc:
                        _codebuddy_auth_debug(
                            f"region redirect fallback failed err={exc}"
                        )
                try:
                    await page.wait_for_function(
                        """() => {
                            const path = window.location.pathname || '';
                            return path === '/started' || !path.startsWith('/register/user/complete');
                        }""",
                        timeout=10000,
                    )
                except Exception:
                    pass
        return submitted
    except Exception:
        return False


def _get_cookie_file_path(email: str) -> Path:
    """Get cookie file path for an email (hashed for privacy)"""
    email_hash = hashlib.sha256(email.encode()).hexdigest()[:16]
    return COOKIES_DIR / f"{email_hash}.json"


async def _save_cookies_to_file(page: Any, email: str) -> bool:
    """Save cookies from page to file"""
    try:
        context = page.context
        cookies = await context.cookies([CODEBUDDY_BASE_URL])
        if not cookies:
            return False

        cookie_file = _get_cookie_file_path(email)
        cookie_data = {
            "email": email,
            "saved_at": time.time(),
            "expires_at": time.time() + 3600,  # 1 hour
            "cookies": cookies,
        }

        with open(cookie_file, "w") as f:
            json.dump(cookie_data, f, indent=2)

        _codebuddy_auth_debug(f"cookies saved file={cookie_file.name}")
        return True
    except Exception as exc:
        _codebuddy_auth_debug(f"save cookies failed err={exc}")
        return False


async def _load_cookies_from_file(email: str) -> dict[str, Any] | None:
    """Load cookies from file if not expired"""
    try:
        cookie_file = _get_cookie_file_path(email)
        if not cookie_file.exists():
            return None

        with open(cookie_file, "r") as f:
            cookie_data = json.load(f)

        expires_at = cookie_data.get("expires_at", 0)
        if time.time() > expires_at:
            _codebuddy_auth_debug(f"cookies expired file={cookie_file.name}")
            cookie_file.unlink(missing_ok=True)
            return None

        _codebuddy_auth_debug(f"cookies loaded file={cookie_file.name}")
        return cookie_data
    except Exception as exc:
        _codebuddy_auth_debug(f"load cookies failed err={exc}")
        return None


async def _restore_cookies_to_page(page: Any, cookie_data: dict[str, Any]) -> bool:
    """Restore cookies to page context"""
    try:
        cookies = cookie_data.get("cookies", [])
        if not cookies:
            return False

        await page.context.add_cookies(cookies)
        _codebuddy_auth_debug("cookies restored to page")
        return True
    except Exception as exc:
        _codebuddy_auth_debug(f"restore cookies failed err={exc}")
        return False


def _build_cookie_header_from_dict(cookies: list[dict[str, Any]]) -> str:
    """Build cookie header string from cookie dict list"""
    parts: list[str] = []
    for cookie in cookies:
        name = str(cookie.get("name") or "").strip()
        value = str(cookie.get("value") or "").strip()
        if name and value:
            parts.append(f"{name}={value}")
    return "; ".join(parts)


async def _build_cookie_header_from_page(page: Any, base_url: str) -> str:
    try:
        context = page.context
        cookies = await context.cookies([base_url])
    except Exception:
        return ""

    if not cookies:
        return ""

    return _build_cookie_header_from_dict(cookies)


async def _create_api_key_via_page(
    page: Any,
    user_enterprise_id: str = "personal-edition-user-id",
    *,
    retries: int = 1,
    key_prefix: str = "key",
) -> str | None:
    """Create an API key via page.evaluate() → fetch from browser context.

    This leverages the browser's active session cookies (credentials: 'include')
    to authenticate the request — no explicit token/cookie header needed.

    Args:
        page: Playwright page with active CodeBuddy session.
        user_enterprise_id: Enterprise ID (default works for personal accounts).
        retries: Number of retry attempts on failure (default 1 = no retry).
        key_prefix: Prefix for the generated key name.
    """
    import time

    for attempt in range(1, retries + 1):
        timestamp = int(time.time())
        key_name = f"{key_prefix}-{timestamp}"

        if attempt > 1:
            backoff = min(2.0 * (attempt - 1), 5.0)
            _codebuddy_auth_debug(
                f"create api key retry {attempt}/{retries} backoff={backoff:.1f}s"
            )
            await asyncio.sleep(backoff)

        try:
            result = await page.evaluate(
                """async ({ url, body }) => {
                    try {
                        const resp = await fetch(url, {
                            method: 'POST',
                            credentials: 'include',
                            headers: {
                                'Accept': 'application/json, text/plain, */*',
                                'Content-Type': 'application/json',
                                'X-Requested-With': 'XMLHttpRequest',
                            },
                            body: JSON.stringify(body),
                        });
                        const text = await resp.text();
                        let json = null;
                        try { json = JSON.parse(text); } catch {}
                        return { status: resp.status, text, json };
                    } catch (err) {
                        return { status: 0, text: String(err), json: null };
                    }
                }""",
                {
                    "url": CODEBUDDY_API_KEYS_ENDPOINT,
                    "body": {
                        "name": key_name,
                        "expire_in_days": -1,
                        "user_enterprise_id": user_enterprise_id,
                    },
                },
            )
        except Exception as exc:
            _codebuddy_auth_debug(
                f"create api key via page error attempt={attempt} err={exc}"
            )
            if attempt < retries:
                continue
            return None

        status = int(result.get("status") or 0)
        payload = result.get("json")
        body_text = str(result.get("text") or "")

        if _codebuddy_auth_debug_enabled():
            code = payload.get("code") if isinstance(payload, dict) else None
            _codebuddy_auth_debug(
                f"create api key via page attempt={attempt} status={status} code={code}"
            )

        if status != 200 or not isinstance(payload, dict):
            if status and body_text:
                _codebuddy_auth_debug(
                    f"create api key via page body={body_text[:200]}"
                )
            if attempt < retries:
                continue
            return None

        if payload.get("code") != 0:
            msg = payload.get("msg") or payload.get("message") or ""
            _codebuddy_auth_debug(
                f"create api key non-zero code={payload.get('code')} msg={msg}"
            )
            if attempt < retries:
                continue
            return None

        data = payload.get("data") or {}
        api_key = str(data.get("key") or "").strip()

        if api_key:
            _codebuddy_auth_debug(
                f"api key created key={api_key[:15]}... name={key_name}"
            )
            return api_key

        if attempt < retries:
            continue
        return None

    return None


async def _create_api_key_fast(page: Any) -> str | None:
    """Create API key directly via page.evaluate() — no region, no enterprise ID fetch.

    Proven via live testing:
    - No region selection required
    - Hardcoded 'personal-edition-user-id' works for all personal accounts
    - Works even on restricted/error pages as long as session cookies are active

    Retries up to 3 times with exponential backoff.
    """
    _codebuddy_auth_debug("creating API key directly (skip region)")
    return await _create_api_key_via_page(
        page,
        user_enterprise_id="personal-edition-user-id",
        retries=3,
        key_prefix="key",
    )


async def _ensure_region_with_retry(
    page: Any, account_email: str, max_retries: int = 3
) -> bool:
    for attempt in range(1, max_retries + 1):
        _codebuddy_auth_debug(f"region selection attempt={attempt}/{max_retries}")

        region_ok = await _handle_codebuddy_region_select(page)
        if region_ok:
            _codebuddy_auth_debug(f"region selection success attempt={attempt}")
            return True

        if attempt < max_retries:
            cookie_data = await _load_cookies_from_file(account_email)
            if cookie_data:
                _codebuddy_auth_debug(
                    f"restoring cookies for retry attempt={attempt + 1}"
                )
                await _restore_cookies_to_page(page, cookie_data)
                await asyncio.sleep(1.0)

                try:
                    await page.goto(
                        f"{CODEBUDDY_BASE_URL}/register/user/complete",
                        wait_until="domcontentloaded",
                        timeout=10000,
                    )
                    await asyncio.sleep(1.0)
                except Exception as exc:
                    _codebuddy_auth_debug(f"region page navigation failed err={exc}")
            else:
                _codebuddy_auth_debug(
                    f"no cookies found for retry attempt={attempt + 1}"
                )
                break

    _codebuddy_auth_debug(f"region selection failed after {max_retries} attempts")
    return False


async def _fetch_user_resource_credit_via_page(page: Any) -> dict[str, float] | None:
    if page is None:
        return None

    now = datetime.utcnow()
    payload_body = {
        "PageNumber": 1,
        "PageSize": 100,
        "ProductCode": "p_tcaca",
        "Status": [0, 3],
        "PackageEndTimeRangeBegin": now.strftime("%Y-%m-%d %H:%M:%S"),
        "PackageEndTimeRangeEnd": (now + timedelta(days=365 * 20)).strftime(
            "%Y-%m-%d %H:%M:%S"
        ),
    }

    try:
        result = await page.evaluate(
            """async ({ url, body }) => {
                try {
                    const resp = await fetch(url, {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'Content-Type': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest',
                        },
                        body: JSON.stringify(body),
                    });
                    const text = await resp.text();
                    let json = null;
                    try { json = JSON.parse(text); } catch {}
                    return { status: resp.status, text, json };
                } catch (err) {
                    return { status: 0, text: String(err), json: null };
                }
            }""",
            {"url": CODEBUDDY_USER_RESOURCE_ENDPOINT, "body": payload_body},
        )
    except Exception as exc:
        _codebuddy_auth_debug(f"credit via page error={exc}")
        return None

    status = int(result.get("status") or 0)
    payload = result.get("json")
    if _codebuddy_auth_debug_enabled():
        code = payload.get("code") if isinstance(payload, dict) else None
        _codebuddy_auth_debug(f"credit via page status={status} code={code}")
    if status != 200 or not isinstance(payload, dict):
        return None
    return _credit_from_resource_payload(payload)


async def _fetch_console_accounts_via_page(page: Any) -> dict[str, Any] | None:
    try:
        result = await page.evaluate(
            """async (url) => {
                try {
                    const resp = await fetch(url, {
                        method: 'GET',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'X-Requested-With': 'XMLHttpRequest',
                        },
                    });
                    const text = await resp.text();
                    let json = null;
                    try { json = JSON.parse(text); } catch {}
                    return { status: resp.status, text, json };
                } catch (err) {
                    return { status: 0, text: String(err), json: null };
                }
            }""",
            CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT,
        )
    except Exception as exc:
        _codebuddy_auth_debug(f"console accounts via page error={exc}")
        return None

    status = int(result.get("status") or 0)
    payload = result.get("json")
    if _codebuddy_auth_debug_enabled():
        code = payload.get("code") if isinstance(payload, dict) else None
        _codebuddy_auth_debug(f"console accounts via page status={status} code={code}")
    if status != 200 or not isinstance(payload, dict):
        return None

    data = payload.get("data") or {}
    accounts = data.get("accounts") or []
    if payload.get("code") != 0 or not accounts:
        return None
    return payload


async def _codebuddy_request_via_page(
    page: Any,
    method: str,
    url: str,
    *,
    body: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any] | None, str]:
    try:
        result = await page.evaluate(
            """async ({ url, method, body }) => {
                try {
                    const headers = {
                        'Accept': 'application/json, text/plain, */*',
                        'X-Requested-With': 'XMLHttpRequest',
                    };
                    const init = {
                        method,
                        credentials: 'include',
                        headers,
                    };
                    if (body !== null) {
                        headers['Content-Type'] = 'application/json';
                        init.body = JSON.stringify(body);
                    }
                    const resp = await fetch(url, init);
                    const text = await resp.text();
                    let json = null;
                    try { json = JSON.parse(text); } catch {}
                    return { status: resp.status, text, json };
                } catch (err) {
                    return { status: 0, text: String(err), json: null };
                }
            }""",
            {"url": url, "method": method.upper(), "body": body},
        )
    except Exception as exc:
        _codebuddy_auth_debug(
            f"page request error method={method.upper()} url={url} err={exc}"
        )
        return 0, None, ""

    status = int(result.get("status") or 0)
    payload = result.get("json")
    body_text = str(result.get("text") or "")
    if not isinstance(payload, dict):
        payload = None
    return status, payload, body_text


async def _submit_region_via_page(page: Any) -> bool:
    status, payload, body = await _codebuddy_request_via_page(
        page,
        "POST",
        CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT,
        body={
            "attributes": {
                "countryCode": ["65"],
                "countryFullName": ["Singapore"],
                "countryName": ["SG"],
            }
        },
    )
    code = payload.get("code") if isinstance(payload, dict) else None
    _codebuddy_auth_debug(f"force region via page status={status} code={code}")
    if not (status == 200 and isinstance(payload, dict) and payload.get("code") == 0):
        if status and body:
            _codebuddy_auth_debug(f"force region via page body={body[:160]}")
        return False

    accounts_payload = await _fetch_console_accounts_via_page(page)
    user_id = ""
    if accounts_payload:
        accounts_data = accounts_payload.get("data") or {}
        accounts = accounts_data.get("accounts") or []
        if accounts:
            user_id = str(accounts[0].get("uid") or "")

    if user_id:
        register_url = f"{CODEBUDDY_BASE_URL}/auth/realms/copilot/overseas/user/register?userId={user_id}"
        reg_status, reg_payload, _ = await _codebuddy_request_via_page(page, "GET", register_url)
        _codebuddy_auth_debug(f"register user status={reg_status} payload={reg_payload}")

    trial_url = f"{CODEBUDDY_BASE_URL}/billing/ide/trial"
    trial_status, trial_payload, _ = await _codebuddy_request_via_page(page, "POST", trial_url)
    _codebuddy_auth_debug(f"activate trial status={trial_status} payload={trial_payload}")

    return True


async def _fetch_console_accounts(
    cookie_header: str, referer: str = ""
) -> dict[str, Any] | None:
    cookie_header = str(cookie_header or "").strip()
    if not cookie_header:
        return None

    headers = {
        **WEB_HEADERS,
        "Cookie": cookie_header,
    }
    if referer:
        headers["Referer"] = referer

    timeout = aiohttp.ClientTimeout(total=15)
    try:
        async with _make_session(timeout, headers) as client:
            async with client.get(
                CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT,
                allow_redirects=False,
                proxy=_req_proxy(client),
            ) as resp:
                if resp.status != 200:
                    return None
                payload = await resp.json()
    except Exception as exc:
        _codebuddy_auth_debug(f"console accounts fetch failed err={exc}")
        return None

    data = payload.get("data") or {}
    accounts = data.get("accounts") or []
    if payload.get("code") != 0 or not accounts:
        return None
    return payload


def _credit_from_resource_payload(
    resource_payload: dict[str, Any],
) -> dict[str, float] | None:
    if resource_payload.get("code") != 0:
        return None

    response_data = ((resource_payload.get("data") or {}).get("Response") or {}).get(
        "Data"
    ) or {}
    total_dosage = float(response_data.get("TotalDosage") or 0)
    accounts_list = response_data.get("Accounts") or []
    summary: dict[str, float] = {"credit_total_dosage": total_dosage}
    if not accounts_list:
        return summary

    total_remain = 0.0
    total_used = 0.0
    total_size = 0.0
    for acct in accounts_list:
        total_remain += float(acct.get("CapacityRemain") or 0)
        total_used += float(acct.get("CapacityUsed") or 0)
        total_size += float(acct.get("CapacitySize") or 0)

    summary["credit_capacity_remain"] = (
        total_dosage if total_dosage > total_remain else total_remain
    )
    summary["credit_capacity_used"] = total_used
    summary["credit_capacity_size"] = (
        total_dosage if total_dosage > total_size else total_size
    )
    return summary


class CodeBuddyProviderAdapter(ProviderAdapter):
    name = "codebuddy"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [part.strip() for part in raw_line.split("|")]

        if len(parts) not in (2, 3):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "codebuddy account must be email|password or email|password|workspace_id",
            )

        email = parts[0]
        password = parts[1]
        workspace_id = parts[2] if len(parts) == 3 else ""

        if not email or not password:
            raise NonRetryableBatcherError(
                ErrorCode.input_missing_required_field,
                "codebuddy account requires email and password",
            )

        if not _EMAIL_PATTERN.match(email):
            raise NonRetryableBatcherError(
                ErrorCode.input_invalid_format,
                "codebuddy account email format is invalid",
            )

        metadata: dict[str, str] = {}
        if workspace_id:
            metadata["workspace_id"] = workspace_id

        return NormalizedAccount(
            provider=self.name,
            identifier=email,
            secret=password,
            metadata=metadata,
            raw=raw_line,
        )

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        if os.getenv("BATCHER_ENABLE_CAMOUFOX", "false").lower() != "true":
            return {"stub": True}

        try:
            timeout = aiohttp.ClientTimeout(total=20)
            async with _make_session(timeout, CLI_HEADERS) as client:
                async with client.post(
                    CODEBUDDY_STATE_ENDPOINT, json={}, proxy=_req_proxy(client)
                ) as resp:
                    if resp.status >= 500:
                        raise RetryableBatcherError(
                            ErrorCode.http_5xx,
                            f"codebuddy auth/state server error ({resp.status})",
                        )
                    if resp.status == 429:
                        raise RetryableBatcherError(
                            ErrorCode.http_429, "codebuddy auth/state rate limited"
                        )
                    if resp.status != 200:
                        body = await resp.text()
                        raise NonRetryableBatcherError(
                            ErrorCode.provider_unsupported_response,
                            f"codebuddy auth/state rejected request ({resp.status}): {body[:120]}",
                        )

                    payload = await resp.json()

            if payload.get("code") != 0:
                raise RetryableBatcherError(
                    ErrorCode.auth_temporary_failure,
                    f"codebuddy auth/state returned code={payload.get('code')}",
                )

            data = payload.get("data") or {}
            state = str(data.get("state") or "").strip()
            auth_url = str(data.get("authUrl") or "").strip()
            if not state or not auth_url:
                raise NonRetryableBatcherError(
                    ErrorCode.provider_unsupported_response,
                    "codebuddy auth/state missing state or authUrl",
                )

            from camoufox.async_api import AsyncCamoufox

            camoufox_kwargs = build_camoufox_kwargs(
                proxy_url=_get_proxy_url() or "",
                default_timeout=30000,
                disable_coop=True,
                firefox_user_prefs=OAUTH_FIREFOX_PREFS,
            )
            timeout_ms = camoufox_kwargs.pop("_default_timeout")
            manager = AsyncCamoufox(**camoufox_kwargs)
            browser = await manager.__aenter__()
            page = await browser.new_page()
            page.set_default_timeout(timeout_ms)

            # ------------------------------------------------------------------
            # Google account warm-up (opt-out via env var)
            # ------------------------------------------------------------------
            # Fresh Gmail accounts logging into the OAuth broker directly on a
            # new IP get slammed with Google's "Something went wrong" screen.
            # Warming up by signing into accounts.google.com FIRST establishes
            # a trusted session and prevents this. Defaults to enabled.
            warmup_enabled = (
                os.getenv("BATCHER_CODEBUDDY_GOOGLE_WARMUP", "true").lower()
                == "true"
            )
            debug_enabled = (
                os.getenv("BATCHER_CODEBUDDY_AUTH_DEBUG", "false").lower()
                == "true"
            )
            if (
                warmup_enabled
                and account.identifier
                and account.secret
                and "@" in account.identifier
            ):
                try:
                    ok = await _warmup_google_session(
                        page,
                        account.identifier,
                        account.secret,
                        debug=debug_enabled,
                    )
                    _codebuddy_auth_debug(
                        f"google warmup {'ok' if ok else 'failed'} for {account.identifier}"
                    )
                except Exception as exc:
                    _codebuddy_auth_debug(f"google warmup crashed: {exc}")

            await page.goto(auth_url, wait_until="domcontentloaded", timeout=45000)

            return {
                "stub": False,
                "manager": manager,
                "browser": browser,
                "page": page,
                "state": state,
                "auth_url": auth_url,
                "auth_started_at": time.time(),
                "account": account.identifier,
            }
        except aiohttp.ServerTimeoutError as exc:
            raise RetryableBatcherError(
                ErrorCode.network_timeout, "codebuddy auth/state timeout"
            ) from exc
        except aiohttp.ClientConnectionError as exc:
            raise RetryableBatcherError(
                ErrorCode.network_connection_error,
                "codebuddy auth/state connection error",
            ) from exc

    async def _restart_browser_page(self, session: dict) -> Any:
        """Restart browser page after a crash. Returns new page or raises."""
        browser = session.get("browser")
        auth_url = session.get("auth_url", "")
        if not browser or not auth_url:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state,
                "cannot restart browser — missing browser or auth_url",
            )
        try:
            # Try to create a new page from existing browser
            page = await browser.new_page()
            page.set_default_timeout(30000)
            await page.goto(auth_url, wait_until="domcontentloaded", timeout=45000)
            session["page"] = page
            _codebuddy_auth_debug("browser page restarted successfully (new page from existing browser)")
            return page
        except Exception:
            pass

        # Browser itself is dead — need full restart
        _codebuddy_auth_debug("browser process dead — performing full restart")
        manager = session.get("manager")
        if manager:
            try:
                await manager.__aexit__(None, None, None)
            except Exception:
                pass

        from camoufox.async_api import AsyncCamoufox

        camoufox_kwargs = build_camoufox_kwargs(
            proxy_url=_get_proxy_url() or "",
            default_timeout=15000,
            disable_coop=True,
            firefox_user_prefs=OAUTH_FIREFOX_PREFS,
        )
        timeout_ms = camoufox_kwargs.pop("_default_timeout")
        new_manager = AsyncCamoufox(**camoufox_kwargs)
        new_browser = await new_manager.__aenter__()
        page = await new_browser.new_page()
        page.set_default_timeout(timeout_ms)
        await page.goto(auth_url, wait_until="domcontentloaded", timeout=25000)

        session["manager"] = new_manager
        session["browser"] = new_browser
        session["page"] = page
        _codebuddy_auth_debug("full browser restart completed")
        return page

    async def authenticate(
        self, account: NormalizedAccount, session: Any
    ) -> dict[str, Any]:
        if session is None or session.get("stub"):
            if "timeout" in account.identifier:
                raise RetryableBatcherError(
                    ErrorCode.network_timeout, "codebuddy timeout"
                )
            if "locked" in account.identifier:
                raise NonRetryableBatcherError(
                    ErrorCode.auth_account_locked,
                    "codebuddy account locked",
                )
            return {"authenticated": True, "state": "stub-state"}

        page = session.get("page")
        if page is None:
            raise RetryableBatcherError(
                ErrorCode.browser_unexpected_state, "missing browser page"
            )

        state = session.get("state", "")
        if not state:
            raise NonRetryableBatcherError(
                ErrorCode.provider_unsupported_response,
                "codebuddy session missing auth state",
            )

        # Internal retry for browser crashes — restart browser up to 2 times
        # before escalating to the outer retry loop in login.py
        _browser_crash_retries = 0
        _max_browser_crash_retries = 2

        while True:
            try:
                return await self._authenticate_inner(account, session, page, state)
            except Exception as exc:
                is_connection_closed = is_browser_crash(exc)
                if is_connection_closed and _browser_crash_retries < _max_browser_crash_retries:
                    _browser_crash_retries += 1
                    _codebuddy_auth_debug(
                        f"browser crash detected ({_browser_crash_retries}/{_max_browser_crash_retries}): {str(exc)[:100]}"
                    )
                    _emit_oauth_progress(
                        f"Browser crashed — restarting ({_browser_crash_retries}/{_max_browser_crash_retries})"
                    )
                    await asyncio.sleep(2.0)
                    try:
                        page = await self._restart_browser_page(session)
                    except Exception as restart_exc:
                        _codebuddy_auth_debug(f"browser restart failed: {restart_exc}")
                        raise RetryableBatcherError(
                            ErrorCode.browser_unexpected_state,
                            f"codebuddy browser crash + restart failed: {exc}",
                        ) from exc
                    continue
                # Not a connection-closed error or retries exhausted — re-raise
                raise

    async def _authenticate_inner(
        self, account: NormalizedAccount, session: Any, page: Any, state: str
    ) -> dict[str, Any]:
        # CodeBuddy login uses an iframe landing (checkbox + Google button) before Google auth form.
        # Iframe hydration on codebuddy.ai can take 5-10 seconds after page.goto,
        # so we retry up to ~30s (60 iterations * 0.5s) before giving up.
        _emit_oauth_progress("Initiating Google OAuth login")
        for _landing_iter in range(60):
            try:
                current_url = page.url
            except Exception:
                current_url = ""
            if "accounts.google.com" in current_url:
                _codebuddy_auth_debug("landing loop: already on accounts.google.com, breaking")
                break
            landing_clicked = await _handle_codebuddy_landing(page)
            if landing_clicked:
                _codebuddy_auth_debug(
                    f"landing loop: google button clicked at iter={_landing_iter}, waiting for nav"
                )
                # Wait for URL to leave the CodeBuddy login page
                for _nav_wait in range(20):
                    await asyncio.sleep(0.5)
                    try:
                        new_url = page.url
                    except Exception:
                        continue
                    if "accounts.google.com" in new_url or "/broker/google/" in new_url:
                        break
                break
            await asyncio.sleep(0.5)

        email_transition_deadline = 0.0
        password_transition_deadline = 0.0
        region_transition_deadline = 0.0
        landing_transition_deadline = 0.0
        email_step_started_at: float | None = None
        _codebuddy_base_netloc = urlparse(CODEBUDDY_BASE_URL).netloc

        # Inactivity timeout: only timeout if NO progress for 150s.
        # As long as something is happening (URL changes, buttons clicked, pages loading),
        # the timer resets. This handles slow internet gracefully.
        _INACTIVITY_TIMEOUT = 150.0
        _last_progress_at = time.monotonic()
        _last_seen_url = ""

        # Progress tracking — emit each step only once
        _progress_emitted: set[str] = set()

        # Track consent state — if consent was clicked and browser crashes after,
        # we know OAuth is complete server-side and can return authenticated immediately.
        _consent_was_clicked = False

        # Google "Something went wrong" — fresh accounts sometimes hit this on
        # first OAuth from a new device/IP. Retry with back-nav up to N times,
        # then give up and mark account as needing manual warm-up.
        _google_something_wrong_retries = 0
        _GOOGLE_SW_MAX_RETRIES = 2
        _last_google_sw_at = 0.0

        _consecutive_page_errors = 0
        for _ in range(600):  # High iteration cap — inactivity timeout is the real guard
            _now_mono = time.monotonic()
            if _now_mono - _last_progress_at > _INACTIVITY_TIMEOUT:
                raise RetryableBatcherError(
                    ErrorCode.auth_temporary_failure,
                    "codebuddy authenticate stuck — no progress for 150s",
                )
            try:
                current_url = page.url
                _consecutive_page_errors = 0
                # Reset inactivity timer when URL changes (page navigated = progress)
                if current_url and current_url != _last_seen_url:
                    _last_progress_at = time.monotonic()
                    _last_seen_url = current_url
            except Exception as _page_exc:
                _consecutive_page_errors += 1
                # If page is consistently unreachable, browser likely crashed
                if _consecutive_page_errors >= 3:
                    # If consent was already clicked, OAuth is complete server-side.
                    # Browser crash on the redirect is expected — return authenticated.
                    if _consent_was_clicked:
                        _codebuddy_auth_debug(
                            "browser crashed after consent was clicked — "
                            "treating as authenticated (OAuth complete server-side)"
                        )
                        _emit_oauth_progress(
                            "OAuth complete — consent granted (browser crashed on redirect)"
                        )
                        return {"authenticated": True, "state": state}
                    raise RetryableBatcherError(
                        ErrorCode.browser_unexpected_state,
                        f"codebuddy browser connection lost: {_page_exc}",
                    )
                await asyncio.sleep(1.0)
                current_url = ""
            parsed_url = urlparse(current_url) if current_url else None
            current_host = parsed_url.netloc if parsed_url else ""
            current_path = parsed_url.path if parsed_url else ""
            on_google_auth = "accounts.google.com" in current_host
            on_codebuddy_login = (
                current_host == _codebuddy_base_netloc
                and current_path.startswith("/login")
            )
            on_codebuddy_region = (
                current_host == _codebuddy_base_netloc
                and current_path.startswith("/register/user/complete")
            )
            # Detect redirect back to CodeBuddy home/root (not login, not region, not started)
            # This happens when Google account picker times out and browser redirects to CodeBuddy home
            _codebuddy_non_auth_paths = ("/", "", "/index.html", "/home")
            on_codebuddy_home = (
                current_host == _codebuddy_base_netloc
                and not on_codebuddy_login
                and not on_codebuddy_region
                and current_path.rstrip("/") in ("", "/index.html", "/home")
                or (
                    current_host == _codebuddy_base_netloc and current_path in ("/", "")
                )
            )
            on_keycloak_auth = (
                current_host == _codebuddy_base_netloc
                and "/auth/realms/" in current_path
            )
            now = time.monotonic()

            # ─── ACCOUNT ACCESS RESTRICTED / SESSION-LOST DETECTION ────────
            # Check EARLY, before anything else, so we don't wait for
            # inactivity timeout on a page that will never make progress.
            # Only check on codebuddy/keycloak pages (not Google interstitials,
            # which have their own transient restriction copy in prompts).
            if current_url and (on_codebuddy_login or on_keycloak_auth or on_codebuddy_home):
                try:
                    _blocked, _kind, _snippet = await _check_codebuddy_access_restricted(page)
                except Exception as _acc_exc:
                    _codebuddy_auth_debug(f"access-restricted check errored: {_acc_exc}")
                    _blocked, _kind, _snippet = (False, "", "")
                if _blocked:
                    _codebuddy_auth_debug(
                        f"account access restricted (real ban) url={current_url[:100]} snippet={_snippet!r}"
                    )
                    _emit_oauth_progress("Account access restricted by CodeBuddy")
                    raise NonRetryableBatcherError(
                        ErrorCode.auth_account_suspended,
                        f"codebuddy blocked this account or exit IP: {_snippet[:180]}",
                    )
                if _kind in ("session-lost", "timed-out"):
                    # Restart auth with a fresh state — the current OAuth
                    # callback/session is dead, no amount of extra clicking
                    # can revive it.
                    _codebuddy_auth_debug(
                        f"keycloak {_kind} page detected — restarting with fresh state "
                        f"url={current_url[:100]} marker={_snippet!r}"
                    )
                    _emit_oauth_progress(f"OAuth {_kind.replace('-', ' ')} — restarting")
                    _fresh_auth_url = session.get("auth_url", "")
                    if _fresh_auth_url:
                        try:
                            await asyncio.sleep(1.5)
                            await page.goto(
                                _fresh_auth_url,
                                wait_until="domcontentloaded",
                                timeout=45000,
                            )
                            _last_progress_at = time.monotonic()
                            landing_transition_deadline = time.monotonic() + 10.0
                            await asyncio.sleep(1.0)
                            continue
                        except Exception as _restart_exc:
                            _codebuddy_auth_debug(
                                f"restart with fresh state failed: {_restart_exc!r}"
                            )
                    # No auth_url or restart failed — raise retryable so caller
                    # can start a completely new attempt.
                    raise RetryableBatcherError(
                        ErrorCode.auth_temporary_failure,
                        f"codebuddy OAuth {_kind} ({_snippet[:120]}); retry gets a fresh state",
                    )

            # ─── GOOGLE "SOMETHING WENT WRONG" DETECTION ────────────────────
            # Fresh Gmail accounts often see this transient error on their
            # first OAuth login from a new device. Strategy:
            #   1. Detect (only on google host)
            #   2. Debounce (don't retrigger for same page load)
            #   3. Retry with page.go_back() twice (Google usually recovers)
            #   4. After N retries, give up as NonRetryable so the caller
            #      surfaces it for manual warm-up
            if current_url and "google" in current_host:
                try:
                    _gsw_hit, _gsw_snippet = await _check_google_something_went_wrong(page)
                except Exception as _gsw_exc:
                    _codebuddy_auth_debug(f"google-SW check errored: {_gsw_exc}")
                    _gsw_hit, _gsw_snippet = (False, "")
                if _gsw_hit and (time.monotonic() - _last_google_sw_at) > 3.0:
                    _last_google_sw_at = time.monotonic()
                    _google_something_wrong_retries += 1
                    _codebuddy_auth_debug(
                        f"google 'Something went wrong' detected "
                        f"(retry {_google_something_wrong_retries}/{_GOOGLE_SW_MAX_RETRIES}) "
                        f"url={current_url[:100]} snippet={_gsw_snippet!r}"
                    )
                    if _google_something_wrong_retries > _GOOGLE_SW_MAX_RETRIES:
                        _emit_oauth_progress(
                            "Google 'Something went wrong' — fresh account block"
                        )
                        raise NonRetryableBatcherError(
                            ErrorCode.auth_temporary_failure,
                            "google 'Something went wrong' persisted — fresh account "
                            "likely needs manual warm-up (login to accounts.google.com "
                            f"once by hand). snippet={_gsw_snippet[:160]}",
                        )
                    _emit_oauth_progress(
                        f"Google transient error — retrying "
                        f"({_google_something_wrong_retries}/{_GOOGLE_SW_MAX_RETRIES})"
                    )
                    # Retry: go back twice with pauses, let Google recover.
                    try:
                        await asyncio.sleep(random.uniform(1.5, 2.5))
                        await page.go_back(wait_until="domcontentloaded", timeout=15000)
                        await asyncio.sleep(random.uniform(1.0, 1.8))
                        await page.go_back(wait_until="domcontentloaded", timeout=15000)
                        await asyncio.sleep(random.uniform(2.0, 3.5))
                    except Exception as _back_exc:
                        _codebuddy_auth_debug(
                            f"go_back during SW recovery failed: {_back_exc}"
                        )
                        # Fallback: restart from auth_url so we get a fresh state.
                        _fresh_auth_url = session.get("auth_url", "")
                        if _fresh_auth_url:
                            try:
                                await page.goto(
                                    _fresh_auth_url,
                                    wait_until="domcontentloaded",
                                    timeout=45000,
                                )
                            except Exception:
                                pass
                    _last_progress_at = time.monotonic()
                    continue

            if current_url:
                if (
                    current_host == urlparse(CODEBUDDY_BASE_URL).netloc
                    and current_path == "/started"
                ):
                    q = parse_qs(parsed_url.query)
                    if (
                        q.get("platform", [""])[0].upper() == CODEBUDDY_PLATFORM
                        and q.get("state", [""])[0] == state
                    ):
                        _emit_oauth_progress("OAuth complete — redirect callback received")
                        return {"authenticated": True, "state": state}

                if current_url.startswith(CODEBUDDY_REDIRECT_SCHEME):
                    _emit_oauth_progress("OAuth complete — redirect callback received")
                    return {"authenticated": True, "state": state}

                normalized_path = (current_path or "").strip().lower()
                # /no-permission typically means areaInfoComplete=false (region not set).
                # This is NOT a permanent suspension — region setup fixes it.
                # We treat it as "authenticated" and let fetch_tokens handle region setup.
                if normalized_path == "/no-permission":
                    _codebuddy_auth_debug(
                        "no-permission page detected — treating as authenticated "
                        "(region setup will be done in fetch_tokens)"
                    )
                    _emit_oauth_progress("OAuth complete — account needs region setup")
                    return {"authenticated": True, "state": state}

                unauthorized_paths = {
                    "/no-client-authorization",
                    "/no-client-authorize",
                }
                if normalized_path in unauthorized_paths:
                    raise NonRetryableBatcherError(
                        ErrorCode.auth_account_suspended,
                        f"codebuddy account unauthorized client access ({normalized_path})",
                    )

            is_verify_email_page = False
            if on_keycloak_auth:
                if "VERIFY_EMAIL" in current_url or "verify-email" in current_url.lower() or ("required-action" in current_path and "execution=VERIFY_EMAIL" in current_url):
                    is_verify_email_page = True
                if not is_verify_email_page:
                    try:
                        page_text = await page.text_content("body")
                        if page_text and ("verify your email" in page_text.lower() or "email verification" in page_text.lower()):
                            is_verify_email_page = True
                    except Exception:
                        pass

            if is_verify_email_page:
                _last_progress_at = time.monotonic()  # progress: email verification page
                _codebuddy_auth_debug(f"email verification page detected at {current_url[:100]}")
                verified = await _handle_codebuddy_email_verification(page)
                if verified:
                    _codebuddy_auth_debug("email verification completed, continuing auth flow")
                    landing_transition_deadline = time.monotonic() + 10.0
                    await asyncio.sleep(2.0)
                    continue
                else:
                    _codebuddy_auth_debug("email verification handler returned False, will retry next loop")
                    await asyncio.sleep(3.0)
                    continue

            if on_keycloak_auth and not is_verify_email_page:
                try:
                    error_el = await page.query_selector("#kc-error-message")
                    if error_el:
                        error_text = await error_el.text_content()
                        _codebuddy_auth_debug(f"keycloak error page detected: {(error_text or '').strip()[:100]}")
                        auth_url = session.get("auth_url", "")
                        if auth_url:
                            _codebuddy_auth_debug(f"retrying auth from scratch: {auth_url[:80]}")
                            await asyncio.sleep(2.0)
                            await page.goto(auth_url, wait_until="domcontentloaded", timeout=45000)
                            landing_transition_deadline = time.monotonic() + 10.0
                            await asyncio.sleep(1.0)
                            continue
                        raise RetryableBatcherError(
                            ErrorCode.browser_unexpected_state,
                            f"keycloak error: {(error_text or 'unknown').strip()[:200]}",
                        )
                except RetryableBatcherError:
                    raise
                except Exception as exc:
                    # Page is likely broken/crashed — log and break early
                    _codebuddy_auth_debug(f"keycloak error check failed (page broken?): {exc}")
                    await asyncio.sleep(1.0)
                    continue

            if await _handle_google_gaplustos(page):
                _last_progress_at = time.monotonic()  # progress: clicked gaplustos
                if "gaplustos" not in _progress_emitted:
                    _emit_oauth_progress("Google security check — confirming identity")
                    _progress_emitted.add("gaplustos")
                await asyncio.sleep(0.8)
                continue

            if await _handle_google_consent_continue(page):
                _last_progress_at = time.monotonic()  # progress: clicked consent
                _consent_was_clicked = True
                if "consent" not in _progress_emitted:
                    _emit_oauth_progress("Google consent — granting access")
                    _progress_emitted.add("consent")
                # After consent is clicked, the OAuth callback fires and Google
                # redirects the browser back to CodeBuddy (via Keycloak broker).
                # We MUST wait for the redirect to complete so:
                #   1. CodeBuddy session cookies are set on www.codebuddy.ai
                #   2. The backend binds the OAuth state → access_token
                # Returning early leaves us with only Google cookies, causing
                # region/token endpoints to return 401 / code=11217.
                #
                # We poll page.url for up to ~30s waiting to land on the
                # codebuddy.ai domain. If the browser crashes on redirect
                # (COOP/cross-origin), fall back to "authenticated" so the
                # token fetch step can retry with what session we have.
                _consent_wait_deadline = time.monotonic() + 30.0
                while time.monotonic() < _consent_wait_deadline:
                    await asyncio.sleep(0.5)
                    try:
                        _post_consent_url = page.url or ""
                    except Exception as _pc_exc:
                        _codebuddy_auth_debug(
                            f"page unreachable after consent click: {_pc_exc} — "
                            "assuming crash on redirect, returning authenticated"
                        )
                        _emit_oauth_progress(
                            "OAuth complete — consent granted (browser crashed on redirect)"
                        )
                        return {"authenticated": True, "state": state}
                    _post_consent_host = urlparse(_post_consent_url).netloc
                    if _post_consent_host == _codebuddy_base_netloc:
                        _codebuddy_auth_debug(
                            f"post-consent redirect landed on CodeBuddy: {_post_consent_url}"
                        )
                        # Give the SPA a moment to finalize session cookies +
                        # backend state binding before token fetch.
                        await asyncio.sleep(2.0)
                        _emit_oauth_progress("OAuth complete — consent granted")
                        return {"authenticated": True, "state": state}
                # Timeout waiting for redirect — still return authenticated so
                # fetch_tokens can attempt navigation to /started?state=... itself.
                _codebuddy_auth_debug(
                    "timed out waiting for post-consent redirect to CodeBuddy — "
                    "returning authenticated; fetch_tokens will navigate"
                )
                _emit_oauth_progress("OAuth complete — consent granted")
                return {"authenticated": True, "state": state}

            # Only attempt accounts fetch when on CodeBuddy domain (not Google auth).
            # This avoids wasted fetch calls on every loop iteration during OAuth.
            accounts_payload = None
            cookie_header = None
            if current_host == _codebuddy_base_netloc:
                # Dismiss any "Service Agreement / User Agreement" modal that
                # blocks interaction with the home page. Idempotent — safe to
                # call every iteration; only clicks Confirm when the modal is
                # actually visible.
                if await _handle_codebuddy_agreement_modal(page):
                    _last_progress_at = time.monotonic()
                    if "agreement" not in _progress_emitted:
                        _emit_oauth_progress("Accepted CodeBuddy Service Agreement")
                        _progress_emitted.add("agreement")
                    await asyncio.sleep(1.0)

                accounts_payload = await _fetch_console_accounts_via_page(page)
                cookie_header = await _build_cookie_header_from_page(
                    page, CODEBUDDY_BASE_URL
                )
                if cookie_header and isinstance(session, dict):
                    session["cookie_header"] = cookie_header

            if accounts_payload is None and cookie_header:
                accounts_payload = await _fetch_console_accounts(
                    cookie_header, current_url
                )
            if accounts_payload is not None:
                accounts_data = accounts_payload.get("data") or {}
                accounts = accounts_data.get("accounts") or []
                area_info_complete_raw = accounts_data.get("areaInfoComplete")
                area_info_complete = (
                    bool(area_info_complete_raw)
                    if area_info_complete_raw is not None
                    else False
                )
                _codebuddy_auth_debug(
                    "console accounts authenticated "
                    f"count={len(accounts)} path={current_path or '/'} "
                    f"areaInfoComplete={area_info_complete} raw={area_info_complete_raw!r}"
                )

                # Account is authenticated regardless of areaInfoComplete status.
                # Region selection is handled separately (or skipped entirely).
                _emit_oauth_progress("OAuth complete — session verified")
                await _save_cookies_to_file(page, account.identifier)
                return {"authenticated": True, "state": state}

            if on_codebuddy_region and now < region_transition_deadline:
                await asyncio.sleep(0.4)
                continue

            if on_codebuddy_region:
                _last_progress_at = time.monotonic()  # progress: on region page
                region_ok = await _ensure_region_with_retry(
                    page, account.identifier, max_retries=3
                )
                if region_ok:
                    region_transition_deadline = time.monotonic() + 8.0
                    await asyncio.sleep(0.8)
                    continue

                if CODEBUDDY_FORCE_REGION_POST_AUTH:
                    forced = await _submit_region_via_page(page)
                    if forced:
                        region_transition_deadline = time.monotonic() + 8.0
                        await asyncio.sleep(0.8)
                        continue

                await asyncio.sleep(0.6)
                continue

            if on_codebuddy_login:
                _last_progress_at = time.monotonic()  # progress: on login page
                await _handle_codebuddy_landing(page)

            # When redirected back to CodeBuddy home after a Google timeout/re-auth,
            # need to click ToS checkbox + Google login button again to restart the flow.
            if on_codebuddy_home and now >= landing_transition_deadline:
                _last_progress_at = time.monotonic()  # progress: retrying landing
                _codebuddy_auth_debug(
                    f"codebuddy home detected (path={current_path!r}), re-triggering landing click"
                )
                landing_clicked = await _handle_codebuddy_landing(page)
                if landing_clicked:
                    _codebuddy_auth_debug(
                        "re-triggered codebuddy landing click on home page"
                    )
                    landing_transition_deadline = time.monotonic() + 12.0
                    await asyncio.sleep(1.5)
                    continue
                # If no landing elements found, try clicking generic buttons for this page
                await _click_continue_button(page)
                landing_transition_deadline = time.monotonic() + 8.0
                await asyncio.sleep(1.0)
                continue

            if on_codebuddy_home and now < landing_transition_deadline:
                await asyncio.sleep(0.5)
                continue

            if on_keycloak_auth and not is_verify_email_page and now >= landing_transition_deadline:
                _codebuddy_auth_debug(
                    f"keycloak auth page detected (path={current_path!r}), clicking Google login"
                )
                landing_clicked = await _handle_codebuddy_landing(page)
                if landing_clicked:
                    _codebuddy_auth_debug("clicked Google login on keycloak page")
                    landing_transition_deadline = time.monotonic() + 10.0
                    await asyncio.sleep(2.0)
                    continue
                await asyncio.sleep(1.0)
                continue

            if on_keycloak_auth and not is_verify_email_page and now < landing_transition_deadline:
                await asyncio.sleep(0.5)
                continue

            target = page
            if on_codebuddy_login:
                iframe = await _get_codebuddy_login_iframe(page)
                if iframe is not None:
                    target = iframe

            google_target = page if on_google_auth else target

            at_password_step = await _is_password_step(google_target)
            at_email_step = await _is_email_step(google_target)

            # Only check for account picker when neither email nor password fields are active.
            # This prevents the picker from falsely matching the password page.
            at_account_picker = False
            if on_google_auth and not at_password_step and not at_email_step:
                at_account_picker = await _is_google_account_picker(google_target)

            if on_google_auth and at_account_picker:
                _last_progress_at = time.monotonic()  # progress: account picker visible
                if "picker" not in _progress_emitted:
                    _emit_oauth_progress("Google OAuth — selecting account")
                    _progress_emitted.add("picker")
                _codebuddy_auth_debug(
                    f"google account picker detected, clicking account={account.identifier}"
                )
                account_clicked = await _click_google_account_in_picker(
                    google_target, account.identifier
                )
                if account_clicked:
                    _codebuddy_auth_debug("google account clicked in picker")
                    await asyncio.sleep(2.0)
                    continue
                else:
                    _codebuddy_auth_debug(
                        "google account not found in picker, trying generic click"
                    )
                    await _click_continue_button(google_target)
                    await asyncio.sleep(1.5)
                    continue

            email_filled = False
            if on_google_auth and at_email_step and not at_password_step:
                _last_progress_at = time.monotonic()  # progress: email step visible
                if "email" not in _progress_emitted:
                    _emit_oauth_progress("Google OAuth — entering email")
                    _progress_emitted.add("email")
                if email_step_started_at is None:
                    email_step_started_at = now
                elif now - email_step_started_at > 35.0:
                    raise RetryableBatcherError(
                        ErrorCode.browser_challenge_blocked,
                        "codebuddy captcha suspected: email step stuck > 35s",
                    )
                if now < email_transition_deadline:
                    await asyncio.sleep(0.4)
                    continue
                # Use proven batch-adder strategy for Google email step:
                # wait_for_selector -> fill -> type -> verify -> press Enter.
                email_filled = await _fill_google_email_step(page, account.identifier)
            if email_filled:
                email_transition_deadline = time.monotonic() + 6.0
                await asyncio.sleep(0.2)
                await asyncio.sleep(1.0)
                continue

            password_filled = False
            if on_google_auth and at_password_step:
                _last_progress_at = time.monotonic()  # progress: password step visible
                if "password" not in _progress_emitted:
                    _emit_oauth_progress("Google OAuth — entering password")
                    _progress_emitted.add("password")
                email_step_started_at = None
                if now < password_transition_deadline:
                    await asyncio.sleep(0.4)
                    continue
                # Use proven batch-adder strategy for Google password step.
                password_filled = await _fill_google_password_step(page, account.secret)
            if password_filled:
                password_transition_deadline = time.monotonic() + 8.0
                await asyncio.sleep(0.2)
                await asyncio.sleep(1.0)
                continue

            # Strict guard: never click generic continue when login fields exist but
            # we failed to validate filled input.
            if on_google_auth and (at_email_step or at_password_step):
                await asyncio.sleep(0.6)
                continue
            if not on_google_auth:
                email_step_started_at = None

            await _click_continue_button(target)
            if target is not page:
                await _click_continue_button(page)
            await asyncio.sleep(1.0)

        raise RetryableBatcherError(
            ErrorCode.auth_temporary_failure,
            "codebuddy browser auth did not reach started callback in time",
        )

    async def fetch_tokens(
        self,
        account: NormalizedAccount,
        auth_state: dict[str, Any],
        session: Any,
    ) -> dict[str, str]:
        state = str(auth_state.get("state") or "")
        if session is None or session.get("stub"):
            return {
                "api_key": "stub-api-key",
                "state": state or "stub-state",
            }

        if not state:
            raise NonRetryableBatcherError(
                ErrorCode.provider_unsupported_response,
                "codebuddy auth state missing for API key creation",
            )

        page = session.get("page") if isinstance(session, dict) else None
        if not page:
            raise NonRetryableBatcherError(
                ErrorCode.provider_unsupported_response,
                "codebuddy browser session missing",
            )

        # Internal retry for browser crashes during token fetch
        for _token_attempt in range(3):
            try:
                return await self._fetch_tokens_inner(page, session, state, account)
            except Exception as exc:
                is_connection_closed = is_browser_crash(exc)
                if is_connection_closed and _token_attempt < 2:
                    _codebuddy_auth_debug(
                        f"browser crash in fetch_tokens (attempt {_token_attempt+1}/3): {str(exc)[:100]}"
                    )
                    _emit_oauth_progress(
                        f"Browser crashed during token fetch — restarting ({_token_attempt+1}/2)"
                    )
                    await asyncio.sleep(2.0)
                    try:
                        page = await self._restart_browser_page(session)
                    except Exception as restart_exc:
                        _codebuddy_auth_debug(f"browser restart failed in fetch_tokens: {restart_exc}")
                        raise RetryableBatcherError(
                            ErrorCode.browser_unexpected_state,
                            f"codebuddy browser crash in fetch_tokens + restart failed: {exc}",
                        ) from exc
                    continue
                raise

        # Should not reach here, but just in case
        raise RetryableBatcherError(
            ErrorCode.provider_token_exchange_failed,
            "codebuddy fetch_tokens exhausted all browser crash retries",
        )

    async def _fetch_tokens_inner(
        self, page: Any, session: Any, state: str, account: NormalizedAccount
    ) -> dict[str, str]:
        # ─── ENSURE PAGE IS ON CODEBUDDY DOMAIN ──────────────────────────
        # After consent-click shortcut, the page may still be on Google domain,
        # or the redirect back to /started may not have completed. Either way,
        # we MUST land on /started?platform=IDE&state=<state> so the CodeBuddy
        # backend binds the OAuth callback to our state, otherwise the token
        # endpoint returns code=11217 ("state not associated with a token") and
        # region/trial APIs return 401.
        _codebuddy_base_netloc = urlparse(CODEBUDDY_BASE_URL).netloc
        try:
            current_url = page.url
        except Exception:
            current_url = ""
        current_host = urlparse(current_url).netloc if current_url else ""
        current_path = urlparse(current_url).path if current_url else ""

        needs_state_nav = (
            current_host != _codebuddy_base_netloc
            or not current_path.startswith("/started")
        )
        if needs_state_nav:
            _codebuddy_auth_debug(
                f"navigating to /started?state=... to bind OAuth (from host={current_host}, path={current_path})"
            )
            # Navigate to the OAuth state endpoint — this completes the OAuth flow
            # and establishes session cookies on the CodeBuddy domain.
            _state_url = f"{CODEBUDDY_BASE_URL}/started?platform={CODEBUDDY_PLATFORM}&state={state}"
            try:
                await page.goto(_state_url, wait_until="domcontentloaded", timeout=30000)
            except Exception as nav_exc:
                _codebuddy_auth_debug(f"navigation to /started failed: {nav_exc}, trying base URL")
                try:
                    await page.goto(CODEBUDDY_BASE_URL, wait_until="domcontentloaded", timeout=30000)
                except Exception:
                    pass
            # Give the SPA time to finalize the token binding on backend
            # (backend needs a moment after receiving the OAuth callback).
            await asyncio.sleep(3.0)

        # ─── ENSURE REGION + TRIAL ACTIVATION ────────────────────────────
        # Region setup and trial activation are required to provision credits.
        # Without this, accounts get "Restricted" status with 0 credits.
        _codebuddy_auth_debug("ensuring region + trial activation before API key creation")
        await self._ensure_region_and_trial(page)

        # ─── DIRECT ACCESS TOKEN (NO API KEY CREATION) ────────────────
        # Per user request: "login pakai gmail simpan akses token".
        # After Gmail OAuth login, the browser holds a valid CodeBuddy session.
        # Poll the device-flow token endpoint using the authenticated session
        # cookies to obtain access_token + refresh_token. No API key is created.
        _codebuddy_auth_debug("fetching access token via state/token endpoint (no API key)")
        tokens = await self._fetch_access_token_via_state(page, state)

        if not tokens.get("access_token"):
            raise RetryableBatcherError(
                ErrorCode.provider_token_exchange_failed,
                "codebuddy failed to fetch access token after Gmail login",
            )

        await _save_cookies_to_file(page, account.identifier)
        _codebuddy_auth_debug("done — access token captured, cookies saved, browser can be closed")

        return {**tokens, "state": state}

    async def _fetch_access_token_via_state(self, page: Any, state: str) -> dict[str, str]:
        """Poll the CodeBuddy device-flow token endpoint using the browser's
        authenticated session. Returns {access_token, refresh_token, ...} or {}."""
        try:
            # Poll token endpoint via page fetch (uses session cookies, credentials include)
            result = await page.evaluate(
                """async (state) => {
                    const url = `/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
                    const resp = await fetch(url, {
                        method: 'GET',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json, text/plain, */*',
                            'X-Requested-With': 'XMLHttpRequest',
                            'X-Domain': 'www.codebuddy.ai',
                        }
                    });
                    if (!resp.ok) return { status: resp.status };
                    return await resp.json();
                }""",
                state,
            )
        except Exception as exc:
            _codebuddy_auth_debug(f"token poll via page failed: {exc}")
            return {}

        code = result.get("code")
        data = result.get("data") or {}

        # If not authorized yet, wait briefly and retry a few times
        for _ in range(5):
            if data.get("accessToken"):
                break
            _codebuddy_auth_debug(f"token not ready yet (code={code}), waiting 3s")
            await asyncio.sleep(3)
            try:
                result = await page.evaluate(
                    """async (state) => {
                        const url = `/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
                        const resp = await fetch(url, {
                            method: 'GET',
                            credentials: 'include',
                            headers: {
                                'Accept': 'application/json, text/plain, */*',
                                'X-Requested-With': 'XMLHttpRequest',
                                'X-Domain': 'www.codebuddy.ai',
                            }
                        });
                        if (!resp.ok) return { status: resp.status };
                        return await resp.json();
                    }""",
                    state,
                )
            except Exception:
                continue
            code = result.get("code")
            data = result.get("data") or {}

        access_token = data.get("accessToken") or data.get("access_token") or ""
        if not access_token:
            _codebuddy_auth_debug(f"no access token after polling (code={code})")
            return {}

        tokens: dict[str, str] = {"access_token": str(access_token)}
        if data.get("refreshToken"):
            tokens["refresh_token"] = str(data["refreshToken"])
        if data.get("expiresIn"):
            tokens["expires_in"] = str(data["expiresIn"])
        _codebuddy_auth_debug(f"access token captured (keys={list(tokens.keys())})")
        return tokens

    async def _ensure_region_and_trial(self, page: Any) -> None:
        """Ensure region is set to Singapore and trial is activated.

        This is required for new accounts to receive credits.
        Without region + trial, accounts are "Restricted" with 0 credits.
        Steps:
          1. Set region to Singapore via /console/login/account
          2. Register overseas user via /auth/realms/copilot/overseas/user/register
          3. Activate trial via /billing/ide/trial
        All steps are idempotent — safe to call on already-configured accounts.
        """
        # Step 1: Submit region (Singapore)
        _codebuddy_auth_debug("region+trial: submitting region (Singapore)")
        region_body = {
            "attributes": {
                "countryCode": ["65"],
                "countryFullName": ["Singapore"],
                "countryName": ["SG"],
            }
        }
        status, payload, body = await _codebuddy_request_via_page(
            page, "POST", CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT, body=region_body
        )
        code = payload.get("code") if isinstance(payload, dict) else None
        _codebuddy_auth_debug(f"region+trial: region status={status} code={code}")

        # Step 2: Get user ID and register overseas
        accounts_payload = await _fetch_console_accounts_via_page(page)
        user_id = ""
        if accounts_payload:
            accounts_data = accounts_payload.get("data") or {}
            accounts = accounts_data.get("accounts") or []
            if accounts:
                user_id = str(accounts[0].get("uid") or "")

        if user_id:
            register_url = (
                f"{CODEBUDDY_BASE_URL}/auth/realms/copilot/overseas/user/register"
                f"?userId={user_id}"
            )
            reg_status, reg_payload, _ = await _codebuddy_request_via_page(
                page, "GET", register_url
            )
            _codebuddy_auth_debug(
                f"region+trial: overseas register status={reg_status} "
                f"payload={reg_payload}"
            )
        else:
            _codebuddy_auth_debug("region+trial: no uid found, skipping overseas register")

        # Step 3: Activate trial
        trial_url = f"{CODEBUDDY_BASE_URL}/billing/ide/trial"
        trial_status, trial_payload, _ = await _codebuddy_request_via_page(
            page, "POST", trial_url
        )
        trial_code = trial_payload.get("code") if isinstance(trial_payload, dict) else None
        _codebuddy_auth_debug(
            f"region+trial: trial activation status={trial_status} code={trial_code}"
        )

        # Delay to let backend provision credits after trial activation
        await asyncio.sleep(2.0)

    async def fetch_quota(
        self,
        account: NormalizedAccount,
        tokens: dict[str, str],
        session: Any,
    ) -> dict[str, Any] | None:
        """Fetch quota via API calls only — no page navigation needed."""
        _ = account

        page = session.get("page") if isinstance(session, dict) else None
        if page is None:
            return None

        # Retry with page restart on browser crash (up to 2 restarts)
        for _quota_attempt in range(3):
            try:
                return await self._fetch_quota_inner(page, session)
            except Exception as exc:
                if is_browser_crash(exc) and _quota_attempt < 2:
                    _codebuddy_auth_debug(
                        f"browser crash in fetch_quota (attempt {_quota_attempt+1}/3): {str(exc)[:100]}"
                    )
                    await asyncio.sleep(1.5)
                    try:
                        page = await self._restart_browser_page(session)
                    except Exception:
                        _codebuddy_auth_debug("browser restart failed in fetch_quota")
                        return None
                    continue
                # Non-crash errors — just return None (quota is best-effort)
                _codebuddy_auth_debug(f"fetch_quota error: {str(exc)[:120]}")
                return None

        _codebuddy_auth_debug("fetch_quota exhausted all crash retries")
        return None

    async def _fetch_quota_inner(
        self, page: Any, session: Any
    ) -> dict[str, Any] | None:
        """Inner fetch_quota logic — may raise on browser crash."""
        # 1. Claim gift credits via API (fast, no navigation)
        _codebuddy_auth_debug("claiming gift credits via API")
        gift_claimed, gift_credits = await self._try_claim_gift_via_api(page)

        # 2. Fetch credit balance via API (no page navigation needed)
        # Retry up to 4 times — credits may take a moment to provision after trial activation
        _codebuddy_auth_debug("fetching credit balance via API")
        for attempt in range(4):
            if attempt > 0:
                await asyncio.sleep(2.0)

            credit_summary = await _fetch_user_resource_credit_via_page(page)
            if credit_summary:
                remain = credit_summary.get("credit_capacity_remain", 0)
                # If remain is 0 but we just activated trial, wait and retry
                if remain <= 0 and attempt < 3:
                    _codebuddy_auth_debug(
                        f"credit remain=0 on attempt {attempt+1}, retrying..."
                    )
                    continue
                if gift_claimed:
                    credit_summary["gift_claimed"] = True
                    credit_summary["gift_credits"] = gift_credits
                _codebuddy_auth_debug(
                    f"credit fetched: remain={credit_summary.get('credit_capacity_remain')} "
                    f"size={credit_summary.get('credit_capacity_size')}"
                )
                return credit_summary

        _codebuddy_auth_debug("credit API failed — returning None")
        return None

    async def _try_claim_gift_via_api(self, page: Any) -> tuple[bool, float]:
        check_url = f"{CODEBUDDY_BASE_URL}/billing/meter/check-gift-claimed"
        claim_url = f"{CODEBUDDY_BASE_URL}/billing/meter/claim-gift"

        try:
            result = await page.evaluate(
                """async (url) => {
                    try {
                        const resp = await fetch(url, {
                            method: 'POST',
                            credentials: 'include',
                            headers: {
                                'Accept': 'application/json, text/plain, */*',
                                'Content-Type': 'application/json',
                                'X-Requested-With': 'XMLHttpRequest',
                            },
                        });
                        const json = await resp.json();
                        return { status: resp.status, json };
                    } catch (err) {
                        return { status: 0, json: null };
                    }
                }""",
                check_url,
            )
        except Exception as exc:
            _codebuddy_auth_debug(f"VIP: check-gift API error={exc}")
            return False, 0

        payload = result.get("json") or {}
        data = payload.get("data") or {}
        claimed = data.get("claimed", True)
        active = data.get("active", False)
        credit_num = float(data.get("credit_num", 0))

        _codebuddy_auth_debug(
            f"VIP: check-gift claimed={claimed} active={active} credit_num={credit_num}"
        )

        if claimed or not active:
            return False, 0

        _codebuddy_auth_debug(f"VIP: claiming {credit_num} credits via API")
        await asyncio.sleep(1.0)

        try:
            result = await page.evaluate(
                """async (url) => {
                    try {
                        const resp = await fetch(url, {
                            method: 'POST',
                            credentials: 'include',
                            headers: {
                                'Accept': 'application/json, text/plain, */*',
                                'Content-Type': 'application/json',
                                'X-Requested-With': 'XMLHttpRequest',
                            },
                        });
                        const json = await resp.json();
                        return { status: resp.status, json };
                    } catch (err) {
                        return { status: 0, json: null };
                    }
                }""",
                claim_url,
            )
        except Exception as exc:
            _codebuddy_auth_debug(f"VIP: claim-gift API error={exc}")
            return False, 0

        claim_payload = result.get("json") or {}
        success = claim_payload.get("code") == 0
        _codebuddy_auth_debug(f"VIP: claim-gift success={success} credits={credit_num}")

        if success:
            await asyncio.sleep(2.0)

        return success, credit_num

    async def _fetch_user_resource_credit(
        self, cookie_header: str
    ) -> dict[str, float] | None:
        if not cookie_header.strip():
            return None

        timeout = aiohttp.ClientTimeout(total=20)
        now = datetime.utcnow()
        payload_body = {
            "PageNumber": 1,
            "PageSize": 100,
            "ProductCode": "p_tcaca",
            "Status": [0, 3],
            "PackageEndTimeRangeBegin": now.strftime("%Y-%m-%d %H:%M:%S"),
            "PackageEndTimeRangeEnd": (now + timedelta(days=365 * 20)).strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
        }
        web_headers = {
            "Cookie": cookie_header,
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
            "Referer": f"{CODEBUDDY_BASE_URL}/profile/usage",
            "Origin": CODEBUDDY_BASE_URL,
            "X-Requested-With": "XMLHttpRequest",
            "X-Domain": urlparse(CODEBUDDY_BASE_URL).netloc,
        }

        async with _make_session(timeout, web_headers) as web_client:
            async with web_client.post(
                CODEBUDDY_USER_RESOURCE_ENDPOINT,
                json=payload_body,
                proxy=_req_proxy(web_client),
            ) as resp:
                if resp.status != 200:
                    _codebuddy_auth_debug(f"credit via cookie status={resp.status}")
                    return None
                resource_payload = await resp.json()
        if _codebuddy_auth_debug_enabled():
            _codebuddy_auth_debug(
                f"credit via cookie code={resource_payload.get('code')}"
            )
        return _credit_from_resource_payload(resource_payload)

    async def refresh_saved_credit(
        self, metadata: dict[str, Any]
    ) -> dict[str, Any] | None:
        cookie_header = str(metadata.get("web_cookie") or "").strip()
        if not cookie_header:
            tokens = metadata.get("tokens") or {}
            if isinstance(tokens, dict):
                cookie_header = str(tokens.get("web_cookie") or "").strip()
        if not cookie_header:
            return None
        return await self._fetch_user_resource_credit(cookie_header)

    async def cleanup_session(self, session: Any) -> None:
        if not isinstance(session, dict):
            return

        manager = session.get("manager")
        if manager is None:
            return

        try:
            await manager.__aexit__(None, None, None)
        except Exception:
            return
