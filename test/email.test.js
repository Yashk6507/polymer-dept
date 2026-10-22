const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { createFakeSmtpServer } = require('./helpers/fake-smtp');

process.env.DATA_FILE = path.join(os.tmpdir(), `ppd-test-email-${process.pid}.json`);
process.env.SMS_PROVIDER = 'none';

// Keep the suite hermetic: a developer's real .env must never route the tests
// to a live provider. These are set before ../server is required.
delete process.env.BREVO_API_KEY;
process.env.EMAIL_PROVIDER = 'smtp';

let fakeSmtp;
let server;

test.before(async () => {
  fakeSmtp = createFakeSmtpServer();
  const port = await fakeSmtp.listen();

  // Configure SMTP to point at the mock before the module reads its config
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USER = 'test@example.com';
  process.env.SMTP_PASS = 'test-password';
  process.env.MAIL_FROM = 'Polymer Department <no-reply@polymer.edu>';

  server = require('../server');
});

test.after(async () => {
  if (fakeSmtp) await fakeSmtp.close();
});

test('SMTP configuration is detected from the environment', () => {
  assert.strictEqual(server.NOTIFY.email.configured, true);
  assert.strictEqual(server.NOTIFY.email.host, '127.0.0.1');
  assert.strictEqual(server.NOTIFY.email.from, 'Polymer Department <no-reply@polymer.edu>');
  assert.deepStrictEqual(server.NOTIFY.email.missing, []);
});

test('a task alert is delivered as a real SMTP message with text and HTML parts', async () => {
  const result = await server.sendEmail(
    'ramesh.yadav@polymer.edu',
    'New task assigned: PPD-2026-000042',
    'Dear Ramesh Yadav,\n\nA new task has been assigned to you.\n\nTicket: PPD-2026-000042\nType of work: Machine Related',
    { ticketNumber: 'PPD-2026-000042' }
  );

  assert.strictEqual(result.status, 'sent', `expected sent, got ${result.status}: ${result.error}`);
  assert.strictEqual(result.channel, 'Email');
  assert.ok(result.provider_id, 'a provider message id should be recorded');

  const delivered = fakeSmtp.messagesTo('ramesh.yadav@polymer.edu');
  assert.strictEqual(delivered.length, 1, 'exactly one message should reach the recipient');
  assert.ok(delivered[0].to.includes('ramesh.yadav@polymer.edu'));
  assert.ok(delivered[0].subject.includes('PPD-2026-000042'), 'subject carries the ticket number');
  assert.ok(delivered[0].text.includes('Type of work: Machine Related'), 'plain-text body carries the task details');
  assert.ok(delivered[0].html.includes('Plastic Polymer Testing Department'), 'HTML part is branded');
  assert.ok(delivered[0].html.includes('PPD-2026-000042'), 'HTML part carries the ticket number');
});

test('an unreachable mail server fails gracefully instead of throwing', async () => {
  // Close the mock so the port refuses connections
  await fakeSmtp.close();
  const closedPort = server.NOTIFY.email.port;

  const result = await server.sendEmail('someone@polymer.edu', 'Test', 'Body');

  assert.strictEqual(result.status, 'failed', 'delivery should be reported as failed');
  assert.ok(result.error, 'a reason should be recorded');
  assert.strictEqual(typeof closedPort, 'number');
});

test('an invalid recipient address is skipped, never sent', async () => {
  const result = await server.sendEmail('not-an-email', 'Test', 'Body');

  assert.strictEqual(result.status, 'skipped');
  assert.match(result.error, /invalid/i);
});

test('a missing recipient address is skipped, never sent', async () => {
  const result = await server.sendEmail(null, 'Test', 'Body');

  assert.strictEqual(result.status, 'skipped');
  assert.match(result.error, /missing or invalid/i);
});

test('delivery errors never leak the SMTP password', async () => {
  const result = await server.sendEmail('someone@polymer.edu', 'Test', 'Body');

  assert.ok(!String(result.error).includes('test-password'), 'the password must not appear in the error');
});
