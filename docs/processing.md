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

In **SMS inbox**, review suggestions prefill recognizable details. Choose **External / unknown account** for a transfer to someone outside your Actual accounts, then select its category. The principal and fee import as separate entries in that same category: a SAR 200 water payment with SAR 0.29 fees debits SAR 200.29 from the account and charges both entries to your chosen bill category. Without a selected category, named external counterparties can use merchant mapping or AI; if no category is resolved, both entries stay uncategorized. Transfers between your Actual accounts remain linked and have no expense category; their fees use the configured Bank Fees category. A transfer template's category applies only to external counterparties.

The review form also prefills the notes the system would import. You can edit or clear them before approving. Your text, including line breaks, is saved with the review and used on both the principal and fee, including after a processing retry. For imported messages, the editor loads the linked transaction's current fields from Actual. **Save to Actual** updates that transaction ID, including its separate fee entry, and syncs the budget. Changing the fee to zero retains a zero-value fee entry so the link remains stable. Older combined payment-and-fee entries remain combined. The original SMS stays unchanged.

If someone changes the transaction in Actual while the form is open, saving returns a conflict: reopen the message to load the new values. Deleted transactions and missing fee entries are never recreated automatically. Split transactions must be edited in Actual to preserve their splits. Connection changes and queue imports wait for an edit to finish. Successful category corrections are learned for future messages.

When a new parser revision starts, it gives retained `ignored` and `needs_review` events from earlier revisions one more attempt. This allows a parser fix to recover a missed transaction. Already imported events are never replayed, and Actual's stable import IDs prevent duplicates.

## How inbox sync works

The Tasker project reads Android's SMS inbox (`content://sms/inbox`) every five minutes. It resumes from a checkpoint stored on the server, so it can catch up after Tasker stops or the phone loses connectivity. A new checkpoint defaults to the current time. In **Tasker connection → Inbox checkpoint**, choose **Now** or a specific date and time, then save. Times in the form use your device’s time zone. Existing checkpoints are kept until you explicitly save a change; viewing the page or downloading the project does not reset them.

The service supports one active inbox-sync phone. Disable the old phone's project before moving to another one. The old `%ActualSmsInboxV2*` Tasker globals are no longer used and can be deleted.

Every SMS after the checkpoint passes through your private HTTPS service. The service checks the sender against `config/banks.yaml`, queues supported bank messages, and saves review-only bank messages for inspection. Unknown senders and empty messages are skipped without storing their content. Polling uses the inbox `date` as `receivedAt` and doesn't include location.

### Change the checkpoint

Use **Tasker connection → Inbox checkpoint** to choose the exact date and time to read from. Moving it backward rechecks older messages; moving it forward skips unread messages before the selected time. Previously imported messages stay deduplicated, and already queued messages are unaffected. The phone fetches the saved checkpoint on its next sync, so changing it does not require importing a new Tasker project.

If Tasker advances the checkpoint while the form is open, saving returns a conflict and reloads the latest position. Review that position and save again. A batch sent with an older checkpoint also returns a conflict rather than overwriting the owner's choice.

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

Before asking AI for help, the service looks for an exact match on the normalized merchant name and Actual account. It learns confirmed mappings from categorized Actual transactions and your manual corrections. Explicit merchant rules and review edits take priority over Actual history. AI suggestions are saved separately for confirmation in **Your merchants** and are never reused automatically. On upgrade, old automatic SMS/AI mappings are marked as suggestions; your explicit edits remain confirmed. Actual history refreshes at startup and every hour by default. The service records the payee and category it imported, so its own unchanged imports cannot confirm an AI guess. A later payee or category correction in Actual can establish a mapping. Legacy imports without enough retained evidence remain unconfirmed. A match reuses the previous payee and category without an AI request; any active expense category can be reused.

If there's no match and you've enabled an AI provider in the web workspace, the service asks that provider for a merchant name and category suggestion. It sends only normalized merchant text, optional exact location/time context, and the configured eligible category IDs and names. It doesn't send raw SMS, balances, account suffixes, aliases, or unrelated personal data.

The default model is `deepseek-v4.1-flash`; change it with `OPENCODE_GO_MODEL`. Requests use OpenCode's OpenAI-compatible Chat Completions endpoint with a JSON-only prompt, and responses are validated locally. The provider's JSON-mode parameter is omitted because the current Flash backend rejects it. This step uses the model without web search.

A category is applied only when confidence meets `ENRICHMENT_MIN_CONFIDENCE`, which defaults to `0.70`. The same threshold applies to name formatting. AI can adjust capitalization and punctuation, but changing the merchant identity requires a confirmed alias. Low-confidence responses preserve the extracted merchant name and leave the category unset. Provider failures, invalid output, quota limits, rate limits, and timeouts don't prevent an otherwise valid transaction from importing. Sanitized requests, responses, timings, outcomes, and failure details are saved in the event audit.

Al Rajhi POS, online-purchase, and refund templates preserve merchant punctuation, digits, and line boundaries. Actual newlines, CRLF, and escaped line breaks are parsed consistently. Missing, conflicting, generic, or date-contaminated purchase/refund merchants go to review rather than becoming reusable mappings. Import IDs and previously imported transactions are preserved.

### What stays on your server

The SQLite database keeps raw SMS, any supplied location, status changes, mapping decisions, enrichment attempts, and import outcomes for authenticated review until you explicitly clear SMS and logs in Settings. Queue data and Actual's local cache live in separate persistent Docker volumes. This service doesn't encrypt those volumes, so protect access to the host and Docker.

### What gets imported

Actual's rules remain authoritative. Transactions are imported as cleared, use a stable `imported_id` to prevent duplicates, and sync after writes. Actual's default behavior of not reimporting deleted entries is preserved.

For foreign-currency messages without a SAR amount, the service uses chronological balance changes when it can do so safely. Otherwise, it imports a zero-value transaction marked `REVIEW REQUIRED`.
