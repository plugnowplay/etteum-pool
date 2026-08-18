#!/usr/bin/env python3
"""Debug: find where 'another tab' text lives in GitHub signup page.
Uses proxy 133 (mobile) which is known to pass DataDome."""
from camoufox.sync_api import Camoufox
import time, re, json, sys

proxy = {'server': 'http://rotate.visionyx.web.id:10000', 'username': 'b6548b714474b99d85d3__mobile.sg', 'password': '2ff4882436ed229f'}

print("Launching with proxy 133 (mobile)...", flush=True)
with Camoufox(headless=False, humanize=True, geoip=True, proxy=proxy) as browser:
    context = browser.new_context()
    context.clear_cookies()
    page = context.new_page()
    page.goto('https://github.com/signup', wait_until='domcontentloaded', timeout=30000)
    print(f"Loaded: {page.title()}", flush=True)

    for i in range(15):
        time.sleep(3)
        try:
            if page.is_visible('input[name="user[email]"]'):
                print(f"Form visible after {(i+1)*3}s", flush=True)
                break
        except:
            pass
    else:
        print("Form NOT visible — datadome timeout", flush=True)
        page.screenshot(path="/tmp/debug_flash_timeout.png")
        sys.exit(1)

    html = page.content()
    print(f"HTML length: {len(html)}", flush=True)

    # Use JS to find all text nodes containing 'another tab'
    result = page.evaluate('''() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        const texts = [];
        let node;
        while (node = walker.nextNode()) {
            const t = node.textContent.toLowerCase();
            if (t.includes('another tab') || t.includes('reload to refresh') || t.includes('signed in with')) {
                const parent = node.parentElement;
                texts.push({
                    text: node.textContent.trim().slice(0, 200),
                    parentTag: parent ? parent.tagName : 'none',
                    parentClass: parent ? parent.className : 'none',
                    parentVisible: parent ? parent.offsetParent !== null : false,
                    parentHTML: parent ? parent.outerHTML.slice(0, 400) : '',
                    grandparentTag: parent && parent.parentElement ? parent.parentElement.tagName : 'none',
                    grandparentClass: parent && parent.parentElement ? parent.parentElement.className : 'none',
                });
            }
        }
        return texts;
    }''')

    print(f"\nText nodes found: {len(result)}", flush=True)
    for i, t in enumerate(result):
        print(f"\n--- [{i}] ---", flush=True)
        print(json.dumps(t, indent=2)[:800], flush=True)

    # Check if it's in a <template> or <noscript>
    templates = page.query_selector_all('template, noscript')
    for j, tpl in enumerate(templates):
        content = tpl.inner_html()[:500]
        if 'another tab' in content.lower() or 'reload' in content.lower():
            print(f"\nFOUND in template/noscript [{j}]: {content[:300]}", flush=True)

    # Check turbo-frame / include-fragment
    for sel in ['turbo-frame', 'include-fragment', '[data-src]', '[data-url]']:
        els = page.query_selector_all(sel)
        for el in els:
            outer = el.evaluate('e => e.outerHTML')[:400]
            if 'another tab' in outer.lower() or 'reload' in outer.lower():
                print(f"\nFOUND in {sel}: {outer}", flush=True)

    print("\nDONE", flush=True)
