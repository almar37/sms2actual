# Processing and inbox sync

## Event status and review

Use `GET /v1/events` to see what's been received and `GET /v1/events/:id` to inspect a particular message. Both require the `X-API-Key` header.

| Status            | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `queued`          | Saved and waiting to be processed                                |
| `processing`      | Currently being processed                                        |
| `imported`        | Imported into Actual                                             |
| `imported_review` | Imported, but needs your attention                               |
| `ignored`         | Recognized as a notification that shouldn't create a transaction |
| `needs_review`    | Saved for inspection without creating a transaction              |
| `failed`          | Processing failed; details remain available                      |

OTP, login, declined, and insufficient-funds notifications are intentionally ignored. Unrecognized or malformed messages from registered banks, along with messages from review-only banks, are saved as `needs_review`. They don't retry within the same parser revision.

The event list has cursor pagination and optional `status`, `enrichmentStatus`, `from`, and `to` filters. Event details include the original input, status history, enrichment attempts, the source of merchant/category mappings, `parserReason`, and operational `error` values. Raw SMS and location are available only in the authenticated detail response.

Processing retries wait 1 minute, 5 minutes, 30 minutes, and 2 hours. Events remain available to inspect after a terminal error.

When a new parser revision starts, it gives retained `ignored` and `needs_review` events from earlier revisions one more attempt. This allows a parser fix to recover a missed transaction. Already imported events are never replayed, and Actual's stable import IDs prevent duplicates.

## How inbox sync works

The Tasker project reads Android's SMS inbox (`content://sms/inbox`) every five minutes. It resumes from a checkpoint stored on the server, so it can catch up after Tasker stops or the phone loses connectivity. On first use, the checkpoint starts seven days in the past.

The service supports one active inbox-sync phone. Disable the old phone's project before moving to another one. The old `%ActualSmsInboxV2*` Tasker globals are no longer used and can be deleted.

Every SMS after the checkpoint passes through your private HTTPS service. The service checks the sender against `config/banks.yaml`, queues supported bank messages, and saves review-only bank messages for inspection. Unknown senders and empty messages are skipped without storing their content. Polling uses the inbox `date` as `receivedAt` and doesn't include location.

### Recheck the last seven days

Run **Reconcile Inbox Last 7 Days** when you've enabled a bank or want to resend recent inbox messages. Wait for any active sync to finish first.

The task moves the server checkpoint to seven days ago, and the next poll works through that window again. Existing event IDs prevent duplicate imports. If the checkpoint is already farther back, reconciliation leaves it there. Resending an event already saved for review doesn't automatically reprocess it after a configuration change.

### Protocol details

Each Tasker run calls `POST /v1/inbox-sync/start` to get the checkpoint, reads all later inbox rows without filtering senders, and sends the oldest first to `POST /v1/inbox-sync/batch`. Batches contain up to 25 rows; one run sends at most 10 batches, or 250 messages. The next poll continues from there.

The checkpoint tracks the inbox row's `(date, _id)`. Tasker sends these identifier fields as received from Android. The server normalizes and validates them, then saves events and advances the checkpoint in the same SQLite transaction. Event IDs use `inbox-v2-<date>-<row _id>`, which also prevents duplicates when replaying messages during migration.

Each batch includes the checkpoint Tasker expects. If another run or a rewind has changed it, the server returns `409 checkpoint_conflict`. Tasker stops and gets the current checkpoint next time. Network failures don't need local recovery: if the server committed the batch, the next start call returns the advanced checkpoint; otherwise, it returns the previous one.

Valid rows are acknowledged as `empty`, `unsupported`, `duplicate`, or `queued`. Each advances the checkpoint. The sync route has a 5 MiB body limit and accepts at most 25 rows per batch.

The Tasker SQL query uses `|~sms~|` as its column divider. The server also accepts unsplit comma-separated rows from older imports that lost their tab divider, preserving commas and newlines within message bodies.

## Merchant names, categories, and privacy

Before asking AI for help, the service looks for an exact match on the normalized merchant name and Actual account. It learns these mappings from categorized Actual transactions, your manual corrections, and successful SMS enrichments. Actual history refreshes at startup and every hour by default. A match reuses the previous payee and category without an AI request; any active expense category can be reused.

If there's no match and you've enabled an AI provider in the web workspace, the service asks that provider for a merchant name and category suggestion. It sends only normalized merchant text, optional exact location/time context, and the configured eligible category IDs and names. It doesn't send raw SMS, balances, account suffixes, aliases, or unrelated personal data.

The default model is `deepseek-v4.1-flash`; change it with `OPENCODE_GO_MODEL`. Requests use OpenCode's OpenAI-compatible Chat Completions endpoint with a JSON-only prompt, and responses are validated locally. The provider's JSON-mode parameter is omitted because the current Flash backend rejects it. This step uses the model without web search.

A category is applied only when confidence meets `ENRICHMENT_MIN_CONFIDENCE`, which defaults to `0.70`. A lower-confidence suggestion may still clean up the payee name. Provider failures, invalid output, quota limits, rate limits, and timeouts don't prevent an otherwise valid transaction from importing. Sanitized requests, responses, timings, outcomes, and failure details are saved in the event audit.

### What stays on your server

The SQLite database keeps raw SMS, any supplied location, status changes, mapping decisions, enrichment attempts, and import outcomes indefinitely for authenticated review. Queue data and Actual's local cache live in separate persistent Docker volumes. This service doesn't encrypt those volumes, so protect access to the host and Docker.

### What gets imported

Actual's rules remain authoritative. Transactions are imported as cleared, use a stable `imported_id` to prevent duplicates, and sync after writes. Actual's default behavior of not reimporting deleted entries is preserved.

For foreign-currency messages without a SAR amount, the service uses chronological balance changes when it can do so safely. Otherwise, it imports a zero-value transaction marked `REVIEW REQUIRED`.
