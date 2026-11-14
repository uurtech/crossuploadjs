# CrossUpload core

**Let users upload files from their phone into your web form.**

CrossUpload puts a QR code next to the file input on your website. The user scans it,
picks a photo or document on the phone, and the file appears in the form on their
computer. Your backend gets a file ID it can check and download.

This is the open-source core of [CrossUpload](https://crossupload.com), MIT licensed.
It runs anywhere Node.js runs, with one dependency (`qrcode`).

```
┌────────────── computer ──────────────┐        ┌──────── phone ────────┐
│  Your form                           │  scan  │  /p  (hosted by this  │
│  [Upload a file] ──▶ widget modal ───┼──QR──▶ │       server)         │
│                      ▲               │        │  [Choose a photo]     │
│  hidden input: ["file_…"]  ◀── SSE ──┼────────┼── upload ─────────────┘
└──────────────────────────────────────┘
          │ submit                       crossupload-core
          ▼                              (sessions, pairing, type checks,
   your backend ── GET /v1/files/:id ──▶  storage, live events)
```

## Quick start

```bash
git clone https://github.com/uurtech/crossuploadjs.git
cd crossuploadjs
npm install
npm start
```

Open http://localhost:4000. That page is a demo form with the widget attached. Click
**Upload a file**, then pick a file on the computer or scan the QR code with a phone on
the same Wi-Fi.

On start the server prints the URL that QR codes point to (your LAN IP by default) and a
temporary `SECRET_KEY`. Copy `.env.example` to `.env` to set your own values.

Requires Node.js 18.17 or newer.

Or install it as a package and run it inside your own project:

```bash
npm install crossupload-core
npx crossupload-core
```

## Add it to your site

### 1. Your backend: a session endpoint

Your server creates an upload session with the secret key and hands the result to the
browser. The secret key never reaches the browser.

```js
// Express example
app.post('/api/crossupload/session', requireLogin, async (req, res) => {
  const r = await fetch('https://uploads.example.com/v1/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CROSSUPLOAD_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      allowedTypes: ['application/pdf', 'image/*'], // optional, can only narrow ALLOWED_TYPES
      maxFileSize: 5 * 1024 * 1024,                 // optional, bytes
      maxFiles: 3,                                  // optional
      externalReference: `user:${req.user.id}`,     // optional, returned with every file
    }),
  });
  res.status(r.status).json(await r.json());
});
```

### 2. Your page: the widget

```html
<button type="button" id="upload">Upload a file</button>
<input type="hidden" id="attachments" name="attachment_ids" value="[]">

<script src="https://uploads.example.com/v1/widget.js"></script>
<script>
  CrossUpload.attach({
    target: '#upload',
    sessionEndpoint: '/api/crossupload/session',
    resultInput: '#attachments',       // gets a JSON array of accepted file IDs
    locale: 'en',                      // 'en' or 'tr'; defaults to the browser language
    onChange({ files }) {},            // every time the accepted list changes
    onComplete({ files }) {},          // when the user clicks Done
    onError({ code, message }) {},
  });
</script>
```

The widget talks to the server it was loaded from. Pass `server: 'https://…'` to override.

### 3. Your form handler: verify every ID

Never trust IDs from the browser. Look each one up with the secret key:

```js
const ids = JSON.parse(req.body.attachment_ids);
for (const id of ids) {
  const file = await fetch(`https://uploads.example.com/v1/files/${id}`, {
    headers: { Authorization: `Bearer ${process.env.CROSSUPLOAD_SECRET_KEY}` },
  }).then((r) => r.json());
  if (file.status !== 'accepted' || file.externalReference !== `user:${req.user.id}`) throw new Error('bad file');
  // Download it: GET /v1/files/:id/content
}
```

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/sessions` | secret key | Create a session. Returns `sessionId`, `clientToken`, limits. |
| `GET` | `/v1/files/:id` | secret key | File metadata: `status`, `mime`, `size`, `sha256`, `sessionId`, `externalReference`. |
| `GET` | `/v1/files/:id/content` | secret key | Download the file. |
| `DELETE` | `/v1/files/:id` | secret key | Delete the file now. |
| `GET` | `/v1/sessions/:id` | client token | Session limits and files (used by the widget). |
| `POST` | `/v1/sessions/:id/pair` | client token | New single-use QR code (`qrSvg`, `url`, `expiresAt`). |
| `GET` | `/v1/sessions/:id/events?token=` | client token | Server-sent events, one `file` event per change. |
| `PUT` | `/v1/sessions/:id/files` | client token | Upload from the computer. Raw body, name in `X-File-Name`. |
| `POST` | `/v1/phone/claim` | pairing token | Exchange the QR token for a phone token (once). |
| `PUT` | `/v1/phone/files` | phone token | Upload from the phone. |
| `GET` | `/v1/widget.js`, `/p` | none | Widget script and phone page. |

Auth is `Authorization: Bearer <token>`. Errors look like
`{ "error": { "code": "file_too_large", "message": "…" } }`.

A file goes `checking` → `accepted` or `rejected` (with a `reason`).

## What the core checks

* **Real file type from the bytes**, not the name or the browser. An HTML page renamed to
  `invoice.pdf` is rejected.
* **Always rejected:** executables (Windows, Linux, macOS), shell scripts, HTML and SVG.
* **Your limits:** type allow-list, size (enforced while streaming), file count. A session
  can narrow the server limits but never widen them.
* **Separate credentials:** the secret key stays on your server; the browser gets a
  session-scoped client token; the phone gets its own token.
* **Single-use, expiring QR codes.** The pairing token travels in the URL fragment, so it
  never shows up in server or proxy logs, and the phone page removes it from the address bar.
* **Retention:** files are deleted after `FILE_TTL_HOURS` (24 by default).

## Configuration

Set in the environment or in `.env` (see `.env.example`).

| Variable | Default | |
|---|---|---|
| `PORT` | `4000` | |
| `PUBLIC_URL` | `http://<LAN IP>:PORT` | What QR codes point to. Must be reachable from the phone. |
| `SECRET_KEY` | random (dev only) | Required in production. |
| `ALLOWED_ORIGINS` | `*` | Comma-separated site origins. `*` is refused in production. |
| `ALLOWED_TYPES` | JPG, PNG, HEIC, WEBP, PDF | MIME types, `image/*` or `.pdf`. |
| `MAX_FILE_SIZE_MB` | `10` | |
| `MAX_FILES` | `5` | Per session. |
| `DATA_DIR` | `./data` | Files and `db.json`. |
| `FILE_TTL_HOURS` | `24` | |
| `SESSION_TTL_MINUTES` | `30` | |
| `DEMO` | `true` (`false` in production) | Serves the demo form at `/`. |
| `NODE_ENV` | | `production` turns on the checks above. |

## Production

* Put it behind HTTPS (nginx, Caddy, a load balancer). Phone cameras open the QR link in
  the browser, and many browser features need HTTPS.
* Set `NODE_ENV=production`, `SECRET_KEY`, `PUBLIC_URL` and `ALLOWED_ORIGINS`.
* Turn off proxy buffering for `/v1/sessions/*/events` (the server sends
  `X-Accel-Buffering: no` for nginx).
* The store is a JSON file in one process. For several instances, replace `src/store.js`
  with a database and a shared event bus.
* There is no virus scanning or rate limiting in the core. Add ClamAV and a rate limiter in
  front if you accept files from the public.

### Embedding in your own Node app

```js
import { createApp, loadConfig } from 'crossupload-core';
const { server, createSession } = createApp(loadConfig({ PORT: '4000' }));
server.listen(4000);
```

## Hosted version

[crossupload.com](https://crossupload.com) runs the same flow as a service and adds
ClamAV scanning, private S3 storage with immutable delivery copies, signed webhooks,
a dashboard with projects and API keys, and usage-based plans with a free tier.

## Development

```bash
npm run dev   # restarts on change
npm test      # unit + end-to-end tests (node:test, no extra dependencies)
```

## License

MIT
