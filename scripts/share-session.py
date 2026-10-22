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


def export_session(session_id):
    cmd = ["opencode", "export", "--pure"]
    if session_id:
        cmd.append(session_id)
    # opencode truncates large exports written to a pipe, so write to a file
    with tempfile.TemporaryFile(mode="w+") as out:
        result = subprocess.run(cmd, stdout=out, stderr=subprocess.PIPE, text=True)
        out.seek(0)
        output = out.read()
    if result.returncode != 0 or not output.strip():
        sys.exit(f"opencode export failed:\n{result.stderr.strip()}")
    return json.loads(output)


def to_share_items(export):
    items = [{"_key": "session", "type": "session", "data": export["info"]}]
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


def request(method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {url} failed: HTTP {e.code}")
    except urllib.error.URLError as e:
        sys.exit(f"Cannot reach {url}: {e.reason}")


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
    args = parser.parse_args()

    server = args.server.rstrip("/")
    state = load_state()

    if args.delete:
        if not args.session_id:
            parser.error("--delete needs a SESSION_ID")
        key = f"{server}|{args.session_id}"
        share = state.get(key)
        if not share:
            sys.exit(f"No saved secret for {args.session_id} on {server}")
        request("DELETE", f"{server}/api/share/{share['id']}", {"secret": share["secret"]})
        del state[key]
        save_state(state)
        print(f"Share removed: {share['id']}")
        return

    if args.file:
        export = json.loads(Path(args.file).read_text())
    else:
        export = export_session(args.session_id)

    session_id = export["info"]["id"]
    key = f"{server}|{session_id}"
    share = state.get(key)
    if share is None:
        created = request("POST", f"{server}/api/share", {"sessionID": session_id})
        share = {"id": created["id"], "secret": created["secret"]}
        state[key] = share
        save_state(state)

    items = to_share_items(export)
    for batch in batches(items):
        request("POST", f"{server}/api/share/{share['id']}/sync", {"secret": share["secret"], "data": batch})

    url = f"{server}/share/{share['id']}"
    print(f"Shared \"{export['info'].get('title', session_id)}\" ({len(items)} items)")
    print(url)
    if shutil.which("pbcopy"):
        subprocess.run(["pbcopy"], input=url, text=True)
        print("URL copied to clipboard")


if __name__ == "__main__":
    main()
