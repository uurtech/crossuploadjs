import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';

let app, base, dir;
const SECRET = 'sk_test_secret';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'crossupload-'));
  const config = loadConfig({ SECRET_KEY: SECRET, DATA_DIR: dir, PORT: '1', MAX_FILE_SIZE_MB: '1', MAX_FILES: '2', DEMO: 'true' });
  app = createApp(config);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  config.publicUrl = base;
});

after(async () => {
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const createSession = (body = {}) => fetch(`${base}/v1/sessions`, {
  method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('sessions need the secret key', async () => {
  const res = await fetch(`${base}/v1/sessions`, { method: 'POST', headers: { Authorization: 'Bearer nope' } });
  assert.equal(res.status, 401);
});

test('device upload: accepted PNG, rejected HTML disguised as PDF, size and count limits', async () => {
  const s = await (await createSession({ externalReference: 'order-1' })).json();
  const put = (body, name, auth = s.clientToken) => fetch(`${base}/v1/sessions/${s.sessionId}/files`, {
    method: 'PUT', body, headers: { Authorization: `Bearer ${auth}`, 'X-File-Name': encodeURIComponent(name) },
  });

  assert.equal((await put(PNG, 'a.png', 'ct_wrong')).status, 401);

  const ok = await put(PNG, 'photo.png');
  assert.equal(ok.status, 201);
  const file = await ok.json();
  assert.equal(file.status, 'accepted');
  assert.equal(file.mime, 'image/png');

  const bad = await (await put(Buffer.from('<html><script>x</script></html>'), 'invoice.pdf')).json();
  assert.equal(bad.status, 'rejected');

  assert.equal((await put(Buffer.alloc(2 * 1024 * 1024, 1), 'big.png')).status, 413);

  await put(PNG, 'second.png');
  assert.equal((await put(PNG, 'third.png')).status, 409);

  const meta = await (await fetch(`${base}/v1/files/${file.id}`, { headers: { Authorization: `Bearer ${SECRET}` } })).json();
  assert.equal(meta.externalReference, 'order-1');
  assert.equal(meta.sessionId, s.sessionId);
  assert.match(meta.sha256, /^[0-9a-f]{64}$/);

  const content = await fetch(`${base}/v1/files/${file.id}/content`, { headers: { Authorization: `Bearer ${SECRET}` } });
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), PNG);
});

test('phone pairing is single use and delivers to the desktop over SSE', async () => {
  const s = await (await createSession()).json();
  const auth = { Authorization: `Bearer ${s.clientToken}` };
  const pair = await (await fetch(`${base}/v1/sessions/${s.sessionId}/pair`, { method: 'POST', headers: auth })).json();
  assert.match(pair.qrSvg, /<svg/);
  const pairToken = new URL(pair.url).hash.slice(1);

  const claim = (t) => fetch(`${base}/v1/phone/claim`, { method: 'POST', body: JSON.stringify({ pairToken: t }) });
  const claimed = await (await claim(pairToken)).json();
  assert.ok(claimed.phoneToken);
  assert.equal((await claim(pairToken)).status, 410, 'a used QR code cannot be claimed again');

  // The long-lived client token is not accepted in the URL any more.
  assert.equal((await fetch(`${base}/v1/sessions/${s.sessionId}/events?token=${s.clientToken}`)).status, 401);
  const { ticket } = await (await fetch(`${base}/v1/sessions/${s.sessionId}/events-ticket`, { method: 'POST', headers: auth })).json();
  const ctrl = new AbortController();
  const events = await fetch(`${base}/v1/sessions/${s.sessionId}/events?ticket=${ticket}`, { signal: ctrl.signal });
  const reader = events.body.getReader();

  const up = await fetch(`${base}/v1/phone/files`, {
    method: 'PUT', body: PNG, headers: { Authorization: `Bearer ${claimed.phoneToken}`, 'X-File-Name': 'IMG_2041.png' },
  });
  assert.equal(up.status, 201);

  let text = '';
  while (!text.includes('"status":"accepted"')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /"source":"phone"/);
  ctrl.abort();

  assert.equal((await fetch(`${base}/v1/sessions/${s.sessionId}/events?ticket=${ticket}`)).status, 401, 'a ticket works once');
  // Phone tokens are stored hashed, never as the bearer value itself.
  assert.ok(!app.store.phones.has(claimed.phoneToken));
});

test('rejected uploads cannot repeat forever', async () => {
  const s = await (await createSession()).json();
  const put = () => fetch(`${base}/v1/sessions/${s.sessionId}/files`, {
    method: 'PUT', body: Buffer.from('MZ fake exe'), headers: { Authorization: `Bearer ${s.clientToken}`, 'X-File-Name': 'x.exe' },
  });
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await put()).status);
  // MAX_FILES is 2 in this suite, so 6 attempts, then 429.
  assert.deepEqual(codes, [422, 422, 422, 422, 422, 422, 429, 429]);
});

test('production refuses the demo, a weak secret and * origins', () => {
  const base = { NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://shop.example', DATA_DIR: dir };
  const strong = 'x'.repeat(32);
  assert.throws(() => loadConfig({ ...base, SECRET_KEY: 'short' }), /32/);
  assert.throws(() => loadConfig({ ...base, SECRET_KEY: strong, DEMO: 'true' }), /DEMO/);
  assert.throws(() => loadConfig({ ...base, SECRET_KEY: strong, ALLOWED_ORIGINS: '*' }), /ALLOWED_ORIGINS/);
  const ok = loadConfig({ ...base, SECRET_KEY: strong });
  assert.equal(ok.demo, false);
});

test('serves the widget and the phone page', async () => {
  assert.match(await (await fetch(`${base}/v1/widget.js`)).text(), /CrossUpload/);
  const phone = await fetch(`${base}/p`);
  assert.match(phone.headers.get('content-security-policy'), /default-src 'self'/);
});
