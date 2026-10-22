# share-session.py

Shares an opencode session on this server.

Since opencode v1.19.1, opencode no longer includes session sharing: `/share` is gone and `enterprise.url` is ignored. This script fills the gap. It exports a session with `opencode export` and uploads it through the share API.

## Requirements

- Python 3 (standard library only)
- `opencode` on your `PATH`
- A running opencode-share server (default: `http://localhost:3006`)

## Usage

```bash
# Share the latest session of the project you are in
scripts/share-session.py

# Share a specific session (works from any directory)
scripts/share-session.py ses_xxx

# Share a file written by `opencode export`
scripts/share-session.py --file session.json

# Remove a share
scripts/share-session.py ses_xxx --delete
```

To find session IDs, run `opencode session list` inside the project.

The script prints the share URL and, on macOS, copies it to the clipboard.

## Server

Use `--server` or `OPENCODE_SHARE_URL` to point the script at a different server:

```bash
export OPENCODE_SHARE_URL=https://share.example.com
scripts/share-session.py ses_xxx
```

## Updating a share

To update a share, run the script again for the same session. It uploads the current state and replaces existing messages and parts.

The script stores share secrets in `~/.local/share/opencode-share/shares.json`, and both updating and `--delete` need them. Without that file, you can't change or delete a share from another machine.

## Limitations

- Subagent (child) sessions and file diffs are not uploaded.
- `opencode export` without a session ID only finds sessions of the current directory's project.
