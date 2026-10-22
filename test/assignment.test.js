const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { createFakeSmtpServer } = require('./helpers/fake-smtp');
const { createFakeSmsProvider } = require('./helpers/fake-sms');

// A throwaway store so the real data/store.json is never touched
process.env.DATA_FILE = path.join(os.tmpdir(), `ppd-test-assign-${process.pid}.json`);
process.env.JWT_SECRET = 'test-secret';

// Keep the suite hermetic: a developer's real .env must never route the tests
// to a live provider. These are set before ../server is required.
delete process.env.BREVO_API_KEY;
process.env.EMAIL_PROVIDER = 'smtp';

const ACCOUNT_SID = 'AC22222222222222222222222222222222';
const AUTH_TOKEN = 'twilio-assign-test-token';

let fakeSmtp;
let fakeSms;
let server;
let httpServer;
let baseUrl;

const api = async (route, { method = 'GET', token, body, form } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: form || (body ? JSON.stringify(body) : undefined)
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }
  return { status: response.status, payload };
};

const login = async (email, password) => {
  const { payload } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return payload.token;
};

test.before(async () => {
  fakeSmtp = createFakeSmtpServer();
  fakeSms = createFakeSmsProvider({
    expectedAuth: `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`
  });

  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(await fakeSmtp.listen());
  process.env.SMTP_USER = 'test@example.com';
  process.env.SMTP_PASS = 'test-password';
  process.env.SMTP_SECURE = 'false';
  process.env.MAIL_FROM = 'Polymer Department <no-reply@polymer.edu>';

  process.env.SMS_PROVIDER = 'twilio';
  process.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.TWILIO_FROM_NUMBER = '+15005550006';
  process.env.TWILIO_API_BASE_URL = `http://127.0.0.1:${await fakeSms.listen()}`;

  server = require('../server');
  httpServer = server.startServer(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

test.after(async () => {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  if (fakeSmtp) await fakeSmtp.close();
  if (fakeSms) await fakeSms.close();
});

test('the dashboard reports the gateways as verified, not merely configured', async () => {
  const token = await login('hod@polymer.edu', 'Admin@123');
  const { status, payload } = await api('/api/notifications/gateways', { token });

  assert.strictEqual(status, 200);
  assert.strictEqual(payload.email.configured, true);
  assert.strictEqual(payload.sms.configured, true);
  assert.strictEqual(payload.sms.provider, 'twilio');
});

test('no secret is exposed by the gateway status endpoint', async () => {
  const token = await login('hod@polymer.edu', 'Admin@123');
  const { payload } = await api('/api/notifications/gateways', { token });
  const serialized = JSON.stringify(payload);

  assert.ok(!serialized.includes('test-password'), 'the SMTP password must not be returned');
  assert.ok(!serialized.includes(AUTH_TOKEN), 'the Twilio auth token must not be returned');
  assert.ok(!serialized.includes('SMTP_PASS='), 'no secret env assignment should leak');
});

test('an assigned task alert reaches the chosen staff member on both channels', async () => {
  const hod = await login('hod@polymer.edu', 'Admin@123');
  const student = await login('amit.patel@student.edu', 'Password123');

  // Two staff members, so we can prove the alert goes to the right one
  const ramesh = await api('/api/admin/staff', {
    method: 'POST',
    token: hod,
    body: {
      name: 'Ramesh Yadav',
      email: 'ramesh.yadav@polymer.edu',
      phone: '9876500011',
      role: 'technician',
      user_id: 'TECH-ALPHA',
      password: 'Password123'
    }
  });
  assert.strictEqual(ramesh.status, 201, JSON.stringify(ramesh.payload));

  const meena = await api('/api/admin/staff', {
    method: 'POST',
    token: hod,
    body: {
      name: 'Meena Iyer',
      email: 'meena.iyer@polymer.edu',
      phone: '9876500022',
      role: 'technician',
      user_id: 'TECH-BRAVO',
      password: 'Password123'
    }
  });
  assert.strictEqual(meena.status, 201, JSON.stringify(meena.payload));

  // Raise a complaint as the student
  const form = new FormData();
  form.append('title', 'Universal Testing Machine will not power on');
  form.append('description', 'No response from the control panel since this morning.');
  form.append('complaint_type', 'Machine Related');
  form.append('category', 'Electrical');
  form.append('priority', 'High');
  form.append('machine_id', '1');
  form.append('location_id', '1');
  form.append('machine_unusable', 'true');

  const created = await api('/api/complaints', { method: 'POST', token: student, form });
  assert.strictEqual(created.status, 201, JSON.stringify(created.payload));
  const complaintId = created.payload.complaint.id;
  const ticket = created.payload.complaint.ticket_number;

  // Assign to Ramesh only
  const assigned = await api(`/api/admin/complaints/${complaintId}/assign`, {
    method: 'POST',
    token: hod,
    body: { assigned_to: ramesh.payload.user.id, instructions: 'Check the main fuse.' }
  });

  assert.strictEqual(assigned.status, 200, JSON.stringify(assigned.payload));
  assert.strictEqual(assigned.payload.delivered.status, 'sent', 'both channels should have been accepted');
  assert.strictEqual(assigned.payload.delivered.email, 'ramesh.yadav@polymer.edu');
  assert.strictEqual(assigned.payload.delivered.phone, '9876500011');

  // The email landed in Ramesh's mailbox and contains the task details
  const delivered = fakeSmtp.messagesTo('ramesh.yadav@polymer.edu');
  assert.strictEqual(delivered.length, 1, 'exactly one email should be delivered');
  assert.ok(delivered[0].subject.includes(ticket), 'the subject carries the ticket number');
  assert.ok(delivered[0].text.includes('Ramesh Yadav'), 'the email is addressed to the assignee');
  assert.ok(delivered[0].text.includes('Type of work: Machine Related'), 'the email states the work type');

  // The SMS landed on Ramesh's phone, and the complainer was alerted on theirs
  const smsCalls = fakeSms.received.filter((r) => /Messages\.json$/.test(r.url));
  assert.strictEqual(smsCalls.length, 2, 'the assignee and the complainer are both alerted');
  const assigneeSms = smsCalls.find((c) => c.params.To === '9876500011');
  assert.ok(assigneeSms, 'the SMS goes to the assignee phone number');
  assert.ok(assigneeSms.params.Body.includes(ticket), 'the SMS carries the ticket number');

  // The complainer is emailed who is handling their complaint, with the details
  const reporterMail = fakeSmtp.messagesTo('amit.patel@student.edu');
  assert.strictEqual(reporterMail.length, 1, 'the complainer should receive one email');
  assert.ok(reporterMail[0].subject.includes(ticket), 'the complainer email carries the ticket number');
  assert.ok(reporterMail[0].text.includes('Ramesh Yadav'), 'the complainer email names the assigned staff member');
  assert.ok(reporterMail[0].text.includes('Assigned to: Ramesh Yadav (technician)'), 'the complainer email names the assignee and role');
  assert.ok(reporterMail[0].text.includes('Check the main fuse.'), 'the complainer email carries the instructions');

  // The alert is signed by the HOD who assigned it, not a hardcoded name
  assert.ok(reporterMail[0].text.includes('Assigned by: Dr. Rajesh Kumar'), 'the complainer email is signed by the acting HOD');

  // Nobody else was contacted
  assert.strictEqual(fakeSmtp.messagesTo('meena.iyer@polymer.edu').length, 0, 'the other technician gets nothing');
  assert.ok(!smsCalls.some((c) => c.params.To === '9876500022'), 'the other technician gets no SMS');
});

test('the assignee sees the alert in their own in-app inbox', async () => {
  const rameshLogin = await login('ramesh.yadav@polymer.edu', 'Password123');
  const { payload } = await api('/api/staff/messages', { token: rameshLogin });

  assert.strictEqual(payload.success, true);
  assert.strictEqual(payload.messages.length, 1);
  assert.strictEqual(payload.unread_count, 1);
  assert.strictEqual(payload.messages[0].delivery_status, 'sent');

  // And a different staff member sees none of it
  const meenaLogin = await login('meena.iyer@polymer.edu', 'Password123');
  const meenaMessages = await api('/api/staff/messages', { token: meenaLogin });
  assert.strictEqual(meenaMessages.payload.messages.length, 0, 'staff only see their own alerts');
});

test('the notification endpoints are protected by the existing auth middleware', async () => {
  const anonymous = await api('/api/notifications/gateways');
  assert.strictEqual(anonymous.status, 401);

  const student = await login('amit.patel@student.edu', 'Password123');
  assert.strictEqual((await api('/api/notifications/gateways', { token: student })).status, 403);
  assert.strictEqual((await api('/api/notifications/outbox', { token: student })).status, 403);
  assert.strictEqual((await api('/api/notifications/gateways/verify', { method: 'POST', token: student })).status, 403);
  assert.strictEqual((await api('/api/notifications/messages/1/retry', { method: 'POST', token: student })).status, 403);
  assert.strictEqual((await api('/api/notifications/retry-failed', { method: 'POST', token: student })).status, 403);

  const technician = await login('ramesh.yadav@polymer.edu', 'Password123');
  assert.strictEqual((await api('/api/notifications/gateways/verify', { method: 'POST', token: technician })).status, 403);
});

test('the outbox lists delivery outcomes for the admin', async () => {
  const hod = await login('hod@polymer.edu', 'Admin@123');
  const { status, payload } = await api('/api/notifications/outbox', { token: hod });

  assert.strictEqual(status, 200);
  // Two alerts per assignment: one for the assignee, one for the complainer
  assert.strictEqual(payload.summary.total, 2);
  assert.strictEqual(payload.summary.sent, 2);

  const assigneeMessage = payload.messages.find((m) => m.recipient_email === 'ramesh.yadav@polymer.edu');
  assert.ok(assigneeMessage, 'the assignee notification is in the outbox');
  assert.strictEqual(assigneeMessage.delivery_attempts.length, 2);

  const reporterMessage = payload.messages.find((m) => m.recipient_email === 'amit.patel@student.edu');
  assert.ok(reporterMessage, 'the complainer notification is in the outbox');
});

test('an already delivered notification cannot be sent again', async () => {
  const hod = await login('hod@polymer.edu', 'Admin@123');
  const outbox = await api('/api/notifications/outbox', { token: hod });
  const message = outbox.payload.messages.find((m) => m.recipient_email === 'ramesh.yadav@polymer.edu');

  const retry = await api(`/api/notifications/messages/${message.id}/retry`, { method: 'POST', token: hod });
  assert.strictEqual(retry.status, 409, 'a delivered notification must not be re-sent');

  const emails = fakeSmtp.messagesTo('ramesh.yadav@polymer.edu');
  assert.strictEqual(emails.length, 1, 'still exactly one email — no duplicate');
});

test('a status change notifies the assigned staff member', async () => {
  const hod = await login('hod@polymer.edu', 'Admin@123');
  const complaints = await api('/api/complaints?limit=5', { token: hod });
  const complaintId = complaints.payload.complaints[0].id;

  const updated = await api(`/api/admin/complaints/${complaintId}/status`, {
    method: 'PATCH',
    token: hod,
    body: { status: 'In Progress', comment: 'Parts ordered.' }
  });
  assert.strictEqual(updated.status, 200, JSON.stringify(updated.payload));

  const delivered = fakeSmtp.messagesTo('ramesh.yadav@polymer.edu');
  assert.strictEqual(delivered.length, 2, 'the assignee should also hear about the status change');
  assert.ok(delivered[1].subject.includes('In Progress'), 'the newest email describes the new status');
});

test('staff creation rejects an invalid email or phone number', async () => {
  const hod = await login('hod@polymer.edu', 'Admin@123');

  const badEmail = await api('/api/admin/staff', {
    method: 'POST',
    token: hod,
    body: { name: 'Bad Email', email: 'not-an-email', phone: '9876500033', role: 'staff', password: 'Password123' }
  });
  assert.strictEqual(badEmail.status, 400);
  assert.match(badEmail.payload.message, /valid email/i);

  const badPhone = await api('/api/admin/staff', {
    method: 'POST',
    token: hod,
    body: { name: 'Bad Phone', email: 'bad.phone@polymer.edu', phone: 'nope', role: 'staff', password: 'Password123' }
  });
  assert.strictEqual(badPhone.status, 400);
  assert.match(badPhone.payload.message, /valid phone/i);

  const missingPhone = await api('/api/admin/staff', {
    method: 'POST',
    token: hod,
    body: { name: 'No Phone', email: 'no.phone@polymer.edu', role: 'staff', password: 'Password123' }
  });
  assert.strictEqual(missingPhone.status, 400);
});

test('a notification gateway failure never blocks the assignment', async () => {
  const hod = await login('hod@polymer.edu', 'Admin@123');
  const student = await login('amit.patel@student.edu', 'Password123');

  // Take the gateways offline: no SMTP, unknown SMS provider
  const originalHost = server.NOTIFY.email.host;
  const originalProvider = server.NOTIFY.sms.provider;
  server.NOTIFY.email.host = null;
  server.NOTIFY.sms.provider = 'none';

  try {
    const form = new FormData();
    form.append('title', 'Spilled polymer pellets in the corridor');
    form.append('description', 'Slipping hazard outside the processing lab.');
    form.append('complaint_type', 'Litter/Cleanliness');
    form.append('category', 'Housekeeping');
    form.append('priority', 'Medium');
    form.append('location_id', '3');
    form.append('general_location', 'Corridor outside Lab 201');

    const created = await api('/api/complaints', { method: 'POST', token: student, form });
    const complaintId = created.payload.complaint.id;

    const staffList = await api('/api/admin/staff', { token: hod });
    const technician = staffList.payload.staff.find((s) => s.user_id === 'TECH-ALPHA');

    const assigned = await api(`/api/admin/complaints/${complaintId}/assign`, {
      method: 'POST',
      token: hod,
      body: { assigned_to: technician.id }
    });

    // The core action still succeeds; delivery is honestly reported as in-app only
    assert.strictEqual(assigned.status, 200, 'assignment must not fail because a gateway is down');
    assert.strictEqual(assigned.payload.success, true);
    assert.strictEqual(assigned.payload.delivered.status, 'skipped');
    assert.match(assigned.payload.delivered.attempts[0].error, /not configured|provider/i);
  } finally {
    server.NOTIFY.email.host = originalHost;
    server.NOTIFY.sms.provider = originalProvider;
  }
});

test('gateway verification reports an error when the provider rejects the credentials', async () => {
  const originalToken = server.NOTIFY.sms.authToken;
  const originalBaseUrl = server.NOTIFY.sms.twilioBaseUrl;
  server.NOTIFY.sms.authToken = 'wrong-token';
  server.NOTIFY.sms.twilioBaseUrl = 'https://127.0.0.1:9';  // unreachable

  try {
    const [email, sms] = await server.verifyGateways();
    assert.strictEqual(sms.status, 'error', 'a bad gateway must not be reported as configured');
    assert.ok(sms.detail, 'a reason should be given');
    assert.ok(!String(sms.detail).includes('wrong-token'), 'the bad credential must not be echoed');
    assert.strictEqual(email.status, 'configured', 'the healthy gateway is unaffected');
  } finally {
    server.NOTIFY.sms.authToken = originalToken;
    // Both settings must be put back: leaving the base URL pointed at the dead port
    // would silently break every SMS send in the tests that follow this one.
    server.NOTIFY.sms.twilioBaseUrl = originalBaseUrl;
  }
});

// Raise a simple complaint as the given user and return it
const raiseComplaint = async (token, overrides = {}) => {
  const form = new FormData();
  form.append('title', overrides.title || 'Extruder barrel temperature is unstable');
  form.append('description', overrides.description || 'Readings swing by 20C during a run.');
  form.append('complaint_type', overrides.complaint_type || 'Machine Related');
  form.append('category', 'Electrical');
  form.append('priority', overrides.priority || 'Medium');
  form.append('machine_id', '1');
  form.append('location_id', '1');

  const created = await api('/api/complaints', { method: 'POST', token, form });
  assert.strictEqual(created.status, 201, JSON.stringify(created.payload));
  return created.payload.complaint;
};

test('alerts are signed by whoever is logged in, not by a fixed name', async () => {
  const hod = await login('hod@polymer.edu', 'Admin@123');
  // The HOD sets the name that should appear on the alerts they send
  const renamed = await api('/api/auth/profile', {
    method: 'PATCH',
    token: hod,
    body: { name: 'Dr. Sunita Deshmukh' }
  });
  assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.payload));
  assert.strictEqual(renamed.payload.user.name, 'Dr. Sunita Deshmukh');

  const tooShort = await api('/api/auth/profile', { method: 'PATCH', token: hod, body: { name: 'A' } });
  assert.strictEqual(tooShort.status, 400, 'a one-character name is rejected');

  try {
    const student = await login('amit.patel@student.edu', 'Password123');

    const form = new FormData();
    form.append('title', 'Melt flow indexer screen is blank');
    form.append('description', 'The display does not light up after switching on.');
    form.append('complaint_type', 'Machine Related');
    form.append('category', 'Electrical');
    form.append('priority', 'Medium');
    form.append('machine_id', '1');
    form.append('location_id', '1');

    const created = await api('/api/complaints', { method: 'POST', token: student, form });
    const complaintId = created.payload.complaint.id;

    const staffList = await api('/api/admin/staff', { token: hod });
    const technician = staffList.payload.staff.find((s) => s.user_id === 'TECH-BRAVO');

    const assigned = await api(`/api/admin/complaints/${complaintId}/assign`, {
      method: 'POST',
      token: hod,
      body: { assigned_to: technician.id }
    });
    assert.strictEqual(assigned.status, 200, JSON.stringify(assigned.payload));

    // Both the assignee and the complainer see the new signature
    const assigneeMail = fakeSmtp.messagesTo('meena.iyer@polymer.edu').pop();
    assert.ok(assigneeMail.text.includes('Assigned by: Dr. Sunita Deshmukh'), 'the assignee email uses the session name');
    assert.ok(!assigneeMail.text.includes('Rajesh Kumar'), 'the seeded name must not leak into the alert');

    const reporterMail = fakeSmtp.messagesTo('amit.patel@student.edu').pop();
    assert.ok(reporterMail.text.includes('Assigned by: Dr. Sunita Deshmukh'), 'the complainer email uses the session name');
  } finally {
    // Put the original name back so the rest of the suite is unaffected
    await api('/api/auth/profile', { method: 'PATCH', token: hod, body: { name: 'Dr. Rajesh Kumar' } });
  }
});

test('a self-registered teacher can be assigned a task, a self-registered student cannot', async () => {
  const hod = await login('hod@polymer.edu', 'Admin@123');

  const teacher = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Prof. Kavita Rao',
      email: 'kavita.rao@polymer.edu',
      password: 'Password123',
      role: 'teacher',
      phone: '9876500044'
    }
  });
  assert.strictEqual(teacher.status, 201, JSON.stringify(teacher.payload));

  const student = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Rohit Sharma', email: 'rohit.sharma@student.edu', password: 'Password123', role: 'student' }
  });
  assert.strictEqual(student.status, 201, JSON.stringify(student.payload));

  // Both accounts exist, but only one of them may be picked as an assignee
  const staffList = await api('/api/admin/staff', { token: hod });
  const assignable = staffList.payload.staff.map((s) => s.email);
  assert.ok(assignable.includes('kavita.rao@polymer.edu'), 'a registered teacher must be selectable as an assignee');
  assert.ok(!assignable.includes('rohit.sharma@student.edu'), 'a student reports problems, they are not assigned work');

  // Assign that teacher a complaint raised by the student
  const studentToken = await login('rohit.sharma@student.edu', 'Password123');
  const complaint = await raiseComplaint(studentToken, { title: 'Lab 3 exhaust fan is dead' });
  const teacherEntry = staffList.payload.staff.find((s) => s.email === 'kavita.rao@polymer.edu');

  const assigned = await api(`/api/admin/complaints/${complaint.id}/assign`, {
    method: 'POST',
    token: hod,
    body: { assigned_to: teacherEntry.id, instructions: 'Inspect the fan motor.' }
  });
  assert.strictEqual(assigned.status, 200, JSON.stringify(assigned.payload));
  assert.strictEqual(assigned.payload.delivered.status, 'sent', JSON.stringify(assigned.payload.delivered));

  const teacherMail = fakeSmtp.messagesTo('kavita.rao@polymer.edu');
  assert.strictEqual(teacherMail.length, 1, 'the teacher is emailed the task');
  assert.ok(teacherMail[0].text.includes('Prof. Kavita Rao'), 'the email is addressed to the teacher');

  // ...and the teacher can actually work it, which is what makes them a real assignee
  const teacherToken = await login('kavita.rao@polymer.edu', 'Password123');
  const queue = await api('/api/dashboard/tasks', { token: teacherToken });
  assert.strictEqual(queue.status, 200, 'a teacher assignee must be able to open the task queue');
  assert.strictEqual(queue.payload.tasks.length, 1);

  const progressed = await api(`/api/admin/complaints/${complaint.id}/status`, {
    method: 'PATCH',
    token: teacherToken,
    body: { status: 'In Progress', comment: 'Replacement motor ordered.' }
  });
  assert.strictEqual(progressed.status, 200, JSON.stringify(progressed.payload));
});

test('the complainer is emailed whenever the complaint status changes', async () => {
  const hod = await login('hod@polymer.edu', 'Admin@123');
  const student = await login('amit.patel@student.edu', 'Password123');

  const complaint = await raiseComplaint(student);
  const before = fakeSmtp.messagesTo('amit.patel@student.edu').length;

  const updated = await api(`/api/admin/complaints/${complaint.id}/status`, {
    method: 'PATCH',
    token: hod,
    body: { status: 'Verified', comment: 'Verified by the department office.' }
  });
  assert.strictEqual(updated.status, 200, JSON.stringify(updated.payload));

  const mail = fakeSmtp.messagesTo('amit.patel@student.edu');
  assert.strictEqual(mail.length, before + 1, 'the complainer should be emailed about the change');

  const newest = mail[mail.length - 1];
  assert.ok(newest.subject.includes(complaint.ticket_number), 'the subject carries the ticket number');
  assert.ok(newest.subject.includes('Verified'), 'the subject states the new status');
  assert.ok(newest.text.includes('from "Submitted" to "Verified"'), 'the email states both statuses');
  assert.ok(newest.text.includes('by Dr. Rajesh Kumar'), 'the email names whoever made the change');
  assert.ok(newest.text.includes('Verified by the department office.'), 'the comment is carried across');
});

test('an administrator can turn a self-registered student into a technician, and it applies at once', async () => {
  const hod = await login('hod@polymer.edu', 'Admin@123');

  const registered = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Sneha Kulkarni',
      email: 'sneha.kulkarni@student.edu',
      password: 'Password123',
      role: 'student'
    }
  });
  assert.strictEqual(registered.status, 201, JSON.stringify(registered.payload));
  const accountId = registered.payload.user.id;

  // The token is deliberately minted *before* the role change: the change must be
  // honoured on the very next request rather than whenever the holder signs in again.
  const studentToken = await login('sneha.kulkarni@student.edu', 'Password123');

  const before = await api('/api/admin/staff', { token: hod });
  assert.ok(
    !before.payload.staff.some((s) => s.id === accountId),
    'a student is not assignable in the first place'
  );

  const changed = await api(`/api/admin/users/${accountId}/role`, {
    method: 'PATCH',
    token: hod,
    body: { role: 'technician' }
  });
  assert.strictEqual(changed.status, 200, JSON.stringify(changed.payload));
  assert.strictEqual(changed.payload.user.role, 'technician');
  assert.ok(changed.payload.message.includes('Sneha Kulkarni'), 'the confirmation names the account');

  // Now assignable...
  const after = await api('/api/admin/staff', { token: hod });
  assert.ok(
    after.payload.staff.some((s) => s.id === accountId),
    'the promoted account must be selectable as an assignee'
  );

  // ...and the pre-existing token already opens the task queue, with no re-login
  const queue = await api('/api/dashboard/tasks', { token: studentToken });
  assert.strictEqual(queue.status, 200, 'the old token must pick up the new role immediately');
});

test('the role-change endpoint refuses bad input and privileged accounts', async () => {
  const hod = await login('hod@polymer.edu', 'Admin@123');

  const registered = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Imran Sheikh', email: 'imran.sheikh@student.edu', password: 'Password123', role: 'student' }
  });
  const accountId = registered.payload.user.id;

  const badRole = await api(`/api/admin/users/${accountId}/role`, {
    method: 'PATCH',
    token: hod,
    body: { role: 'superuser' }
  });
  assert.strictEqual(badRole.status, 400, 'an unknown role is rejected');

  const sameRole = await api(`/api/admin/users/${accountId}/role`, {
    method: 'PATCH',
    token: hod,
    body: { role: 'student' }
  });
  assert.strictEqual(sameRole.status, 400, 'a no-op change is rejected');

  const missing = await api('/api/admin/users/999999/role', {
    method: 'PATCH',
    token: hod,
    body: { role: 'teacher' }
  });
  assert.strictEqual(missing.status, 404, 'an unknown account is rejected');

  // The HOD account is protected, so the department cannot demote itself by accident
  const hodId = (await api('/api/admin/users', { token: hod })).payload.users
    .find((u) => u.email === 'hod@polymer.edu').id;
  const demoteHod = await api(`/api/admin/users/${hodId}/role`, {
    method: 'PATCH',
    token: hod,
    body: { role: 'student' }
  });
  assert.strictEqual(demoteHod.status, 403, 'an HOD/admin account cannot be changed here');

  // A staff member must not be able to promote themselves
  const studentToken = await login('imran.sheikh@student.edu', 'Password123');
  const asStudent = await api(`/api/admin/users/${accountId}/role`, {
    method: 'PATCH',
    token: studentToken,
    body: { role: 'technician' }
  });
  assert.strictEqual(asStudent.status, 403, 'only an administrator may change a role');
});

test('nobody is emailed about a status change they made themselves', async () => {
  const hod = await login('hod@polymer.edu', 'Admin@123');

  // The HOD raises a complaint and then moves it: their own action must not email them
  const own = await raiseComplaint(hod, { title: 'Store room light is flickering' });
  const before = fakeSmtp.messagesTo('hod@polymer.edu').length;

  const updated = await api(`/api/admin/complaints/${own.id}/status`, {
    method: 'PATCH',
    token: hod,
    body: { status: 'Under Review', comment: 'Looking into it.' }
  });
  assert.strictEqual(updated.status, 200, JSON.stringify(updated.payload));

  assert.strictEqual(
    fakeSmtp.messagesTo('hod@polymer.edu').length,
    before,
    'the acting user must not be emailed about their own action'
  );
});
