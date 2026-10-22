const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

process.env.DATA_FILE = path.join(os.tmpdir(), `ppd-test-deliver-${process.pid}.json`);
process.env.SMS_PROVIDER = 'none';

const server = require('../server');

const sent = (channel) => ({ channel, status: 'sent', provider_id: `${channel}-id` });
const failed = (channel) => ({ channel, status: 'failed', error: `${channel} rejected` });
const skipped = (channel) => ({ channel, status: 'skipped', error: `${channel} not configured` });

const makeMessage = (overrides = {}) => ({
  id: 1,
  recipient_id: 5,
  recipient_name: 'Ramesh Yadav',
  recipient_email: 'ramesh.yadav@polymer.edu',
  recipient_phone: '9876500009',
  delivery_channel: 'Email + SMS',
  delivery_status: 'queued',
  delivery_attempts: [],
  subject: 'New task assigned: PPD-2026-000001',
  body: 'Ticket: PPD-2026-000001',
  ticket_number: 'PPD-2026-000001',
  ...overrides
});

const noop = () => {};

test('a fully successful delivery is recorded as sent on both channels', async () => {
  const message = makeMessage();

  await server.deliverMessage(message, {
    sendEmail: async () => sent('Email'),
    sendSms: async () => sent('SMS'),
    persist: noop
  });

  assert.strictEqual(message.delivery_status, 'sent');
  assert.deepStrictEqual(message.delivery_attempts.map((a) => a.channel), ['Email', 'SMS']);
  assert.ok(message.delivered_at, 'a delivery timestamp should be stored');
});

test('when no gateway is configured the message is kept but marked skipped', async () => {
  const message = makeMessage();

  await server.deliverMessage(message, {
    sendEmail: async () => skipped('Email'),
    sendSms: async () => skipped('SMS'),
    persist: noop
  });

  assert.strictEqual(message.delivery_status, 'skipped', 'configuration must never masquerade as delivery');
  assert.strictEqual(message.delivery_attempts.length, 2);
});

test('a half-delivered message is reported as partial', async () => {
  const message = makeMessage();

  await server.deliverMessage(message, {
    sendEmail: async () => sent('Email'),
    sendSms: async () => failed('SMS'),
    persist: noop
  });

  assert.strictEqual(message.delivery_status, 'partial');
});

test('email-only mode: a delivered email is reported as sent, not partial', async () => {
  const message = makeMessage();

  await server.deliverMessage(message, {
    sendEmail: async () => sent('Email'),
    sendSms: async () => skipped('SMS'),
    persist: noop
  });

  assert.strictEqual(message.delivery_status, 'sent', 'an unconfigured SMS channel must not mark the email as partial');
  assert.deepStrictEqual(message.delivery_attempts.map((a) => a.channel), ['Email', 'SMS']);
});

test('a wholly failed delivery is reported as failed', async () => {
  const message = makeMessage();

  await server.deliverMessage(message, {
    sendEmail: async () => failed('Email'),
    sendSms: async () => failed('SMS'),
    persist: noop
  });

  assert.strictEqual(message.delivery_status, 'failed');
});

test('a recipient with no contact details is recorded without any send attempt', async () => {
  const message = makeMessage({ recipient_email: null, recipient_phone: null });
  let calls = 0;

  await server.deliverMessage(message, {
    sendEmail: async () => { calls += 1; return sent('Email'); },
    sendSms: async () => { calls += 1; return sent('SMS'); },
    persist: noop
  });

  assert.strictEqual(calls, 0, 'nothing should be attempted without a contact');
  assert.strictEqual(message.delivery_status, 'skipped');
});

test('retrying a partial delivery resends only the failed channel', async () => {
  const message = makeMessage();
  const attempted = [];

  // First attempt: email works, SMS fails
  await server.deliverMessage(message, {
    sendEmail: async () => { attempted.push('Email'); return sent('Email'); },
    sendSms: async () => { attempted.push('SMS'); return failed('SMS'); },
    persist: noop
  });
  assert.strictEqual(message.delivery_status, 'partial');

  // Retry: the SMS gateway is healthy now
  await server.deliverMessage(message, {
    sendEmail: async () => { attempted.push('Email'); return sent('Email'); },
    sendSms: async () => { attempted.push('SMS'); return sent('SMS'); },
    persist: noop
  });

  assert.deepStrictEqual(attempted, ['Email', 'SMS', 'SMS'], 'the staff member must not get the email twice');
  assert.strictEqual(message.delivery_status, 'sent');
  assert.strictEqual(message.delivery_attempts.length, 2, 'successes are carried over, not duplicated');
});

test('retrying an already delivered message sends nothing at all', async () => {
  const message = makeMessage();

  await server.deliverMessage(message, {
    sendEmail: async () => sent('Email'),
    sendSms: async () => sent('SMS'),
    persist: noop
  });

  let calls = 0;
  await server.deliverMessage(message, {
    sendEmail: async () => { calls += 1; return sent('Email'); },
    sendSms: async () => { calls += 1; return sent('SMS'); },
    persist: noop
  });

  assert.strictEqual(calls, 0, 'no duplicate notification may be sent');
  assert.strictEqual(message.delivery_status, 'sent');
});

test('recordMessage stores the recipient phone and email and starts as queued', () => {
  const message = server.recordMessage(
    { id: 42, name: 'Ramesh Yadav', email: 'ramesh.yadav@polymer.edu', phone: '9876500009' },
    { subject: 'New task assigned: PPD-2026-000007', body: 'Body text', kind: 'assignment', complaint: { id: 7, ticket_number: 'PPD-2026-000007' } }
  );

  assert.strictEqual(message.recipient_email, 'ramesh.yadav@polymer.edu');
  assert.strictEqual(message.recipient_phone, '9876500009');
  assert.strictEqual(message.delivery_channel, 'Email + SMS');
  assert.strictEqual(message.delivery_status, 'queued');
  assert.strictEqual(message.ticket_number, 'PPD-2026-000007');
  assert.strictEqual(message.read_status, false);
  assert.ok(message.created_at);
});

test('recordMessage only reports the channels that have a contact on file', () => {
  const phoneOnly = server.recordMessage(
    { id: 43, name: 'Phone Only', email: null, phone: '9876500009' },
    { subject: 's', body: 'b', kind: 'assignment', complaint: null }
  );
  assert.strictEqual(phoneOnly.delivery_channel, 'SMS');

  const emailOnly = server.recordMessage(
    { id: 44, name: 'Email Only', email: 'e@polymer.edu', phone: null },
    { subject: 's', body: 'b', kind: 'assignment', complaint: null }
  );
  assert.strictEqual(emailOnly.delivery_channel, 'Email');
});

test('outbox summary counts each delivery state', () => {
  const original = server.getStore();
  const snapshot = { ...original, messages: [
    { delivery_status: 'sent' },
    { delivery_status: 'sent' },
    { delivery_status: 'failed' },
    { delivery_status: 'partial' },
    { delivery_status: 'queued' },
    { delivery_status: 'skipped' },
    // Recorded while no gateway was configured, but the recipient is reachable
    { delivery_status: 'skipped', recipient_email: 'staff@polymer.edu' }
  ] };

  server.setStore(snapshot);
  const summary = server.outboxSummary();

  assert.strictEqual(summary.total, 7);
  assert.strictEqual(summary.sent, 2);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.partial, 1);
  assert.strictEqual(summary.skipped, 2);
  assert.strictEqual(summary.pending, 1);
  // failed + partial + queued + the reachable skipped message. The contact-less
  // skipped row can never be delivered, so it is not counted.
  assert.strictEqual(summary.retryable, 4, 'everything with an undelivered, reachable channel is retryable');

  server.setStore(original);
});
