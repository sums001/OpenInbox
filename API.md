# Inbox API

The Inbox API lets scripts, apps and automations read, search, organize and send mail from your
OpenInbox mailboxes over HTTPS. It runs in the same Worker as the web app, so there is nothing
extra to deploy.

- **Base URL:** `https://<your OpenInbox address>/api/v1`
- **Format:** JSON in and out, UTF-8.
- **Auth:** an API key in the `Authorization` header.

## API keys

Create a key in **Settings → API keys**. A key acts as you, limited to what you choose:

| Permission | Allows |
| --- | --- |
| `read` | List, read and search messages and threads, download attachments |
| `send` | Send and schedule messages, cancel scheduled ones |
| `modify` | Mark read or unread, star, archive, move to spam or trash, snooze, label |

You can also limit a key to some of your inboxes and give it an expiry date. Creating a key asks
for your password, since a key keeps working after you sign out. The key is shown once;
OpenInbox stores only a hash of it. Deleting the key, disabling its user or removing the user from
a mailbox takes effect on the next request. When an admin resets your password, or the owner
account is recovered with the recovery key, your keys are deleted, in case the account had been
taken over. Changing your own password keeps them.

```sh
curl https://mail.example.com/api/v1/me \
  -H "Authorization: Bearer oik_..."
```

Cookies don't authenticate the API, and API keys don't work for the web app's own endpoints.

## Limits

- **60 requests per minute** per user, across all their keys. Over that, the API answers `429`
  with a `Retry-After` header (seconds). Poll every minute or so rather than continuously: each
  request uses some of the free plan's daily database budget.
- Sent mail counts against your sending providers' daily and monthly limits, exactly like mail
  sent from the web app, and falls back between providers the same way.
- Cloudflare's free plan allows 100,000 Worker requests a day for the whole instance.

> [!CAUTION]
> The API is for mail people expect from you: notifications, replies, follow-ups with
> customers. Sending providers ban accounts for cold outreach, purchased lists and bulk
> marketing. See [Use it responsibly](README.md#use-it-responsibly).

## Errors

Errors use HTTP status codes and a JSON body:

```json
{ "error": { "code": "bad_from", "message": "sales@example.com is not an address of a mailbox this key can use." } }
```

| Status | Meaning |
| --- | --- |
| `400` | Invalid request (`validation`, `bad_from`, …) |
| `401` | Missing, unknown, deleted or expired key |
| `403` | The key lacks the permission, or you can read the mailbox but not send from it |
| `404` | Not found, or outside the key's mailboxes |
| `409` | Not possible in this setup, e.g. `attachments_disabled`, `no_provider` |
| `429` | Rate limited |

## Endpoints

### `GET /me`

The key's user and limits.

```json
{ "user": { "id": 1, "email": "ann@example.com", "name": "Ann" }, "key": { "id": 7, "scopes": ["read", "send"], "mailboxIds": null } }
```

### `GET /mailboxes` · `read`

Mailboxes the key can use, with every address you can send from.

```json
{ "mailboxes": [{ "id": 3, "address": "sales@example.com", "displayName": "Sales", "kind": "shared", "canSend": true, "addresses": ["sales@example.com", "hello@example.com"] }] }
```

### `POST /messages` · `send`

Sends a message, or schedules it with `sendAt`.

| Field | Type | |
| --- | --- | --- |
| `from` | string | One of your addresses (see `GET /mailboxes`). Required. |
| `to`, `cc`, `bcc` | array | `"ann@example.net"` or `{ "name": "Ann", "address": "ann@example.net" }`. `to` needs at least one. Up to 100 each. |
| `subject` | string | |
| `text` | string | Plain-text body. |
| `html` | string | HTML body. Give `text`, `html` or both. With only `html`, the text part is derived from it. |
| `inReplyTo` | number | ID of a message in the same mailbox to reply to: the reply joins its thread with the right `In-Reply-To` and `References` headers. |
| `sendAt` | number or string | Milliseconds since the epoch, or an ISO 8601 date with a time zone. More than a minute ahead schedules the message. |
| `attachments` | array | Up to 10 of `{ "filename", "contentType", "content" }`, where `content` is base64. At most 20 MB each and 25 MB together. Needs attachment storage (Admin → Integrations → Attachments). |

```sh
curl https://mail.example.com/api/v1/messages \
  -H "Authorization: Bearer oik_..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: invoice-1042" \
  -d '{
    "from": "billing@example.com",
    "to": [{ "name": "Ann", "address": "ann@example.net" }],
    "subject": "Invoice 1042",
    "text": "Hi Ann, your invoice is attached.",
    "attachments": [{ "filename": "invoice-1042.pdf", "contentType": "application/pdf", "content": "JVBERi0xLjQK..." }]
  }'
```

Answers `201`:

```json
{ "id": 7212, "threadId": 7210, "status": "sent", "messageId": "...@example.com", "error": null, "retryAt": null, "sendAt": null, "replayed": false }
```

`status` is `sent`, `scheduled` or `failed` (a replay can also show `sending` while the first
request is still sending, or `draft` if the message was cancelled since). A failed send with `retryAt` set is retried
automatically (up to 3 more times); without it, `error` explains why it can't be sent, e.g. a
suppressed recipient. Delivery results arrive later: check `status` with `GET /messages/{id}`
(`delivered`, `bounced`, `complained`) when your provider sends delivery webhooks.

**Idempotency.** Send an `Idempotency-Key` header (any string up to 200 characters, unique per
message) to make retries safe: the same key with the same API key within 24 hours returns the
first message, with `"replayed": true` and status `200`, instead of sending again.

### `POST /messages/{id}/cancel` · `send`

Cancels a scheduled message. It goes back to your drafts.

### `GET /messages` · `read`

Messages in the order they became visible: received mail when it is stored, sent mail when it is
sent (a scheduled message appears once it goes out), newest last. Made for polling: keep the
`nextCursor` from each response and pass it next time to get only what is new. The order is the
order the database stored them in, so messages that arrive at the same moment are never skipped.

| Query | |
| --- | --- |
| `mailbox` | A mailbox ID, or `all` (default) |
| `direction` | `in` (received) or `out` (sent) |
| `folder` | `inbox`, `archive`, `spam` or `trash` |
| `cursor` | `nextCursor` from the previous response. Treat it as an opaque string. |
| `since` | Instead of `cursor`, on the first request: start with messages from this time (milliseconds since the epoch). `since=<now>` returns nothing yet and a cursor to poll from. Without either, polling starts at the oldest message. |
| `limit` | 1–100, default 50 |

```json
{
  "messages": [{
    "id": 7215, "threadId": 7210, "mailboxId": 3, "folder": "inbox", "direction": "in", "status": "received",
    "messageId": "CAF...@mail.example.net", "from": { "name": "Ann", "address": "ann@example.net" },
    "to": [{ "name": "", "address": "billing@example.com" }], "cc": [], "subject": "Re: Invoice 1042",
    "snippet": "Thanks, paid today.", "sentAt": 1762412400000, "receivedAt": 1762412403120, "isRead": false, "hasAttachments": false
  }],
  "nextCursor": "48211"
}
```

`nextCursor` is always present, also when nothing new arrived, so a poller can store it and ask
again later. A message moved to another folder after it was listed isn't listed again, and
`status` and `folder` are as they were when listed: read the message for its current state.

### `GET /messages/{id}` · `read`

One message with its bodies and attachments: everything in the list item, plus `bcc` (sent mail
only), `replyTo`, `text`, `html`, `auth` (SPF, DKIM and DMARC results of received mail),
`spamReason`, `error`, `sendAt` and `attachments` (`id`, `filename`, `contentType`, `size`,
`inline`, `contentId`, `stored`), and `tracking`: opens and clicks of mail sent while tracking
was on (see [Tracking](#tracking)), else `null`. `html` is the original HTML: sanitize it before
showing it in a browser.

### `GET /messages/{id}/events` · `read`

Opens and clicks of a message you sent: `{ "summary": {...}, "events": [...] }`, events newest
first. See [Tracking](#tracking).

### `GET /attachments/{id}` · `read`

The attachment's bytes, with its content type and a `Content-Disposition: attachment` header.
Attachments of received mail are kept only when attachment storage is on, or for messages under
950 KB.

### `GET /threads` · `read`

Conversations in a view, newest first.

| Query | |
| --- | --- |
| `mailbox` | A mailbox ID, or `all` (default) |
| `view` | `inbox` (default), `sent`, `drafts`, `starred`, `snoozed`, `archive`, `allmail`, `spam` or `trash` |
| `cursor` | `nextCursor` from the previous page |
| `limit` | 1–100, default 50 |

### `GET /threads/{id}` · `read`

A conversation and its messages (up to 300), as in `GET /messages/{id}`. Very large HTML bodies
may be `null` with `htmlDeferred: true`; fetch those with `GET /messages/{id}`.

### `GET /search` · `read`

Searches like the web app: `?q=invoice from:ann has:attachment before:2026-01-01`, optional
`mailbox` and `limit`. Returns `{ "threads": [...] }`.

### `POST /threads/actions` · `modify`

```json
{ "threadIds": [7210], "action": "archive" }
```

`action` is one of `read`, `unread`, `star`, `unstar`, `archive`, `inbox`, `spam`, `notspam`,
`trash`, `snooze` (with `until`, milliseconds), `unsnooze`, `label` and `unlabel` (with
`labelId`). Threads outside the key's mailboxes are skipped; the response says how many were
changed: `{ "ok": true, "count": 1 }`.

## Tracking

An admin can turn on tracking for the whole instance in **Admin → Settings → Open and click
tracking**. It is off by default. While it is on, every message people send, from the web app or
the API, is tracked: you see when it is opened and its links clicked, in the web app under the
message and here. There is no per-message choice. The sent copy gets a 1×1 image
and its `http(s)` links point to `https://<your OpenInbox address>/api/t/...`, which records the
click and redirects. The copy shown in your Sent mail is the original; the downloadable .eml is the
copy that was sent, so opening it in a mail app may count as an open. Links keep redirecting for a
year after sending, also if you delete the message. A plain-text message gets
an HTML part, since tracking needs one. System mail (auto-replies, unsubscribe requests) is not
tracked, and neither are links in quoted or forwarded mail: those were written by someone else, and
redirecting them through your address would let an outsider borrow it.

Opens and clicks are noisy, so every hit gets a `source`:

| Source | What it is | Counted as |
| --- | --- | --- |
| `human` | A mail app or browser, as far as can be told | A person |
| `proxy` | A provider's image proxy fetching for a reader (Gmail, Outlook.com) | A person, but the device and repeat opens are hidden |
| `apple` | Apple Mail Privacy Protection, which loads the images of every message it receives | A machine: the message arrived, nothing more |
| `scanner` | Security scanners and bots that follow links before anyone reads them, `HEAD` requests, and clicks within 10 seconds of sending | A machine |

The summary counts people and machines apart:

```json
{
  "opened": 2, "firstOpenedAt": 1762413000000, "lastOpenedAt": 1762420000000, "machineOpens": 1,
  "clicked": 1, "firstClickedAt": 1762413100000, "machineClicks": 3,
  "links": [{ "url": "https://example.com/pricing", "clicks": 1 }]
}
```

Each event has `kind` (`open` or `click`), `source`, `url` (for clicks), `ip`, `userAgent`,
`country` and `at`. A message records at most 300 events (links keep redirecting after that), and
events are deleted after 180 days.

Keep in mind:

- Tracking is a guess, not proof: images may be blocked (no open recorded), a forwarded
  message reports its new reader's opens, and a message to several people counts all of them
  together.
- Tracking pixels and redirected links make spam filters more suspicious, especially for cold
  mail from a new domain. Replies are the more reliable signal.
- Some laws (for example GDPR and ePrivacy in the EU) require consent for tracking pixels.

## Example: answer new mail from a script

```js
const BASE = 'https://mail.example.com/api/v1';
const headers = { Authorization: `Bearer ${process.env.OPENINBOX_KEY}`, 'Content-Type': 'application/json' };
const api = async (path, init) => (await fetch(BASE + path, { headers, ...init })).json();

// Run every minute or so. The cursor is kept between runs, e.g. in a file.
let cursor = await loadCursor();
const query = cursor ? `cursor=${cursor}` : `since=${Date.now()}`;
const { messages, nextCursor } = await api(`/messages?direction=in&folder=inbox&${query}`);
const { mailboxes } = await api('/mailboxes');
for (const m of messages) {
  // Reply from the mailbox's own address: the mail may have come to an alias, Cc or Bcc.
  const from = mailboxes.find((b) => b.id === m.mailboxId).address;
  await api('/messages', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': `ack-${m.id}` },
    body: JSON.stringify({ from, to: [m.from], subject: `Re: ${m.subject}`, text: 'Thanks, we got your message.', inReplyTo: m.id }),
  });
}
await saveCursor(nextCursor);
```
