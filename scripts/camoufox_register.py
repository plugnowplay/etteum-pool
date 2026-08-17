#!/usr/bin/env python3
"""
Camoufox-based GitHub account registration.
Called by etteum-pool backend to bypass DataDome captcha.

Usage:
  python3 camoufox_register.py --email EMAIL --password PASS --proxy PROXY_URL --imap-host HOST --imap-port PORT --imap-user USER --imap-pass PASS --domain DOMAIN

Outputs JSON to stdout:
  {"success": true, "status": "verified", "code": "123456"}
  {"success": false, "status": "error", "error": "..."}
"""
import argparse
import json
import sys
import time
import re
import imaplib
import email as emailmod
from datetime import datetime, timedelta

def read_verification_code(imap_host, imap_port, imap_user, imap_pass, target_email, since_minutes=10):
    """Poll IMAP for GitHub verification email."""
    try:
        mail = imaplib.IMAP4_SSL(imap_host, imap_port)
        mail.login(imap_user, imap_pass)
        mail.select("INBOX")

        since = (datetime.now() - timedelta(minutes=since_minutes)).strftime("%d-%b-%Y")
        # Search for recent emails
        status, data = mail.search(None, f'(SINCE {since})')
        if status != "OK":
            mail.logout()
            return None, "IMAP search failed"

        ids = data[0].split()
        # Check last 20 emails
        for eid in reversed(ids[-20:]):
            status, msg_data = mail.fetch(eid, "(RFC822)")
            if status != "OK":
                continue
            raw = msg_data[0][1]
            msg = emailmod.message_from_bytes(raw)

            from_addr = msg.get("From", "").lower()
            to_addr = msg.get("To", "").lower()
            subject = msg.get("Subject", "")

            # Check if from GitHub and to our target email
            if "github.com" not in from_addr:
                continue
            if target_email.lower() not in to_addr and target_email.lower() not in msg.get("Delivered-To", "").lower():
                continue

            # Parse body
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

            # Extract verification code — GitHub uses [AUTH-XXXXXX] or 6-digit code
            code_match = re.search(r'\[AUTH-(\d+)\]', body) or \
                         re.search(r'verification code[:\s]*(\d{6})', body, re.I) or \
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
    parser.add_argument("--proxy", required=True, help="Full proxy URL with credentials")
    parser.add_argument("--imap-host", required=True)
    parser.add_argument("--imap-port", type=int, default=993)
    parser.add_argument("--imap-user", required=True)
    parser.add_argument("--imap-pass", required=True)
    parser.add_argument("--domain", required=True)
    args = parser.parse_args()

    # Parse proxy URL: http://user:pass@host:port
    proxy_match = re.match(r'https?://([^:]+):([^@]+)@([^:]+):(\d+)', args.proxy)
    if proxy_match:
        proxy = {
            'server': f'http://{proxy_match.group(3)}:{proxy_match.group(4)}',
            'username': proxy_match.group(1),
            'password': proxy_match.group(2),
        }
    else:
        proxy = {'server': args.proxy}

    try:
        from camoufox.sync_api import Camoufox
    except ImportError:
        print(json.dumps({"success": False, "status": "error", "error": "camoufox not installed"}))
        sys.exit(1)

    try:
        with Camoufox(headless=True, humanize=True, geoip=True, proxy=proxy) as browser:
            page = browser.new_page()

            # Step 1: Load signup page
            print(json.dumps({"progress": "loading_signup_page"}), file=sys.stderr)
            page.goto('https://github.com/signup', wait_until='domcontentloaded', timeout=20000)

            # Wait for DataDome to resolve (up to 30s)
            for i in range(10):
                time.sleep(3)
                has_email = page.is_visible('input[name="user[email]"]')
                if has_email:
                    break
            else:
                print(json.dumps({"success": False, "status": "error", "error": "DataDome captcha not resolved after 30s"}))
                sys.exit(0)

            print(json.dumps({"progress": "signup_form_loaded"}), file=sys.stderr)

            # Step 2: Fill the form (email, password, username)
            page.fill('input[name="user[email]"]', args.email)
            page.fill('input[name="user[password]"]', args.password)

            # GitHub requires a username field (user[login]) — derive from email local part
            username = args.email.split("@")[0].replace(".", "")
            # GitHub username rules: alphanumeric + hyphen, max 39 chars
            username = re.sub(r'[^a-zA-Z0-9-]', '', username)[:39]
            page.fill('input[name="user[login]"]', username)

            # Uncheck marketing/copilot consent checkboxes if present
            for cb in ['input[name="user_signup[marketing_consent]"]', 'input[name="user_signup[copilot_opt_in]"]']:
                try:
                    if page.is_checked(cb):
                        page.uncheck(cb)
                except Exception:
                    pass

            time.sleep(1)

            # Submit — click the "Create account" button specifically,
            # NOT a generic button[type=submit] which matches "Continue with Google"
            print(json.dumps({"progress": "submitting_form"}), file=sys.stderr)
            create_btn = page.query_selector('button[type="submit"]:has-text("Create account")')
            if not create_btn:
                create_btn = page.query_selector('input[type="submit"][value*="Create"]')
            if not create_btn:
                # Fallback: the form's primary submit
                create_btn = page.query_selector('form[action*="signup"] button[type="submit"]')

            if create_btn:
                create_btn.click()
            else:
                print(json.dumps({"success": False, "status": "error", "error": "Could not find Create account button"}))
                sys.exit(0)

            # Wait for redirect or error
            time.sleep(6)

            url = page.url
            html = page.content()
            has_verify = 'verify' in url.lower() or 'account' in url.lower()
            has_error = 'flash-error' in html or 'is-error' in html

            if has_error:
                error_match = re.search(r'class="[^"]*flash[^"]*"[^>]*>([^<]+)', html)
                error_msg = error_match.group(1).strip() if error_match else "Signup form error"
                print(json.dumps({"success": False, "status": "error", "error": error_msg}))
                sys.exit(0)

            if not has_verify:
                # Check if we're still on signup page
                if 'signup' in url.lower():
                    print(json.dumps({"success": False, "status": "error", "error": f"Still on signup page (url: {url})"}))
                    sys.exit(0)

            print(json.dumps({"progress": "signup_submitted", "url": url}), file=sys.stderr)

            # Step 3: Poll IMAP for verification code
            for attempt in range(3):
                print(json.dumps({"progress": f"polling_imap_attempt_{attempt+1}"}), file=sys.stderr)
                code, err = read_verification_code(
                    args.imap_host, args.imap_port, args.imap_user,
                    args.imap_pass, args.email
                )
                if code:
                    print(json.dumps({"progress": "code_found", "code": code}), file=sys.stderr)

                    # Step 4: Enter verification code on GitHub
                    try:
                        # Look for verification code input
                        code_input = page.query_selector('input[name="user[verification_code]"]') or \
                                     page.query_selector('input[type="text"]')
                        if code_input:
                            code_input.fill(code)
                            page.click('button[type="submit"]')
                            time.sleep(3)
                            url2 = page.url
                            print(json.dumps({"success": True, "status": "verified", "code": code, "url": url2}))
                        else:
                            # Can't find input — but code was received
                            print(json.dumps({"success": True, "status": "registered", "code": code, "note": "could not auto-verify on page"}))
                    except Exception as e:
                        print(json.dumps({"success": True, "status": "registered", "code": code, "note": f"verify error: {e}"}))
                    sys.exit(0)

                time.sleep(15)

            # No code found
            print(json.dumps({"success": False, "status": "error", "error": "No verification code found in IMAP after 3 attempts"}))

    except Exception as e:
        print(json.dumps({"success": False, "status": "error", "error": str(e)}))
        sys.exit(0)


if __name__ == "__main__":
    main()
