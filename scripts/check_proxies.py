#!/usr/bin/env python3
"""Check proxy pool readiness for GitHub signup (DataDome).

Three-layer check per proxy:
  1. HTTP connectivity   — can we reach the proxy? (HTTP 200/407, NOT 503/000)
  2. Exit IP ASN         — is the exit IP residential/mobile, not datacenter?
  3. DataDome GitHub     — does github.com/signup return 200 (form) not 403?

A proxy is "GitHub-ready" only if ALL three pass. Datacenter IPs (e.g. VPS,
Cloud Host Pte Ltd, Alibaba, Oracle) are hard-blocked by DataDome regardless
of connectivity.

Usage:
  python3 check_proxies.py                 # scan all 'active' proxies in DB
  python3 check_proxies.py 133 134         # scan specific proxy IDs
  python3 check_proxies.py --json          # machine-readable output
"""

import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "poolprox3.db")
DB_PATH = os.path.abspath(DB_PATH)

HTTPBIN = "https://httpbin.org/ip"
IPINFO = "https://ipinfo.io/json"
GITHUB = "https://github.com/signup"

# ASN org substrings that indicate a DATACENTER (DataDome hard-block).
# Residential/mobile providers are NOT in this list.
DATACENTER_HINTS = [
    "cloud host", "cloudflare", "alibaba", "oracle", "amazon", "aws",
    "microsoft", "azure", "google cloud", "digitalocean", "linode",
    "vultr", "hetzner", "ovh", "scaleway", "hostinger", "dreamhost",
    "contabo", "ionos", "rackspace", "server", "datacenter", "colo",
    "web host", "hosting", "idc", "cloud", "vps",
]


def get_proxy_urls(ids=None):
    """Read proxy_pool table from SQLite DB."""
    if not os.path.exists(DB_PATH):
        print(f"DB not found: {DB_PATH}", file=sys.stderr)
        return {}
    con = sqlite3.connect(DB_PATH)
    try:
        cur = con.cursor()
        if ids:
            ph = ",".join("?" * len(ids))
            cur.execute(f"SELECT id, url, label FROM proxy_pool WHERE id IN ({ph})", ids)
        else:
            cur.execute("SELECT id, url, label FROM proxy_pool WHERE status='active'")
        return {row[0]: {"url": row[1], "label": row[2]} for row in cur.fetchall()}
    finally:
        con.close()


def fetch_via_proxy(proxy_url, url, timeout=12):
    """GET url through the proxy. Returns (http_status, body) or (0, '')."""
    try:
        handler = urllib.request.ProxyHandler({
            "http": proxy_url, "https": proxy_url,
        })
        opener = urllib.request.build_opener(handler)
        opener.addheaders = [("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")]
        req = urllib.request.Request(url)
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception:
        return 0, ""


def check_proxy(proxy_url, timeout=12):
    """Run all three checks. Returns dict."""
    result = {"connectivity": False, "exit_ip": None, "is_datacenter": None,
              "github_status": None, "ready": False, "reasons": []}

    # 1. Connectivity via httpbin
    status, body = fetch_via_proxy(proxy_url, HTTPBIN, timeout)
    result["connectivity"] = status == 200
    if not result["connectivity"]:
        result["reasons"].append(f"connect: HTTP {status} (want 200)")
        return result

    # 2. Exit IP + ASN
    try:
        info = json.loads(body)
        result["exit_ip"] = info.get("ip")
        org = (info.get("org") or "").lower()
        result["is_datacenter"] = any(h in org for h in DATACENTER_HINTS)
        if result["is_datacenter"]:
            result["reasons"].append(f"datacenter ASN: {info.get('org')}")
    except Exception:
        result["is_datacenter"] = None
        result["reasons"].append("could not parse exit IP/ASN")

    # 3. DataDome GitHub gate
    gh_status, _ = fetch_via_proxy(proxy_url, GITHUB, timeout)
    result["github_status"] = gh_status
    if gh_status != 200:
        result["reasons"].append(f"github: HTTP {gh_status} (want 200, 403=DataDome block)")

    result["ready"] = (
        result["connectivity"]
        and result["is_datacenter"] is False
        and result["github_status"] == 200
    )
    return result


def main():
    ids = None
    json_out = "--json" in sys.argv
    if "--json" in sys.argv:
        sys.argv.remove("--json")
    if len(sys.argv) > 1:
        try:
            ids = [int(x) for x in sys.argv[1:]]
        except ValueError:
            print("Usage: check_proxies.py [id ...] [--json]", file=sys.stderr)
            return 1

    proxies = get_proxy_urls(ids)
    if not proxies:
        print("No proxies found.", file=sys.stderr)
        return 1

    results = []
    for pid, info in proxies.items():
        r = check_proxy(info["url"])
        results.append({"id": pid, "label": info["label"], **r})

    if json_out:
        print(json.dumps(results, indent=2))
        return 0

    print(f"\nProxy pool check ({len(results)} proxies) — GitHub signup readiness\n")
    print(f"{'ID':<5} {'Ready':<6} {'Connect':<8} {'DC?':<5} {'GitHub':<7} {'Exit IP':<16} Label")
    print("-" * 80)
    for r in sorted(results, key=lambda x: not x["ready"]):
        dc = "YES" if r["is_datacenter"] else ("no" if r["is_datacenter"] is False else "?")
        gh = r["github_status"] or "timeout"
        print(f"{r['id']:<5} {'✅' if r['ready'] else '❌':<6} "
              f"{'OK' if r['connectivity'] else 'FAIL':<8} {dc:<5} {gh:<7} "
              f"{(r['exit_ip'] or '-'):<16} {r['label']}")
        for reason in r["reasons"]:
            print(f"        └ {reason}")

    ready_count = sum(1 for r in results if r["ready"])
    print(f"\n{ready_count}/{len(results)} proxies GitHub-ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
