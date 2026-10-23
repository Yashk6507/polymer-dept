const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const UPLOAD_DIR = path.join(UPLOADS_DIR, 'complaints');
const DATA_DIR = path.join(__dirname, 'data');
// Overridable so the test suite can run against a throwaway store
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'store.json');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const JWT_EXPIRE = process.env.JWT_EXPIRE || '7d';

// Ensure runtime directories exist
[UPLOAD_DIR, DATA_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/* ------------------------------------------------------------------ *
 * Persistence (JSON file store)
 * ------------------------------------------------------------------ */

const emptyStore = () => ({
  users: [],
  locations: [],
  machines: [],
  complaints: [],
  complaintImages: [],
  complaintUpdates: [],
  assignments: [],
  notifications: [],
  messages: [],
  counters: {
    userId: 0,
    locationId: 0,
    machineId: 0,
    complaintId: 0,
    imageId: 0,
    updateId: 0,
    assignmentId: 0,
    notificationId: 0,
    messageId: 0
  }
});

let db = emptyStore();

function seedStore() {
  const hash = (password) => bcrypt.hashSync(password, 10);

  db.locations = [
    { id: 1, building: 'Main Block', hall: 'Polymer Testing Laboratory', room_number: '101', floor: 'Ground Floor', description: 'Primary testing facility' },
    { id: 2, building: 'Main Block', hall: 'Material Testing Laboratory', room_number: '102', floor: 'Ground Floor', description: 'Material characterization lab' },
    { id: 3, building: 'Main Block', hall: 'Processing Laboratory', room_number: '201', floor: 'First Floor', description: 'Polymer processing equipment' }
  ];

  db.machines = [
    { id: 1, machine_code: 'UTM-001', machine_name: 'Universal Testing Machine', manufacturer: 'Instron', model: '5900 Series', category: 'Mechanical Testing', location_id: 1, status: 'Operational' },
    { id: 2, machine_code: 'MFI-001', machine_name: 'Melt Flow Index Tester', manufacturer: 'Tinius Olsen', model: 'MP600', category: 'Rheology Testing', location_id: 1, status: 'Operational' },
    { id: 3, machine_code: 'IZD-001', machine_name: 'Izod Impact Tester', manufacturer: 'Zwick/Roell', model: 'HIT50P', category: 'Impact Testing', location_id: 2, status: 'Operational' },
    { id: 4, machine_code: 'EXT-001', machine_name: 'Extrusion Machine', manufacturer: 'Brabender', model: 'DSE 20/40', category: 'Processing', location_id: 3, status: 'Operational' },
    { id: 5, machine_code: 'INJ-001', machine_name: 'Injection Moulding Machine', manufacturer: 'Haitian', model: 'MA600', category: 'Processing', location_id: 3, status: 'Out of Service' }
  ];

  // Staff, technicians and faculty are deliberately NOT seeded — the HOD adds the
  // department's real staff from Admin Dashboard → Staff → Add Staff Member.
  db.users = [
    { id: 1, name: 'Dr. Rajesh Kumar', email: 'hod@polymer.edu', password_hash: hash('Admin@123'), role: 'hod', user_id: 'HOD001', phone: '9876543210', department: 'Plastic Polymer Testing', created_at: new Date().toISOString() },
    { id: 2, name: 'Amit Patel', email: 'amit.patel@student.edu', password_hash: hash('Password123'), role: 'student', user_id: 'STU2023001', phone: '9876543214', department: 'Plastic Polymer Testing', created_at: new Date().toISOString() }
  ];

  db.counters = {
    userId: 2,
    locationId: 3,
    machineId: 5,
    complaintId: 0,
    imageId: 0,
    updateId: 0,
    assignmentId: 0,
    notificationId: 0,
    messageId: 0
  };
}

function loadStore() {
  if (!fs.existsSync(DATA_FILE)) {
    seedStore();
    persist();
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db = { ...emptyStore(), ...raw, counters: { ...emptyStore().counters, ...(raw.counters || {}) } };
  } catch (error) {
    console.error('Could not read data store, starting from seed data:', error.message);
    seedStore();
    persist();
  }
}

function persist() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function nextId(key) {
  db.counters[key] = (db.counters[key] || 0) + 1;
  return db.counters[key];
}

loadStore();

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const ALL_STATUSES = ['Submitted', 'Under Review', 'Verified', 'Assigned', 'In Progress', 'On Hold', 'Resolved', 'Closed', 'Rejected', 'Reopened'];
const ADMIN_ROLES = ['hod', 'admin'];
const REVIEW_ROLES = ['hod', 'admin', 'faculty'];
// Staff-tier roles: they work a queue and may only progress their own assignments.
// Teachers can be handed a task, so they are staff-tier for queue access and statuses.
const STAFF_ROLES = ['staff', 'technician', 'worker', 'teacher'];
// Anyone who is allowed to browse the full complaint register
const COMPLAINT_VIEW_ROLES = ['hod', 'admin', 'faculty', 'staff', 'technician', 'worker', 'teacher'];
// Roles that can be given an assignment. A teacher who registers from the public page
// must be selectable here, otherwise the registration is a dead end.
const ASSIGNEE_ROLES = ['staff', 'technician', 'worker', 'faculty', 'teacher'];
// Roles an administrator may provision from the Staff tab
const PROVISIONABLE_STAFF_ROLES = ['staff', 'technician', 'worker', 'faculty', 'teacher'];
// Statuses a technician/staff member is allowed to set on their own assignment
const WORKER_STATUSES = ['In Progress', 'On Hold', 'Resolved', 'Reopened'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const COMPLAINT_TYPES = ['Machine Related', 'Teacher Related', 'Litter/Cleanliness', 'System Failure', 'Classroom Issue', 'Student Related', 'Infrastructure', 'Other'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const publicUser = (user) => {
  if (!user) return null;
  const { password_hash, ...rest } = user;
  return rest;
};

const publicUserSummary = (user) => (user ? { id: user.id, name: user.name, role: user.role } : null);

/**
 * The signed-in HOD/admin behind the current request. Notification wording and
 * the "Assigned by" line resolve the name from the session on every request, so
 * whoever is actually logged in signs the alerts — never a fixed name.
 */
const actingUser = (req) => db.users.find((u) => u.id === req.user.id) || null;
const actingUserName = (req) => (actingUser(req) || {}).name || 'Department office';

const generateTicketNumber = (id) => `PPD-${new Date().getFullYear()}-${String(id).padStart(6, '0')}`;

// Builds a complaint payload without ever spreading a machine/location object,
// which would otherwise overwrite `id`, `status` and `category`.
function complaintView(complaint) {
  if (!complaint) return null;
  const machine = db.machines.find((m) => m.id === complaint.machine_id);
  const location = db.locations.find((l) => l.id === complaint.location_id);
  const reporter = db.users.find((u) => u.id === complaint.reporter_id);

  return {
    ...complaint,
    machine_name: machine ? machine.machine_name : null,
    machine_code: machine ? machine.machine_code : null,
    machine_status: machine ? machine.status : null,
    building: location ? location.building : null,
    hall: location ? location.hall : null,
    room_number: location ? location.room_number : null,
    floor: location ? location.floor : null,
    // Human readable location that also covers non-machine complaints
    location_display: complaint.complaint_type === 'Machine Related'
      ? [location?.building, location?.hall, location?.room_number && `Room ${location.room_number}`].filter(Boolean).join(', ')
      : complaint.general_location || 'Not specified',
    reporter_name: reporter ? reporter.name : 'Unknown',
    reporter_role: reporter ? reporter.role : null,
    reporter_email: reporter ? reporter.email : null,
    reporter_user_id: reporter ? reporter.user_id : null,
    image_count: db.complaintImages.filter((img) => img.complaint_id === complaint.id).length
  };
}

function createNotification(userId, complaintId, title, message) {
  db.notifications.push({
    id: nextId('notificationId'),
    user_id: userId,
    complaint_id: complaintId,
    title,
    message,
    read_status: false,
    created_at: new Date().toISOString()
  });
}

function recordUpdate(complaint, userId, oldStatus, newStatus, comment) {
  db.complaintUpdates.push({
    id: nextId('updateId'),
    complaint_id: complaint.id,
    user_id: userId,
    old_status: oldStatus,
    new_status: newStatus,
    comment,
    created_at: new Date().toISOString()
  });
}

function isAssignedTo(complaintId, userId) {
  return db.assignments.some((a) => a.complaint_id === complaintId && a.assigned_to === userId);
}

/* ------------------------------------------------------------------ *
 * Notification gateways
 *
 * Email goes out over SMTP (nodemailer) and SMS over a provider HTTP API.
 * Both are optional: when a gateway is not configured the message is still
 * recorded in the in-app outbox and marked "skipped", so nothing is lost and
 * the app keeps working on a machine with no credentials.
 *
 * Configuration is read from .env exactly once at startup. Configuration alone
 * never claims success — `verifyGateways()` actually talks to the provider and
 * the dashboard reports that result.
 * ------------------------------------------------------------------ */

const NODEMAILER_AVAILABLE = (() => {
  try {
    require.resolve('nodemailer');
    return true;
  } catch (error) {
    return false;
  }
})();

const DEFAULT_TIMEOUT_MS = 10000;

const NOTIFY = {
  email: {
    // "brevo" uses the Brevo HTTP API (xkeysib- key); otherwise plain SMTP.
    // Setting BREVO_API_KEY is enough to switch provider, so no extra variable
    // is needed for the common case.
    provider: String(process.env.EMAIL_PROVIDER || (process.env.BREVO_API_KEY ? 'brevo' : 'smtp')).toLowerCase(),
    host: process.env.SMTP_HOST || null,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
    apiKey: process.env.BREVO_API_KEY || null,
    apiBaseUrl: process.env.BREVO_API_BASE_URL || 'https://api.brevo.com',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || null,
    timeout: parseInt(process.env.SMTP_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10),
    get configured() {
      if (this.provider === 'brevo') {
        return Boolean(this.apiKey && senderEmail(this.from));
      }
      return Boolean(this.host && this.user && this.pass && NODEMAILER_AVAILABLE);
    },
    // Which variables are still missing — used for the dashboard hint, never values
    get missing() {
      if (this.provider === 'brevo') {
        const missing = [];
        if (!this.apiKey) missing.push('BREVO_API_KEY');
        if (!senderEmail(this.from)) missing.push('MAIL_FROM (a verified Brevo sender address)');
        return missing;
      }
      const missing = [];
      if (!NODEMAILER_AVAILABLE) missing.push('nodemailer (run: npm install nodemailer)');
      if (!this.host) missing.push('SMTP_HOST');
      if (!this.user) missing.push('SMTP_USER');
      if (!this.pass) missing.push('SMTP_PASS');
      return missing;
    }
  },
  sms: {
    provider: String(process.env.SMS_PROVIDER || 'none').toLowerCase(),
    senderId: process.env.SMS_SENDER_ID || null,
    accountSid: process.env.TWILIO_ACCOUNT_SID || null,
    authToken: process.env.TWILIO_AUTH_TOKEN || null,
    fromNumber: process.env.TWILIO_FROM_NUMBER || null,
    // Twilio publishes regional base URLs, so overriding this is a supported setting
    twilioBaseUrl: process.env.TWILIO_API_BASE_URL || 'https://api.twilio.com',
    apiKey: process.env.FAST2SMS_API_KEY || null,
    route: process.env.FAST2SMS_ROUTE || 'q',
    fast2smsBaseUrl: process.env.FAST2SMS_API_BASE_URL || 'https://www.fast2sms.com',
    timeout: parseInt(process.env.SMS_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10),
    get configured() {
      if (this.provider === 'twilio') {
        return Boolean(this.accountSid && this.authToken && this.fromNumber);
      }
      if (this.provider === 'fast2sms') {
        return Boolean(this.apiKey);
      }
      return false;
    },
    get missing() {
      if (this.provider === 'none') return ['SMS_PROVIDER'];
      if (this.provider === 'twilio') {
        const missing = [];
        if (!this.accountSid) missing.push('TWILIO_ACCOUNT_SID');
        if (!this.authToken) missing.push('TWILIO_AUTH_TOKEN');
        if (!this.fromNumber) missing.push('TWILIO_FROM_NUMBER');
        return missing;
      }
      if (this.provider === 'fast2sms') {
        if (!this.apiKey) return ['FAST2SMS_API_KEY'];
        if (!this.senderId) return ['SMS_SENDER_ID (needed for the Fast2SMS sender)'];
        return [];
      }
      return [`SMS_PROVIDER (unsupported value "${this.provider}")`];
    }
  }
};

let mailTransport;

function getMailTransport() {
  // Only SMTP mode uses nodemailer; Brevo is called over its HTTP API
  if (NOTIFY.email.provider !== 'smtp' || !NOTIFY.email.configured) return null;
  if (mailTransport === undefined) {
    const nodemailer = require('nodemailer');
    mailTransport = nodemailer.createTransport({
      host: NOTIFY.email.host,
      port: NOTIFY.email.port,
      secure: NOTIFY.email.secure,
      auth: { user: NOTIFY.email.user, pass: NOTIFY.email.pass },
      connectionTimeout: NOTIFY.email.timeout,
      greetingTimeout: NOTIFY.email.timeout,
      socketTimeout: NOTIFY.email.timeout
    });
  }
  return mailTransport;
}

/* ---------- input validation ---------- */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const isValidEmail = (value) => EMAIL_PATTERN.test(String(value || '').trim());

const normalizePhone = (value) => String(value || '').replace(/[\s()\-.]/g, '');

const isValidPhone = (value) => {
  const phone = normalizePhone(value);
  return /^\+?\d{7,15}$/.test(phone);
};

/**
 * Pulls the bare address out of a MAIL_FROM value such as
 * "Polymer Department <no-reply@polymer.edu>". Brevo needs the name and the
 * email separately, so both forms are accepted.
 */
function senderEmail(from) {
  if (!from) return null;
  const match = String(from).match(/<([^>]+)>/);
  const address = (match ? match[1] : String(from)).trim();
  return isValidEmail(address) ? address : null;
}

function senderParts(from) {
  const email = senderEmail(from);
  if (!email) return { email: String(from || '').trim() };
  // Only attach a display name when one was explicitly given as `Name <addr>`;
  // for a bare address the address itself must never become the display name.
  const match = String(from).match(/<([^>]+)>/);
  if (!match) return { email };
  const name = String(from).split('<')[0].trim().replace(/^"|"$/g, '');
  return name ? { name, email } : { email };
}

/** Pulls Brevo's human-readable reason out of an error response body. */
function brevoReason(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && parsed.message) return String(parsed.message);
  } catch (error) {
    /* not JSON — fall through to the raw excerpt */
  }
  return String(body || '').slice(0, 200);
}

/**
 * A rejected send, described so an admin can act on it. Brevo's IP allow-list is by
 * far the most common failure and its raw body buries the one useful fact — the
 * blocked address — inside a sentence that gets truncated. Surface both the address
 * and the page that fixes it.
 */
function brevoFailureReason(status, body) {
  const raw = String(body || '');
  const blocked = raw.match(/unrecognised IP address ([0-9a-fA-F:.]+)/i);
  if (blocked) {
    return redact(
      `Brevo blocked this server's IP ${blocked[1]}. Authorise it, or switch IP blocking off, ` +
      'at https://app.brevo.com/security/authorised_ips'
    );
  }
  return redact(`Brevo responded ${status}: ${brevoReason(raw)}`);
}

/* ---------- secret redaction ---------- */

/**
 * Never let a credential reach the logs, the data store or the dashboard.
 * Any configured secret appearing in an error string is masked.
 */
function redact(value) {
  if (value === null || value === undefined) return value;
  let text = String(value);

  const secrets = [
    NOTIFY.email.pass,
    NOTIFY.email.apiKey,
    NOTIFY.sms.authToken,
    NOTIFY.sms.apiKey
  ].filter((secret) => typeof secret === 'string' && secret.length >= 4);

  secrets.forEach((secret) => {
    text = text.split(secret).join('***');
  });

  // Auth headers / query strings can embed credentials we did not enumerate
  text = text.replace(/(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '$1 ***');
  text = text.replace(/(authorization|api[_-]?key|password|token)=([^&\s"']+)/gi, '$1=***');

  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

const logNotify = (level, message) => {
  const line = `[notify] ${redact(message)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/* ---------- HTTP helper (no provider SDK needed) ---------- */

/**
 * Request with a hard timeout. Picks http or https from the URL, which also
 * lets a local mock provider stand in for the real one during tests.
 */
function httpRequestForm(url, { method = 'POST', form = null, json = null, headers = {}, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      return reject(new Error(`Invalid gateway URL: ${url}`));
    }

    const transport = target.protocol === 'http:' ? http : https;
    // `json` is used by the Brevo API; `form` by Twilio / Fast2SMS
    const payload = json ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : null;
    const requestHeaders = { ...headers };

    if (payload) {
      requestHeaders['Content-Type'] = json ? 'application/json' : 'application/x-www-form-urlencoded';
      requestHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method,
      headers: requestHeaders
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: data }));
    });

    request.setTimeout(timeout, () => {
      request.destroy(new Error(`Gateway request timed out after ${timeout}ms`));
    });
    request.on('error', reject);

    if (payload) request.write(payload);
    request.end();
  });
}

/* ---------- email ---------- */

/**
 * Professional HTML + plain-text body. `message.body` is the existing plain text
 * alert, so the wording stays identical across email and the in-app outbox.
 */
function renderEmail(message) {
  const escape = (value) => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const paragraphs = String(message.body || '')
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 14px;">${escape(block).replace(/\n/g, '<br>')}</p>`)
    .join('');

  const referenceRow = message.ticket_number
    ? `<tr>
         <td style="padding:6px 0;color:#6b7280;font-size:13px;">Reference</td>
         <td style="padding:6px 0;font-size:13px;font-weight:600;color:#1f2937;">${escape(message.ticket_number)}</td>
       </tr>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="background:#1e40af;padding:20px 28px;color:#ffffff;">
              <div style="font-size:17px;font-weight:700;">Plastic Polymer Testing Department</div>
              <div style="font-size:12px;opacity:0.9;margin-top:2px;">Machine Complaint &amp; Maintenance Management System</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <h1 style="margin:0 0 18px;font-size:18px;color:#1f2937;">${escape(message.subject)}</h1>
              ${paragraphs}
              ${message.ticket_number ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;border-top:1px solid #e5e7eb;padding-top:12px;width:100%;">${referenceRow}</table>` : ''}
            </td>
          </tr>
          <tr>
            <td style="background:#f9fafb;padding:16px 28px;color:#6b7280;font-size:11px;border-top:1px solid #e5e7eb;">
              This is an automated message from the PPD Complaint Management System. Please do not reply to this email.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { html, text: message.body || '' };
}

async function sendEmail(to, subject, body, options = {}) {
  if (!isValidEmail(to)) {
    return { channel: 'Email', status: 'skipped', error: 'Recipient email address is missing or invalid' };
  }
  const content = renderEmail({ subject, body, ticket_number: options.ticketNumber || null });

  if (NOTIFY.email.provider === 'brevo') {
    if (!NOTIFY.email.configured) {
      return { channel: 'Email', status: 'skipped', error: 'Brevo is not configured' };
    }

    const request = options.request || httpRequestForm;

    try {
      const response = await request(`${NOTIFY.email.apiBaseUrl}/v3/smtp/email`, {
        json: {
          sender: senderParts(NOTIFY.email.from),
          to: [{ email: to }],
          subject: `[PPD] ${subject}`,
          htmlContent: content.html,
          textContent: content.text
        },
        headers: { 'api-key': NOTIFY.email.apiKey, Accept: 'application/json' },
        timeout: NOTIFY.email.timeout
      });

      if (response.status >= 200 && response.status < 300) {
        let providerId = null;
        try {
          providerId = JSON.parse(response.body).messageId || null;
        } catch (error) {
          providerId = null;
        }
        return { channel: 'Email', status: 'sent', provider_id: providerId };
      }

      const reason = brevoFailureReason(response.status, response.body);
      markEmailGatewayRejected(response.status, reason);
      logNotify('error', `Email to ${to} failed: ${reason}`);
      return { channel: 'Email', status: 'failed', error: reason };
    } catch (error) {
      const reason = redact(error.message || 'Unknown Brevo error');
      logNotify('error', `Email to ${to} failed: ${reason}`);
      return { channel: 'Email', status: 'failed', error: reason };
    }
  }

  if (!NODEMAILER_AVAILABLE) {
    return { channel: 'Email', status: 'skipped', error: 'nodemailer is not installed (run: npm install nodemailer)' };
  }
  if (!NOTIFY.email.configured) {
    return { channel: 'Email', status: 'skipped', error: 'SMTP is not configured' };
  }

  const transport = options.transport !== undefined ? options.transport : getMailTransport();
  if (!transport) {
    return { channel: 'Email', status: 'skipped', error: 'SMTP is not configured' };
  }

  try {
    const info = await transport.sendMail({
      from: NOTIFY.email.from,
      to,
      subject: `[PPD] ${subject}`,
      text: content.text,
      html: content.html
    });
    return { channel: 'Email', status: 'sent', provider_id: (info && info.messageId) || null };
  } catch (error) {
    const reason = redact(error.message || 'Unknown SMTP error');
    logNotify('error', `Email to ${to} failed: ${reason}`);
    return { channel: 'Email', status: 'failed', error: reason };
  }
}

/* ---------- SMS ---------- */

async function sendSms(to, body, options = {}) {
  const sms = NOTIFY.sms;
  const request = options.request || httpRequestForm;

  if (!isValidPhone(to)) {
    return { channel: 'SMS', status: 'skipped', error: 'Recipient phone number is missing or invalid' };
  }
  if (!sms.configured) {
    return {
      channel: 'SMS',
      status: 'skipped',
      error: sms.provider === 'none'
        ? 'No SMS provider configured'
        : `SMS provider "${sms.provider}" is missing credentials`
    };
  }

  const recipient = normalizePhone(to);

  try {
    if (sms.provider === 'twilio') {
      const auth = Buffer.from(`${sms.accountSid}:${sms.authToken}`).toString('base64');
      const response = await request(
        `${sms.twilioBaseUrl}/2010-04-01/Accounts/${sms.accountSid}/Messages.json`,
        {
          form: { To: recipient, From: sms.fromNumber, Body: body },
          headers: { Authorization: `Basic ${auth}` },
          timeout: sms.timeout
        }
      );

      if (response.status >= 200 && response.status < 300) {
        let providerId = null;
        try {
          providerId = JSON.parse(response.body).sid || null;
        } catch (error) {
          providerId = null;
        }
        return { channel: 'SMS', status: 'sent', provider_id: providerId };
      }

      const reason = redact(`Twilio responded ${response.status}: ${String(response.body).slice(0, 200)}`);
      logNotify('error', `SMS to ${recipient} failed: ${reason}`);
      return { channel: 'SMS', status: 'failed', error: reason };
    }

    if (sms.provider === 'fast2sms') {
      const response = await request(`${sms.fast2smsBaseUrl}/dev/bulkV2`, {
        form: {
          route: sms.route,
          sender_id: sms.senderId || '',
          message: body,
          numbers: recipient,
          flash: '0'
        },
        headers: { authorization: sms.apiKey },
        timeout: sms.timeout
      });

      let parsed = {};
      try {
        parsed = JSON.parse(response.body);
      } catch (error) {
        parsed = {};
      }

      if (response.status >= 200 && response.status < 300 && parsed.return !== false) {
        return { channel: 'SMS', status: 'sent', provider_id: parsed.request_id || null };
      }

      const reason = redact(`Fast2SMS responded ${response.status}: ${String(response.body).slice(0, 200)}`);
      logNotify('error', `SMS to ${recipient} failed: ${reason}`);
      return { channel: 'SMS', status: 'failed', error: reason };
    }

    return { channel: 'SMS', status: 'skipped', error: `Unsupported SMS provider "${sms.provider}"` };
  } catch (error) {
    const reason = redact(error.message || 'Unknown SMS error');
    logNotify('error', `SMS to ${recipient} failed: ${reason}`);
    return { channel: 'SMS', status: 'failed', error: reason };
  }
}

/* ---------- delivery orchestration ---------- */

const summarizeDelivery = (attempts) => {
  if (!attempts || attempts.length === 0) return 'skipped';

  // A channel that was skipped because no gateway is configured (for example
  // SMS when SMS_PROVIDER=none) is not a delivery failure. In an email-only
  // setup a delivered email must still read as "sent", never "partial", so
  // only channels that were really attempted are counted.
  const attempted = attempts.filter((a) => a.status !== 'skipped');
  if (attempted.length === 0) return 'skipped';

  const sent = attempted.filter((a) => a.status === 'sent').length;
  const failed = attempted.filter((a) => a.status === 'failed').length;
  if (sent === attempted.length) return 'sent';
  if (sent > 0) return 'partial';
  if (failed > 0) return 'failed';
  return 'skipped';
};

/**
 * Hands a recorded outbox message to the real gateways and stores the outcome.
 *
 * Retry-safe: a channel that already succeeded is carried over untouched instead
 * of being sent again, so retrying a half-delivered message can never duplicate
 * the half that worked. `options` exists so tests can inject fakes.
 */
async function deliverMessage(message, options = {}) {
  if (!message) return null;

  const email = options.sendEmail || sendEmail;
  const sms = options.sendSms || sendSms;
  const save = options.persist || persist;

  const previous = message.delivery_attempts || [];
  const attempts = previous.filter((a) => a.status === 'sent');
  const alreadySent = new Set(attempts.map((a) => a.channel));

  if (message.recipient_email && !alreadySent.has('Email')) {
    attempts.push(await email(message.recipient_email, message.subject, message.body, {
      ticketNumber: message.ticket_number
    }));
  }
  if (message.recipient_phone && !alreadySent.has('SMS')) {
    attempts.push(await sms(message.recipient_phone, message.body));
  }

  message.delivery_attempts = attempts;
  message.delivery_status = summarizeDelivery(attempts);
  // "Delivered" means a channel really accepted the message. A blocked or refused
  // send must never carry a delivery timestamp, or the outbox would claim success
  // for a message nobody received.
  const deliveredNow = attempts.some((a) => a.status === 'sent');
  if (deliveredNow) message.delivered_at = new Date().toISOString();
  message.retry_count = message.retry_count || 0;
  message.last_attempt_at = new Date().toISOString();
  save();

  return message;
}

/* ---------- gateway verification ---------- */

/**
 * Configuration is not delivery. This actually opens an SMTP session / calls the
 * provider so the dashboard can tell "Configured" apart from "Configuration error".
 */
const gatewayHealth = {
  email: { status: 'unchecked', checked_at: null, detail: null },
  sms: { status: 'unchecked', checked_at: null, detail: null }
};

/**
 * The verification probe only runs at startup and on demand, so the email IP
 * can become blocked in between. A real send that Brevo refuses is the
 * strongest evidence the gateway is down: reporting "Configured" while every
 * alert is being rejected is worse than reporting nothing. Only credentials
 * and the IP allow-list are gateway-wide — a 400 is about one bad recipient
 * and must not take the whole banner down with it.
 */
function markEmailGatewayRejected(status, reason) {
  if (status !== 401 && status !== 403) return;
  gatewayHealth.email = { status: 'error', checked_at: new Date().toISOString(), detail: reason };
}

async function verifyEmailGateway() {
  if (NOTIFY.email.provider === 'brevo') {
    if (!NOTIFY.email.configured) {
      gatewayHealth.email = { status: 'in_app_only', checked_at: new Date().toISOString(), detail: `Missing: ${NOTIFY.email.missing.join(', ')}` };
      return gatewayHealth.email;
    }

    try {
      // Probe the send endpoint with a deliberately recipient-less payload.
      // Brevo checks the key and the authorised-IP list *before* it validates
      // the body, so:
      //   400 -> the key authenticated and this IP is allowed  => configured
      //   401 -> "Key not found" = bad key, "unrecognised IP address" = the
      //          account's IP allow-list is blocking us
      // Nothing can ever be delivered here because there is no recipient.
      const response = await httpRequestForm(`${NOTIFY.email.apiBaseUrl}/v3/smtp/email`, {
        json: { sender: senderParts(NOTIFY.email.from) },
        headers: { 'api-key': NOTIFY.email.apiKey, Accept: 'application/json' },
        timeout: NOTIFY.email.timeout
      });

      if (response.status >= 200 && response.status < 300) {
        // Shouldn't happen without a recipient, but treat acceptance as success
        gatewayHealth.email = { status: 'configured', checked_at: new Date().toISOString(), detail: 'Brevo API credentials accepted' };
      } else if (response.status === 400) {
        gatewayHealth.email = { status: 'configured', checked_at: new Date().toISOString(), detail: 'Brevo API credentials accepted' };
      } else {
        const reason = brevoFailureReason(response.status, response.body);
        logNotify('warn', `Email gateway verification failed: ${reason}`);
        gatewayHealth.email = { status: 'error', checked_at: new Date().toISOString(), detail: reason };
      }
    } catch (error) {
      const detail = redact(error.message || 'Brevo verification failed');
      logNotify('warn', `Email gateway verification failed: ${detail}`);
      gatewayHealth.email = { status: 'error', checked_at: new Date().toISOString(), detail };
    }

    return gatewayHealth.email;
  }

  if (!NODEMAILER_AVAILABLE) {
    gatewayHealth.email = { status: 'error', checked_at: new Date().toISOString(), detail: 'nodemailer is not installed' };
    return gatewayHealth.email;
  }
  if (!NOTIFY.email.configured) {
    gatewayHealth.email = { status: 'in_app_only', checked_at: new Date().toISOString(), detail: `Missing: ${NOTIFY.email.missing.join(', ')}` };
    return gatewayHealth.email;
  }

  try {
    await getMailTransport().verify();
    gatewayHealth.email = { status: 'configured', checked_at: new Date().toISOString(), detail: `SMTP session verified against ${NOTIFY.email.host}` };
  } catch (error) {
    const detail = redact(error.message || 'SMTP verification failed');
    logNotify('warn', `Email gateway verification failed: ${detail}`);
    gatewayHealth.email = { status: 'error', checked_at: new Date().toISOString(), detail };
  }
  return gatewayHealth.email;
}

async function verifySmsGateway() {
  const sms = NOTIFY.sms;

  if (sms.provider === 'none') {
    gatewayHealth.sms = { status: 'in_app_only', checked_at: new Date().toISOString(), detail: 'Missing: SMS_PROVIDER' };
    return gatewayHealth.sms;
  }
  if (!sms.configured) {
    gatewayHealth.sms = { status: 'error', checked_at: new Date().toISOString(), detail: `Missing: ${sms.missing.join(', ')}` };
    return gatewayHealth.sms;
  }
  if (sms.provider !== 'twilio' && sms.provider !== 'fast2sms') {
    gatewayHealth.sms = { status: 'error', checked_at: new Date().toISOString(), detail: `Unsupported provider "${sms.provider}"` };
    return gatewayHealth.sms;
  }

  try {
    let response;

    if (sms.provider === 'twilio') {
      const auth = Buffer.from(`${sms.accountSid}:${sms.authToken}`).toString('base64');
      response = await httpRequestForm(
        `${sms.twilioBaseUrl}/2010-04-01/Accounts/${sms.accountSid}.json`,
        { method: 'GET', headers: { Authorization: `Basic ${auth}` }, timeout: sms.timeout }
      );
    } else {
      response = await httpRequestForm(`${sms.fast2smsBaseUrl}/dev/wallet`, {
        method: 'GET',
        headers: { authorization: sms.apiKey },
        timeout: sms.timeout
      });
    }

    if (response.status >= 200 && response.status < 300) {
      gatewayHealth.sms = { status: 'configured', checked_at: new Date().toISOString(), detail: `${sms.provider} credentials accepted` };
    } else {
      const detail = redact(`${sms.provider} rejected the credentials (HTTP ${response.status})`);
      logNotify('warn', `SMS gateway verification failed: ${detail}`);
      gatewayHealth.sms = { status: 'error', checked_at: new Date().toISOString(), detail };
    }
  } catch (error) {
    const detail = redact(error.message || 'SMS verification failed');
    logNotify('warn', `SMS gateway verification failed: ${detail}`);
    gatewayHealth.sms = { status: 'error', checked_at: new Date().toISOString(), detail };
  }

  return gatewayHealth.sms;
}

const verifyGateways = () => Promise.all([verifyEmailGateway(), verifySmsGateway()]);

/**
 * Records an outbound notification in the message outbox.
 * The message is stored against the recipient's phone number and email address so the
 * staff profile can show exactly what was sent, to which contact and when.
 * Call deliverMessage() with the returned record to push it through the gateways.
 */
function recordMessage(recipient, { subject, body, kind, complaint }) {
  if (!recipient) return null;

  const email = recipient.email || null;
  const phone = recipient.phone || null;
  const channel = email && phone ? 'Email + SMS' : email ? 'Email' : phone ? 'SMS' : 'No contact on file';

  const message = {
    id: nextId('messageId'),
    recipient_id: recipient.id,
    recipient_name: recipient.name,
    recipient_email: email,
    recipient_phone: phone,
    delivery_channel: channel,
    delivery_status: 'queued',
    delivery_attempts: [],
    delivered_at: null,
    last_attempt_at: null,
    retry_count: 0,
    subject,
    body,
    kind,
    complaint_id: complaint ? complaint.id : null,
    ticket_number: complaint ? complaint.ticket_number : null,
    read_status: false,
    created_at: new Date().toISOString()
  };

  db.messages.push(message);
  return message;
}

// AI-powered priority analysis
function analyzeComplaintPriority(complaint) {
  const title = (complaint.title || '').toLowerCase();
  const description = (complaint.description || '').toLowerCase();
  const category = (complaint.category || '').toLowerCase();
  const text = `${title} ${description} ${category}`;

  let score = 0;
  const reasons = [];

  const safetyKeywords = ['safety', 'danger', 'hazard', 'injury', 'fire', 'smoke', 'explosion', 'leak', 'gas', 'electrical', 'shock', 'burn'];
  const foundSafety = safetyKeywords.filter((keyword) => text.includes(keyword));
  if (foundSafety.length > 0) {
    score += 40;
    reasons.push(`Safety concern detected: ${foundSafety.join(', ')}`);
  }

  const failureKeywords = ['not working', 'completely', 'totally', 'stopped', 'unusable', 'broken', 'failed', 'dead', "won't start"];
  const foundFailure = failureKeywords.filter((keyword) => text.includes(keyword));
  if (foundFailure.length > 0 || complaint.machine_unusable) {
    score += 30;
    reasons.push('Machine completely unusable');
  }

  const productionKeywords = ['production', 'testing', 'deadline', 'urgent', 'immediately', 'asap', 'critical', 'important project'];
  const foundProduction = productionKeywords.filter((keyword) => text.includes(keyword));
  if (foundProduction.length > 0) {
    score += 25;
    reasons.push('Production/testing impact');
  }

  const criticalMachines = ['universal testing machine', 'injection moulding', 'extrusion'];
  const machine = db.machines.find((m) => m.id === complaint.machine_id);
  if (machine && criticalMachines.some((cm) => machine.machine_name.toLowerCase().includes(cm))) {
    score += 20;
    reasons.push('Critical equipment affected');
  }

  if (category.includes('electrical') || category.includes('mechanical') || text.includes('electric') || text.includes('power')) {
    score += 15;
    reasons.push('Electrical/mechanical issue');
  }

  const previousComplaints = db.complaints.filter((c) =>
    c.machine_id === complaint.machine_id &&
    c.id !== complaint.id &&
    c.status !== 'Closed'
  );
  if (complaint.machine_id && previousComplaints.length > 0) {
    score += 15;
    reasons.push(`${previousComplaints.length} open complaint(s) for same machine`);
  }

  if (category.includes('calibration') || text.includes('calibration') || text.includes('accuracy') || text.includes('reading')) {
    score += 10;
    reasons.push('Calibration/accuracy issue');
  }

  if (/error|e\d+|fault|code/.test(text)) {
    score += 10;
    reasons.push('Technical error code detected');
  }

  let suggestedPriority;
  if (score >= 60) suggestedPriority = 'Critical';
  else if (score >= 40) suggestedPriority = 'High';
  else if (score >= 20) suggestedPriority = 'Medium';
  else suggestedPriority = 'Low';

  return {
    suggestedPriority,
    confidenceScore: score,
    reasons,
    analysis: `AI Analysis: ${reasons.length > 0 ? reasons.join(' • ') : 'Routine maintenance or minor issue'}`
  };
}

/* ------------------------------------------------------------------ *
 * Middleware
 * ------------------------------------------------------------------ */

const auth = (req, res, next) => {
  try {
    const token = req.cookies.token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const payload = jwt.verify(token, JWT_SECRET);

    // The role is read from the store rather than trusted from the token: when an
    // administrator changes an account's role, or removes it, that must take effect
    // at once instead of whenever the holder happens to sign in again.
    const account = db.users.find((u) => u.id === payload.id);
    if (!account) {
      return res.status(401).json({ success: false, message: 'This account no longer exists' });
    }

    req.user = { ...payload, email: account.email, role: account.role };
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }
  next();
};

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `complaint-${uniqueSuffix}${path.extname(file.originalname).toLowerCase()}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) return cb(null, true);
    cb(new Error('Only image files (JPEG, JPG, PNG, WebP) are allowed'));
  }
});

/* ------------------------------------------------------------------ *
 * Auth routes
 * ------------------------------------------------------------------ */

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role, user_id, phone } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ success: false, message: 'Name, email, password and role are required' });
    }

    // Privileged roles can only be provisioned by an existing administrator.
    const selfServiceRoles = ['student', 'teacher', 'worker', 'faculty', 'staff', 'technician'];
    if (!selfServiceRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'HOD/Admin accounts cannot be self-registered. Please contact the department administrator.'
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long' });
    }

    if (db.users.some((u) => u.email.toLowerCase() === normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    const newUser = {
      id: nextId('userId'),
      name: String(name).trim(),
      email: normalizedEmail,
      password_hash: await bcrypt.hash(password, 10),
      role,
      user_id: user_id ? String(user_id).trim() : null,
      phone: phone ? String(phone).trim() : null,
      department: 'Plastic Polymer Testing',
      created_at: new Date().toISOString()
    };

    db.users.push(newUser);
    persist();

    const token = jwt.sign({ id: newUser.id, email: newUser.email, role: newUser.role }, JWT_SECRET, { expiresIn: JWT_EXPIRE });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });

    res.status(201).json({ success: true, message: 'Registration successful', user: publicUser(newUser), token });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const user = db.users.find((u) => u.email.toLowerCase() === String(email).trim().toLowerCase());
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRE });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });

    res.json({ success: true, message: 'Login successful', user: publicUser(user), token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }
  res.json({ success: true, user: publicUser(user) });
});

// Lets the signed-in user set the name that appears on the alerts they send.
// The name is read from the session on every request, so this is what makes
// "whoever the HOD is" the actual signer of assignment emails.
app.patch('/api/auth/profile', auth, (req, res) => {
  const user = actingUser(req);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  const { name, phone } = req.body;

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (trimmed.length < 2) {
      return res.status(400).json({ success: false, message: 'Please provide your full name' });
    }
    user.name = trimmed;
  }

  if (phone !== undefined && String(phone).trim() && !isValidPhone(phone)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid phone number (7-15 digits, optionally starting with +)' });
  }
  if (phone !== undefined) user.phone = phone ? String(phone).trim() : null;

  persist();
  res.json({ success: true, message: 'Profile updated', user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out successfully' });
});

/* ------------------------------------------------------------------ *
 * Machine + location routes
 * ------------------------------------------------------------------ */

app.get('/api/machines', auth, (req, res) => {
  const machines = db.machines
    .filter((m) => m.status !== 'Retired')
    .map((machine) => {
      const location = db.locations.find((l) => l.id === machine.location_id);
      return {
        ...machine,
        building: location ? location.building : null,
        hall: location ? location.hall : null,
        room_number: location ? location.room_number : null,
        floor: location ? location.floor : null
      };
    })
    .sort((a, b) => a.machine_name.localeCompare(b.machine_name));

  res.json({ success: true, machines });
});

app.get('/api/machines/locations', auth, (req, res) => {
  res.json({ success: true, locations: db.locations });
});

app.get('/api/machines/:id', auth, (req, res) => {
  const machine = db.machines.find((m) => m.id === parseInt(req.params.id, 10));
  if (!machine) {
    return res.status(404).json({ success: false, message: 'Machine not found' });
  }

  const location = db.locations.find((l) => l.id === machine.location_id);
  const related = db.complaints.filter((c) => c.machine_id === machine.id);

  res.json({
    success: true,
    machine: {
      ...machine,
      building: location ? location.building : null,
      hall: location ? location.hall : null,
      room_number: location ? location.room_number : null,
      floor: location ? location.floor : null
    },
    stats: {
      total_complaints: related.length,
      pending_complaints: related.filter((c) => !['Resolved', 'Closed', 'Rejected'].includes(c.status)).length,
      resolved_complaints: related.filter((c) => ['Resolved', 'Closed'].includes(c.status)).length
    },
    recentComplaints: related
      .slice()
      .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))
      .slice(0, 10)
      .map(complaintView)
  });
});

/* ------------------------------------------------------------------ *
 * Complaint routes
 * ------------------------------------------------------------------ */

app.post('/api/complaints', auth, upload.array('images', 5), (req, res) => {
  try {
    const {
      complaint_type,
      machine_id,
      location_id,
      general_location,
      category,
      title,
      description,
      priority,
      problem_occurred_at,
      machine_unusable
    } = req.body;

    const type = complaint_type || 'Machine Related';

    if (!title || !String(title).trim() || !description || !String(description).trim()) {
      return res.status(400).json({ success: false, message: 'Problem title and description are required' });
    }
    if (!category) {
      return res.status(400).json({ success: false, message: 'Problem category is required' });
    }
    if (!COMPLAINT_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid complaint type' });
    }

    let finalMachineId = null;
    let finalLocationId = null;
    let locationText = general_location ? String(general_location).trim() : null;

    if (type === 'Machine Related') {
      const machine = db.machines.find((m) => m.id === parseInt(machine_id, 10));
      if (!machine) {
        return res.status(400).json({ success: false, message: 'Please select a valid machine' });
      }
      const location = db.locations.find((l) => l.id === parseInt(location_id, 10)) ||
        db.locations.find((l) => l.id === machine.location_id);
      if (!location) {
        return res.status(400).json({ success: false, message: 'Please select a valid location' });
      }
      finalMachineId = machine.id;
      finalLocationId = location.id;
      locationText = null;
    } else if (!locationText) {
      return res.status(400).json({ success: false, message: 'Please provide the location or area' });
    }

    const complaint = {
      id: nextId('complaintId'),
      ticket_number: '',
      reporter_id: req.user.id,
      complaint_type: type,
      machine_id: finalMachineId,
      location_id: finalLocationId,
      general_location: locationText,
      category: String(category).trim(),
      title: String(title).trim(),
      description: String(description).trim(),
      priority: PRIORITIES.includes(priority) ? priority : 'Medium',
      status: 'Submitted',
      problem_occurred_at: problem_occurred_at || new Date().toISOString(),
      // FormData submits "on" for a checked checkbox
      machine_unusable: machine_unusable === true || machine_unusable === 'true' || machine_unusable === 'on',
      submitted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      resolved_at: null,
      closed_at: null
    };
    complaint.ticket_number = generateTicketNumber(complaint.id);

    const aiAnalysis = analyzeComplaintPriority(complaint);
    complaint.ai_suggested_priority = aiAnalysis.suggestedPriority;
    complaint.ai_confidence_score = aiAnalysis.confidenceScore;
    complaint.ai_analysis = aiAnalysis.analysis;
    complaint.ai_reasons = aiAnalysis.reasons;

    // Elevate the user supplied priority when the AI considers the issue more severe
    const rank = { Low: 1, Medium: 2, High: 3, Critical: 4 };
    if (rank[aiAnalysis.suggestedPriority] > rank[complaint.priority]) {
      complaint.priority = aiAnalysis.suggestedPriority;
      complaint.priority_auto_adjusted = true;
    }

    db.complaints.push(complaint);

    if (req.files && req.files.length > 0) {
      req.files.forEach((file) => {
        db.complaintImages.push({
          id: nextId('imageId'),
          complaint_id: complaint.id,
          image_url: `/uploads/complaints/${file.filename}`,
          uploaded_by: req.user.id,
          uploaded_at: new Date().toISOString()
        });
      });
    }

    recordUpdate(complaint, req.user.id, null, 'Submitted', 'Complaint submitted successfully');

    createNotification(
      req.user.id,
      complaint.id,
      'Complaint Submitted',
      `Your complaint ${complaint.ticket_number} has been submitted successfully and is awaiting review.`
    );

    persist();

    res.status(201).json({ success: true, message: 'Complaint submitted successfully', complaint: complaintView(complaint) });
  } catch (error) {
    console.error('Submit complaint error:', error);
    res.status(500).json({ success: false, message: 'Failed to submit complaint' });
  }
});

app.get('/api/complaints/my', auth, (req, res) => {
  const { status, priority } = req.query;

  const complaints = db.complaints
    .filter((c) => c.reporter_id === req.user.id)
    .filter((c) => !status || c.status === status)
    .filter((c) => !priority || c.priority === priority)
    .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))
    .map(complaintView);

  res.json({ success: true, complaints });
});

app.get('/api/complaints', auth, authorize(...COMPLAINT_VIEW_ROLES), (req, res) => {
  const { status, priority, machine_id, search } = req.query;

  const searchTerm = search ? String(search).toLowerCase() : null;

  const complaints = db.complaints
    .filter((c) => !status || c.status === status)
    .filter((c) => !priority || c.priority === priority)
    .filter((c) => !machine_id || c.machine_id === parseInt(machine_id, 10))
    .map(complaintView)
    .filter((c) => !searchTerm ||
      (c.ticket_number || '').toLowerCase().includes(searchTerm) ||
      (c.title || '').toLowerCase().includes(searchTerm) ||
      (c.machine_name || '').toLowerCase().includes(searchTerm))
    .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));

  res.json({ success: true, complaints });
});

app.get('/api/complaints/:id', auth, (req, res) => {
  const complaint = db.complaints.find((c) => c.id === parseInt(req.params.id, 10));
  if (!complaint) {
    return res.status(404).json({ success: false, message: 'Complaint not found' });
  }

  const canView = complaint.reporter_id === req.user.id ||
    [...ADMIN_ROLES, ...REVIEW_ROLES, ...STAFF_ROLES].includes(req.user.role);
  if (!canView) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  const images = db.complaintImages.filter((img) => img.complaint_id === complaint.id);
  const updates = db.complaintUpdates
    .filter((u) => u.complaint_id === complaint.id)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map((u) => ({ ...u, user_name: (db.users.find((usr) => usr.id === u.user_id) || {}).name || 'System' }));

  const assignment = db.assignments
    .filter((a) => a.complaint_id === complaint.id)
    .sort((a, b) => new Date(b.assigned_at) - new Date(a.assigned_at))[0];

  res.json({
    success: true,
    complaint: complaintView(complaint),
    images,
    updates,
    assignment: assignment
      ? {
        ...assignment,
        assigned_to_name: publicUserSummary(db.users.find((u) => u.id === assignment.assigned_to))?.name || null,
        assigned_by_name: publicUserSummary(db.users.find((u) => u.id === assignment.assigned_by))?.name || null
      }
      : null
  });
});

/* ------------------------------------------------------------------ *
 * Dashboard routes
 * ------------------------------------------------------------------ */

function buildStatistics() {
  const countByStatus = (status) => db.complaints.filter((c) => c.status === status).length;

  return {
    total_complaints: db.complaints.length,
    submitted: countByStatus('Submitted'),
    under_review: countByStatus('Under Review'),
    verified: countByStatus('Verified'),
    assigned: countByStatus('Assigned'),
    in_progress: countByStatus('In Progress'),
    on_hold: countByStatus('On Hold'),
    resolved: countByStatus('Resolved'),
    closed: countByStatus('Closed'),
    rejected: countByStatus('Rejected'),
    high_priority: db.complaints.filter((c) => c.priority === 'High' || c.priority === 'Critical').length,
    resolved_or_closed: countByStatus('Resolved') + countByStatus('Closed')
  };
}

// Public, aggregate-only statistics used by the landing page
app.get('/api/stats/public', (req, res) => {
  const stats = buildStatistics();
  res.json({
    success: true,
    statistics: {
      total_complaints: stats.total_complaints,
      in_progress: stats.in_progress + stats.assigned,
      resolved: stats.resolved_or_closed,
      machines: db.machines.length,
      locations: db.locations.length
    }
  });
});

app.get('/api/dashboard/statistics', auth, (req, res) => {
  const statistics = buildStatistics();

  let userStats = null;
  if (!COMPLAINT_VIEW_ROLES.includes(req.user.role)) {
    const mine = db.complaints.filter((c) => c.reporter_id === req.user.id);
    userStats = {
      my_complaints: mine.length,
      my_pending: mine.filter((c) => !['Resolved', 'Closed', 'Rejected'].includes(c.status)).length,
      my_resolved: mine.filter((c) => ['Resolved', 'Closed'].includes(c.status)).length
    };
  }

  let staffStats = null;
  if (ASSIGNEE_ROLES.includes(req.user.role)) {
    const mine = db.assignments.filter((a) => a.assigned_to === req.user.id);
    const withComplaint = mine.map((a) => ({ assignment: a, complaint: db.complaints.find((c) => c.id === a.complaint_id) }))
      .filter((entry) => entry.complaint);

    staffStats = {
      assigned_tasks: withComplaint.length,
      pending_tasks: withComplaint.filter((e) => e.complaint.status === 'Assigned').length,
      in_progress_tasks: withComplaint.filter((e) => e.complaint.status === 'In Progress').length,
      completed_tasks: withComplaint.filter((e) => ['Resolved', 'Closed'].includes(e.complaint.status)).length,
      overdue_tasks: withComplaint.filter((e) =>
        e.assignment.due_date &&
        new Date(e.assignment.due_date) < new Date() &&
        !['Resolved', 'Closed'].includes(e.complaint.status)
      ).length
    };
  }

  const byCategory = Object.entries(
    db.complaints.reduce((acc, c) => {
      acc[c.category] = (acc[c.category] || 0) + 1;
      return acc;
    }, {})
  ).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count).slice(0, 10);

  const byMachine = db.machines
    .map((m) => ({ machine_name: m.machine_name, count: db.complaints.filter((c) => c.machine_id === m.id).length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const recentActivity = db.complaints
    .slice()
    .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))
    .slice(0, 5)
    .map(complaintView);

  res.json({ success: true, statistics, userStats, staffStats, byCategory, byMachine, recentActivity });
});

app.get('/api/admin/complaints/prioritized', auth, authorize(...ADMIN_ROLES, 'faculty'), (req, res) => {
  const priorityOrder = { Critical: 4, High: 3, Medium: 2, Low: 1 };

  const complaints = db.complaints
    .filter((c) => ['Submitted', 'Under Review', 'Verified'].includes(c.status))
    .map(complaintView)
    .sort((a, b) => {
      const scoreDiff = (b.ai_confidence_score || 0) - (a.ai_confidence_score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0);
    });

  res.json({ success: true, complaints });
});

app.get('/api/dashboard/notifications', auth, (req, res) => {
  const notifications = db.notifications
    .filter((n) => n.user_id === req.user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50)
    .map((n) => ({
      ...n,
      ticket_number: (db.complaints.find((c) => c.id === n.complaint_id) || {}).ticket_number || null
    }));

  res.json({
    success: true,
    notifications,
    unread_count: notifications.filter((n) => !n.read_status).length
  });
});

app.patch('/api/dashboard/notifications/:id/read', auth, (req, res) => {
  const notification = db.notifications.find((n) => n.id === parseInt(req.params.id, 10) && n.user_id === req.user.id);
  if (!notification) {
    return res.status(404).json({ success: false, message: 'Notification not found' });
  }
  notification.read_status = true;
  persist();
  res.json({ success: true, message: 'Notification marked as read' });
});

app.post('/api/dashboard/notifications/read-all', auth, (req, res) => {
  db.notifications.filter((n) => n.user_id === req.user.id).forEach((n) => { n.read_status = true; });
  persist();
  res.json({ success: true, message: 'All notifications marked as read' });
});

// Tasks assigned to the signed-in staff member / technician
app.get('/api/dashboard/tasks', auth, authorize(...ASSIGNEE_ROLES), (req, res) => {
  const tasks = db.assignments
    .filter((a) => a.assigned_to === req.user.id)
    .map((assignment) => {
      const complaint = db.complaints.find((c) => c.id === assignment.complaint_id);
      if (!complaint) return null;
      return {
        ...assignment,
        ...complaintView(complaint),
        assignment_id: assignment.id,
        complaint_id: complaint.id,
        complaint_status: complaint.status,
        assigned_by_name: publicUserSummary(db.users.find((u) => u.id === assignment.assigned_by))?.name || null,
        is_overdue: Boolean(assignment.due_date) &&
          new Date(assignment.due_date) < new Date() &&
          !['Resolved', 'Closed'].includes(complaint.status)
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.assigned_at) - new Date(a.assigned_at));

  res.json({ success: true, tasks });
});

/* ------------------------------------------------------------------ *
 * Admin routes
 * ------------------------------------------------------------------ */

app.patch('/api/admin/complaints/:id/status', auth, authorize(...REVIEW_ROLES, ...STAFF_ROLES), async (req, res) => {
  const complaint = db.complaints.find((c) => c.id === parseInt(req.params.id, 10));
  if (!complaint) {
    return res.status(404).json({ success: false, message: 'Complaint not found' });
  }

  const { status, comment } = req.body;
  if (!ALL_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status value' });
  }

  const isWorker = STAFF_ROLES.includes(req.user.role);
  if (isWorker) {
    if (!WORKER_STATUSES.includes(status)) {
      return res.status(403).json({ success: false, message: 'Technicians can only set: In Progress, On Hold, Resolved or Reopened' });
    }
    if (!isAssignedTo(complaint.id, req.user.id)) {
      return res.status(403).json({ success: false, message: 'You can only update complaints assigned to you' });
    }
  }

  if (complaint.status === status) {
    return res.status(400).json({ success: false, message: `Complaint is already in "${status}" status` });
  }

  const oldStatus = complaint.status;
  complaint.status = status;
  complaint.updated_at = new Date().toISOString();
  if (status === 'Resolved') complaint.resolved_at = complaint.updated_at;
  if (status === 'Closed') complaint.closed_at = complaint.updated_at;

  // Keep the machine status in sync with the work being carried out
  if (['In Progress', 'On Hold'].includes(status)) {
    const machine = db.machines.find((m) => m.id === complaint.machine_id);
    if (machine) machine.status = 'Under Maintenance';
  }
  if (['Resolved', 'Closed'].includes(status)) {
    const machine = db.machines.find((m) => m.id === complaint.machine_id);
    // Only restore to Operational when no other active complaint exists for the machine
    const otherActive = db.complaints.some((c) =>
      c.machine_id === complaint.machine_id &&
      c.id !== complaint.id &&
      !['Resolved', 'Closed', 'Rejected'].includes(c.status)
    );
    if (machine && !otherActive) machine.status = 'Operational';
  }

  recordUpdate(complaint, req.user.id, oldStatus, status, comment || `Status changed to ${status}`);

  createNotification(
    complaint.reporter_id,
    complaint.id,
    'Status Update',
    `Complaint ${complaint.ticket_number} status changed to: ${status}`
  );

  const actorName = actingUserName(req);

  // The person who reported the complaint follows it by email too, so they learn who
  // moved it, from where and to what — not merely that "something changed". Nobody is
  // emailed about their own action.
  const reporter = db.users.find((u) => u.id === complaint.reporter_id);
  const reporterMessage = (reporter && reporter.id !== req.user.id)
    ? recordMessage(reporter, {
      kind: 'status',
      subject: `${complaint.ticket_number} is now "${status}"`,
      body: `Dear ${reporter.name},\n\nYour complaint ${complaint.ticket_number} (${complaint.title}) has been moved from "${oldStatus}" to "${status}" by ${actorName}.\n\n${comment || 'No comment provided.'}\n\nYou can track the progress from your dashboard.`,
      complaint
    })
    : null;

  // Keep whoever is working on the complaint informed (skip the person who just made the change)
  const notifications = db.assignments
    .filter((a) => a.complaint_id === complaint.id && !a.completed_at && a.assigned_to !== req.user.id)
    .map((a) => db.users.find((u) => u.id === a.assigned_to))
    .filter(Boolean)
    .map((assignee) => recordMessage(assignee, {
      kind: 'status',
      subject: `${complaint.ticket_number} is now "${status}"`,
      body: `Dear ${assignee.name},\n\nComplaint ${complaint.ticket_number} (${complaint.title}) has been moved to "${status}" by ${actorName}.\n\n${comment || 'No comment provided.'}`,
      complaint
    }));

  // Close out the assignment when the work is finished
  if (['Resolved', 'Closed'].includes(status)) {
    db.assignments
      .filter((a) => a.complaint_id === complaint.id && !a.completed_at)
      .forEach((a) => {
        a.completed_at = complaint.updated_at;
        a.completion_notes = comment || null;
      });
  }

  await Promise.all([...notifications, reporterMessage].filter(Boolean).map(deliverMessage));

  persist();
  res.json({ success: true, message: 'Status updated successfully' });
});

app.post('/api/admin/complaints/:id/assign', auth, authorize(...ADMIN_ROLES, 'faculty'), async (req, res) => {
  const complaint = db.complaints.find((c) => c.id === parseInt(req.params.id, 10));
  if (!complaint) {
    return res.status(404).json({ success: false, message: 'Complaint not found' });
  }

  const { assigned_to, due_date, instructions } = req.body;
  const staffMember = db.users.find((u) => u.id === parseInt(assigned_to, 10));
  if (!staffMember) {
    return res.status(400).json({ success: false, message: 'Please select a valid staff member' });
  }
  if (!ASSIGNEE_ROLES.includes(staffMember.role)) {
    return res.status(400).json({ success: false, message: `Complaints can only be assigned to: ${ASSIGNEE_ROLES.join(', ')}` });
  }

  const oldStatus = complaint.status;

  db.assignments.push({
    id: nextId('assignmentId'),
    complaint_id: complaint.id,
    assigned_to: staffMember.id,
    assigned_by: req.user.id,
    assigned_at: new Date().toISOString(),
    due_date: due_date || null,
    instructions: instructions || null,
    completed_at: null,
    completion_notes: null
  });

  complaint.status = 'Assigned';
  complaint.updated_at = new Date().toISOString();

  recordUpdate(complaint, req.user.id, oldStatus, 'Assigned', `Assigned to ${staffMember.name}`);

  createNotification(
    complaint.reporter_id,
    complaint.id,
    'Complaint Assigned',
    `Your complaint ${complaint.ticket_number} has been assigned to ${staffMember.name}.`
  );

  createNotification(
    staffMember.id,
    complaint.id,
    'New Task Assigned',
    `You have been assigned complaint ${complaint.ticket_number}: ${complaint.title}`
  );

  // Outbox: this is what reaches the staff member's phone number / email address
  const signerName = actingUserName(req);
  const dueLine = due_date ? `\nTarget completion date: ${new Date(due_date).toDateString()}` : '';
  const instructionsLine = instructions ? `\nInstructions: ${instructions}` : '';
  const message = recordMessage(staffMember, {
    kind: 'assignment',
    subject: `New task assigned: ${complaint.ticket_number}`,
    body: `Dear ${staffMember.name},\n\nA new task has been assigned to you.\n\nTicket: ${complaint.ticket_number}\nType of work: ${complaint.complaint_type}\nComplaint: ${complaint.title}\nPriority: ${complaint.priority}\nLocation: ${complaintView(complaint).location_display}${dueLine}${instructionsLine}\n\nAssigned by: ${signerName}\n\nPlease open the staff dashboard to update the progress.`,
    complaint
  });

  // Outbox: the complainer is told who is handling their complaint, with the details
  const reporter = db.users.find((u) => u.id === complaint.reporter_id) || null;
  const reporterMessage = recordMessage(reporter, {
    kind: 'assignment',
    subject: `Your complaint ${complaint.ticket_number} has been assigned`,
    body: `Dear ${reporter.name},\n\nYour complaint has been assigned to a staff member.\n\nTicket: ${complaint.ticket_number}\nComplaint: ${complaint.title}\nType of work: ${complaint.complaint_type}\nPriority: ${complaint.priority}\nLocation: ${complaintView(complaint).location_display}\nAssigned to: ${staffMember.name} (${staffMember.role})${staffMember.email ? `\nStaff email: ${staffMember.email}` : ''}${staffMember.phone ? `\nStaff phone: ${staffMember.phone}` : ''}${dueLine}${instructionsLine}\n\nAssigned by: ${signerName}\n\nYou can track the progress from your dashboard.`,
    complaint
  });

  // Push the task alerts through the real gateways (email / SMS) and record the outcome
  await Promise.all([message, reporterMessage].filter(Boolean).map(deliverMessage));

  persist();
  res.json({
    success: true,
    message: `Complaint assigned to ${staffMember.name}`,
    delivered: message
      ? {
        channel: message.delivery_channel,
        email: message.recipient_email,
        phone: message.recipient_phone,
        status: message.delivery_status,
        attempts: message.delivery_attempts
      }
      : null
  });
});

app.get('/api/admin/users', auth, authorize(...ADMIN_ROLES), (req, res) => {
  const users = db.users
    .slice()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(publicUser);

  res.json({ success: true, users });
});

// Roles an administrator may move an account into from the Staff tab. Self-registered
// accounts start as reporters, so this is how one of them becomes assignable.
const SWITCHABLE_ROLES = ['student', 'teacher', 'staff', 'worker', 'technician', 'faculty'];

app.patch('/api/admin/users/:id/role', auth, authorize(...ADMIN_ROLES), (req, res) => {
  const user = db.users.find((u) => u.id === parseInt(req.params.id, 10));
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  const { role } = req.body;
  if (!SWITCHABLE_ROLES.includes(role)) {
    return res.status(400).json({
      success: false,
      message: `Role must be one of: ${SWITCHABLE_ROLES.join(', ')}`
    });
  }

  // Administrators are never demoted from here, so the department cannot lock itself
  // out of its own dashboard with a single click.
  if (ADMIN_ROLES.includes(user.role)) {
    return res.status(403).json({ success: false, message: 'An HOD or admin account cannot be changed here' });
  }

  if (user.role === role) {
    return res.status(400).json({ success: false, message: `${user.name} is already a ${role}` });
  }

  const previousRole = user.role;
  user.role = role;
  persist();

  res.json({
    success: true,
    message: `${user.name} is now a ${role} (was ${previousRole})`,
    user: publicUser(user)
  });
});

// Distinct "type of work" labels for the still-open tasks in a list of assignments.
const assignedWorkTypes = (assignments) => [...new Set(
  assignments
    .map((a) => {
      const complaint = db.complaints.find((c) => c.id === a.complaint_id);
      return complaint && !['Resolved', 'Closed'].includes(complaint.status)
        ? complaint.complaint_type
        : null;
    })
    .filter(Boolean)
)];

app.get('/api/admin/staff', auth, authorize(...REVIEW_ROLES), (req, res) => {
  const staff = db.users
    .filter((u) => ASSIGNEE_ROLES.includes(u.role))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((u) => {
      const assignments = db.assignments.filter((a) => a.assigned_to === u.id);
      const open = assignments.filter((a) => {
        if (a.completed_at) return false;
        const complaint = db.complaints.find((c) => c.id === a.complaint_id);
        return complaint && !['Resolved', 'Closed'].includes(complaint.status);
      });
      const messages = db.messages.filter((m) => m.recipient_id === u.id);

      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        user_id: u.user_id,
        phone: u.phone,
        created_at: u.created_at,
        total_tasks: assignments.length,
        open_tasks: open.length,
        completed_tasks: assignments.length - open.length,
        message_count: messages.length,
        work_types: assignedWorkTypes(open)
      };
    });

  res.json({ success: true, staff });
});

const staffProfile = (user) => {
  const assignments = db.assignments
    .filter((a) => a.assigned_to === user.id)
    .map((assignment) => {
      const complaint = db.complaints.find((c) => c.id === assignment.complaint_id);
      if (!complaint) return null;
      return {
        ...assignment,
        ...complaintView(complaint),
        assignment_id: assignment.id,
        complaint_id: complaint.id,
        complaint_status: complaint.status,
        is_overdue: Boolean(assignment.due_date) &&
          new Date(assignment.due_date) < new Date() &&
          !['Resolved', 'Closed'].includes(complaint.status)
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.assigned_at) - new Date(a.assigned_at));

  const messages = db.messages
    .filter((m) => m.recipient_id === user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return {
    profile: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      user_id: user.user_id,
      department: user.department,
      member_since: user.created_at
    },
    stats: {
      total_tasks: assignments.length,
      open_tasks: assignments.filter((t) => !['Resolved', 'Closed'].includes(t.complaint_status)).length,
      in_progress_tasks: assignments.filter((t) => t.complaint_status === 'In Progress').length,
      completed_tasks: assignments.filter((t) => ['Resolved', 'Closed'].includes(t.complaint_status)).length,
      overdue_tasks: assignments.filter((t) => t.is_overdue).length,
      messages_sent: messages.length
    },
    // What kind of work this member currently has on their plate
    work_types: Object.entries(
      assignments
        .filter((t) => !['Resolved', 'Closed'].includes(t.complaint_status))
        .reduce((acc, t) => {
          const key = t.complaint_type || 'Unspecified';
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {})
    ).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    tasks: assignments,
    messages
  };
};

// Full staff profile: contact details, workload, current tasks and the message history
// that was addressed to the member's phone number / email address.
app.get('/api/admin/staff/:id', auth, authorize(...REVIEW_ROLES), (req, res) => {
  const user = db.users.find((u) => u.id === parseInt(req.params.id, 10));
  if (!user) {
    return res.status(404).json({ success: false, message: 'Staff member not found' });
  }
  if (!ASSIGNEE_ROLES.includes(user.role)) {
    return res.status(400).json({ success: false, message: 'This user is not a staff member' });
  }

  res.json({ success: true, ...staffProfile(user) });
});

// Provision a new staff / technician / worker / faculty account
app.post('/api/admin/staff', auth, authorize(...ADMIN_ROLES), async (req, res) => {
  try {
    const { name, email, phone, role, user_id, password } = req.body;

    if (!name || !email || !role || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, role and a temporary password are required' });
    }
    if (!PROVISIONABLE_STAFF_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Role must be one of: ${PROVISIONABLE_STAFF_ROLES.join(', ')}`
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }
    if (db.users.some((u) => u.email.toLowerCase() === normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long' });
    }
    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ success: false, message: 'A phone number is required so task alerts can reach the staff member' });
    }
    if (!isValidPhone(phone)) {
      return res.status(400).json({ success: false, message: 'Please provide a valid phone number (7-15 digits, optionally starting with +)' });
    }

    const newUser = {
      id: nextId('userId'),
      name: String(name).trim(),
      email: normalizedEmail,
      password_hash: await bcrypt.hash(password, 10),
      role,
      user_id: user_id ? String(user_id).trim() : null,
      phone: String(phone).trim(),
      department: 'Plastic Polymer Testing',
      created_at: new Date().toISOString()
    };

    db.users.push(newUser);
    persist();
    res.status(201).json({ success: true, message: `${newUser.name} added to the staff list`, user: publicUser(newUser) });
  } catch (error) {
    console.error('Add staff error:', error);
    res.status(500).json({ success: false, message: 'Could not add the staff member' });
  }
});

// Edit a staff member — used to fill in / correct the names shown in the staff list
app.patch('/api/admin/staff/:id', auth, authorize(...ADMIN_ROLES), (req, res) => {
  const user = db.users.find((u) => u.id === parseInt(req.params.id, 10));
  if (!user) {
    return res.status(404).json({ success: false, message: 'Staff member not found' });
  }
  if (!ASSIGNEE_ROLES.includes(user.role)) {
    return res.status(400).json({ success: false, message: 'This user is not a staff member' });
  }

  const { name, email, phone, user_id, role, password } = req.body;

  if (email !== undefined && email !== '') {
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }
    if (db.users.some((u) => u.id !== user.id && u.email.toLowerCase() === normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Email already registered to another user' });
    }
    user.email = normalizedEmail;
  }

  if (phone !== undefined && phone !== null && String(phone).trim() && !isValidPhone(phone)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid phone number (7-15 digits, optionally starting with +)' });
  }

  if (role !== undefined && role !== '') {
    if (!PROVISIONABLE_STAFF_ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: `Role must be one of: ${PROVISIONABLE_STAFF_ROLES.join(', ')}` });
    }
    user.role = role;
  }

  if (name !== undefined && String(name).trim()) user.name = String(name).trim();
  if (phone !== undefined) user.phone = phone ? String(phone).trim() : null;
  if (user_id !== undefined) user.user_id = user_id ? String(user_id).trim() : null;

  if (password) {
    if (String(password).length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long' });
    }
    user.password_hash = bcrypt.hashSync(String(password), 10);
  }

  persist();
  res.json({ success: true, message: 'Staff member updated', user: publicUser(user) });
});

app.delete('/api/admin/staff/:id', auth, authorize(...ADMIN_ROLES), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = db.users.find((u) => u.id === id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'Staff member not found' });
  }
  if (id === req.user.id) {
    return res.status(400).json({ success: false, message: 'You cannot remove your own account' });
  }

  const openAssignments = db.assignments.filter((a) => {
    if (a.assigned_to !== id || a.completed_at) return false;
    const complaint = db.complaints.find((c) => c.id === a.complaint_id);
    return complaint && !['Resolved', 'Closed'].includes(complaint.status);
  });

  if (openAssignments.length > 0) {
    return res.status(400).json({
      success: false,
      message: `${user.name} still has ${openAssignments.length} open task(s). Reassign or close them first.`
    });
  }

  db.users.splice(db.users.indexOf(user), 1);
  db.notifications = db.notifications.filter((n) => n.user_id !== id);
  persist();
  res.json({ success: true, message: `${user.name} removed from the staff list` });
});

/* ------------------------------------------------------------------ *
 * Message outbox
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Notification gateway status and outbox management
 *
 * Deliberately reports *verification*, not just configuration: environment
 * variables being present is never presented as working delivery. No secret
 * value (SMTP password, auth token, API key) is ever returned.
 * ------------------------------------------------------------------ */

const gatewayStatusView = (health, configured, extra) => ({
  ...extra,
  configured,
  status: health.status,
  checked_at: health.checked_at,
  detail: health.detail
});

app.get('/api/notifications/gateways', auth, authorize(...ADMIN_ROLES, 'faculty'), (req, res) => {
  res.json({
    success: true,
    email: gatewayStatusView(gatewayHealth.email, NOTIFY.email.configured, {
      provider: NOTIFY.email.provider,
      library_installed: NODEMAILER_AVAILABLE,
      smtp_host: NOTIFY.email.host,
      smtp_port: NOTIFY.email.host ? NOTIFY.email.port : null,
      secure: NOTIFY.email.secure,
      from: NOTIFY.email.from,
      missing: NOTIFY.email.missing,
      timeout_ms: NOTIFY.email.timeout
    }),
    sms: gatewayStatusView(gatewayHealth.sms, NOTIFY.sms.configured, {
      provider: NOTIFY.sms.provider,
      sender_id: NOTIFY.sms.senderId,
      missing: NOTIFY.sms.missing,
      timeout_ms: NOTIFY.sms.timeout
    })
  });
});

// Re-check the gateways on demand (the dashboard "Re-check" button)
app.post('/api/notifications/gateways/verify', auth, authorize(...ADMIN_ROLES), async (req, res) => {
  try {
    await verifyGateways();
    res.json({ success: true, email: gatewayHealth.email, sms: gatewayHealth.sms });
  } catch (error) {
    console.error('Gateway verification error:', redact(error.message));
    res.status(500).json({ success: false, message: 'Could not verify the notification gateways' });
  }
});

/**
 * A notification is worth retrying when it still has a channel that could
 * plausibly be delivered now:
 *   failed / partial — the gateway rejected it, so try the failed channel again
 *   queued           — recorded but never attempted
 *   skipped          — no gateway was configured at the time; only worth
 *                      retrying if the recipient actually has a contact address
 * Channels that already succeeded are carried over untouched by deliverMessage,
 * so a retry can never send a duplicate.
 */
const isRetryableNotification = (message) => {
  const status = message && message.delivery_status;
  if (status === 'failed' || status === 'partial' || status === 'queued') return true;
  if (status === 'skipped') return Boolean(message.recipient_email || message.recipient_phone);
  return false;
};

const outboxSummary = () => {
  const counts = { queued: 0, sent: 0, partial: 0, failed: 0, skipped: 0 };
  db.messages.forEach((m) => {
    const key = counts[m.delivery_status] === undefined ? 'queued' : m.delivery_status;
    counts[key] += 1;
  });
  return {
    total: db.messages.length,
    ...counts,
    // "pending" = recorded but no terminal gateway outcome yet
    pending: counts.queued,
    retryable: db.messages.filter(isRetryableNotification).length
  };
};

// Admin view of the whole outbox, so failed notifications are visible and fixable
app.get('/api/notifications/outbox', auth, authorize(...ADMIN_ROLES, 'faculty'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);

  const messages = [...db.messages]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);

  res.json({ success: true, summary: outboxSummary(), messages });
});

/**
 * Re-attempt a failed notification. Channels that already succeeded are left
 * alone by deliverMessage(), so a retry can never send a duplicate to a member
 * who has already received that channel.
 */
app.post('/api/notifications/messages/:id/retry', auth, authorize(...ADMIN_ROLES), async (req, res) => {
  const message = db.messages.find((m) => m.id === parseInt(req.params.id, 10));
  if (!message) {
    return res.status(404).json({ success: false, message: 'Notification not found' });
  }
  if (message.delivery_status === 'sent') {
    return res.status(409).json({ success: false, message: 'This notification has already been delivered' });
  }

  try {
    message.retry_count = (message.retry_count || 0) + 1;
    await deliverMessage(message);
    res.json({ success: true, message: `Retry finished with status "${message.delivery_status}"`, notification: message });
  } catch (error) {
    console.error('Notification retry error:', redact(error.message));
    res.status(500).json({ success: false, message: 'Could not retry the notification' });
  }
});

// Retry every notification that still has an undelivered channel
app.post('/api/notifications/retry-failed', auth, authorize(...ADMIN_ROLES), async (req, res) => {
  const retryable = db.messages.filter(isRetryableNotification);

  try {
    for (const message of retryable) {
      message.retry_count = (message.retry_count || 0) + 1;
      await deliverMessage(message);
    }
    res.json({
      success: true,
      message: `Retried ${retryable.length} notification${retryable.length === 1 ? '' : 's'}`,
      attempted: retryable.length,
      summary: outboxSummary()
    });
  } catch (error) {
    console.error('Bulk notification retry error:', redact(error.message));
    res.status(500).json({ success: false, message: 'Could not retry the notifications' });
  }
});

// Messages addressed to the signed-in user (delivered to their phone number / email)
app.get('/api/staff/messages', auth, (req, res) => {
  const messages = db.messages
    .filter((m) => m.recipient_id === req.user.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({
    success: true,
    messages,
    unread_count: messages.filter((m) => !m.read_status).length
  });
});

app.patch('/api/staff/messages/:id/read', auth, (req, res) => {
  const message = db.messages.find((m) => m.id === parseInt(req.params.id, 10) && m.recipient_id === req.user.id);
  if (!message) {
    return res.status(404).json({ success: false, message: 'Message not found' });
  }
  message.read_status = true;
  persist();
  res.json({ success: true, message: 'Message marked as read' });
});

/* ------------------------------------------------------------------ *
 * Analytics (weekly / monthly / yearly)
 * ------------------------------------------------------------------ */

const startOfWeek = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // week starts on Monday
  return d;
};
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

function buildAnalytics(period) {
  const now = new Date();
  const buckets = [];

  if (period === 'weekly') {
    const thisMonday = startOfWeek(now);
    for (let i = 11; i >= 0; i--) {
      const start = new Date(thisMonday);
      start.setDate(start.getDate() - i * 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      buckets.push({
        key: dayKey(start),
        label: `${start.getDate()} ${MONTH_NAMES[start.getMonth()]}`,
        start,
        end,
        total: 0,
        resolved: 0,
        pending: 0
      });
    }
  } else if (period === 'monthly') {
    for (let i = 11; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
      buckets.push({
        key: monthKey(start),
        label: `${MONTH_NAMES[start.getMonth()]} ${start.getFullYear()}`,
        start,
        end,
        total: 0,
        resolved: 0,
        pending: 0
      });
    }
  } else {
    for (let i = 4; i >= 0; i--) {
      const start = new Date(now.getFullYear() - i, 0, 1);
      const end = new Date(start.getFullYear() + 1, 0, 1);
      buckets.push({
        key: String(start.getFullYear()),
        label: String(start.getFullYear()),
        start,
        end,
        total: 0,
        resolved: 0,
        pending: 0
      });
    }
  }

  const windowStart = buckets[0].start;
  const windowEnd = buckets[buckets.length - 1].end;
  const windowLabel = {
    weekly: 'Last 12 weeks',
    monthly: 'Last 12 months',
    yearly: 'Last 5 years'
  }[period];

  const inWindow = db.complaints.filter((c) => {
    const submitted = new Date(c.submitted_at);
    return submitted >= windowStart && submitted < windowEnd;
  });

  inWindow.forEach((c) => {
    const submitted = new Date(c.submitted_at);
    const bucket = buckets.find((b) => submitted >= b.start && submitted < b.end);
    if (!bucket) return;
    const done = ['Resolved', 'Closed'].includes(c.status);
    bucket.total += 1;
    if (done) bucket.resolved += 1;
    else bucket.pending += 1;
  });

  const resolvedInWindow = inWindow.filter((c) => ['Resolved', 'Closed'].includes(c.status));
  const withResolutionTime = inWindow.filter((c) => c.resolved_at);
  const avgResolutionHours = withResolutionTime.length
    ? Math.round(
      (withResolutionTime.reduce((sum, c) => sum + (new Date(c.resolved_at) - new Date(c.submitted_at)), 0) /
        withResolutionTime.length / 3600000) * 10
    ) / 10
    : null;

  const busiest = buckets.reduce((max, b) => (b.total > max.total ? b : max), buckets[0]);

  const tally = (list, keyFn) => Object.entries(
    list.reduce((acc, item) => {
      const key = keyFn(item) || 'Unspecified';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})
  ).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);

  const staffWorkload = db.users
    .filter((u) => ASSIGNEE_ROLES.includes(u.role))
    .map((u) => {
      const assignments = db.assignments.filter((a) => a.assigned_to === u.id);
      const open = assignments.filter((a) => {
        if (a.completed_at) return false;
        const complaint = db.complaints.find((c) => c.id === a.complaint_id);
        return complaint && !['Resolved', 'Closed'].includes(complaint.status);
      });
      return {
        name: u.name,
        role: u.role,
        open: open.length,
        completed: assignments.length - open.length
      };
    })
    .sort((a, b) => b.open - a.open || b.completed - a.completed);

  return {
    period,
    label: windowLabel,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    buckets,
    summary: {
      period_total: inWindow.length,
      period_resolved: resolvedInWindow.length,
      period_pending: inWindow.length - resolvedInWindow.length,
      resolution_rate: inWindow.length ? Math.round((resolvedInWindow.length / inWindow.length) * 1000) / 10 : 0,
      all_time_total: db.complaints.length,
      avg_resolution_hours: avgResolutionHours,
      busiest_label: busiest.label,
      busiest_count: busiest.total,
      open_assignments: db.assignments.filter((a) => {
        if (a.completed_at) return false;
        const complaint = db.complaints.find((c) => c.id === a.complaint_id);
        return complaint && !['Resolved', 'Closed'].includes(complaint.status);
      }).length,
      overdue_assignments: db.assignments.filter((a) => {
        if (a.completed_at || !a.due_date) return false;
        const complaint = db.complaints.find((c) => c.id === a.complaint_id);
        return complaint && new Date(a.due_date) < now && !['Resolved', 'Closed'].includes(complaint.status);
      }).length
    },
    byStatus: tally(inWindow, (c) => c.status),
    byPriority: tally(inWindow, (c) => c.priority),
    byType: tally(inWindow, (c) => c.complaint_type),
    byCategory: tally(inWindow, (c) => c.category).slice(0, 8),
    topMachines: tally(inWindow.filter((c) => c.machine_id), (c) => (db.machines.find((m) => m.id === c.machine_id) || {}).machine_name).slice(0, 8),
    staff_workload: staffWorkload
  };
}

app.get('/api/admin/analytics', auth, authorize(...REVIEW_ROLES), (req, res) => {
  const period = ['weekly', 'monthly', 'yearly'].includes(req.query.period) ? req.query.period : 'monthly';
  res.json({ success: true, ...buildAnalytics(period) });
});

// Machine management
app.post('/api/admin/machines', auth, authorize(...ADMIN_ROLES), (req, res) => {
  const {
    machine_code, machine_name, manufacturer, model, category,
    location_id, status, installation_date, last_maintenance_date, next_maintenance_date
  } = req.body;

  if (!machine_code || !machine_name || !category) {
    return res.status(400).json({ success: false, message: 'Machine code, name and category are required' });
  }

  const code = String(machine_code).trim().toUpperCase();
  if (db.machines.some((m) => m.machine_code.toUpperCase() === code)) {
    return res.status(400).json({ success: false, message: 'A machine with this code already exists' });
  }

  const location = db.locations.find((l) => l.id === parseInt(location_id, 10));
  if (!location) {
    return res.status(400).json({ success: false, message: 'Please select a valid location' });
  }

  const machine = {
    id: nextId('machineId'),
    machine_code: code,
    machine_name: String(machine_name).trim(),
    manufacturer: manufacturer || null,
    model: model || null,
    category,
    location_id: location.id,
    status: ['Operational', 'Under Maintenance', 'Out of Service', 'Retired'].includes(status) ? status : 'Operational',
    installation_date: installation_date || null,
    last_maintenance_date: last_maintenance_date || null,
    next_maintenance_date: next_maintenance_date || null,
    created_at: new Date().toISOString()
  };

  db.machines.push(machine);
  persist();
  res.status(201).json({ success: true, message: 'Machine added successfully', machine });
});

app.patch('/api/admin/machines/:id', auth, authorize(...ADMIN_ROLES), (req, res) => {
  const machine = db.machines.find((m) => m.id === parseInt(req.params.id, 10));
  if (!machine) {
    return res.status(404).json({ success: false, message: 'Machine not found' });
  }

  const fields = ['machine_name', 'manufacturer', 'model', 'category', 'location_id', 'status', 'installation_date', 'last_maintenance_date', 'next_maintenance_date'];
  fields.forEach((field) => {
    if (req.body[field] !== undefined && req.body[field] !== '') {
      machine[field] = field === 'location_id' ? parseInt(req.body[field], 10) : req.body[field];
    }
  });

  persist();
  res.json({ success: true, message: 'Machine updated successfully', machine });
});

app.delete('/api/admin/machines/:id', auth, authorize(...ADMIN_ROLES), (req, res) => {
  const index = db.machines.findIndex((m) => m.id === parseInt(req.params.id, 10));
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Machine not found' });
  }

  const machineId = db.machines[index].id;
  const linkedComplaints = db.complaints.filter((c) => c.machine_id === machineId).length;
  if (linkedComplaints > 0) {
    // Keep history intact: retire instead of deleting
    db.machines[index].status = 'Retired';
    persist();
    return res.json({
      success: true,
      message: `Machine has ${linkedComplaints} linked complaint(s) and was marked as Retired instead of deleted`
    });
  }

  db.machines.splice(index, 1);
  persist();
  res.json({ success: true, message: 'Machine deleted successfully' });
});

// Location management
app.post('/api/admin/locations', auth, authorize(...ADMIN_ROLES), (req, res) => {
  const { building, hall, room_number, floor, description } = req.body;
  if (!room_number) {
    return res.status(400).json({ success: false, message: 'Room number is required' });
  }

  const location = {
    id: nextId('locationId'),
    building: building || 'Main Block',
    hall: hall || null,
    room_number: String(room_number).trim(),
    floor: floor || null,
    description: description || null
  };

  db.locations.push(location);
  persist();
  res.status(201).json({ success: true, message: 'Location added successfully', location });
});

app.delete('/api/admin/locations/:id', auth, authorize(...ADMIN_ROLES), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const index = db.locations.findIndex((l) => l.id === id);
  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Location not found' });
  }
  if (db.machines.some((m) => m.location_id === id)) {
    return res.status(400).json({ success: false, message: 'Location still has machines assigned to it' });
  }

  db.locations.splice(index, 1);
  persist();
  res.json({ success: true, message: 'Location deleted successfully' });
});

/* ------------------------------------------------------------------ *
 * Page + fallback routes
 * ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', uptime: process.uptime() });
});

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'register.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/staff', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'staff.html')));

app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: 'API endpoint not found' });
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Error handling (including multer upload errors)
app.use((err, req, res, next) => {
  console.error(err.stack || err);
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Image is too large. Maximum size is 5MB per image.'
      : err.code === 'LIMIT_UNEXPECTED_FILE'
        ? 'Too many images. You can upload up to 5 photos.'
        : err.message;
    return res.status(400).json({ success: false, message });
  }
  if (err.message && err.message.startsWith('Only image files')) {
    return res.status(400).json({ success: false, message: err.message });
  }
  res.status(500).json({ success: false, message: 'Something went wrong!' });
});

/**
 * Start the HTTP server. Guarded so the test suite can require this module
 * without binding a port.
 */
function startServer(port = PORT) {
  return app.listen(port, () => {
    console.log(`\n🚀 Polymer Department Complaint System running!`);
    console.log(`📍 URL: http://localhost:${port}`);
    console.log(`📚 Department: Plastic Polymer Testing`);
    console.log(`💾 Data file: ${DATA_FILE}`);
    console.log(`\n🔐 Demo credentials:`);
    console.log(`   HOD:     hod@polymer.edu / Admin@123`);
    console.log(`   Student: amit.patel@student.edu / Password123`);
    console.log(`   Staff/technician/faculty accounts are added by the HOD from Admin → Staff.`);
    console.log(`\n📮 Notification gateways:`);
    console.log(`   Email: ${NOTIFY.email.configured ? `${NOTIFY.email.provider === 'brevo' ? 'Brevo API' : `SMTP ${NOTIFY.email.host}`} configured (verifying in the background)` : `in-app only — missing ${NOTIFY.email.missing.join(', ')}`}`);
    console.log(`   SMS:   ${NOTIFY.sms.configured ? `provider "${NOTIFY.sms.provider}" configured (verifying in the background)` : `in-app only — missing ${NOTIFY.sms.missing.join(', ')}`}`);

    // Verification talks to the provider, so it must never block startup
    verifyGateways().then(([email, sms]) => {
      console.log(`\n   Email: ${email.status}${email.detail ? ` — ${email.detail}` : ''}`);
      console.log(`   SMS:   ${sms.status}${sms.detail ? ` — ${sms.detail}` : ''}`);
      console.log(`\n✅ System ready!\n`);
    }).catch((error) => {
      console.warn(`[notify] Gateway verification error: ${redact(error.message)}`);
      console.log(`\n✅ System ready!\n`);
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  // Notification internals exposed for the test suite
  NOTIFY,
  gatewayHealth,
  isValidEmail,
  isValidPhone,
  normalizePhone,
  redact,
  renderEmail,
  sendEmail,
  markEmailGatewayRejected,
  senderEmail,
  senderParts,
  sendSms,
  deliverMessage,
  summarizeDelivery,
  recordMessage,
  verifyGateways,
  outboxSummary,
  isRetryableNotification,
  httpRequestForm,
  getMailTransport,
  loadStore,
  getStore: () => db,
  setStore: (next) => { db = next; }
};
