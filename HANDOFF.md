# Handoff — resume on the Actual Docker host

## Continuation on blackbox — 2026-11-05

The repository is now at `/home/foreman/workbench/actual-sms` on the correct
Docker host. The export notes below describe the earlier machine; this section
records the subsequent setup work.

- Verified the running `actualbudget` container reports **26.9.0** and has the
  `actual` alias on `shared-net`.
- Verified `streaming-cloudflared-1` is running on `streaming_flare-net`.
  The existing defaults in `compose.tunnel.yaml` are correct.
- Built the Node **22.23.4** production image, tagged
  `actual-sms-setup:local` and `actual-sms-actual-sms:latest`. A temporary container
  reached `http://actual:5006/info` on `shared-net`, and its native SQLite driver
  passed an in-memory query.
- Updated only compatible dependency resolutions in `package-lock.json`:
  Fastify **5.12.8**, fast-uri **4.2.3** and **3.1.9**, plus the router's compatible
  dependencies. The exact Actual API pin remains **26.9.0**.
- Ran `npm run check` and `npm run build` in a clean Node 22 Docker environment:
  **15 test files passed; 254 tests passed; 1 optional live test skipped**.
  Compose validation without environment resolution, setup shell syntax, and
  Tasker XML validation also passed. The transferred host `node_modules` has
  broken executable links; host `npm run check` is not usable without reinstalling
  dependencies. The validation image is `actual-sms-validation:local`.
- Reviewed dependency audit paths. The two critical findings are confined to
  development dependencies (Vitest/Tinypool), which are pruned from production.
  After the compatible updates, the production audit reports **one high finding,
  Zod**, whose offered fix requires a major upgrade. The existing HTTP API checks
  its API key before body validation and limits request body size; this does not
  resolve the advisory. No major dependency migrations were attempted.
- `.env` and `config/accounts.yaml` have **not been created**, and the service has
  **not been started**. The user was asked to run the local wizard below so
  credentials stay out of chat. Check whether those files now exist before
  proceeding; do not overwrite them or rerun setup with `--force`.
- `actual-sms.rigipi.xyz` did not resolve from this host. No Cloudflare management
  connection was available. The user was asked to add its HTTP tunnel route to
  `actual-sms:3000`, with no path restriction.
- No authenticated budget access, transaction imports, live smoke tests, or
  changes to the existing Actual/cloudflared services have occurred.

The next required local step is:

```sh
cd /home/foreman/workbench/actual-sms
ACTUAL_SMS_SETUP_NETWORK=shared-net sh scripts/setup-docker.sh
```

Enter `http://actual:5006` as the server URL, supply credentials locally, select
existing account/category names and real SMS identifiers, and leave OpenCode
disabled. Once both private files exist, validate and start using
`compose.tunnel.yaml` alone, then check readiness, authenticated event reads, and
unauthorized requests. The wizard's generic next-command message names
`compose.example.yaml`; use the tunnel file for this deployment instead.

## Goal and authorization

The user authorized configuring actual-sms to import into their existing Actual
Budget, with Tasker sending through an existing Cloudflare Tunnel. They then
identified this machine as the wrong machine and requested the repository and
conversation be exported. Move the supplied source archive to the correct Docker
host before continuing deployment.

The chosen public hostname is **actual-sms.rigipi.xyz**. Tasker base URL:
**https://actual-sms.rigipi.xyz**.

Read `AGENTS.md`, `CONVERSATION.md`, and `DEPLOYMENT.md` before continuing. The
conversation record preserves requests and decisions but is not a native chat
session import. Do not assume any budget or service has been configured yet.

## Confirmed infrastructure

- Homebase Compose: `/mnt/HDD-A/dckr/homebase/docker-compose.yaml`.
- Actual service: `actual`; container: `actualbudget`; internal port: `5006`.
- Actual network in Compose: external `shared-net`.
- Existing Actual URL: `https://actual.geo.lan`.
- Its read-only `/info` endpoint reported **26.9.0** on 2026-11-05.
- Actual image in existing Compose: `actualbudget/actual-server:latest`.
- Existing budget data: `/mnt/HDD-A/dckr/homebase/conf/actual:/data`.
- Streaming Compose: `/mnt/HDD-A/dckr/streaming/docker-compose.yaml`.
- Existing `cloudflared` service runs a token-managed tunnel on Compose network
  `flare-net`. Its expected Docker network name is `streaming_flare-net`, but
  **the real network name must be verified on the correct Docker daemon**.
- Caddy also exists, with internal-CA certificates, but the agreed SMS route
  bypasses it.
- Grafana already publishes port 3000 in Homebase. The new tunnel Compose file
  publishes no host ports.

The machine where these changes were prepared could read the mounted Compose
files and reach Actual over HTTPS. Its own Docker daemon had no running or
stopped containers and did not have `shared-net`. That was not evidence that the
real Actual deployment was down. No SSH target was confirmed.

## Changes already in the source archive

- `package.json` and regenerated `package-lock.json`: exact Actual API dependency
  upgraded from `26.5.2` to **26.9.0**.
- `src/actual-version.ts` and related test fixtures: aligned to **26.9.0**.
- `Dockerfile`: build/runtime base updated from Node 20 to **Node 22**.
- `AGENTS.md` and README version references updated; README links to deployment
  guide. Prettier was run as required by repository instructions.
- `.env.example`: restored a non-secret template with private Docker Actual URL
  and network defaults. Credentials are blank; API key is only a placeholder.
- `.gitignore`, `.dockerignore`, `.prettierrc.json`, `.prettierignore`: restored or
  added support files to keep secrets/build artifacts out and allow formatting.
- `compose.tunnel.yaml`: standalone deployment file for actual-sms, with separate
  persistent queue/cache volumes, read-only config mounts, health check, bounded
  logs, no host ports, and external Actual/tunnel networks. Defaults:
  `ACTUAL_NETWORK=shared-net`, `TUNNEL_NETWORK=streaming_flare-net`.
- `scripts/setup-docker.sh`: supports optional `ACTUAL_SMS_SETUP_NETWORK`, while
  preserving the original optional host mapping and no-network behavior.
- `DEPLOYMENT.md`: detailed host setup, budget wizard, tunnel, and Tasker guide
  using the selected hostname.
- `CONVERSATION.md` and this file: portable context for the next session.

There is **no `.git` history** in the supplied repository directory. The source
archive preserves the current working tree, including all changes above, rather
than a Git commit or bundle.

## Verification already completed

A temporary, checksum-verified Node **22.23.4** toolchain was installed under
`/tmp/actual-sms-toolchain` on the old machine. It is not included in the archive.
Dependencies were installed locally with npm; `node_modules` is not transferable
across machines and is excluded.

- `npm run check` passed: format check -> lint with zero warnings -> TypeScript
  typecheck -> Vitest.
- **15 test files passed; 254 tests passed; 1 optional live test skipped.**
- `npm run build` passed.
- Tasker XML parsed successfully; setup shell script passed `sh -n`.
- No production Actual/OpenCode smoke tests were run.
- npm reported **17 dependency audit findings: 8 moderate, 7 high, 2 critical**.
  These were not evaluated or auto-fixed during configuration. Review the actual
  advisory paths before exposing the service; avoid blindly using force upgrades
  that would break the required Actual API/server version match.

Only portable source/configuration examples are included. Local build outputs,
installed dependencies, caches, real environment files, account mappings, and
credentials are excluded. No production `.env` or `config/accounts.yaml` had been
created in this repository at export.

## What remains

1. Extract the archive into a fresh directory on the correct Docker host.
2. Inspect the real Actual and cloudflared containers/networks; adjust network
   defaults if necessary. Recheck `/info` in case Actual has upgraded since export.
3. Run the setup wizard locally to supply Actual password, budget Sync ID,
   optional encryption password, exact existing account/category names, and bank
   SMS matching rules. Do not send passwords in chat.
4. Run repository checks/build on the target machine or an appropriate container.
5. Start using `compose.tunnel.yaml` alone, not merged with the example file that
   publishes port 3000.
6. In the existing Cloudflare Tunnel, configure hostname `actual-sms.rigipi.xyz`, type
   **HTTP**, service **actual-sms:3000**, no path restriction. The current session
   did not have Cloudflare management access and did not create this route.
7. Check `https://actual-sms.rigipi.xyz/readyz`, authenticated events, and unauthorized
   API behavior. If Access is enabled, use Service Auth with appropriate Tasker
   headers; do not put a browser-login challenge in front of unattended requests.
8. Validate a controlled import using a disposable budget. The live smoke test
   explicitly writes/deletes a transaction and must not be pointed casually at
   the user's production budget.
9. Import the Tasker XML; set `%ActualSmsServiceUrl` to
   `https://actual-sms.rigipi.xyz` and `%ActualSmsApiKey` to the generated service API
   key. Grant SMS permission/background access. First sync reads seven days;
   verify mappings before enabling the five-minute polling profile.

Do not mount Actual's database directory into the SMS service. The adapter uses
Actual's API and a separate local cache. Do not create accounts/categories: the
service requires existing exact names. Keep optional OpenCode enrichment disabled
initially. Read the full deployment guide for the commands.

## Prompt for the next assistant

> Read AGENTS.md, HANDOFF.md, CONVERSATION.md, and DEPLOYMENT.md. This is the
> transferred actual-sms working tree; it has not been deployed. Continue the
> authorized setup on this correct Docker host. The public Tasker URL is
> https://actual-sms.rigipi.xyz through my existing Cloudflare Tunnel. Verify the live
> Actual version and Docker networks, finish budget/account configuration using
> locally entered credentials, run the required checks, and verify connectivity.
> Preserve my existing Actual data and do not run live import smoke tests against
> my production budget without an appropriate disposable test setup.
