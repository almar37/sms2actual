# sms2actual

Import bank SMS notifications into [Actual Budget](https://actualbudget.org/) with Android Tasker. Messages enter a durable queue, transfers between your accounts become linked transfers, and merchant history helps categorize spending. Optional AI can suggest merchant names and categories.

Includes English and Arabic recognition for SAB, Al Rajhi, Wadaie, and D360. STC Bank messages are retained for review. Add banks in YAML or teach message templates in the web UI.

## Quick start

You need Docker with Compose, an existing **Actual Budget 26.9.0** server and budget, and Android with Tasker. Node.js and npm are not required on the Docker host.

From a checkout of this repository:

```sh
docker compose up -d
```

Open **http://localhost:3000** for a new installation. If this host already has a local Compose override, use its published port instead, such as **http://localhost:3002**. Run `docker compose ps` to check the address.

Complete setup in the browser:

1. Set your workspace password (at least 8 characters). No username is needed.
2. Enter your Actual server URL, server password, and budget Sync ID. Find the Sync ID in Actual under **Settings → Show advanced settings → Sync ID**. Enter the budget encryption password if enabled.
3. In **Accounts & cards**, map existing Actual accounts to the bank and suffixes shown in your SMS. Choose an existing expense category for Bank Fees and save. The service never creates accounts or categories.
4. In **Tasker connection**, enter an HTTPS service URL reachable by your phone, choose and save an inbox checkpoint (Now is the default, or select an earlier date and time), then download the configured project, and import it into Tasker. Grant SMS permission, allow background activity, and run **Sync SMS Inbox To Actual Budget** once.

No `.env`, account YAML, CLI wizard, or manually generated API key is required. The first Docker build can take a few minutes. Only the first owner can register. Existing owners sign in with their current password; usernames are no longer required. The default port is bound to loopback; complete owner setup before exposing the service remotely.

Messages remain queued until Actual and account routing are configured. The web UI stays available if the saved Actual connection fails; use **Settings → Actual server connection** to reconnect or change credentials. A different budget after imports requires a separate instance so message deduplication and audit history remain tied to the original budget.

Tasker starts from your saved checkpoint and checks every five minutes. Without a saved checkpoint, its first sync starts from the current time. Check **SMS inbox** for imported messages or messages needing review. Repeated inbox syncs use stable identifiers to prevent duplicate imports.

## Remote access and Docker networking

The default browser origin is `http://localhost:3000`. For another origin, set `PUBLIC_URL` and, if needed, the host port or bind address. These are optional Compose settings; copy `.env.example` to `.env` or set them in your shell:

```dotenv
PUBLIC_URL=https://sms.example.com
```

Then recreate the service with `docker compose up -d`. Put HTTPS in front of the service using your reverse proxy or tunnel. Your phone needs access to sms2actual; the Actual server itself can stay private. `TRUSTED_ORIGINS` accepts additional exact browser origins separated by commas. Use only origins you control.

| Setting           | Default                 | Purpose                                         |
| ----------------- | ----------------------- | ----------------------------------------------- |
| `PUBLIC_URL`      | `http://localhost:3000` | Main browser origin, including its port         |
| `HOST_PORT`       | `3000`                  | Port published on the Docker host               |
| `BIND_ADDRESS`    | `127.0.0.1`             | Host interface accepting connections            |
| `TRUSTED_ORIGINS` | Empty                   | Additional browser origins, separated by commas |

The service listens on port 3000 **inside the container**, even when `HOST_PORT` uses another number. If your main origin is already an HTTPS domain, keep `PUBLIC_URL` set to that domain and add any local browser addresses to `TRUSTED_ORIGINS`.

### Port conflicts

If another service already uses port 3000, choose a free host port and its matching browser origin:

```sh
HOST_PORT=3002 PUBLIC_URL=http://localhost:3002 docker compose up -d
```

Save those values in `.env` to keep them for later runs:

```dotenv
HOST_PORT=3002
PUBLIC_URL=http://localhost:3002
```

Then use `docker compose up -d` as usual. Other services can continue using port 3000.

### Local deployment overrides

An automatically loaded `compose.override.yaml` can hold host-specific ports, environment files, and network connections; it is gitignored. For example, to publish only port 3002:

```yaml
services:
  actual-sms:
    environment:
      PUBLIC_URL: http://localhost:3002
    ports: !override
      - '127.0.0.1:3002:3000'
```

The `!override` tag replaces the base port list. Without it, Compose may publish both the original port and the additional port, leaving the conflict in place. Keep private hostnames and network names in the local override rather than the public base file.

Plain `docker compose up -d` loads this override automatically. When supplying explicit `-f` arguments, include every override you need; Compose does not automatically add `compose.override.yaml` in that case. Inspect the final ports and networks with `docker compose config`, which can also contain private environment values.

### Connecting to Actual and a reverse proxy

The Actual server address must be reachable **from the container**. `localhost` refers to the sms2actual container. For Actual in another Compose project, attach sms2actual to that project's network in a local override. For a reverse-proxy network, use the provided example:

```sh
cp compose.proxy.example.yaml compose.proxy.yaml
PROXY_NETWORK=caddy docker compose -f compose.yaml -f compose.proxy.yaml up -d
```

For an explicit hostname/IP mapping, copy `compose.host-override.example.yaml` to `compose.host-override.yaml`, set `ACTUAL_HOSTNAME` and `ACTUAL_HOST_IP`, and include the override with `-f`. The base configuration has no dependency on private networks or hostnames.

For LAN access without a proxy, set `BIND_ADDRESS` to the host's LAN IP, `PUBLIC_URL` to its exact HTTP origin, and optionally `HOST_PORT`. Use HTTPS for credentials outside a trusted local connection. Changing `HOST_PORT` also requires updating `PUBLIC_URL`.

## Your web workspace

- **Overview:** balances, recent transactions, message counts, and Tasker contact status. Refresh waits for Actual to sync, then reloads balances, transactions, and account/category details. It also refreshes automatically every 30 seconds. Date cutoffs use Riyadh time to include today's SMS transactions after midnight; a failed sync shows an error while keeping the previous overview visible.
- **SMS inbox:** original messages, processing history, filters, and manual review. Correct already imported transactions in Actual.
- **Accounts & cards:** account and card suffixes, transfer identifiers, credit limits, and default repayment accounts.
- **Merchants and templates:** remember category corrections and teach unfamiliar message formats.
- **AI categorization:** optional OpenCode Go, OpenAI, or Anthropic credentials and model settings. History is checked before AI is called.
- **Tasker connection:** choose where SMS sync starts, move the saved checkpoint backward or forward, download the configured Android project, reveal its SMS key, or replace that credential.
- **Settings:** Actual connection, password changes, and browser sessions.

The Tasker key is separate from any optional legacy `.env` `API_KEY`. It can submit SMS and sync the inbox. Replacing it requires downloading and importing a new Tasker project. Normal UI setup does not need the legacy key.

## Data, backups, and updates

The `sms-data` volume stores the SQLite queue, audit history, web settings, encrypted credentials, and `runtime-secrets.json`. The `actual-cache` volume stores Actual's downloaded budget. Keep the data volume and its secrets together when backing up or restoring. Existing environment-based installations must also retain their original `API_KEY` and any explicit `AUTH_SECRET`. Keep the same Compose project name when upgrading so Compose reuses the existing volumes. The image runs as the non-root `node` user.

```sh
docker compose logs --tail=100 actual-sms
docker compose ps
```

Check readiness at `/readyz` using the published host port, for example:

```sh
curl --fail http://localhost:3002/readyz
```

Use port 3000 instead for an unmodified fresh installation. `/healthz` and `/readyz` check the web service. Actual connection and import readiness are shown in the workspace. A healthy container may still need initial setup or an Actual reconnection.

To update after pulling repository changes:

```sh
docker compose up -d --build
```

The `--build` flag matters after source changes: plain `docker compose up -d` can reuse an older image. If startup complains about required Actual environment variables after upgrading to web setup, rebuild the image first. Existing deployments should keep their local environment file, volume mappings, and network overrides during the upgrade; see the migration guide below.

`docker compose down` keeps your data. **`docker compose down -v` deletes the volumes**, including credentials and message history.

- [Advanced configuration, bank grammar, and existing deployment migration](docs/configuration.md)
- [Processing, inbox sync, event statuses, and privacy](docs/processing.md)

## Development

Use Node.js 22 or newer:

```sh
npm ci
npm run check
npm run build
DB_PATH=./data/events.sqlite ACTUAL_CACHE_DIR=./actual-cache npm run dev
```

The backend serves the built web UI. For frontend hot reload, run `npm run dev:web` alongside it with `PUBLIC_URL=http://localhost:5173` on the backend. `npm run check` runs formatting, lint, TypeScript/Svelte checks, and tests in order. Normal tests use isolated fixtures and contact no live services.

For browser checks, install Chromium and its system dependencies with `npx playwright install --with-deps chromium`, then run `npm run test:web`. It uses in-memory SQLite and a fake Actual adapter. The production build outputs `dist/src/main.js` and `dist/web`.

### Disposable Actual smoke test

The live smoke test creates and deletes a transaction. Use a separate, disposable budget with a uniquely named test account. It refuses to run without `LIVE_ACTUAL_TEST=1` and explicit credentials.

The test creates a uniquely identified zero-value transaction, checks it after syncing, deletes it, and syncs again. If cleanup fails, it exits with an error and prints the identifier so you can remove the transaction yourself.

```sh
LIVE_ACTUAL_TEST=1 \
ACTUAL_SERVER_URL=https://actual.example.test \
ACTUAL_SMOKE_SYNC_ID=disposable-budget-sync-id \
ACTUAL_SMOKE_PASSWORD=server-password \
ACTUAL_SMOKE_ENCRYPTION_PASSWORD=optional-budget-password \
ACTUAL_SMOKE_CACHE_DIR=/tmp/actual-sms-smoke-cache \
ACTUAL_SMOKE_ACCOUNT_NAME='SMS Smoke Test' \
npm run smoke:actual
```

`ACTUAL_SMOKE_ENCRYPTION_PASSWORD` is optional; all other variables shown are required. These credentials apply only to the smoke test and don't change production startup settings.

To include the OpenCode Go smoke test in the test run, set `LIVE_OPENCODE_GO_TEST=1` and an explicit `OPENCODE_GO_API_KEY`.

### Upgrading Actual

The `@actual-app/api` dependency is pinned to **26.9.0** to match the deployed Actual server. Startup logs both versions. A mismatch, or failure to discover the server version, produces a warning but doesn't prevent readiness. Authentication, budget download, and migration failures pause imports; the web workspace stays available to fix the connection.

When upgrading:

1. Upgrade the Actual server.
2. Set `@actual-app/api` to that exact version, without `^` or `~`, and regenerate `package-lock.json`.
3. Run `npm run check` and `npm run build`.
4. Rebuild the Docker image and run the disposable smoke test before deployment.

If you see `out-of-sync-migrations`, update the API client to a version that includes your server's migrations.

## License

MIT. See [LICENSE](LICENSE).
