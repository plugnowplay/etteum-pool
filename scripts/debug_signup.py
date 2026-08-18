#!/usr/bin/env python3
"""Debug: test GitHub signup WITHOUT reload — submit directly after datadome resolves."""
from camoufox.sync_api import Camoufox
import time, re, sys

proxy = {'server': 'http://resi.visionyx.web.id:10200', 'username': '8b8ccac4740d6448265f__resi.sg', 'password': '7cf5f6ff698b8f66'}

print("Launching Camoufox...", flush=True)
with Camoufox(headless=True, humanize=True, geoip=True, proxy=proxy) as browser:
    context = browser.new_context()
    context.clear_cookies()
    page = context.new_page()

    print("Navigating to github.com/signup...", flush=True)
    page.goto('https://github.com/signup', wait_until='domcontentloaded', timeout=30000)
    print(f"Loaded: title={page.title()}", flush=True)

    # Wait for datadome
    print("Waiting for datadome to resolve...", flush=True)
    for i in range(15):
        time.sleep(3)
        if page.is_visible('input[name="user[email]"]'):
            print(f"Form visible after {(i+1)*3}s", flush=True)
            break
    else:
        print("Form NOT visible after 45s — datadome timeout", flush=True)
        sys.exit(1)

    # Get hidden inputs
    hidden = page.query_selector_all('input[type="hidden"]')
    print(f"\nHidden inputs: {len(hidden)}", flush=True)
    for el in hidden:
        name = el.get_attribute('name') or '?'
        val = (el.get_attribute('value') or '')[:60]
        print(f"  {name} = {val}", flush=True)

    # Get form info
    form = page.query_selector('form[action*="signup"]')
    if form:
        print(f"\nForm: action={form.get_attribute('action')} method={form.get_attribute('method')}", flush=True)

    # Fill form — NO RELOAD
    print("\nFilling form (NO reload)...", flush=True)
    page.fill('input[name="user[email]"]', 'deborah.khan982@mcoreconnect.com')
    page.fill('input[name="user[password]"]', 'TestPass123!')
    page.fill('input[name="user[login]"]', 'deborahkhan982999')
    time.sleep(1)

    # Check flash state BEFORE submit
    html_before = page.content()
    has_flash_before = 'another tab' in html_before.lower()
    print(f"Flash 'another tab' before submit: {has_flash_before}", flush=True)

    # Submit
    print("Clicking submit...", flush=True)
    btn = page.query_selector('button[type="submit"]:has-text("Create account")')
    if not btn:
        btn = page.query_selector('form[action*="signup"] button[type="submit"]')
    if btn:
        btn.click()
        print("Submit clicked, waiting 8s...", flush=True)
        time.sleep(8)

        url_after = page.url
        title_after = page.title()
        print(f"\nAfter submit:", flush=True)
        print(f"  URL: {url_after}", flush=True)
        print(f"  Title: {title_after}", flush=True)

        html_after = page.content()
        if 'another tab' in html_after.lower():
            idx = html_after.lower().index('another tab')
            ctx = html_after[max(0,idx-300):idx+200]
            print(f"\n  FOUND 'another tab' in HTML at pos {idx}", flush=True)
            print(f"  Context: {ctx[:400]}", flush=True)
        elif 'flash-error' in html_after or 'is-error' in html_after:
            print("  Flash error found", flush=True)
            flash_els = page.query_selector_all('.flash-error, .is-error')
            for el in flash_els:
                txt = el.inner_text().strip()[:200]
                print(f"  Flash: {txt}", flush=True)
        else:
            print("  No flash error found", flush=True)
            if 'verify' in url_after.lower():
                print("  >>> SUCCESS: redirected to verify page!", flush=True)
            else:
                try:
                    body = page.inner_text('body')[:500]
                    print(f"  Body: {body}", flush=True)
                except:
                    pass

        # Screenshot
        page.screenshot(path="/tmp/debug_no_reload.png", full_page=True)
        print("Screenshot: /tmp/debug_no_reload.png", flush=True)
    else:
        print("No submit button found", flush=True)
        page.screenshot(path="/tmp/debug_no_button.png", full_page=True)

print("\nDONE", flush=True)
