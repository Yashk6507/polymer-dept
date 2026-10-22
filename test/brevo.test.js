const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const nodeHttp = require('http');

// A throwaway store so the real data/store.json is never touched
process.env.DATA_FILE = path.join(os.tmpdir(), `ppd-test-brevo-${process.pid}.json`);
process.env.SMS_PROVIDER = 'none';

const API_KEY = 'xkeysib-test-key-do-not-leak-0001';

/* ---- fake Brevo API (no real network, no real mail) --------------------
 * Mirrors the real ordering: the key is checked first, then the authorised-IP
 * list, and only then is the payload validated. A payload without recipients
 * is therefore rejected with 400 — which is what the gateway probe relies on.
 */
const createFakeBrevo = ({ apiKey = API_KEY, blockIp = false } = {}) => {
  const received = [];

  const server = nodeHttp.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.headers['api-key'] !== apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end('{"message":"Key not found","code":"unauthorized"}');
      }

      if (blockIp) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end('{"message":"We have detected you are using an unrecognised IP address 203.0.113.7.","code":"unauthorized"}');
      }

      const parsed = body ? JSON.parse(body) : null;
      received.push({ url: req.url, method: req.method, body: parsed });

      if (req.url === '/v3/smtp/email') {
        if (!parsed || !Array.isArray(parsed.to) || parsed.to.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end('{"message":"recipients is required","code":"missing_parameter"}');
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end('{"messageId":"<brevo-message-id@polymer.edu>"}');
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });

  return {
    received,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve))
  };
};

let fakeBrevo;
let blockedBrevo;
let blockedPort;
let server;

const deliveries = () => fakeBrevo.received.filter((r) => r.url === '/v3/smtp/email' && r.body && r.body.to);

test.before(async () => {
  fakeBrevo = createFakeBrevo();
  blockedBrevo = createFakeBrevo({ blockIp: true });

  const port = await fakeBrevo.listen();
  blockedPort = await blockedBrevo.listen();

  process.env.BREVO_API_KEY = API_KEY;
  process.env.BREVO_API_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.MAIL_FROM = 'Polymer Department <no-reply@polymer.edu>';

  server = require('../server');
});

test.after(async () => {
  if (fakeBrevo) await fakeBrevo.close();
  if (blockedBrevo) await blockedBrevo.close();
});

test('setting BREVO_API_KEY selects the Brevo provider', () => {
  assert.strictEqual(server.NOTIFY.email.provider, 'brevo');
  assert.strictEqual(server.NOTIFY.email.configured, true);
  assert.deepStrictEqual(server.NOTIFY.email.missing, []);
});

test('a task alert is delivered through the Brevo API', async () => {
  const result = await server.sendEmail(
    'ramesh.yadav@polymer.edu',
    'New task assigned: PPD-2026-000042',
    'Dear Ramesh Yadav,\n\nA new task has been assigned to you.\n\nTicket: PPD-2026-000042',
    { ticketNumber: 'PPD-2026-000042' }
  );

  assert.strictEqual(result.status, 'sent', `expected sent, got ${result.status}: ${result.error}`);
  assert.strictEqual(result.channel, 'Email');
  assert.strictEqual(result.provider_id, '<brevo-message-id@polymer.edu>');

  const sent = deliveries()[0];
  assert.deepStrictEqual(sent.body.to, [{ email: 'ramesh.yadav@polymer.edu' }]);
  assert.deepStrictEqual(sent.body.sender, { name: 'Polymer Department', email: 'no-reply@polymer.edu' });
  assert.ok(sent.body.subject.includes('PPD-2026-000042'));
  assert.ok(sent.body.htmlContent.includes('Plastic Polymer Testing Department'), 'the HTML template is used');
  assert.ok(sent.body.textContent.includes('PPD-2026-000042'), 'the plain-text part is sent too');
});

test('the API key travels in the header, never in the URL', async () => {
  await server.sendEmail('someone@polymer.edu', 'Subject', 'Body');

  const last = fakeBrevo.received[fakeBrevo.received.length - 1];
  assert.ok(!last.url.includes(API_KEY), 'the key must not be embedded in the URL');
});

test('a rejected API key is reported as failed with a redacted reason', async () => {
  const original = server.NOTIFY.email.apiKey;
  server.NOTIFY.email.apiKey = 'xkeysib-wrong-key-9999';

  try {
    const result = await server.sendEmail('someone@polymer.edu', 'Subject', 'Body');
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error, 'a reason should be recorded');
    assert.ok(!String(result.error).includes('xkeysib-wrong-key-9999'), 'the key must never be echoed');
  } finally {
    server.NOTIFY.email.apiKey = original;
  }
});

test('an unreachable Brevo API is reported as failed, not thrown', async () => {
  const original = server.NOTIFY.email.apiBaseUrl;
  server.NOTIFY.email.apiBaseUrl = 'http://127.0.0.1:9';

  try {
    const result = await server.sendEmail('someone@polymer.edu', 'Subject', 'Body');
    assert.strictEqual(result.status, 'failed');
  } finally {
    server.NOTIFY.email.apiBaseUrl = original;
  }
});

test('an IP-blocked send names the address and the page that fixes it', async () => {
  const originalUrl = server.NOTIFY.email.apiBaseUrl;
  const originalKey = server.NOTIFY.email.apiKey;
  server.NOTIFY.email.apiKey = API_KEY;
  server.NOTIFY.email.apiBaseUrl = `http://127.0.0.1:${blockedPort}`;

  try {
    const result = await server.sendEmail('ramesh.yadav@polymer.edu', 'Subject', 'Body');
    assert.strictEqual(result.status, 'failed');
    assert.match(result.error, /blocked this server's IP 203\.0\.113\.7/i, 'the admin must be told which IP was blocked');
    assert.match(result.error, /app\.brevo\.com\/security\/authorised_ips/, 'the fix must be linked, not truncated');
  } finally {
    server.NOTIFY.email.apiBaseUrl = originalUrl;
    server.NOTIFY.email.apiKey = originalKey;
  }
});

test('a send refused for a blocked IP corrects the gateway banner, a bad recipient does not', async () => {
  const originalUrl = server.NOTIFY.email.apiBaseUrl;
  const originalKey = server.NOTIFY.email.apiKey;
  server.NOTIFY.email.apiKey = API_KEY;
  server.NOTIFY.email.apiBaseUrl = `http://127.0.0.1:${blockedPort}`;

  try {
    // Verification first, so we start from a healthy banner the way a real
    // startup would — the address then starts being blocked mid-life.
    server.gatewayHealth.email = { status: 'configured', checked_at: new Date().toISOString(), detail: 'Brevo API credentials accepted' };

    await server.sendEmail('ramesh.yadav@polymer.edu', 'Subject', 'Body');
    assert.strictEqual(server.gatewayHealth.email.status, 'error', 'a refused send must stop the banner claiming "Configured"');
    assert.match(server.gatewayHealth.email.detail, /203\.0\.113\.7/, 'the banner carries the blocked address');
  } finally {
    server.NOTIFY.email.apiBaseUrl = originalUrl;
    server.NOTIFY.email.apiKey = originalKey;
    server.gatewayHealth.email = { status: 'unchecked', checked_at: null, detail: null };
  }
});

test('a single bad recipient does not mark the whole email gateway as broken', async () => {
  // Brevo answers a recipient-less payload with 400. That is one bad message,
  // not a dead gateway, so the banner must be left alone.
  server.gatewayHealth.email = { status: 'configured', checked_at: new Date().toISOString(), detail: 'Brevo API credentials accepted' };

  const response = { status: 400, body: '{"message":"recipients is required","code":"missing_parameter"}' };
  await server.sendEmail('someone@polymer.edu', 'Subject', 'Body', { request: async () => response });

  assert.strictEqual(server.gatewayHealth.email.status, 'configured', 'a 400 is about one message, not the gateway');
  server.gatewayHealth.email = { status: 'unchecked', checked_at: null, detail: null };
});

test('an invalid recipient is skipped, never sent', async () => {
  const before = deliveries().length;
  const result = await server.sendEmail('not-an-email', 'Subject', 'Body');

  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(deliveries().length, before, 'nothing should reach Brevo');
});

test('gateway verification accepts good Brevo credentials without sending mail', async () => {
  const before = deliveries().length;
  const [email] = await server.verifyGateways();

  assert.strictEqual(email.status, 'configured', email.detail);
  assert.strictEqual(deliveries().length, before, 'the probe must never deliver a message');

  // The probe is a recipient-less request, which Brevo answers with 400
  const probe = fakeBrevo.received.filter((r) => r.url === '/v3/smtp/email' && !(r.body && r.body.to));
  assert.ok(probe.length > 0, 'the probe should hit the send endpoint');
});

test('gateway verification reports an error when Brevo rejects the key', async () => {
  const original = server.NOTIFY.email.apiKey;
  server.NOTIFY.email.apiKey = 'xkeysib-bad-key-1234';

  try {
    const [email] = await server.verifyGateways();
    assert.strictEqual(email.status, 'error');
    assert.match(email.detail, /Key not found/i);
    assert.ok(!String(email.detail).includes('xkeysib-bad-key-1234'), 'the bad key must not be echoed');
  } finally {
    server.NOTIFY.email.apiKey = original;
  }
});

test('gateway verification explains a blocked IP address', async () => {
  const originalKey = server.NOTIFY.email.apiKey;
  const originalUrl = server.NOTIFY.email.apiBaseUrl;
  server.NOTIFY.email.apiKey = API_KEY;
  server.NOTIFY.email.apiBaseUrl = `http://127.0.0.1:${blockedPort}`;

  try {
    const [email] = await server.verifyGateways();
    assert.strictEqual(email.status, 'error');
    assert.match(email.detail, /203\.0\.113\.7/, 'the blocked address must be named');
    assert.match(email.detail, /app\.brevo\.com\/security\/authorised_ips/, 'and the page that fixes it must be linked');
  } finally {
    server.NOTIFY.email.apiKey = originalKey;
    server.NOTIFY.email.apiBaseUrl = originalUrl;
  }
});

test('a MAIL_FROM of bare address form is understood', () => {
  assert.strictEqual(server.senderEmail('plasticpolydepartment@gmail.com'), 'plasticpolydepartment@gmail.com');
  assert.deepStrictEqual(server.senderParts('plasticpolydepartment@gmail.com'), { email: 'plasticpolydepartment@gmail.com' });
  assert.strictEqual(server.senderEmail('not an address'), null);
});
