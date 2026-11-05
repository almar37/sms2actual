# Homebase deployment through Cloudflare Tunnel

This deployment connects Tasker to the SMS service through the existing Cloudflare
Tunnel. The service connects directly to Actual over Docker networking.

```text
Tasker -> https://actual-sms.rigipi.xyz -> cloudflared -> actual-sms:3000
                                                        |
                                                        v
                                                   actual:5006
```

## Prepare the Docker host

Run these commands on the host running the Homebase and streaming stacks, from
this repository directory. This directory must be available to that Docker host.

The Actual endpoint currently reports version **26.9.0**. This service pins its API
to the same version. Keep both versions aligned on future upgrades. The Homebase
Compose file currently uses `latest`; pinning it to `26.9.0` avoids an accidental
future upgrade. No changes to the existing Actual container are required here.

Confirm the existing networks and containers:

```sh
docker inspect actualbudget --format '{{json .NetworkSettings.Networks}}'
docker inspect "$(docker compose -f /mnt/HDD-A/dckr/streaming/docker-compose.yaml ps -q cloudflared)" --format '{{json .NetworkSettings.Networks}}'
```

`compose.tunnel.yaml` defaults to `shared-net` for Actual and
`streaming_flare-net` for cloudflared. The latter is the expected Compose network
name from the `streaming` directory; confirm it against the running container.
If the names differ, set `ACTUAL_NETWORK` and `TUNNEL_NETWORK` in `.env` after
setup. Both networks must already exist.

## Connect the budget

The Docker setup script works without Node or npm installed on the host:

```sh
ACTUAL_SMS_SETUP_NETWORK=shared-net sh scripts/setup-docker.sh
```

When prompted:

- Actual server URL: `http://actual:5006`
- Actual server password: enter locally in the wizard.
- Budget Sync ID: copy from Actual Settings -> Show advanced settings -> Sync ID.
- Budget encryption password: enter only if the budget is encrypted.
- Accounts and categories: select existing entries from the fetched lists.
- Account/card suffixes: use the digits in your own bank SMS messages.
- OpenCode Go API key: leave empty initially.

The wizard creates private `.env` and `config/accounts.yaml` files and generates
the Tasker API key. Existing files are protected unless `--force` is used. Do not
use `--force` for routine deployment.

For transfers between your own accounts, review `transferIdentifiers` and
`billPaymentIdentifiers` in the README; the wizard does not ask for these optional
fields. Do not copy the made-up account identifiers from the example file.

## Start the SMS service

```sh
docker compose -f compose.tunnel.yaml config --quiet
docker compose -f compose.tunnel.yaml up --build -d
docker compose -f compose.tunnel.yaml ps
docker compose -f compose.tunnel.yaml logs --tail=100 actual-sms
```

Use this Compose file by itself. Combining it with `compose.example.yaml` would
retain the example's host port publication, which conflicts with Grafana.

The service publishes no host ports. Its queue and Actual cache use separate
persistent volumes. Actual's existing `/data` directory is not mounted into it.

## Add the Cloudflare route

In the existing Cloudflare Tunnel, add a published application route:

| Setting         | Value                            |
| --------------- | -------------------------------- |
| Public hostname | `actual-sms.rigipi.xyz`          |
| Service type    | HTTP                             |
| Service URL     | `actual-sms:3000`                |
| Path            | Leave empty to forward all paths |

This is the SMS endpoint. Keep Actual private on the internal Docker network.
The existing tunnel connector must be on the network selected by `TUNNEL_NETWORK`.
Caddy is not involved in this route.

Check from a device outside the home network:

```sh
curl --fail https://actual-sms.rigipi.xyz/readyz
```

Expected response: `{"status":"ready"}`. An unauthenticated request to `/v1/events`
should return HTTP 401. This deployment uses the service's `X-API-Key`
authentication. A Cloudflare Access interactive login page will prevent the current
Tasker project from syncing. If Access is enabled, use a Service Auth policy and
add `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers to all three Tasker
HTTP Request actions, in addition to `X-API-Key`.

## Configure Tasker

1. Copy `tasker/Actual_SMS_Inbox.prj.xml` to your Android phone.
2. In Tasker, long-press the project tabs and choose **Import Project**.
3. Import the XML. Keep **Actual SMS Inbox Sync** disabled during configuration.
4. Set the project variables when prompted, or in the project's properties:
   - **Actual SMS service URL** (`%ActualSmsServiceUrl`):
     `https://actual-sms.rigipi.xyz` with no trailing slash or API path.
   - **Actual SMS API key** (`%ActualSmsApiKey`): the `API_KEY` generated in `.env`.
     This is not the Actual server password or the Cloudflare tunnel token.
5. Grant Tasker SMS permission and allow it to run in the background without
   battery optimization. Disable an older SMS-forwarding project if present.
6. After account mappings and server readiness are verified, run **Sync SMS Inbox
   To Actual Budget** manually and inspect its events and the budget.
7. Enable **Actual SMS Inbox Sync** and apply Tasker's changes. It polls every
   five minutes and catches up after connectivity returns.

The first sync reads the last seven days. The project automatically calls
`/v1/inbox-sync/start`, `/batch`, and `/rewind` under that base URL and supplies the
API header. Do not append those paths to the project variable yourself.

Use **Reconcile Inbox Last 7 Days** only when deliberately rechecking recent
messages. Events and stable import IDs prevent replay duplicates, but review
statuses still need inspection. Normal development tests do not import anything;
the live smoke test requires a disposable budget and explicitly creates and
deletes a transaction.
