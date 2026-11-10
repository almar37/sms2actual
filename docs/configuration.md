# Advanced configuration

Most users configure accounts, categories, templates, and AI in the web workspace. This reference covers bank grammar and the optional YAML configuration retained for existing deployments.

## Existing deployments and the CLI

Existing `.env` files, encrypted SQLite settings, and `config/accounts.yaml` remain supported with `compose.example.yaml`:

```sh
docker compose -f compose.example.yaml up -d --build
```

That legacy Compose file requires `.env` and mounts the local YAML files. `API_KEY` remains the owner setup key for these deployments. Without an explicit `AUTH_SECRET`, its legacy derivation from `API_KEY` is preserved. Keep both stable and back them up.

`npm run setup` is still available for generating legacy configuration using Docker. It writes `.env` and `config/accounts.yaml`; `npm run setup -- --force` permits overwriting them. It is optional for new installations. Use `npm run setup:host` only after building native dependencies on the host.

For a new installation, use the root `compose.yaml` and the web setup described in [the README](../README.md). Do not replace an existing deployment's volume names or Compose project name during migration: that would open empty volumes. Back up the original data and secret before changing deployment configuration.

## Account routing

A single bank sender can send messages for several accounts. Routing rules tell the service which Actual account each message belongs to.

Every rule names a `bank` and uses at least one of these matching options:

| Option                        | Use it when…                                                |
| ----------------------------- | ----------------------------------------------------------- |
| `accountSuffixes`             | The SMS identifies an account or card by its final digits   |
| `transactionKinds`            | The transaction type identifies the account                 |
| `hasBalance: true` or `false` | The presence or absence of a balance distinguishes accounts |

Rules must not overlap. For example, Al Rajhi credit-card messages with a numeric balance can route separately from checking messages without one.

For transfers, `transferIdentifiers` optionally lists destination aliases. `billPaymentIdentifiers` maps biller codes to destination accounts. These options don't affect ordinary account matching, and transfer destinations can belong to any configured bank. If a bank identifies accounts in `From` and `To` fields, give each account its suffixes without transaction-type shortcuts so the service can match the source or destination correctly.

Tasker always sends the full message, so account routing changes don't require changes on your phone.

For credit-card repayment receipts that omit the funding account, set an optional default in `config/accounts.yaml`:

```yaml
creditCardPaymentFundingAccount: Checking - 0131
```

Use the exact existing, open Actual account name. The service credits the card and uses Actual's transfer payee to debit the funding account as a linked transfer. This default applies only to recognized card-repayment receipts; a funding account explicitly identified in the SMS takes priority. Ordinary deposits, refunds, and purchases do not use this default. The chosen funding account is saved with each payment, and changing the default affects future payments. Restart after editing the setting. Already imported card credits require linking in Actual rather than replaying the SMS.

D360 uses `bank: d360` and the card suffix shown in the SMS. Set `actualName` to the exact name of your existing Actual account. For an international purchase such as `JPY 878.00 (SAR 20.91)`, the service imports the SAR equivalent plus any separately reported fee and keeps the foreign amount in the notes. It never treats a yen amount as SAR. Run **Reconcile Inbox Last 7 Days** after enabling D360 to pick up messages that were previously skipped.

## Adding a bank

Add the bank to `config/banks.yaml`. This registry supplies the setup wizard's bank list and tells the service how to identify incoming senders. For example, add this entry under `banks`:

```yaml
- id: example-bank
  name: Example Bank
  senders: [ExampleBank, Example Bank]
  disposition: import
```

Then add a route under `accounts` in **Accounts & cards**, or in an optional legacy `config/accounts.yaml`. Use an existing Actual account name and the suffix shown in your SMS:

```yaml
accounts:
  - actualName: Example Checking
    match:
      bank: example-bank
      accountSuffixes: ['1234']
```

Sender aliases match the whole sender name, ignoring case and extra whitespace. They are literal names, so list each spelling your phone receives; regexes and partial matches aren't supported.

For older requests that omit the sender, optional `messageAliases` can identify the bank from the message text. These matches require word boundaries. If a message matches more than one bank, it's saved for review.

`disposition` defaults to `import`. Set it to `needs_review` to save a bank's messages without importing them. Review-only banks aren't offered in setup and can't have account routes.

Choose a stable bank ID beginning with a lowercase letter and containing only lowercase letters, digits, underscores, or hyphens. Routing and transaction deduplication depend on these IDs. Startup rejects duplicate IDs or aliases, unknown bank IDs in account routes, and routes for review-only banks.

If the bank's wording already fits the shared English/Arabic rules, YAML changes are all you need. For different wording or field labels, add a [custom SMS template](#custom-sms-templates). Messages from registered import banks that can't be understood are saved for review.

Restart after editing the files, then run **Reconcile Inbox Last 7 Days** to recover recent messages from the newly supported sender. Changing bank configuration alone does not retry events already saved for review.

The image includes the bank registry and shared grammar. After editing these files, rebuild with `docker compose up -d --build`. For runtime overrides, bind-mount your files and set `BANKS_CONFIG_PATH` and `PARSING_CONFIG_PATH`.

## Custom SMS templates

For a message marked **Unsupported format** in the web inbox, use **Teach this format** to select exact SMS fields, validate the rule, save it, and import that message. Those learned templates are stored in SQLite and can be edited in **Message templates**. The YAML configuration below is for maintaining shared bank grammar.

All banks share one parser engine and a set of English/Arabic rules in `config/parsing.yaml`. Bank identification is a separate step used for routing. The parser reads transaction details; routing and processing handle account matching and transfers between your own accounts.

You can add a template when a bank uses wording the shared rules don't recognize. Add it under `templates` in `config/parsing.yaml`, then reference its ID on the bank entry in `config/banks.yaml` with `templates: [example-purchase]`.

Mark an incoming card-repayment template with `kind: transfer_in` and `cardPaymentReceived: true` to allow the configured funding-account default. The same marker is supported on shared incoming-kind rules. Other transaction kinds cannot use this marker.

For example:

```yaml
- id: example-purchase
  match:
    - source: 'Statement debit'
      flags: i
  kind: purchase
  fields:
    principal:
      - source: 'Paid SAR (?<value>[0-9.]+)'
        flags: u
  required: [principal, accountAlias]
```

This recognizes a purchase containing `Statement debit` and extracts its amount from `Paid SAR …`. It uses the shared account extractor and requires both an amount and an account alias.

Templates work as follows:

- Patterns run after Arabic digits are converted, thousands separators are removed, and whitespace is collapsed.
- Use single-quoted YAML regex strings to preserve backslashes. Flags can include `i`, `m`, `s`, and `u`, each once. The engine handles repeated matching.
- Scalar field patterns must capture `value`. The `foreign` field captures `amount` and `currency`.
- Pattern lists run in order. Keep specific transaction kinds, such as card payments and transfers, before generic purchases in the shared rules.
- Fields you leave out use the shared extractors. If you override a field and its pattern doesn't match, that field stays absent.

Supported fields are `accountAlias`, `accountAliases`, `from`, `to`, `iban`, `beneficiary`, `biller`, `merchant`, `principal`, `total`, `fee`, `balance`, `foreign`, `date`, `sarEquivalent`, and the boolean marker `cashback`. Amount fields describe SAR amounts; foreign amounts are stored separately. Dates use the supported formats and Riyadh timezone, falling back to the time the SMS was received. YAML templates can't run custom conversion code or accounting formulas.

Ignored notifications and review-only banks are handled before template matching. With exactly one matching template, the service uses its transaction kind and field overrides. With none, it uses the shared rules. Missing or invalid required fields send the message to `unsupported_format`; multiple matching templates do the same with reason `ambiguous_template`. Purchase, refund, transfer, and fee accounting stays in the shared engine.

Test new templates against both messages they should match and messages they shouldn't. Restart after edits, and deploy bank and parser configuration together. Setup and startup validate the parser configuration and bank template references. Invalid versions, fields, flags, regexes, captures, or references are rejected.

Compose mounts this file at `/config/parsing.yaml`; older deployments need to add the mount. `PARSING_CONFIG_PATH` can select another mounted location. For host development, use `PARSING_CONFIG_PATH=config/parsing.yaml`.

The current parser revision is 15, which includes account-reference and transfer-identity fixes. A parser revision can trigger [reprocessing of older events](processing.md#event-status-and-review), but editing YAML alone doesn't trigger a historical replay. Imported events are never replayed.
