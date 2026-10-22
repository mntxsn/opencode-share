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

# List your shares with their links
scripts/share-session.py --list

# Show "Shared by Alice" on the share page
scripts/share-session.py --author "Alice"
```

To set your name once, put `export OPENCODE_SHARE_AUTHOR="Alice"` in your shell profile. `--author` overrides it. Each run sends the current name, so running without a name removes it from the share.

To find session IDs, run `opencode session list` inside the project.

The script prints the share URL and, on macOS, copies it to the clipboard.

## Server

Use `--server` or `OPENCODE_SHARE_URL` to point the script at a different server:

```bash
export OPENCODE_SHARE_URL=https://share.example.com
scripts/share-session.py ses_xxx
```

## Redaction

Everything in a session is visible to anyone with the URL: messages, thinking, tool commands and their full output. Before uploading, the script therefore:

- replaces common secrets with `[REDACTED]`: private keys, AWS/GitHub/GitLab/OpenAI/Anthropic/Slack/Google keys, JWTs, bearer tokens, passwords in URLs, `API_KEY=...`-style assignments and quoted `"password": "..."` values
- replaces your home directory (for example `/Users/alice`) with `~`

It prints what it redacted. Pattern matching can't catch everything, so check sessions in which the agent read config or credential files.

| Option | Environment variable | Effect |
|--------|----------------------|--------|
| `--no-redact` | `OPENCODE_SHARE_REDACT=0` | Don't redact secrets |
| `--keep-home` | `OPENCODE_SHARE_HIDE_HOME=0` | Keep the full home directory path |
| `--redact-pattern REGEX` (repeatable) | `OPENCODE_SHARE_REDACT_PATTERNS` (one regex per line) | Also redact your own patterns, such as internal host names or customer names |
| `--dry-run` | | Show what would be redacted, upload nothing |
| `--dry-run --output FILE` | | Also write the cleaned data to `FILE` for inspection |

Command-line options override environment variables. Example for a team setup in your shell profile:

```bash
export OPENCODE_SHARE_URL=http://share.internal:3006
export OPENCODE_SHARE_REDACT_PATTERNS='\bacme-corp\.internal\b
\bcustomer-(?:alpha|beta)\b'
```

`opencode export --sanitize` is not used: it replaces every text, command and output, which leaves nothing worth sharing.

## Links

After uploading, the script prints two links:

- **Link**: the one to send to others. On macOS it is copied to the clipboard.
- **Manage link**: the same page with a **Delete share** button in the header. It contains the share's secret, so keep it to yourself. The secret sits after `#`, which browsers never send to the server. When the page opens, it removes the secret from the address bar, and "Copy link" never includes it.

`--list` prints both links for all your shares on the server and marks the ones that were deleted or have expired.

## Updating a share

To update a share, run the script again for the same session. It uploads the current state and replaces existing messages and parts. This also resets the server's retention period (30 days by default). If the share was deleted or has expired in the meantime, the script creates a new one with the same link.

The script stores share secrets in `~/.local/share/opencode-share/shares.json`. Updating, `--delete` and the manage link need them. Without that file, you can't change or delete a share from another machine.

## Limitations

- Subagent (child) sessions and file diffs are not uploaded.
- Without a session ID, the script shares the most recently updated session of the current directory's project (as listed by `opencode session list`).
