const test = require('node:test');
const assert = require('node:assert');

// Point the store at a throwaway file so the real data/store.json is untouched
process.env.DATA_FILE = require('path').join(require('os').tmpdir(), `ppd-test-${process.pid}.json`);
process.env.SMS_PROVIDER = 'none';

const server = require('../server');

test('email validation accepts real addresses and rejects malformed ones', () => {
  ['staff@polymer.edu', 'a.b+tag@sub.domain.co.in'].forEach((value) => {
    assert.strictEqual(server.isValidEmail(value), true, `${value} should be valid`);
  });

  ['', null, 'plainstring', 'no@tld', '@nouser.com', 'user@', 'two@@at.com', 'spaces in@mail.com']
    .forEach((value) => {
      assert.strictEqual(server.isValidEmail(value), false, `${value} should be rejected`);
    });
});

test('phone validation accepts 7-15 digits and rejects junk', () => {
  ['9876543210', '+919876543210', '98765 43210', '(+91) 98765-43210'].forEach((value) => {
    assert.strictEqual(server.isValidPhone(value), true, `${value} should be valid`);
  });

  ['', null, 'abc', '12345', '12345678901234567890', 'phone']
    .forEach((value) => {
      assert.strictEqual(server.isValidPhone(value), false, `${value} should be rejected`);
    });
});

test('phone numbers are normalised for the gateway', () => {
  assert.strictEqual(server.normalizePhone('(+91) 98765-43210'), '+919876543210');
  assert.strictEqual(server.normalizePhone('98765 43210'), '9876543210');
});

test('secrets are stripped from error text', () => {
  const original = server.NOTIFY.email.pass;
  server.NOTIFY.email.pass = 'super-secret-password';

  const cleaned = server.redact('SMTP error: auth failed for super-secret-password (5.7.8)');
  assert.ok(cleaned.includes('***'), 'the secret should be masked');
  assert.ok(!cleaned.includes('super-secret-password'), 'the secret must not survive');

  server.NOTIFY.email.pass = original;
});

test('redaction masks auth headers and truncates long output', () => {
  assert.ok(!server.redact('Authorization: Bearer abc123def456').includes('abc123def456'));
  assert.ok(!server.redact('?api_key=abcdef123456').includes('abcdef123456'));
  assert.ok(server.redact('x'.repeat(1000)).length <= 301);
});

test('delivery summary distinguishes sent, partial, failed and skipped', () => {
  const emailSent = { channel: 'Email', status: 'sent' };
  const smsSent = { channel: 'SMS', status: 'sent' };
  const smsFailed = { channel: 'SMS', status: 'failed' };
  const smsSkipped = { channel: 'SMS', status: 'skipped' };

  assert.strictEqual(server.summarizeDelivery([]), 'skipped');
  assert.strictEqual(server.summarizeDelivery([emailSent, smsSent]), 'sent');
  assert.strictEqual(server.summarizeDelivery([emailSent, smsFailed]), 'partial');
  assert.strictEqual(server.summarizeDelivery([smsFailed]), 'failed');
  assert.strictEqual(server.summarizeDelivery([smsSkipped]), 'skipped');
  // Email-only setup: SMS is switched off, so its skipped channel must not
  // downgrade a delivered email to "partial".
  assert.strictEqual(server.summarizeDelivery([emailSent, smsSkipped]), 'sent');
});

test('only notifications that can still be delivered are retryable', () => {
  const { isRetryableNotification: retryable } = server;

  assert.strictEqual(retryable({ delivery_status: 'failed' }), true);
  assert.strictEqual(retryable({ delivery_status: 'queued' }), true);
  assert.strictEqual(retryable({ delivery_status: 'partial' }), true);

  // Recorded while no gateway existed: worth another try now that one is on
  assert.strictEqual(retryable({ delivery_status: 'skipped', recipient_email: 'a@b.com' }), true);
  assert.strictEqual(retryable({ delivery_status: 'skipped', recipient_phone: '+919876543210' }), true);

  // Nothing to retry: already delivered, or no contact address at all
  assert.strictEqual(retryable({ delivery_status: 'sent' }), false);
  assert.strictEqual(retryable({ delivery_status: 'skipped' }), false);
  assert.strictEqual(retryable(null), false);
});

test('email template is professional, escaped and carries the task details', () => {
  const rendered = server.renderEmail({
    subject: 'New task assigned: PPD-2026-000001',
    ticket_number: 'PPD-2026-000001',
    body: 'Dear Ramesh Yadav,\n\nA new task has been assigned to you.\n\nTicket: PPD-2026-000001\nType of work: Machine Related'
  });

  assert.ok(rendered.html.includes('Plastic Polymer Testing Department'), 'department header present');
  assert.ok(rendered.html.includes('PPD-2026-000001'), 'ticket number present');
  assert.ok(rendered.html.includes('Type of work: Machine Related'), 'task details present');
  assert.ok(rendered.html.includes('<html'), 'a complete HTML document');
  assert.strictEqual(rendered.text.includes('Type of work: Machine Related'), true, 'plain-text fallback kept');
});

test('email template escapes HTML so a complaint cannot inject markup', () => {
  const rendered = server.renderEmail({
    subject: '<script>alert(1)</script>',
    body: '<img src=x onerror=alert(1)>'
  });

  // No raw tag may survive — angle brackets must be entity-encoded so the
  // browser renders the text instead of executing it.
  assert.ok(!/<script/i.test(rendered.html), 'no live script tag');
  assert.ok(!/<img/i.test(rendered.html), 'no live img tag');
  assert.ok(rendered.html.includes('&lt;script&gt;'), 'escaped script text should be present');
  assert.ok(rendered.html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped img text should be present');
});
