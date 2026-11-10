# Processing and inbox sync

## Event status and review

Use `GET /v1/events` to see what's been received and `GET /v1/events/:id` to inspect a particular message. Both require the `X-API-Key` header.

| Status               | Meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `queued`             | Saved and waiting to be processed                                |
| `processing`         | Currently being processed                                        |
| `imported`           | Imported into Actual                                             |
| `imported_review`    | Imported, but needs your attention                               |
| `ignored`            | Recognized as a notification that shouldn't create a transaction |
| `unsupported_format` | Supported bank message whose fields need a learned format        |
| `needs_review`       | Saved for inspection without creating a transaction              |
| `failed`             | Processing failed; details remain available                      |

OTP, login, declined, and insufficient-funds notifications are intentionally ignored. Unrecognized or malformed messages from supported banks are saved as `unsupported_format`. Messages from review-only banks and ambiguous template matches stay `needs_review`. They don't retry within the same parser revision.

The event list has cursor pagination and optional `status`, `enrichmentStatus`, `from`, and `to` filters. Event details include the original input, status history, enrichment attempts, the source of merchant/category mappings, `parserReason`, and operational `error` values. Raw SMS and location are available only in the authenticated detail response.

Processing retries wait 1 minute, 5 minutes, 30 minutes, and 2 hours. Events remain available to inspect after a terminal error.

In **SMS inbox**, review suggestions prefill recognizable details. Choose **External / unknown account** for a transfer to someone outside your Actual accounts, then select its category. The principal and fee import as separate entries in that same category: a SAR 200 water payment with SAR 0.29 fees debits SAR 200.29 from the account and charges both entries to your chosen bill category. Without a selected category, named external counterparties can use merchant mapping or AI; if no category is resolved, both entries stay uncategorized. Transfers between your Actual accounts remain linked and have no expense category; their fees use the configured Bank Fees category. A transfer template's category applies only to external counterparties.

The review form also prefills the notes the system would import. You can edit or clear them before approving. Your text, including line breaks, is saved with the review and used on both the principal and fee, including after a processing retry. For imported messages, the editor loads the linked transaction's current fields from Actual. **Save to Actual** updates that transaction ID, including its separate fee entry, and syncs the budget. Changing the fee to zero retains a zero-value fee entry so the link remains stable. Older combined payment-and-fee entries remain combined. The original SMS stays unchanged.

If someone changes the transaction in Actual while the form is open, saving returns a conflict: reopen the message to load the new values. Deleted transactions and missing fee entries are never recreated automatically. Split transactions must be edited in Actual to preserve their splits. Connection changes and queue imports wait for an edit to finish. Successful category corrections are learned for future messages.

When a new parser revision starts, it gives retained `ignored`, `unsupported_format`, and `needs_review` events from earlier revisions one more attempt. This allows a parser fix to recover a missed transaction. Already imported events are never replayed, and Actual's stable import IDs prevent duplicates.

## Deleting a message

Use the delete button in **SMS inbox** or **Delete SMS** in the review drawer. The confirmation lists linked Actual entries and defaults to **No — keep Actual entries**. Removing only the SMS also removes its processing logs, review override, balance observation, and detected limit from sms2actual. It does not delete SMS on your phone, clear merchant rules, or change the inbox checkpoint.

Choose **Yes — delete linked Actual entries too** to remove the identified transaction and its associated fee. Actual handles the opposite side of linked transfers and split lines belonging to a deleted split parent. Links use recorded Actual IDs or deterministic service import IDs, never guessed amounts or merchant names. Changed entries require refreshing the confirmation. If Actual is offline or links cannot be verified, SMS-only deletion remains available.

Actual deletion is journaled before calling the SDK. A failure keeps the SMS visible and holds it out of processing and parser replay, including after restart. Refresh the deletion confirmation to retry, or remove just the SMS and keep the remaining Actual entries. The service verifies deletion after syncing before removing its local message. Other SMS records referencing the same transfer are retained.

Deleted messages can be restored by resubmitting them. Move the inbox checkpoint to before the deleted SMS and run Tasker sync, or use **Reconcile Inbox Last 7 Days** for a recent SMS. An ordinary sync continues from the current checkpoint, so it does not reread older messages. Messages already present in the inbox remain deduplicated. Minimal transaction-link metadata (without SMS text) preserves links for other transfer SMS; it does not block restoration. Restored SMS follows the normal processing flow.

## Teaching an unsupported format

Open an `unsupported_format` message and use **Teach this format**. Select a value in the received SMS, choose its field, and press **Use selected text**, or copy the exact value into its box. The amount is required; purchases and refunds also require a merchant. Account/card suffixes route the message using your existing account rules. Include every value that changes (such as balance, fees, and dates), since all remaining wording stays fixed. When selecting a date, choose its day/month/year order and whether it includes a time; ISO and common slash formats support Arabic digits. Without a selected date, the transaction uses the SMS received time. Any changing timestamp left as fixed wording will prevent future matches.

Text absent from the SMS turns its box red. Repeated strings require selecting a specific occurrence. The server independently rejects invalid offsets, overlaps, partial numbers, invalid field types, ambiguous routes, and templates already matching the example. Saving persists a literal, bounded template and queues the original SMS in one database transaction. Future matching messages follow the normal durable import flow. The rule cannot override ignored OTP or declined messages. This teaches supported bank wording; it does not enable unknown senders or review-only banks.

## How inbox sync works

The Tasker project reads Android's SMS inbox (`content://sms/inbox`) every five minutes. It resumes from a checkpoint stored on the server, so it can catch up after Tasker stops or the phone loses connectivity. A new checkpoint defaults to the current time. In **Tasker connection → Inbox checkpoint**, choose **Now** or a specific date and time, then save. Times in the form use your device’s time zone. Existing checkpoints are kept until you explicitly save a change; viewing the page or downloading the project does not reset them.

The service supports one active inbox-sync phone. Disable the old phone's project before moving to another one. The old `%ActualSmsInboxV2*` Tasker globals are no longer used and can be deleted.

The current Tasker project filters inbox rows on the phone using exact, case-insensitive sender aliases from `config/banks.yaml` for the banks assigned to your configured accounts. With no accounts configured, the query matches nothing. The service still validates senders and queues supported bank messages. Empty messages are skipped. Older projects queried the entire inbox; reimport the updated project to stop unrelated messages being uploaded. Previously retained messages are not automatically deleted. Polling uses the inbox `date` as `receivedAt` and doesn't include location.

### Change the checkpoint

Use **Tasker connection → Inbox checkpoint** to choose the exact date and time to read from. Moving it backward rechecks older messages; moving it forward skips unread messages before the selected time. Previously imported messages stay deduplicated, and already queued messages are unaffected. The phone fetches the saved checkpoint on its next sync, so changing it does not require importing a new Tasker project.

If Tasker advances the checkpoint while the form is open, saving returns a conflict and reloads the latest position. Review that position and save again. A batch sent with an older checkpoint also returns a conflict rather than overwriting the owner's choice.

### Recheck the last seven days

Run **Reconcile Inbox Last 7 Days** when you've enabled a bank or want to resend recent inbox messages. Wait for any active sync to finish first.

The task moves the server checkpoint to seven days ago, and the next poll works through that window again. Existing event IDs prevent duplicate imports. If the checkpoint is already farther back, reconciliation leaves it there. Resending an event already saved for review doesn't automatically reprocess it after a configuration change.

### Protocol details

Each Tasker run calls `POST /v1/inbox-sync/start` to get the checkpoint and sender filter, reads later inbox rows matching that filter, and sends the oldest first to `POST /v1/inbox-sync/batch`. Batches contain up to 25 rows; one run sends at most 10 batches, or 250 messages. The next poll continues from there.

The checkpoint tracks the inbox row's `(date, _id)`. Tasker sends these identifier fields as received from Android. The server normalizes and validates them, then saves events and advances the checkpoint in the same SQLite transaction. Event IDs use `inbox-v2-<date>-<row _id>`, which also prevents duplicates when replaying messages during migration.

Each batch includes the checkpoint Tasker expects. If another run or a rewind has changed it, the server returns `409 checkpoint_conflict`. Tasker stops and gets the current checkpoint next time. Network failures don't need local recovery: if the server committed the batch, the next start call returns the advanced checkpoint; otherwise, it returns the previous one.

Valid rows are acknowledged as `empty`, `unsupported`, `duplicate`, or `queued`. Each advances the checkpoint. The sync route has a 5 MiB body limit and accepts at most 25 rows per batch.

The Tasker SQL query uses `|~sms~|` as its column divider. The server also accepts unsplit comma-separated rows from older imports that lost their tab divider, preserving commas and newlines within message bodies.

## Merchant names, categories, and privacy

Global merchants retain multiple SMS identifiers separately from a user-selected payee, including uncategorized merchants. Name changes in **Your merchants** update the payee on matching ordinary service imports across all accounts and apply to future imports independently of category selection. This preserves imported descriptions and stable IDs. Splits, linked transfers, and non-service transactions are excluded from bulk payee updates.

Before asking AI for help, the service looks for an exact match on any normalized SMS identifier in the shared merchant catalog. It learns confirmed mappings from categorized Actual transactions and your manual corrections. Explicit merchant rules and review edits take priority over Actual history. Merchants have one shared default category. On upgrade, records with the same confirmed preferred name or SMS identifier are merged transactionally, keeping all identifiers. Conflicting equally authoritative categories remain unset and block automatic categorization until reviewed; conflicting names also block payee substitution. AI guesses are excluded from name-based merging. Editing a merchant to use an existing preferred name deliberately combines their identifier lists. Removed identifiers are remembered so old history cannot recreate them. The migration runs once and preserves legacy mapping evidence and original transaction IDs. AI suggestions are saved separately for confirmation in **Your merchants** and are never reused automatically. On upgrade, old automatic SMS/AI mappings are marked as suggestions; your explicit edits remain confirmed. Actual history refreshes at startup and every hour by default. The service records the payee and category it imported, so its own unchanged imports cannot confirm an AI guess. A later payee or category correction in Actual can establish a mapping. Legacy imports without enough retained evidence remain unconfirmed. A match reuses the previous payee and category without an AI request; any active expense category can be reused.

If there's no match and you've enabled an AI provider in the web workspace, the service asks that provider for a merchant name and category suggestion. It sends only normalized merchant text, optional exact location/time context, and the configured eligible category IDs and names. It doesn't send raw SMS, balances, account suffixes, aliases, or unrelated personal data.

The default model is `deepseek-v4.1-flash`; change it with `OPENCODE_GO_MODEL`. Requests use OpenCode's OpenAI-compatible Chat Completions endpoint with a JSON-only prompt, and responses are validated locally. The provider's JSON-mode parameter is omitted because the current Flash backend rejects it. This step uses the model without web search.

A category is applied only when confidence meets `ENRICHMENT_MIN_CONFIDENCE`, which defaults to `0.70`. The same threshold applies to name formatting. AI can adjust capitalization and punctuation, but changing the merchant identity requires a confirmed alias. Low-confidence responses preserve the extracted merchant name and leave the category unset. Provider failures, invalid output, quota limits, rate limits, and timeouts don't prevent an otherwise valid transaction from importing. Sanitized requests, responses, timings, outcomes, and failure details are saved in the event audit.

Al Rajhi POS, online-purchase, and refund templates preserve merchant punctuation, digits, and line boundaries. Actual newlines, CRLF, and escaped line breaks are parsed consistently. Missing, conflicting, generic, or date-contaminated purchase/refund merchants go to review rather than becoming reusable mappings. Import IDs and previously imported transactions are preserved.

Compact Al Rajhi Mada/Google Pay notifications headed `شراء PoS` are supported, including the `عبر` card suffix, `بـ12 SR` amount, `لـ` merchant, and transaction date. Routing uses the suffix shown after `عبر`; configure it on the intended existing account in **Accounts & cards**. Parser revision 17 retries retained review messages from the previous version after startup. A missing or malformed required field still holds the notification for review, with any recognized fields prefilled.

Existing Al Rajhi merchant keys are rechecked against retained original SMS whenever merchant history refreshes, including after startup. Use **Your merchants → Recheck Al Rajhi merchants** to run the same cleanup immediately. Successful reparsing removes dates, amount fields, and other extraction errors from the saved keys; duplicate keys for the same merchant are grouped. Explicit aliases are retained when unambiguous. Conflicting saved names or categories require confirmation in the merchant editor before reuse. Missing or unsupported original messages stay flagged rather than being guessed.

This cleanup updates merchant mappings only: it does not reimport transactions or change existing transactions in Actual. Original SMS, stored transaction details, and Actual IDs remain intact so older import links still resolve. Corrections are recorded in each affected message's history and remembered across Actual history refreshes and SMS-log resets, preventing stale imported descriptions from recreating the old keys. To change an existing Actual transaction, use **SMS inbox → Save to Actual**.

### What stays on your server

The SQLite database keeps raw SMS, any supplied location, status changes, mapping decisions, enrichment attempts, and import outcomes for authenticated review until you explicitly clear SMS and logs in Settings. Queue data and Actual's local cache live in separate persistent Docker volumes. This service doesn't encrypt those volumes, so protect access to the host and Docker.

### What gets imported

Actual's rules remain authoritative. Transactions are imported as cleared, use a stable `imported_id` to prevent duplicates, and sync after writes. Actual's default behavior of not reimporting deleted entries is preserved.

For foreign-currency messages without a SAR amount, the service uses chronological balance changes when it can do so safely. Otherwise, it imports a zero-value transaction marked `REVIEW REQUIRED`.
