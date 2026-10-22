#!/usr/bin/env python3
"""Share an opencode session on an opencode-share server.

opencode >= 1.19 dropped built-in sharing, so this script exports a session
with `opencode export` and uploads it through the share API.

Usage:
  share-session.py                   share the latest session of the current project
  share-session.py SESSION_ID        share a specific session
  share-session.py --file x.json     share a file written by `opencode export`
  share-session.py SESSION_ID --delete

Running it again for the same session updates the existing share. Share
secrets are kept in ~/.local/share/opencode-share/shares.json.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_SERVER = os.environ.get("OPENCODE_SHARE_URL", "http://localhost:3006")
STATE_FILE = Path.home() / ".local/share/opencode-share/shares.json"
# axum rejects JSON bodies over 2 MB, so sync in smaller batches
MAX_BATCH_BYTES = 1_500_000

REDACTED = "[REDACTED]"
# Common credential formats. When a pattern has a `secret` group, only that part is replaced.
SECRET_PATTERNS = {
    "private key": r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
    "AWS key": r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
    "GitHub token": r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b",
    "GitLab token": r"\bglpat-[A-Za-z0-9_-]{20,}",
    "OpenAI/Anthropic key": r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}",
    "Slack token": r"\bxox[abposr]-[A-Za-z0-9-]{10,}",
    "Google API key": r"\bAIza[0-9A-Za-z_-]{35}",
    "JWT": r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
    "bearer token": r"(?i)\bBearer\s+(?P<secret>[A-Za-z0-9._~+/-]{16,}=*)",
    "URL password": r"\b[a-z][a-z0-9+.-]*://[^/\s:@]+:(?P<secret>[^@\s/]+)@",
    # API_KEY=..., export GITHUB_TOKEN=... (env files, shell)
    "env assignment": r"\b[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*\s*=\s*[\"']?(?P<secret>[^\s\"']{4,})",
    # "password": "...", token: '...' (JSON, YAML, code)
    "quoted assignment": r"(?i)[\w.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[\w.-]*[\"']?\s*[:=]\s*[\"'](?P<secret>[^\"'\s]{4,})[\"']",
}


def env_flag(name, default):
    value = os.environ.get(name, "").strip().lower()
    if value in ("1", "true", "yes", "on"):
        return True
    if value in ("0", "false", "no", "off"):
        return False
    return default


class Redactor:
    """Removes secrets and the home directory path from all strings in an export."""

    def __init__(self, redact_secrets, hide_home, extra_patterns):
        self.patterns = []
        if redact_secrets:
            self.patterns = [(name, re.compile(p)) for name, p in SECRET_PATTERNS.items()]
        for pattern in extra_patterns:
            try:
                self.patterns.append((f"custom: {pattern}", re.compile(pattern)))
            except re.error as e:
                sys.exit(f"Invalid --redact-pattern {pattern!r}: {e}")
        home = str(Path.home())
        self.home = re.compile(re.escape(home) + r"(?![\w.-])") if hide_home else None
        self.counts = {}

    def _count(self, name):
        self.counts[name] = self.counts.get(name, 0) + 1

    def _replace_home(self, match):
        self._count("home directory")
        return "~"

    def _replace(self, name, match):
        has_secret_group = "secret" in match.re.groupindex and match.group("secret") is not None
        # Already redacted by an earlier, more specific pattern
        if has_secret_group and match.group("secret").startswith(REDACTED):
            return match.group(0)
        self._count(name)
        if has_secret_group:
            start, end = match.span("secret")
            text = match.group(0)
            offset = match.start()
            return text[: start - offset] + REDACTED + text[end - offset :]
        return REDACTED

    def text(self, value):
        for name, pattern in self.patterns:
            value = pattern.sub(lambda m, name=name: self._replace(name, m), value)
        if self.home:
            value = self.home.sub(self._replace_home, value)
        return value

    def apply(self, value):
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.apply(item) for item in value]
        if isinstance(value, dict):
            return {key: self.apply(item) for key, item in value.items()}
        return value

    def summary(self):
        if not self.counts:
            return "Nothing redacted"
        return "Redacted: " + ", ".join(f"{name} ×{count}" for name, count in sorted(self.counts.items()))


def latest_session_id():
    # `opencode export` without an ID opens an interactive picker, so look the ID up first
    result = subprocess.run(
        ["opencode", "session", "list", "--pure", "--format", "json", "--max-count", "1"],
        stdin=subprocess.DEVNULL, capture_output=True, text=True,
    )
    if result.returncode != 0:
        sys.exit(f"opencode session list failed:\n{result.stderr.strip()}")
    sessions = json.loads(result.stdout or "[]")
    if not sessions:
        sys.exit("No opencode session found for this directory. Pass a SESSION_ID.")
    return sessions[0]["id"]


def export_session(session_id):
    cmd = ["opencode", "export", "--pure", session_id]
    # opencode truncates large exports written to a pipe, so write to a file
    with tempfile.TemporaryFile(mode="w+") as out:
        result = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.PIPE, text=True)
        out.seek(0)
        output = out.read()
    if result.returncode != 0 or not output.strip():
        sys.exit(f"opencode export failed:\n{result.stderr.strip()}")
    return json.loads(output)


def to_share_items(export, author):
    items = [
        {"_key": "session", "type": "session", "data": export["info"]},
        # Always sent, so running without --author removes a previously set name
        {"_key": "share_meta", "type": "share_meta", "data": {"author": author}},
    ]
    for message in export["messages"]:
        info = message["info"]
        items.append({"_key": f"message/{info['id']}", "type": "message", "data": info})
        for part in message["parts"]:
            items.append({"_key": f"part/{part['id']}", "type": "part", "data": part})
    return items


def batches(items):
    batch, size = [], 0
    for item in items:
        item_size = len(json.dumps(item))
        if batch and size + item_size > MAX_BATCH_BYTES:
            yield batch
            batch, size = [], 0
        batch.append(item)
        size += item_size
    if batch:
        yield batch


class ShareMissing(Exception):
    """The share no longer exists on the server: deleted on the share page or expired."""


def request(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise ShareMissing(url) from None
        sys.exit(f"{method} {url} failed: HTTP {e.code}")
    except urllib.error.URLError as e:
        sys.exit(f"Cannot reach {url}: {e.reason}")


def share_exists(server, share_id):
    """True or False, or None when the server can't be asked."""
    try:
        with urllib.request.urlopen(f"{server}/share/{share_id}"):
            return True
    except urllib.error.HTTPError as e:
        return False if e.code == 404 else None
    except urllib.error.URLError:
        return None


def share_links(server, share):
    url = f"{server}/share/{share['id']}"
    # The fragment is never sent to the server; the page reads it and shows a Delete button
    return url, f"{url}#manage={share['secret']}"


def list_shares(state, server):
    shares = [share for key, share in state.items() if key.startswith(f"{server}|")]
    if not shares:
        print(f"No shares on {server}")
        return
    for share in shares:
        url, manage_url = share_links(server, share)
        print(share.get("title") or share["id"])
        exists = share_exists(server, share["id"])
        if exists is False:
            print("  Deleted or expired on the server. Share the session again to recreate it.")
        else:
            print(f"  Link:        {url}")
            print(f"  Manage link: {manage_url}")
        print()


def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except FileNotFoundError:
        return {}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))
    STATE_FILE.chmod(0o600)


def main():
    parser = argparse.ArgumentParser(description="Share an opencode session on an opencode-share server.")
    parser.add_argument("session_id", nargs="?", help="session ID (default: latest session of the current project)")
    parser.add_argument("--file", help="use a JSON file from `opencode export` instead of running it")
    parser.add_argument("--server", default=DEFAULT_SERVER, help=f"share server URL (default: {DEFAULT_SERVER})")
    parser.add_argument("--delete", action="store_true", help="remove the share for SESSION_ID")
    parser.add_argument("--list", action="store_true", help="list your shares on the server with their links")
    parser.add_argument("--no-redact", dest="redact", action="store_false",
                        default=env_flag("OPENCODE_SHARE_REDACT", True),
                        help="do not redact secrets such as API keys and passwords (env: OPENCODE_SHARE_REDACT=0)")
    parser.add_argument("--keep-home", dest="hide_home", action="store_false",
                        default=env_flag("OPENCODE_SHARE_HIDE_HOME", True),
                        help="keep the home directory path instead of replacing it with ~ (env: OPENCODE_SHARE_HIDE_HOME=0)")
    parser.add_argument("--redact-pattern", action="append", metavar="REGEX",
                        default=[p for p in os.environ.get("OPENCODE_SHARE_REDACT_PATTERNS", "").splitlines() if p.strip()],
                        help="additional regex to redact, repeatable (env: OPENCODE_SHARE_REDACT_PATTERNS, one per line)")
    parser.add_argument("--dry-run", action="store_true", help="show what would be redacted without uploading")
    parser.add_argument("--output", metavar="FILE", help="with --dry-run: write the cleaned share data to FILE")
    parser.add_argument("--author", metavar="NAME", default=os.environ.get("OPENCODE_SHARE_AUTHOR"),
                        help="name shown as \"Shared by NAME\" on the share page (env: OPENCODE_SHARE_AUTHOR)")
    args = parser.parse_args()

    server = args.server.rstrip("/")
    state = load_state()

    if args.list:
        list_shares(state, server)
        return

    if args.delete:
        if not args.session_id:
            parser.error("--delete needs a SESSION_ID")
        key = f"{server}|{args.session_id}"
        share = state.get(key)
        if not share:
            sys.exit(f"No saved secret for {args.session_id} on {server}")
        try:
            request("DELETE", f"{server}/api/share/{share['id']}", {"secret": share["secret"]})
            print(f"Share removed: {share['id']}")
        except ShareMissing:
            print(f"Share {share['id']} was already deleted or has expired")
        del state[key]
        save_state(state)
        return

    if args.file:
        export = json.loads(Path(args.file).read_text())
    else:
        export = export_session(args.session_id or latest_session_id())

    session_id = export["info"]["id"]
    redactor = Redactor(args.redact, args.hide_home, args.redact_pattern)
    author = (args.author or "").strip()[:100] or None
    items = redactor.apply(to_share_items(export, author))

    if args.dry_run:
        print(f"Dry run for \"{export['info'].get('title', session_id)}\" ({len(items)} items), nothing uploaded")
        print(redactor.summary())
        if args.output:
            Path(args.output).write_text(json.dumps(items, indent=2))
            print(f"Cleaned data written to {args.output}")
        return

    title = export["info"].get("title") or session_id
    key = f"{server}|{session_id}"

    def new_share():
        created = request("POST", f"{server}/api/share", {"sessionID": session_id})
        share = {"id": created["id"], "secret": created["secret"], "title": title}
        # Save the secret right away, so a failed upload can be retried
        state[key] = share
        save_state(state)
        return share

    def upload(share):
        for batch in batches(items):
            request("POST", f"{server}/api/share/{share['id']}/sync", {"secret": share["secret"], "data": batch})

    share = state.get(key) or new_share()
    try:
        upload(share)
    except ShareMissing:
        # Deleted on the share page or expired: start over with a new share
        share = new_share()
        upload(share)
    share["title"] = title
    save_state(state)

    url, manage_url = share_links(server, share)
    print(f"Shared \"{title}\" ({len(items)} items)")
    print(redactor.summary())
    print()
    print(f"Link:        {url}")
    print(f"Manage link: {manage_url}")
    print("             Opens the share with a Delete button. Keep it to yourself.")
    if shutil.which("pbcopy"):
        subprocess.run(["pbcopy"], input=url, text=True)
        print()
        print("Link copied to clipboard")


if __name__ == "__main__":
    main()
