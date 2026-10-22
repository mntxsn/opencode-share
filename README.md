# opencode-share

A self-hosted server for sharing [opencode](https://opencode.ai) sessions within a team. You upload a session with a small script and send the link. Anyone with the link sees the conversation as a chat: your prompts, the agent's answers, tool calls and thinking.

Since opencode v1.19.1, opencode has no built-in sharing (`/share` and `enterprise.url` are gone). This project replaces it: a Rust server (Axum, PostgreSQL) plus [scripts/share-session.py](scripts/share-session.py) to upload sessions.

## Features

- Chat layout: your prompts on the right, the agent on the left, with rendered Markdown
- **Final answers only** switch: hides the agent's intermediate messages and shows only the last answer to each prompt
- Collapsible tool calls (command, input, output, errors) and thinking blocks
- Side-by-side diffs for changed files
- Light and dark mode, works on phones
- Secrets and your home directory path are redacted before upload
- Shares expire automatically (30 days after the last upload by default)
- Optional author name ("Shared by …") and expiry date on each share

## Setting up the server

You need Docker with Docker Compose.

```bash
git clone https://github.com/mntxsn/opencode-share.git
cd opencode-share
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, and adjust the other settings if needed
docker compose up -d --build
```

The server now runs on port 3006 (`SHARE_PUBLISH_PORT` in `.env`). `curl http://localhost:3006/` returns `Hello World`.

Share data lives in the Docker volume `db_data`. It survives restarts and rebuilds. `docker compose down -v` deletes it.

| Task | Command |
|------|---------|
| Update to a new version | `git pull && docker compose up -d --build` |
| Apply changed settings in `.env` | `docker compose up -d` |
| Show logs | `docker compose logs -f app` |
| Stop | `docker compose down` |

### HTTPS and a host name

The server speaks plain HTTP. For a URL like `https://share.example.internal`, put a reverse proxy in front of it. With [Caddy](https://caddyserver.com), a `Caddyfile` like this is enough:

```
share.example.internal {
    tls internal
    reverse_proxy localhost:3006
}
```

`tls internal` creates a certificate from Caddy's own certificate authority. Team members' machines have to trust that authority, or you use a certificate from your organization instead. If only the proxy should reach the server, publish the port on localhost only: `SHARE_PUBLISH_PORT=127.0.0.1:3006`.

## Sharing a session

You need Python 3 and `opencode` on your `PATH`. The script uses only the Python standard library.

1. Get the script, for example by cloning this repository, and put it on your `PATH`:

   ```bash
   ln -s "$PWD/scripts/share-session.py" ~/.local/bin/opencode-share
   ```

2. Point it at your team's server and set your name, in `~/.zshrc` or `~/.bashrc`:

   ```bash
   export OPENCODE_SHARE_URL=https://share.example.internal
   export OPENCODE_SHARE_AUTHOR="Alice"
   ```

3. Share from inside your project directory:

   ```bash
   opencode-share                    # the latest session of this project
   opencode-share ses_xxx            # a specific session (opencode session list shows the IDs)
   opencode-share --dry-run          # check what gets redacted, upload nothing
   opencode-share ses_xxx --delete   # remove a share
   ```

The script prints the link and, on macOS, copies it to the clipboard. Running it again for the same session updates the share and restarts its retention period.

Redaction, custom patterns and all other options are described in [scripts/README.md](scripts/README.md).

## Configuration

The server reads these environment variables. With Docker Compose, set them in `.env`.

| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_PASSWORD` | Database password (Compose only). Use letters, digits and hyphens | `postgres` |
| `SHARE_PUBLISH_PORT` | Host port, or `address:port` (Compose only) | `3006` |
| `SHARE_RETENTION_DAYS` | Delete shares this many days after their last upload. `0` keeps them forever | `30` |
| `SHARE_CLEANUP_INTERVAL_MINUTES` | How often expired shares are deleted | `60` |
| `SHARE_SHOW_COST` | Show the session and message cost | `false` |
| `SHARE_SHOW_TOKENS` | Show token counts (input, output, reasoning) | `false` |
| `SHARE_SHOW_DIRECTORY` | Working directory on the share page: `none`, `name` (project folder only) or `full` | `name` |
| `SHARE_FINAL_ANSWERS_ONLY` | Start with "Final answers only" switched on. A viewer's own choice is remembered in their browser and takes precedence | `true` |
| `RUST_LOG` | Log filter | `opencode_share=info,tower_http=info` |
| `DATABASE_URL` | PostgreSQL connection URL (without Compose) | `postgres://postgres@localhost/opencode_share` |
| `HOST` / `PORT` | Address and port the server listens on (without Compose) | `0.0.0.0` / `3006` |

Boolean variables accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`. Invalid values are logged and replaced by the default. The server logs the active configuration at startup.

Expired shares are deleted at startup and then once per cleanup interval, so a share can stay reachable for up to one interval after its expiry date.

## Privacy and security

- **Anyone with the link can view a share.** There are no accounts. Share IDs are opencode session IDs, so treat links like passwords and run the server only on a network you trust (VPN, office network).
- **Everything in a session is visible:** prompts, answers, thinking, commands and their full output. The script redacts common secrets and replaces your home directory with `~` before uploading, but pattern matching can't catch everything. Use `--dry-run` for sessions in which the agent read config or credential files.
- The `SHARE_SHOW_*` settings only change the page. The data API still returns everything that was uploaded.
- Changing or deleting a share needs its secret, which only the uploader's machine has (`~/.local/share/opencode-share/shares.json`).
- Creating shares needs no authentication. Anyone who can reach the server can upload.
- The page escapes all session content and sends a strict Content-Security-Policy.

## API

| Method and path | Body | Purpose |
|-----------------|------|---------|
| `POST /api/share` | `{"sessionID": "..."}` | Create a share. Returns `id`, `secret` and `url` |
| `POST /api/share/{id}/sync` | `{"secret": "...", "data": [...]}` | Add or replace items |
| `GET /api/share/{id}/data` | | All items of a share |
| `DELETE /api/share/{id}` | `{"secret": "..."}` | Delete a share |
| `GET /share/{id}` | | The share page |

Items are arbitrary JSON objects. An item with a `_key` replaces the stored item with the same key, an item without one is appended. The share page understands the item types `session`, `message`, `part`, `session_diff` and `share_meta`, matching the data from `opencode export`.

Limits: 2 MB per request, 100,000 items and 64 MB per share.

## Development

Requires Rust (stable) and a PostgreSQL database. Migrations run automatically at startup.

```bash
export DATABASE_URL=postgres://postgres:change-me@localhost:5432/opencode_share
cargo run
```

| Path | Contents |
|------|----------|
| `src/main.rs` | Startup, routing, cleanup task |
| `src/config.rs` | Environment variables |
| `src/core/share.rs` | Share storage and merge logic |
| `src/routes/` | API (`api.rs`) and share page (`share.rs`) |
| `src/middleware.rs` | Access log and security headers |
| `templates/share.html` | Page skeleton |
| `static/share.js`, `static/share.css` | Page rendering and styles |
| `scripts/share-session.py` | Upload script |
| `migrations/` | Database schema |

Static files and templates are read from disk at runtime. Without Docker, reloading the page is enough to see changes. With Docker, rebuild the image.

The integration tests in `tests/` currently don't compile, because the crate has no library target (`src/lib.rs`) for them to import.

## License

Same as the original opencode project.
