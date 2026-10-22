# College Plastic Polymer Testing Department — Machine Complaint & Maintenance Management System

A web-based complaint and maintenance management system for the Plastic Polymer Testing Department.
It lets students, teachers, faculty, staff and technicians report equipment problems, track them
through a defined workflow, and lets the HOD/Admin review, prioritise, assign and close them.

---

## Features

### Students, Teachers and Workers
- Register / log in with role-based access
- Report machine problems **and** non-machine issues (cleanliness, classroom, infrastructure, IT, etc.)
- Attach up to 5 photos per complaint (JPEG / JPG / PNG / WebP, 5 MB each)
- Get a unique ticket number (`PPD-<year>-<6 digits>`) on submission
- Track status, view the full audit trail and receive in-app notifications
- "PPD Assistant" chatbot for common questions

### HOD and Administrators
- **Complaints tab** — see every complaint with a status filter and an **AI Priority View**
- Inspect the automatic priority analysis (suggested priority, confidence score, key factors)
- Verify complaints, set any status, and assign to staff/technicians/faculty/workers with a due date
- **Staff tab** — the place to *fill in the names* of the department's real staff: add a member
  (name, email, phone, role, optional staff ID, temporary password), edit their details, remove
  them, and open a full **staff profile**
- **Change an Account's Role** — promote a self-registered `student` account to `teacher`, `staff`,
  `worker`, `technician` or `faculty` so it becomes selectable as an assignee and gets a task queue
- **Staff profile** shows contact details, workload tiles, assigned tasks and the complete log of
  messages delivered to that member's phone number / email address
- **Analytics tab** — weekly / monthly / yearly complaint analysis (trend chart + breakdowns)
- Machine and location management API
- Department-wide statistics

### Technicians / Staff / Workers / Faculty
- Personal task queue of everything assigned to them
- Overdue highlighting and per-task counts
- Update progress (`In Progress`, `On Hold`, `Resolved`, `Reopened`) with a work note
- **Messages sent to you** — every task alert addressed to their phone number and email address

---

## Staff alerts (email + SMS)

When the HOD assigns a complaint, the system records a message against the assignee's phone number
and email address (channel is reported as `Email + SMS`, `Email` or `SMS` depending on what is on
file) and pushes it through the configured gateways. The same happens when a complaint the member is
working on changes status.

Staff members therefore need a **phone number** — the API rejects a new staff account without one.

### Gateways

| Channel | Transport | Configuration |
| --- | --- | --- |
| Email | SMTP via `nodemailer` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` |
| SMS | HTTP API, no SDK required | `SMS_PROVIDER=twilio` with `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER`, or `SMS_PROVIDER=fast2sms` with `FAST2SMS_API_KEY` / `SMS_SENDER_ID` / `FAST2SMS_ROUTE` |

Copy `.env.example` to `.env` and fill in the values, then restart. **Nothing is mandatory** — with
no credentials the app still works and every alert is kept in the in-app outbox. `SMS_PROVIDER`
defaults to `none`, in which case no SMS is ever attempted.

Gmail works with an [App Password](https://support.google.com/accounts/answer/185833); Office365 and
most college mail servers work with plain SMTP settings. `fast2sms` is the cheapest option for Indian
numbers but needs a DLT-registered sender ID; Twilio works internationally.

### Gateway status is verified, not assumed

Credentials being present in `.env` is never reported as working delivery. At startup (and whenever
the HOD presses **Re-check now**) the server opens a real SMTP session with `transport.verify()` and
makes a real credential call to the SMS provider. The **Notification Gateways** card on the HOD
**Staff** tab, and the startup banner, report the verified result:

| Status | Meaning |
| --- | --- |
| `Configured` | The server proved the gateway works (live SMTP session / provider accepted the credentials) |
| `In-app only` | No gateway configured — alerts stay in the outbox (the default state) |
| `Configuration error` | Credentials are set but verification failed — the reason is shown, redacted |
| `Not checked yet` | Verification has not run yet |

The status is also corrected by real traffic. If a send is refused with `401`/`403` (a bad key, or
an address that has just been blocked), the email gateway is moved to `Configuration error` with
that reason, so the card cannot keep claiming `Configured` while every alert is being rejected.
A `400` — a single bad recipient — deliberately leaves the gateway status alone.

Each card also lists the exact variable names that are still missing and a short configuration hint.
No password, auth token or API key is ever returned by the API or rendered in the UI.

### Notification outbox and retries

Every alert is recorded against the recipient before delivery is attempted, so it is visible even
when a gateway is down. The HOD **Staff** tab shows a **Notification Outbox** card with counts for
recorded / delivered / partly delivered / failed / pending / in-app-only messages and a per-message
row showing the contact used, the subject and the per-channel result.

- **Retry** (per message) and **Retry all failed** re-attempt only the channels that did not already
  succeed, so a retry can never duplicate a message a member has already received.
- A message whose delivery status is `sent` cannot be retried (the API returns `409`).
- Errors are stored and logged through `redact()`, which strips passwords, auth headers and API keys
  before anything reaches a log line or the UI.
- Gateway failures never break the feature that triggered them: an assignment still succeeds and
  simply reports `delivery_status: skipped`.

### Delivery outcomes

Every message stores what actually happened, so nothing fails silently:

| Status | Meaning |
| --- | --- |
| `sent` | Every configured channel accepted the message |
| `partial` | Some channels succeeded, others failed |
| `failed` | The gateway rejected the message (reason recorded per channel) |
| `skipped` | No gateway configured, or the recipient has no contact for that channel |

The per-channel result (provider message id, or the exact provider error) is shown under each message
in the staff profile, and the HOD's assignment toast reports the outcome.

### Where alerts appear

- HOD → **Staff** tab → a member's **Profile** → "Messages sent to …'s phone / email"
- The member's own dashboard → **Messages Sent To You** card

Both show the delivery status and the underlying provider result.

### Who signs the alerts

Assignment and status alerts are signed with the name of the account that is actually signed in —
never a hardcoded name. The HOD/admin sets that name from **Signing Name** in the dashboard header
(`PATCH /api/auth/profile`), and it is appended to each alert as `Assigned by: <name>` (assignment)
or `by <name>` (status change).

Assigning a complaint sends **two** alerts:

1. the assignee gets the task details (type of work, complaint, priority, location, due date,
   instructions and who assigned it);
2. the person who raised the complaint gets an email confirming the complaint is assigned, naming
   the assigned staff member and their role, email and phone, plus the same due date and
   instructions.

Every later status change also emails the person who raised the complaint, stating the old and new
status, who made the change and any comment. Nobody is emailed about a change they made themselves.

The HOD/Admin continues to see the in-app version of these in their notification bell.

### Who can be assigned a task

Assignable roles are `staff`, `technician`, `worker`, `teacher` and `faculty`. A teacher who
registers from the public page is therefore immediately selectable in **Assign to Staff**, and can
open the staff task queue and progress their own assignments.

`student` accounts are reporters only: they raise complaints and receive the alerts, but they are
not offered as assignees. If a task must go to somebody who registered as a student, promote that
account from the Staff tab: **Change an Account's Role → Account → New Role → Update Role**. It
takes effect on the very next request, so the person does not have to sign out and back in, and
they can be assigned work straight away. (The HOD can also add a member directly with
**Add Staff Member** instead.)

---

## Prerequisites

- **Node.js** v18 or higher (the test suite uses the built-in `node:test` runner)
- **npm**

No database server is required — see [Data storage](#data-storage).

## Installation & running

```bash
cd C:/polymer-dept
npm install
npm start        # or: npm run dev  (nodemon, auto-reload)
```

Open <http://localhost:5000>.

Optional: copy `.env.example` to `.env` to override the defaults. This is also where you switch on
real email and SMS delivery — see [Staff alerts](#staff-alerts-email--sms).

### Tests

```bash
npm test
```

The suite runs on Node's built-in test runner and **never talks to a real mail or SMS server**: it
uses an in-process fake SMTP server (`test/helpers/fake-smtp.js`), a fake Brevo API
(`test/brevo.test.js`) and a fake Twilio / Fast2SMS endpoint (`test/helpers/fake-sms.js`), with
`DATA_FILE` pointed at a temporary JSON store. The email tests also clear `BREVO_API_KEY` and force
`EMAIL_PROVIDER=smtp` so a developer's real `.env` can never route the suite to a live provider. It
covers email and phone validation, secret redaction, the email template, SMTP and Brevo delivery and
failure handling, SMS delivery, timeouts and rejected credentials, delivery-status summarisation,
retry-without-duplicates, and the full assignment → alert → outbox → retry flow behind the auth
middleware.

### Troubleshooting delivery

| Symptom | Cause and fix |
| --- | --- |
| `Brevo blocked this server's IP <addr>` | The account's IP restriction is on and the address changed. **Preferred fix:** turn the restriction off — Settings → Security → **Authorized IPs** → *Deactivate blocking* (for both the API keys and SMTP keys rows) at <https://app.brevo.com/security/authorised_ips>. Allow-listing a single address only helps until the next change: home broadband, college networks and IPv6 privacy addresses rotate, so the same break recurs. |
| `Key not found` | `BREVO_API_KEY` is wrong or revoked. |
| `sender ... not valid` / sender errors | `MAIL_FROM` is not a verified sender in the Brevo account (Senders & IP → Senders). |
| Card shows **Configuration error** | The server verified the credentials and the provider refused them; the exact (redacted) reason is shown in the card. |
| Card shows **In-app only** | No credentials are set, so nothing is sent — alerts are recorded in the outbox only. |

### Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| HOD | `hod@polymer.edu` | `Admin@123` |
| Student | `amit.patel@student.edu` | `Password123` |

No staff, technician, worker or faculty accounts are seeded — the HOD adds the department's real
staff from **Admin Dashboard → Staff → Add Staff Member**, which is where the names, email
addresses and phone numbers are filled in.

Additional `student`, `teacher`, `worker` and `staff` accounts can be self-registered.
**`hod` and `admin` accounts cannot be self-registered** — they are provisioned by the department
administrator.

---

## Data storage

The running application persists everything to a single JSON file:

```
data/store.json
```

It is created automatically on first start and seeded with three locations, five laboratory
machines and the HOD + student accounts above. Every write (registration, complaint, assignment,
status change, notification, staff alert) is flushed to this file immediately, so data survives
restarts.

The file holds `users`, `locations`, `machines`, `complaints`, `complaintImages`,
`complaintUpdates`, `assignments`, `notifications`, `messages` and a `counters` block that
allocates monotonic IDs.

**Resetting the system** — stop the server, delete `data/store.json` and `uploads/complaints/`,
then start it again. The seed data will be recreated.

Uploaded photos are stored on disk under `uploads/complaints/` and served from `/uploads/...`.

> `database/schema.sql` and `database/seed.sql` are kept as an **optional PostgreSQL reference
> model** only. They are not used at runtime and require no database to be installed.

---

## Roles and permissions

| Role | Dashboard | Can do |
| --- | --- | --- |
| `student`, `teacher`, `worker` | `/dashboard` | Submit complaints, view and track their own |
| `faculty` | `/staff` | Everything staff can do, plus review, prioritise and assign complaints |
| `staff`, `technician`, `worker` | `/staff` | Work only on complaints assigned to them; set `In Progress`, `On Hold`, `Resolved`, `Reopened` |
| `hod`, `admin` | `/admin` | Full access: all complaints, any status, assignment, **staff management**, analytics, machine & location management, user listing |

Enforcement lives in the API, not just the UI: staff and technicians are blocked from changing the
status of complaints that are not assigned to them, and from using statuses outside their allowed
set.

---

## Complaint workflow

```
Submitted → Under Review → Verified → Assigned → In Progress → Resolved → Closed
                                                       ↕            ↓
                                                    On Hold      Reopened
                                                                  ↘ Rejected
```

- Machine status is synchronised automatically: `In Progress` / `On Hold` sets the machine to
  `Under Maintenance`, and resolving or closing restores `Operational` once no other active
  complaint exists for that machine.
- Every transition is recorded in the complaint's history with the actor, timestamp and comment.
- Resolving or closing automatically completes the open assignment(s).

---

## Automatic priority analysis

When a complaint is created it is scored by a heuristic engine (`analyzeComplaintPriority`) that
weighs safety keywords, total-failure wording, production impact, critical-equipment references,
electrical hazards, previously reported duplicates, calibration/error-code signals and the
"machine completely unusable" flag. The result is stored on the complaint as:

- `ai_suggested_priority` — `Low` / `Medium` / `High` / `Critical`
- `ai_confidence_score` — 0–100
- `ai_analysis` — human-readable summary
- `ai_reasons` — list of the factors that fired
- `priority_auto_adjusted` — `true` when the reporter's priority was raised

The reporter's own priority is never lowered, only elevated.

---

## API reference

All authenticated routes expect `Authorization: Bearer <token>` (the token is also set as an
HttpOnly `token` cookie at login).

### Authentication
| Method | Endpoint | Access |
| --- | --- | --- |
| POST | `/api/auth/register` | public |
| POST | `/api/auth/login` | public |
| POST | `/api/auth/logout` | public |
| GET | `/api/auth/me` | any signed-in user |
| PATCH | `/api/auth/profile` | any signed-in user (sets the name that signs their alerts) |

### Machines and locations
| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/api/machines` | any signed-in user |
| GET | `/api/machines/locations` | any signed-in user |
| GET | `/api/machines/:id` | any signed-in user |
| POST | `/api/admin/machines` | `hod`, `admin` |
| PATCH | `/api/admin/machines/:id` | `hod`, `admin` |
| DELETE | `/api/admin/machines/:id` | `hod`, `admin` |
| POST | `/api/admin/locations` | `hod`, `admin` |
| DELETE | `/api/admin/locations/:id` | `hod`, `admin` |

Deleting a machine that still has complaints marks it `Retired` instead of removing it, so
history is never orphaned.

### Complaints
| Method | Endpoint | Access |
| --- | --- | --- |
| POST | `/api/complaints` | any signed-in user (multipart, `images` × 5) |
| GET | `/api/complaints/my` | any signed-in user (`?status=`, `?priority=`) |
| GET | `/api/complaints` | `hod`, `admin`, `faculty`, `staff`, `technician`, `teacher` |
| GET | `/api/complaints/:id` | reporter, or any reviewer/staff role |
| PATCH | `/api/admin/complaints/:id/status` | `hod`, `admin`, `faculty`, `staff`, `technician`, `teacher` (staff only on their own tasks) |
| POST | `/api/admin/complaints/:id/assign` | `hod`, `admin`, `faculty` |
| GET | `/api/admin/complaints/prioritized` | `hod`, `admin`, `faculty` |

### Dashboard
| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/api/stats/public` | public (aggregate counts only) |
| GET | `/api/dashboard/statistics` | any signed-in user |
| GET | `/api/dashboard/notifications` | any signed-in user |
| PATCH | `/api/dashboard/notifications/:id/read` | owner |
| POST | `/api/dashboard/notifications/read-all` | owner |
| GET | `/api/dashboard/tasks` | `staff`, `technician`, `worker`, `faculty`, `teacher` |
| GET | `/api/admin/users` | `hod`, `admin` |
| GET | `/api/admin/staff` | `hod`, `admin`, `faculty` |
| GET | `/api/health` | public |

### Staff management
| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/api/admin/staff` | `hod`, `admin`, `faculty` (list + workload + alert counts) |
| GET | `/api/admin/staff/:id` | `hod`, `admin`, `faculty` (profile, stats, tasks, message log) |
| POST | `/api/admin/staff` | `hod`, `admin` (requires name, email, **phone**, role, password) |
| PATCH | `/api/admin/staff/:id` | `hod`, `admin` (rename / correct contact details, optional new password) |
| DELETE | `/api/admin/staff/:id` | `hod`, `admin` (blocked while open tasks remain, and for your own account) |
| GET | `/api/admin/users` | `hod`, `admin` (every account, for the role picker) |
| PATCH | `/api/admin/users/:id/role` | `hod`, `admin` (promote a self-registered account so it can be assigned work) |

Provisionable roles: `staff`, `technician`, `worker`, `faculty`, `teacher`.

`PATCH /api/admin/users/:id/role` accepts `student`, `teacher`, `staff`, `worker`, `technician` or
`faculty`. It refuses to touch an `hod`/`admin` account (`403`) so the department cannot be locked
out of its own dashboard, rejects a role it does not recognise and a no-op change (`400`), and
answers `404` for an unknown account. The new role is read from the store on every request, so it
applies immediately — including to a token that was issued before the change.

### Message outbox and gateways
| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/api/staff/messages` | any signed-in user (their own messages + unread count) |
| PATCH | `/api/staff/messages/:id/read` | message recipient |
| GET | `/api/notifications/gateways` | `hod`, `admin`, `faculty` (verified email / SMS state, no secrets) |
| POST | `/api/notifications/gateways/verify` | `hod`, `admin` (re-run verification now) |
| GET | `/api/notifications/outbox` | `hod`, `admin`, `faculty` (`?limit=`, default 50, max 200) |
| POST | `/api/notifications/messages/:id/retry` | `hod`, `admin` (`409` if already delivered) |
| POST | `/api/notifications/retry-failed` | `hod`, `admin` (retries every still-deliverable message) |

### Analytics
| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/api/admin/analytics?period=weekly\|monthly\|yearly` | `hod`, `admin`, `faculty` |

Returns trend buckets (last 12 weeks / 12 months / 5 years), a summary (period total, resolved,
pending, resolution rate, average resolution time, busiest bucket, open and overdue assignments,
all-time total) and breakdowns by status, priority, complaint type, category and machine, plus
per-staff workload. An unknown `period` falls back to `monthly`.

---

## Project structure

```
polymer-dept/
├── server.js               # the entire API + static server
├── package.json
├── .env.example
├── data/
│   └── store.json          # JSON persistence (created at runtime)
├── uploads/
│   └── complaints/         # uploaded photos (created at runtime)
├── database/
│   ├── schema.sql          # optional PostgreSQL reference model
│   └── seed.sql
├── test/                   # node:test suite (fake SMTP + fake SMS provider, no real sending)
│   ├── helpers/
│   ├── email.test.js
│   ├── sms.test.js
│   ├── delivery.test.js
│   ├── assignment.test.js
│   └── validation.test.js
└── public/
    ├── index.html          # landing page
    ├── login.html
    ├── register.html
    ├── dashboard.html      # student / teacher / worker
    ├── staff.html          # staff / technician / faculty task queue
    ├── admin.html          # HOD / admin
    ├── app.js              # shared helpers (API, toasts, formatting, notification bell, chatbot)
    ├── styles.css
    └── college-logo.png
```

---

## Security notes

- Passwords are hashed with bcrypt (cost factor 10).
- Sessions use JWTs signed with `JWT_SECRET` — set a strong value in production.
- Role checks are enforced server-side on every protected route.
- Self-registration is restricted to non-privileged roles.
- All user-supplied text is escaped before being inserted into the DOM on the front end.
- Uploads are restricted by MIME type, extension and size; multer errors return `400` with a
  readable message.
