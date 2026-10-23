<div align="center">

<img src="src/web/public/icon-192.png" width="72" height="72" alt="">

# OpenInbox

**Your own email on your own domains, running entirely in your free Cloudflare account.**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sums001/OpenInbox)

</div>

![The OpenInbox mail client](docs/screenshots/mail.png)

## Features

- **Receive** on any domain in your Cloudflare account. Email Routing is set up for you.
- **Send** through Resend, Brevo, Mailjet or any SMTP server. DNS records are written for you, and when one provider hits its free limit, mail falls back to another.
- **A full web inbox:** threads, search (`from:` `has:attachment` `before:`), labels, filters, snooze, scheduled and undo send, dark mode, mobile layout.
- **Teams:** multiple users, personal and shared inboxes, aliases, `you+tag@` addressing, catch-all.
- **An admin dashboard** showing traffic, free-tier usage, domain health with one-click repair, and delivery and audit logs.
- **Safe by default:** HTML mail is sanitized and sandboxed, remote images are blocked until you allow them, failed SPF/DKIM/DMARC goes to Spam, two-factor sign-in is optional, and stored credentials are encrypted.

## Deploy

You need a free Cloudflare account, a GitHub account, and a domain on Cloudflare's nameservers. Sending needs a free account with a provider, but receiving works without one.

**1. Create a Cloudflare API token** at [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) with these permissions:

| Scope | Permission | Access | |
| --- | --- | --- | --- |
| Zone | Zone | Read | required |
| Zone | DNS | Edit | required |
| Zone | Email Routing Rules | Edit | required |
| Account | Workers Scripts | Edit | required |
| Account | Account Settings | Read | recommended |
| Zone | Workers Routes | Edit | optional: app on `mail.yourdomain` |
| Zone | Analytics | Read | optional: delivery log |
| Account | Email Routing Addresses | Edit | optional: forwarding |
| Account | Account Analytics | Read | optional: usage on the dashboard |
| Account | Workers R2 Storage | Edit | optional: attachments bucket |

**2. Click Deploy to Cloudflare** and fill in the form:
- `ENCRYPTION_KEY`: a long random secret (e.g. `openssl rand -hex 32`). **Keep a copy.** You need it to claim the deployment and to recover the owner account.
- `CF_API_TOKEN`: the token from step 1.

**3. Open the Worker's `workers.dev` address** and follow the setup page. It creates your admin account and connects your domain.

**4. Connect a sending provider** in Admin → Integrations.

## Free-tier limits

| What | Free limit |
| --- | --- |
| Worker requests | 100,000 / day per account |
| D1 storage | 500 MB, roughly 50,000–100,000 messages |
| Incoming message size | 25 MB |
| Sending | Resend 100/day, Brevo 300/day, Mailjet 200/day |

Mail is stored text-only by default. Attachments are kept only on messages under 950 KB. To keep every attachment, turn on R2 storage in Admin → Integrations → Attachments. R2 has a 10 GB free tier, but Cloudflare requires a payment method on the account first.

## Updating

In your copy of the repo on GitHub, run **Actions → Sync upstream → Run workflow**. It also runs weekly by itself. Cloudflare redeploys automatically and applies database migrations.

## Troubleshooting

- **Mail not arriving or not sending:** start with Admin → Domains → *Check health* and Admin → Mail flow.
- **Locked out of the owner account:** on the sign-in page, choose *Owner locked out?* and enter the owner email and `ENCRYPTION_KEY`.
- **First build failed with D1 error 7404:** click *Retry build* in the Cloudflare dashboard.

## Development

```sh
npm ci
cp .dev.vars.example .dev.vars   # then add the mock API lines below
npm run db:migrate:local
npm run dev:mock                 # terminal 1: mock Cloudflare and provider APIs on :8790
npm run dev                      # terminal 2: app on http://localhost:5173
```

Local `.dev.vars` (never put real credentials here):

```sh
ENCRYPTION_KEY=any-long-random-string-for-local-use
CF_API_TOKEN=dev-token
CF_API_BASE=http://127.0.0.1:8790/cf
RESEND_API_BASE=http://127.0.0.1:8790/resend
BREVO_API_BASE=http://127.0.0.1:8790/brevo
MAILJET_API_BASE=http://127.0.0.1:8790/mailjet
GITHUB_API_BASE=http://127.0.0.1:8790/github
WORKER_NAME=openinbox
```

Before opening a pull request, run `npm run lint && npm run typecheck && npm test && npm run test:e2e`.

Report security issues privately through GitHub's **Security → Report a vulnerability**, not in a public issue.

## License

[MIT](LICENSE)
