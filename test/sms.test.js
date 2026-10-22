const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { createFakeSmsProvider } = require('./helpers/fake-sms');

process.env.DATA_FILE = path.join(os.tmpdir(), `ppd-test-sms-${process.pid}.json`);

// Keep the suite hermetic: a developer's real .env must never route the tests
// to a live provider. These are set before ../server is required.
delete process.env.BREVO_API_KEY;
process.env.EMAIL_PROVIDER = 'smtp';

const ACCOUNT_SID = 'AC11111111111111111111111111111111';
const AUTH_TOKEN = 'twilio-test-auth-token';

let fakeProvider;
let baseUrl;
let server;

test.before(async () => {
  fakeProvider = createFakeSmsProvider({
    expectedAuth: `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`
  });
  const port = await fakeProvider.listen();
  baseUrl = `http://127.0.0.1:${port}`;

  process.env.SMS_PROVIDER = 'twilio';
  process.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.TWILIO_FROM_NUMBER = '+15005550006';
  process.env.TWILIO_API_BASE_URL = baseUrl;

  server = require('../server');
});

test.after(async () => {
  if (fakeProvider) await fakeProvider.close();
});

test('SMS configuration is detected from the environment', () => {
  assert.strictEqual(server.NOTIFY.sms.provider, 'twilio');
  assert.strictEqual(server.NOTIFY.sms.configured, true);
  assert.deepStrictEqual(server.NOTIFY.sms.missing, []);
});

test('a task alert is sent to the staff member phone number', async () => {
  const result = await server.sendSms('9876543210', 'PPD-2026-000001 assigned to you.');

  assert.strictEqual(result.status, 'sent', `expected sent, got ${result.status}: ${result.error}`);
  assert.strictEqual(result.channel, 'SMS');
  assert.ok(result.provider_id, 'the provider message id should be recorded');

  const calls = fakeProvider.received.filter((r) => /Messages\.json$/.test(r.url));
  assert.strictEqual(calls.length, 1, 'exactly one provider call should be made');
  assert.strictEqual(calls[0].params.To, '9876543210');
  assert.strictEqual(calls[0].params.From, '+15005550006');
  assert.match(calls[0].params.Body, /PPD-2026-000001/);
});

test('the provider credential is sent, not embedded in the URL', async () => {
  const calls = fakeProvider.received.filter((r) => /Messages\.json$/.test(r.url));
  const expected = `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`;

  assert.strictEqual(calls[0].authorization, expected);
  assert.ok(!calls[0].url.includes(AUTH_TOKEN), 'the auth token must not appear in the URL');
});

test('a rejected send is reported as failed with a redacted reason', async () => {
  const result = await server.sendSms('9876543210', 'Body', {
    request: () => Promise.resolve({
      status: 401,
      body: JSON.stringify({ code: 20003, message: 'Authentication Error' })
    })
  });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /401/);
  assert.ok(!result.error.includes(AUTH_TOKEN), 'the auth token must never be echoed back');
});

test('a gateway timeout is reported as failed, not thrown', async () => {
  const result = await server.sendSms('9876543210', 'Body', {
    request: () => Promise.reject(new Error('Gateway request timed out after 10000ms'))
  });

  assert.strictEqual(result.status, 'failed');
  assert.match(result.error, /timed out/i);
});

test('an invalid phone number is skipped, never sent', async () => {
  const result = await server.sendSms('not-a-phone', 'Body');

  assert.strictEqual(result.status, 'skipped');
  assert.match(result.error, /invalid/i);
});

test('a missing phone number is skipped, never sent', async () => {
  const result = await server.sendSms(null, 'Body');

  assert.strictEqual(result.status, 'skipped');
  assert.match(result.error, /missing or invalid/i);
});

test('gateway verification reports the credentials as good when the provider accepts them', async () => {
  const verified = await server.verifyGateways();

  assert.strictEqual(verified[1].status, 'configured');
  assert.match(verified[1].detail, /twilio/i);
});
