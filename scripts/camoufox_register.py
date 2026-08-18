#!/usr/bin/env python3
"""
Camoufox-based GitHub account registration.
Uses Camoufox (anti-detect Firefox) headed under Xvfb to resolve the DataDome
page-load interstitial, then submits the signup form and captures the launch
code from IMAP to complete email verification.

Usage:
  python3 camoufox_register.py --email EMAIL --password PASS --proxy PROXY_URL --imap-host HOST --imap-port PORT --imap-user USER --imap-pass PASS --domain DOMAIN

Outputs JSON to stdout:
  {"success": true, "status": "verified", "code": "123456"}
  {"success": false, "status": "error", "error": "..."}

Progress logs go to stderr (captured by backend → journald + WebSocket).
"""
import argparse
import json
import sys
import time
import re
import os
import imaplib
import email as emailmod
from datetime import datetime, timedelta, timezone


def log_progress(step, **extra):
    """Emit a progress log line to stderr. Backend captures → journald + WS broadcast."""
    payload = {"progress": step, "ts": datetime.now(timezone.utc).isoformat()}
    payload.update(extra)
    print(json.dumps(payload), file=sys.stderr, flush=True)


def log_error(error_msg, **extra):
    """Emit a final error result to stdout + progress to stderr."""
    log_progress("error", error=error_msg, **extra)
    print(json.dumps({"success": False, "status": "error", "error": error_msg, **extra}))
    sys.exit(0)


# ── Captcha Solver Sidecar ──────────────────────────────────────────
SOLVER_URL = "http://127.0.0.1:8877"

def solve_datadome_via_solver(proxy_url, timeout_s=90):
    """Call the captcha-solver sidecar to harvest a DataDome clearance cookie."""
    import urllib.request
    import urllib.error

    payload = json.dumps({
        "type": "datadome",
        "url": "https://octocaptcha.com/datadome?origin_page=github_signup_redesign",
        "referer": "https://github.com/",
        "proxy": proxy_url,
        "timeout_s": timeout_s,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{SOLVER_URL}/solve",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        log_progress("captcha_solver_calling", solver_url=SOLVER_URL, type="datadome")
        with urllib.request.urlopen(req, timeout=timeout_s + 10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("success"):
                cookie_val = data.get("datadome_cookie") or data.get("value") or ""
                log_progress("captcha_solver_success",
                             cookie_len=len(cookie_val),
                             user_agent=data.get("user_agent", "")[:50])
            else:
                log_progress("captcha_solver_failed", error=data.get("error", "unknown"))
            return data
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")[:300]
        log_progress("captcha_solver_http_error", code=e.code, body=body)
        return {"success": False, "error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        log_progress("captcha_solver_exception", error=str(e))
        return {"success": False, "error": str(e)}


def take_screenshot(page, label, screenshots_dir="/tmp/etteum-github-screenshots"):
    """Take a screenshot for debugging."""
    try:
        os.makedirs(screenshots_dir, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        path = os.path.join(screenshots_dir, f"{ts}_{label}.png")
        page.screenshot(path=path, full_page=True)
        log_progress("screenshot_saved", path=path, label=label)
        return path
    except Exception as e:
        log_progress("screenshot_failed", label=label, error=str(e))
        return None


def dump_page_state(page, label):
    """Dump current page URL, title, element checks for debugging."""
    try:
        url = page.url
        title = page.title()
        html = page.content()

        datadome_keys = []
        for key in ["datadome", "DataDome", "captcha", "cf-challenge",
                     "Checking your browser", "Please wait"]:
            if key.lower() in html.lower():
                datadome_keys.append(key)

        element_checks = {}
        for sel, name in [
            ('input[name="user[email]"]', "email_input"),
            ('input[name="user[password]"]', "password_input"),
            ('input[name="user[login]"]', "username_input"),
            ('button[type="submit"]:has-text("Create account")', "create_btn"),
            ('form[action*="signup"]', "signup_form"),
            ('iframe[src*="datadome"]', "datadome_iframe"),
            ('iframe[src*="octocaptcha"]', "octocaptcha_iframe"),
            ('div[class*="captcha"]', "captcha_div"),
        ]:
            try:
                el = page.query_selector(sel)
                visible = el.is_visible() if el else False
                element_checks[name] = {"exists": bool(el), "visible": visible}
            except Exception:
                element_checks[name] = {"exists": False, "visible": False, "error": True}

        error_texts = []
        try:
            for el in page.query_selector_all('.flash-error:not([hidden]), .flash-danger:not([hidden]), [role="alert"]:not([hidden])'):
                if el.is_visible():
                    txt = el.inner_text().strip()
                    if txt and txt not in error_texts:
                        error_texts.append(txt[:300])
        except Exception:
            pass

        body_text = ""
        try:
            body_text = page.inner_text("body")[:500].replace("\n", " | ")
        except Exception:
            pass

        log_progress(f"page_state_{label}", url=url, title=title,
                     datadome_indicators=datadome_keys,
                     elements=element_checks,
                     error_texts=error_texts,
                     body_snippet=body_text)
    except Exception as e:
        log_progress(f"page_state_{label}_failed", error=str(e))


def read_verification_code(imap_host, imap_port, imap_user, imap_pass, target_email, since_minutes=10):
    """Poll IMAP for GitHub verification email."""
    try:
        mail = imaplib.IMAP4_SSL(imap_host, imap_port)
        mail.login(imap_user, imap_pass)
        mail.select("INBOX")

        since = (datetime.now() - timedelta(minutes=since_minutes)).strftime("%d-%b-%Y")
        status, data = mail.search(None, f'(SINCE {since})')
        if status != "OK":
            mail.logout()
            return None, "IMAP search failed"

        ids = data[0].split()
        for eid in reversed(ids[-20:]):
            status, msg_data = mail.fetch(eid, "(RFC822)")
            if status != "OK":
                continue
            raw = msg_data[0][1]
            msg = emailmod.message_from_bytes(raw)

            from_addr = msg.get("From", "").lower()
            to_addr = msg.get("To", "").lower()

            if "github.com" not in from_addr:
                continue
            if target_email.lower() not in to_addr and target_email.lower() not in msg.get("Delivered-To", "").lower():
                continue

            body = ""
            if msg.is_multipart():
                for part in msg.walk():
                    ct = part.get_content_type()
                    if ct in ("text/plain", "text/html"):
                        payload = part.get_payload(decode=True)
                        if payload:
                            body += payload.decode("utf-8", errors="ignore")
            else:
                payload = msg.get_payload(decode=True)
                if payload:
                    body = payload.decode("utf-8", errors="ignore")

            # GitHub launch codes are currently 8 digits (previously 6). Match either.
            # Preferred: the digits that appear on their own line right after the
            # "entering the code below:" preamble. Fallback: any 6-10 digit run on
            # its own line, then any 6-10 digit token.
            code_match = re.search(r'\[AUTH-(\d+)\]', body) or \
                         re.search(r'code below[:\s]*[\r\n]+\s*(\d{6,10})\b', body, re.I) or \
                         re.search(r'verification code[:\s]*(\d{6,10})', body, re.I) or \
                         re.search(r'^\s*(\d{6,10})\s*$', body, re.M) or \
                         re.search(r'\b(\d{8})\b', body) or \
                         re.search(r'\b(\d{6})\b', body)
            if code_match:
                code = code_match.group(1)
                mail.logout()
                return code, None

        mail.logout()
        return None, "No matching email found"
    except Exception as e:
        return None, str(e)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--proxy", required=True)
    parser.add_argument("--imap-host", required=True)
    parser.add_argument("--imap-port", type=int, default=993)
    parser.add_argument("--imap-user", required=True)
    parser.add_argument("--imap-pass", required=True)
    parser.add_argument("--domain", required=True)
    args = parser.parse_args()

    log_progress("script_started", email=args.email, proxy=args.proxy, domain=args.domain, browser="camoufox")

    # Parse proxy URL for Camoufox (dict format)
    proxy_match = re.match(r'https?://([^:]+):([^@]+)@([^:]+):(\d+)', args.proxy)
    if proxy_match:
        proxy = {
            'server': f'http://{proxy_match.group(3)}:{proxy_match.group(4)}',
            'username': proxy_match.group(1),
            'password': proxy_match.group(2),
        }
        log_progress("proxy_parsed", host=proxy_match.group(3), port=proxy_match.group(4))
    else:
        proxy = {'server': args.proxy}
        log_progress("proxy_raw", proxy=args.proxy)

    # Import Camoufox — best for DataDome page-load resolution
    log_progress("importing_camoufox")
    try:
        from camoufox.sync_api import Camoufox as _Camoufox
    except ImportError:
        log_error("camoufox not installed")
        return

    Camoufox = _Camoufox  # type: ignore[assignment]

    # ── Step 0: Solve OctoCaptcha DataDome via sidecar BEFORE launching ──
    # The external solver can pass octocaptcha.com DataDome that Camoufox cannot
    # resolve natively. Solving first lets us match the browser UA to the
    # cookie's UA binding.
    log_progress("step0_solving_octocaptcha_datadome")
    solver_result = solve_datadome_via_solver(args.proxy, timeout_s=90)
    dd_cookie = ""
    solver_ua = ""
    if solver_result.get("success"):
        dd_cookie = solver_result.get("datadome_cookie") or solver_result.get("value") or ""
        solver_ua = solver_result.get("user_agent", "")
        log_progress("step0_solver_success", cookie_len=len(dd_cookie), solver_ua=solver_ua[:60])
    else:
        log_progress("step0_solver_failed", error=solver_result.get("error", "unknown"))

    try:
        log_progress("launching_browser", headless=False, humanize=True, geoip=True, browser="camoufox", virtual_display=":99")
        launch_kwargs: dict = {"headless": False, "humanize": True, "geoip": True, "proxy": proxy, "virtual_display": ":99"}
        with Camoufox(**launch_kwargs) as browser:
            log_progress("browser_launched")

            ctx_kwargs: dict = {}
            context = browser.new_context(**ctx_kwargs)
            # Do NOT clear cookies here — let Camoufox manage its own DataDome
            # cookies naturally. We only add the octocaptcha.com cookie later
            # AFTER github.com DataDome has resolved.
            log_progress("context_created")

            page = context.new_page()
            log_progress("page_created")

            # ── Step 1: Load signup page ──────────────────────────────
            log_progress("step1_navigating", url="https://github.com/signup")
            try:
                page.goto('https://github.com/signup', wait_until='domcontentloaded', timeout=25000)
                try:
                    page.wait_for_load_state('networkidle', timeout=10000)
                except Exception:
                    pass
            except Exception as e:
                log_error("Navigation failed", url="https://github.com/signup", detail=str(e))

            log_progress("step1_loaded", url=page.url, title=page.title())

            # Detect rate-limiting
            try:
                page_title = page.title()
                if "too many requests" in page_title.lower() or "rate limit" in page_title.lower():
                    dump_page_state(page, "rate_limited")
                    take_screenshot(page, "rate_limited")
                    log_error("GitHub rate limit — proxy IP blocked. Wait or try different proxy.",
                              url=page.url, title=page_title)
            except Exception:
                pass

            dump_page_state(page, "after_load")

            # ── Step 1b: Wait for DataDome to resolve (Camoufox auto-resolves) ──
            log_progress("waiting_datadome", max_wait=45, check_interval=3)
            datadome_detected = False

            for i in range(15):
                time.sleep(3)
                try:
                    has_email = page.is_visible('input[name="user[email]"]')
                except Exception:
                    has_email = False

                try:
                    dd_iframe = page.query_selector('iframe[src*="datadome"]')
                    dd_div = page.query_selector('#datadome, div[class*="captcha"]')
                    if dd_iframe or dd_div:
                        datadome_detected = True
                except Exception:
                    pass

                if has_email:
                    log_progress("datadome_resolved", iteration=i + 1, waited_sec=(i + 1) * 3,
                                 datadome_was_detected=datadome_detected)
                    break

                log_progress("datadome_waiting", iteration=i + 1, waited_sec=(i + 1) * 3,
                             email_visible=False, datadome_detected=datadome_detected)
            else:
                dump_page_state(page, "datadome_timeout")
                take_screenshot(page, "datadome_timeout")
                log_error("DataDome captcha not resolved after 45s",
                          datadome_detected=datadome_detected, final_url=page.url)

            # ── Step 2: Fill the form ─────────────────────────────────
            log_progress("step2_form_loaded")
            dump_page_state(page, "form_loaded")

            log_progress("filling_email", value=args.email)
            page.fill('input[name="user[email]"]', args.email)

            log_progress("filling_password")
            page.fill('input[name="user[password]"]', args.password)

            username = args.email.split("@")[0].replace(".", "")
            username = re.sub(r'[^a-zA-Z0-9-]', '', username)[:30]
            import random as _rnd
            username = username + str(_rnd.randint(100, 999))
            log_progress("filling_username", value=username)
            page.fill('input[name="user[login]"]', username)

            # Uncheck checkboxes
            for cb_name in ['user_signup[marketing_consent]', 'user_signup[copilot_opt_in]']:
                cb_sel = f'input[name="{cb_name}"]'
                try:
                    if page.is_checked(cb_sel):
                        page.uncheck(cb_sel)
                        log_progress("unchecked", checkbox=cb_name)
                except Exception:
                    log_progress("checkbox_not_found", checkbox=cb_name)

            time.sleep(1)
            log_progress("form_filled", email=args.email, username=username)

            # ── Step 2b: Inject octocaptcha cookie & wait for token ──
            # NOW inject the solver's DataDome cookie for octocaptcha.com only.
            # This happens AFTER github.com DataDome resolved naturally, so
            # it won't interfere. The iframe picks up the cookie on its domain.
            if dd_cookie:
                try:
                    context.add_cookies([
                        {"name": "datadome", "value": dd_cookie, "domain": ".octocaptcha.com", "path": "/"},
                    ])
                    log_progress("datadome_cookie_injected", cookie_len=len(dd_cookie), domain=".octocaptcha.com")
                except Exception as e:
                    log_progress("datadome_cookie_inject_error", detail=str(e))

            # Reload the octocaptcha iframe so it picks up the fresh cookie
            try:
                frame = page.query_selector('iframe.js-octocaptcha-frame, iframe[src*="octocaptcha"]')
                if frame:
                    src = frame.get_attribute('src') or ""
                    if src:
                        log_progress("octocaptcha_iframe_reloading")
                        page.evaluate(f'''(function() {{
                            var f = document.querySelector("iframe.js-octocaptcha-frame, iframe[src*='octocaptcha']");
                            if (f) {{ f.src = f.src; }}
                        }})()''')
            except Exception as e:
                log_progress("octocaptcha_reload_error", detail=str(e)[:200])

            log_progress("step2b_waiting_token")
            token_ready = False
            for oci in range(10):
                time.sleep(3)
                try:
                    url = page.url
                    if 'verify' in url.lower():
                        log_progress("octocaptcha_redirect", iteration=oci + 1, url=url)
                        token_ready = True
                        break
                except Exception:
                    pass
                try:
                    token_field = page.query_selector('input[name="octocaptcha-token"]')
                    if token_field:
                        token_val = token_field.get_attribute('value') or ''
                        if token_val:
                            log_progress("octocaptcha_token_filled", iteration=oci + 1, token_len=len(token_val))
                            token_ready = True
                            break
                except Exception:
                    pass
                log_progress("octocaptcha_waiting", iteration=oci + 1, waited_sec=(oci + 1) * 3)

            if not token_ready:
                log_progress("octocaptcha_token_not_ready")

            # ── Submit the form ───────────────────────────────────────
            log_progress("step2b_submitting")
            dump_page_state(page, "before_submit")

            # Submit strategy: prefer form.requestSubmit() to bypass button JS-gating.
            # The "Create account" button is often disabled by client-side validation
            # (waiting on timestamp_secret regen, etc.) — ElementHandle.click() then
            # burns 30s of "element is not enabled" retries. requestSubmit() posts
            # the form directly, bypassing the disabled attribute on the trigger.
            submitted_via = None
            try:
                did_submit = page.evaluate('''() => {
                    const form = document.querySelector('form[action*="signup"]')
                              || document.querySelector('form');
                    if (!form) return false;
                    if (typeof form.requestSubmit === 'function') {
                        form.requestSubmit();
                    } else {
                        form.submit();
                    }
                    return true;
                }''')
                if did_submit:
                    submitted_via = "form_requestSubmit"
                    log_progress("submit_clicked", button_type=submitted_via)
            except Exception as e:
                log_progress("form_submit_error", detail=str(e)[:200])

            # Fallback: try the specific "Create account" button, but with a short
            # timeout and force=True so a stale disabled attribute can't stall us.
            if not submitted_via:
                create_btn = page.query_selector('button[type="submit"]:has-text("Create account")')
                btn_type = "button_create_account"
                if not create_btn:
                    create_btn = page.query_selector('input[type="submit"][value*="Create"]')
                    btn_type = "input_create"
                if not create_btn:
                    create_btn = page.query_selector('form[action*="signup"] button[type="submit"]')
                    btn_type = "form_signup_submit"

                if create_btn:
                    log_progress("clicking_submit_fallback", button_type=btn_type)
                    try:
                        create_btn.click(force=True, timeout=5000)
                        submitted_via = btn_type
                        log_progress("submit_clicked", button_type=btn_type)
                    except Exception as e:
                        log_progress("submit_click_failed", button_type=btn_type, detail=str(e)[:200])

            if not submitted_via:
                dump_page_state(page, "no_submit_button")
                take_screenshot(page, "no_submit_button")
                log_error("Could not submit signup form (requestSubmit + button click both failed)")

            # ── Step 3: Wait for octocaptcha iframe & resolve ─────────
            log_progress("step3_octocaptcha_handling")

            octocaptcha_frame = None
            for i in range(10):
                time.sleep(2)
                try:
                    frame = page.query_selector('iframe.js-octocaptcha-frame, iframe[src*="octocaptcha"]')
                    if frame:
                        is_vis = frame.is_visible()
                        log_progress("octocaptcha_iframe_found", iteration=i + 1, visible=is_vis, waited_sec=(i + 1) * 2)
                        if is_vis:
                            octocaptcha_frame = frame
                            break
                    url = page.url
                    if 'verify' in url.lower() or 'account/verify' in url.lower():
                        log_progress("octocaptcha_bypassed", iteration=i + 1, url=url)
                        break
                    token_field = page.query_selector('input[name="octocaptcha-token"]')
                    if token_field:
                        token_val = token_field.get_attribute('value') or ''
                        if token_val:
                            log_progress("octocaptcha_token_auto_filled", iteration=i + 1, token_len=len(token_val))
                            break
                    log_progress("octocaptcha_searching", iteration=i + 1, waited_sec=(i + 1) * 2)
                except Exception as e:
                    log_progress("octocaptcha_search_error", iteration=i + 1, detail=str(e))

            # If iframe found, try to interact with it
            if octocaptcha_frame:
                log_progress("octocaptcha_interacting")
                try:
                    frame_element = octocaptcha_frame.content_frame()
                    if frame_element:
                        log_progress("octocaptcha_frame_accessed", url=frame_element.url[:100])
                        for j in range(15):
                            time.sleep(3)
                            try:
                                frame_url = frame_element.url
                                if 'captcha' not in frame_url.lower() or 'verified' in frame_url.lower():
                                    log_progress("octocaptcha_frame_resolved", iteration=j + 1, url=frame_url[:100])
                                    break
                                dd_inside = frame_element.query_selector('iframe[src*="datadome"], div[class*="captcha"]')
                                if dd_inside:
                                    log_progress("datadome_in_iframe", iteration=j + 1, visible=dd_inside.is_visible())
                                else:
                                    log_progress("octocaptcha_frame_waiting", iteration=j + 1)
                            except Exception as e:
                                log_progress("octocaptcha_frame_error", iteration=j + 1, detail=str(e)[:100])
                                break
                        try:
                            token_field = page.query_selector('input[name="octocaptcha-token"]')
                            if token_field:
                                token_val = token_field.get_attribute('value') or ''
                                if token_val:
                                    log_progress("octocaptcha_token_filled_after_interaction", token_len=len(token_val))
                                else:
                                    log_progress("octocaptcha_token_still_empty")
                        except Exception:
                            pass
                        take_screenshot(page, "octocaptcha_interaction")
                    else:
                        log_progress("octocaptcha_no_content_frame")
                        take_screenshot(page, "octocaptcha_no_frame")
                except Exception as e:
                    log_progress("octocaptcha_interaction_error", detail=str(e)[:200])
                    take_screenshot(page, "octocaptcha_error")
            else:
                log_progress("octocaptcha_no_iframe_found")
                take_screenshot(page, "no_octocaptcha")

            # ── Step 4: Check result & poll IMAP ──────────────────────
            try:
                page.wait_for_load_state('networkidle', timeout=10000)
            except Exception:
                time.sleep(5)

            url = page.url
            try:
                html = page.content()
            except Exception:
                html = ""
            has_verify = 'verify' in url.lower() or 'account/verify' in url.lower()

            has_error = False
            try:
                visible_errors = page.query_selector_all('.flash-error:not([hidden]), .flash-danger:not([hidden]), [role="alert"]:not([hidden])')
                for el in visible_errors:
                    if el.is_visible():
                        has_error = True
                        break
            except Exception:
                pass

            if not has_verify and 'signup' in url.lower():
                try:
                    form_visible = page.is_visible('form[action*="signup"]')
                    if form_visible:
                        has_error = True
                except Exception:
                    has_error = True

            log_progress("step3_checked", url=url, has_verify=has_verify, has_error=has_error)

            if has_error:
                dump_page_state(page, "form_error")
                take_screenshot(page, "form_error")
                error_msg = "Signup form error — form still visible after submit"
                try:
                    flash_el = page.query_selector('.flash-error:not([hidden]), .flash-danger:not([hidden]), [role="alert"]:not([hidden])')
                    if flash_el and flash_el.is_visible():
                        error_msg = flash_el.inner_text().strip()[:300]
                except Exception:
                    pass
                log_error(error_msg, url=url)

            if not has_verify and not has_error:
                if 'signup' in url.lower():
                    dump_page_state(page, "still_on_signup")
                    take_screenshot(page, "still_on_signup")
                    log_error(f"Still on signup page (url: {url})", url=url)
                elif 'sessions/social/google' in url.lower():
                    dump_page_state(page, "google_oauth_redirect")
                    take_screenshot(page, "google_oauth_redirect")
                    log_error(f"GitHub redirected to Google OAuth (url: {url})", url=url)

            log_progress("signup_submitted", url=url)

            # ── Step 5: Poll IMAP for verification code ───────────────
            # 6 attempts × 15s = ~90s window. Gmail forward chain (via cloudflare-
            # email) sometimes takes 30-60s to deliver GitHub launch codes.
            IMAP_MAX_ATTEMPTS = 6
            IMAP_GAP_SEC = 15
            for attempt in range(IMAP_MAX_ATTEMPTS):
                log_progress("polling_imap", attempt=attempt + 1, max_attempts=IMAP_MAX_ATTEMPTS)
                code, err = read_verification_code(
                    args.imap_host, args.imap_port, args.imap_user,
                    args.imap_pass, args.email
                )
                if code:
                    log_progress("code_found", code=code, attempt=attempt + 1)
                    try:
                        log_progress("entering_verification_code", code_len=len(code))

                        # ── OTP entry strategy ──
                        # GitHub's launch-code UI is a custom widget: 8 visual
                        # boxes backed by either (A) 8 chained <input maxlength=1>
                        # or (B) 1 hidden <input maxlength=8> with decorative
                        # overlays. Both patterns respond to plain keystrokes
                        # after focusing the code area. So we do it the
                        # user-natural way: focus the area, then type each digit
                        # one at a time via keyboard events (which the widget
                        # auto-advances internally).
                        filled = False

                        # Try to focus SOMETHING in the code area. Order:
                        # 1) label "Enter code" → its associated input (getByLabel semantics)
                        # 2) first digit-like input
                        # 3) any input under a form on /account_verifications
                        focus_target = None
                        for sel in [
                            'input[aria-label*="of the launch code"]',
                            'input[aria-label*="launch code"]',
                            'input[aria-label^="Digit"]',
                            'input[autocomplete="one-time-code"]',
                            'input[inputmode="numeric"]',
                            'input[maxlength="1"]',
                            'input[maxlength="8"]',
                            'form input[type="text"]',
                            'form input[type="tel"]',
                            'form input:not([type="hidden"])',
                        ]:
                            try:
                                el = page.query_selector(sel)
                                if el:
                                    focus_target = el
                                    log_progress("otp_focus_target_found", selector=sel)
                                    break
                            except Exception:
                                pass

                        if focus_target:
                            try:
                                focus_target.click(timeout=3000)
                            except Exception:
                                try:
                                    focus_target.focus()
                                except Exception:
                                    pass
                            time.sleep(0.3)
                            # Type each digit with a small delay so any per-key
                            # focus-advance JS has time to move focus.
                            for ch in code:
                                page.keyboard.type(ch, delay=50)
                                time.sleep(0.08)
                            filled = True
                            log_progress("otp_typed_via_keyboard", code_len=len(code))
                        else:
                            # Absolute last resort: dump every input so a human
                            # can see what's on the page and log a screenshot.
                            try:
                                probe = page.evaluate('''() => {
                                    const inputs = Array.from(document.querySelectorAll('input'));
                                    return inputs.map(el => ({
                                        type: el.type,
                                        name: el.name,
                                        id: el.id,
                                        aria: el.getAttribute('aria-label'),
                                        ariaLabelledby: el.getAttribute('aria-labelledby'),
                                        autocomplete: el.autocomplete,
                                        inputmode: el.getAttribute('inputmode'),
                                        maxlength: el.getAttribute('maxlength'),
                                        cls: el.className,
                                        visible: el.offsetParent !== null,
                                    }));
                                }''')
                                # Serialize to JSON string so it survives log
                                # transport (Bun flattens dicts to "[object Object]").
                                log_progress("otp_input_probe", inputs_json=json.dumps(probe[:20]))
                            except Exception as pe:
                                log_progress("otp_input_probe_failed", error=str(pe)[:200])

                            # Even without a targeted focus we can try a bare
                            # keyboard.type — the page may already have focus
                            # inside the code widget by default (first box is
                            # normally auto-focused on load).
                            try:
                                for ch in code:
                                    page.keyboard.type(ch, delay=50)
                                    time.sleep(0.08)
                                filled = True
                                log_progress("otp_typed_blind", code_len=len(code))
                            except Exception as e:
                                log_progress("otp_type_error", detail=str(e)[:200])

                        if filled:
                            # Trigger 'input' + 'change' events on every code
                            # input to force any React/JS controller to
                            # register the values (needed for the widget's
                            # internal token to sync, otherwise Continue stays
                            # disabled even though all 8 boxes show digits).
                            try:
                                page.evaluate('''() => {
                                    const inputs = document.querySelectorAll(
                                        'input[maxlength="1"], input[aria-label*="launch code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]'
                                    );
                                    inputs.forEach(el => {
                                        el.dispatchEvent(new Event('input',  {bubbles:true}));
                                        el.dispatchEvent(new Event('change', {bubbles:true}));
                                    });
                                }''')
                                log_progress("otp_events_dispatched")
                            except Exception as e:
                                log_progress("otp_events_error", detail=str(e)[:200])

                            # Wait for the Continue button to become enabled
                            # (max 5s). If it never enables, we'll still try
                            # form.requestSubmit() as a last resort.
                            continue_btn_enabled = False
                            for wi in range(10):
                                try:
                                    is_enabled = page.evaluate('''() => {
                                        const btns = Array.from(document.querySelectorAll('button[type="submit"], button'));
                                        const cont = btns.find(b => (b.textContent || '').trim().toLowerCase().startsWith('continue'));
                                        if (!cont) return null;
                                        return !cont.disabled && cont.getAttribute('aria-disabled') !== 'true';
                                    }''')
                                    if is_enabled is True:
                                        continue_btn_enabled = True
                                        log_progress("continue_btn_enabled", waited_ms=wi * 500)
                                        break
                                except Exception:
                                    pass
                                time.sleep(0.5)

                            # Submit: prefer clicking the (now-enabled) Continue
                            # button — that's the path the widget's own JS
                            # expects. Fall back to form.requestSubmit().
                            submitted = False
                            if continue_btn_enabled:
                                try:
                                    btn = page.query_selector('button[type="submit"]:has-text("Continue")') \
                                          or page.query_selector('button:has-text("Continue")')
                                    if btn:
                                        btn.click(timeout=5000)
                                        submitted = True
                                        log_progress("continue_clicked")
                                except Exception as e:
                                    log_progress("continue_click_error", detail=str(e)[:200])

                            if not submitted:
                                try:
                                    submitted = bool(page.evaluate('''() => {
                                        const form = document.querySelector('form[action*="verification"]')
                                                  || document.querySelector('form[action*="verify"]')
                                                  || document.querySelector('form');
                                        if (!form) return false;
                                        if (typeof form.requestSubmit === 'function') form.requestSubmit();
                                        else form.submit();
                                        return true;
                                    }'''))
                                    if submitted:
                                        log_progress("verify_form_requestSubmit_fallback")
                                except Exception as e:
                                    log_progress("verify_form_submit_error", detail=str(e)[:200])

                            if not submitted:
                                try:
                                    btn = page.query_selector('button[type="submit"]') \
                                          or page.query_selector('button:has-text("Continue")')
                                    if btn:
                                        btn.click(force=True, timeout=5000)
                                        submitted = True
                                except Exception as e:
                                    log_progress("verify_click_error", detail=str(e)[:200])

                            log_progress("code_submitted",
                                         submitted=submitted,
                                         via_continue=continue_btn_enabled)

                            # After clicking Continue, GitHub can take several
                            # seconds to process the code + redirect. Watch for
                            # a URL change explicitly (up to 15s) instead of
                            # relying on networkidle which returns instantly
                            # when the widget just does a fetch/XHR.
                            initial_url = page.url
                            for wi in range(30):  # 30 × 0.5s = 15s
                                time.sleep(0.5)
                                cur_url = page.url
                                if cur_url != initial_url:
                                    log_progress("verify_url_changed",
                                                 from_url=initial_url,
                                                 to_url=cur_url,
                                                 waited_ms=(wi + 1) * 500)
                                    break
                                # Also break early if an error message appeared
                                try:
                                    err_txt = page.evaluate('''() => {
                                        const el = document.querySelector('.flash-error, [role="alert"], .error, .octocaptcha-error');
                                        return el && el.offsetParent !== null ? el.innerText.trim().slice(0, 200) : null;
                                    }''')
                                    if err_txt:
                                        log_progress("verify_error_appeared",
                                                     text=err_txt,
                                                     waited_ms=(wi + 1) * 500)
                                        break
                                except Exception:
                                    pass
                            try:
                                page.wait_for_load_state('networkidle', timeout=5000)
                            except Exception:
                                pass
                            url2 = page.url
                            take_screenshot(page, "after_verify_submit")
                            log_progress("verification_complete", url=url2)
                            # Consider it verified only if we left the verification page
                            is_verified = ('account_verifications' not in url2.lower()
                                           and 'verify' not in url2.lower())
                            print(json.dumps({
                                "success": True,
                                "status": "verified" if is_verified else "registered",
                                "code": code,
                                "url": url2,
                                **({"note": "code submitted but still on verify page"} if not is_verified else {}),
                            }))
                        else:
                            dump_page_state(page, "no_code_input")
                            take_screenshot(page, "no_code_input")
                            print(json.dumps({"success": True, "status": "registered", "code": code, "note": "could not auto-verify on page"}))
                    except Exception as e:
                        print(json.dumps({"success": True, "status": "registered", "code": code, "note": f"verify error: {e}"}))
                    sys.exit(0)

                log_progress("imap_no_code", attempt=attempt + 1, error=err)
                if attempt < IMAP_MAX_ATTEMPTS - 1:
                    time.sleep(IMAP_GAP_SEC)

            dump_page_state(page, "no_code_final")
            take_screenshot(page, "no_code_final")
            log_error(f"No verification code found in IMAP after {IMAP_MAX_ATTEMPTS} attempts")

    except Exception as e:
        log_progress("exception", error=str(e), error_type=type(e).__name__)
        print(json.dumps({"success": False, "status": "error", "error": str(e)}))
        sys.exit(0)


if __name__ == "__main__":
    main()
