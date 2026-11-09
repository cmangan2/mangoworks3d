# MangoWorks3D

Static site (`index.html`) plus a Netlify Functions API (`netlify/functions/api.mjs`) with data in Netlify Blobs.

- `/` — public site. Customers sign in at `/account` with an emailed 6-digit code to track quotes/orders.
- Customer files (up to 100 MB each, 200 MB per request) upload in 3 MB pieces via `/api/uploads` (`netlify/lib/uploads.mjs`), since a function request/response is capped near 6 MB; downloads join the pieces in the browser. A daily scheduled function (`cleanup.mjs`) deletes uploads from forms never submitted.
- `/admin/` — admin app: requests (status, price, message to customer), stock products + photos, materials & colors, site settings, customers.

## Netlify environment variables

| Variable | Value |
|---|---|
| `ADMIN_EMAILS` | Comma-separated emails that get admin access (default: `mangoworks3d@gmail.com`). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Outgoing mail, e.g. Gmail: `smtp.gmail.com` / `465` / `mangoworks3d@gmail.com` / an App Password. |
| `MAIL_FROM` | Optional, e.g. `MangoWorks3D <mangoworks3d@gmail.com>`. |
| `RESEND_API_KEY` | Optional alternative to SMTP (needs a verified domain in Resend). |

Without mail settings, sign-in refuses with a message saying email isn't set up (unless `MW_DEV_SHOW_CODE=1` locally), and notifications are only written to the function log.

## Local development

```
npm install
NODE_OPTIONS= MW_DEV_SHOW_CODE=1 ADMIN_EMAILS=you@example.com netlify dev
```

`MW_DEV_SHOW_CODE=1` (only when no mail is configured) fills the sign-in code in automatically.
