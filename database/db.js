'use strict';

/**
 * PostgreSQL-backed data access layer for the Polymer Department app.
 * Replaces the JSON-file store (data/store.json) with a real database.
 *
 * All methods are async and return plain JS objects/arrays mirroring the
 * shape of the original store.json records, so server.js route handlers need
 * only add `await` and swap `db.<collection>.<method>()` for `db.<method>()`.
 *
 * If DATA_FILE env var is set (test mode), falls back to the JSON file store
 * for backwards compatibility with the test suite.
 */

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// ── Detect test mode ───────────────────────────────────────────────────────
const TEST_MODE = Boolean(process.env.DATA_FILE);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'store.json');

// ── In-memory store (used when TEST_MODE is true) ──────────────────────────
let testDb = null;

function getTestStore() {
  if (testDb) return testDb;
  const emptyStore = () => ({
    users: [], locations: [], machines: [], complaints: [],
    complaintImages: [], complaintUpdates: [], assignments: [], notifications: [], messages: [],
    counters: { userId: 0, locationId: 0, machineId: 0, complaintId: 0, imageId: 0, updateId: 0, assignmentId: 0, notificationId: 0, messageId: 0 }
  });
  const seedStore = () => {
    const hash = (p) => bcrypt.hashSync(p, 10);
    testDb.locations = [
      { id: 1, building: 'Main Block', hall: 'Polymer Testing Laboratory', room_number: '101', floor: 'Ground Floor', description: 'Primary testing facility' },
      { id: 2, building: 'Main Block', hall: 'Material Testing Laboratory', room_number: '102', floor: 'Ground Floor', description: 'Material characterization lab' },
      { id: 3, building: 'Main Block', hall: 'Processing Laboratory', room_number: '201', floor: 'First Floor', description: 'Polymer processing equipment' }
    ];
    testDb.machines = [
      { id: 1, machine_code: 'UTM-001', machine_name: 'Universal Testing Machine', manufacturer: 'Instron', model: '5900 Series', category: 'Mechanical Testing', location_id: 1, status: 'Operational' },
      { id: 2, machine_code: 'MFI-001', machine_name: 'Melt Flow Index Tester', manufacturer: 'Tinius Olsen', model: 'MP600', category: 'Rheology Testing', location_id: 1, status: 'Operational' },
      { id: 3, machine_code: 'IZD-001', machine_name: 'Izod Impact Tester', manufacturer: 'Zwick/Roell', model: 'HIT50P', category: 'Impact Testing', location_id: 2, status: 'Operational' },
      { id: 4, machine_code: 'EXT-001', machine_name: 'Extrusion Machine', manufacturer: 'Brabender', model: 'DSE 20/40', category: 'Processing', location_id: 3, status: 'Operational' },
      { id: 5, machine_code: 'INJ-001', machine_name: 'Injection Moulding Machine', manufacturer: 'Haitian', model: 'MA600', category: 'Processing', location_id: 3, status: 'Out of Service' }
    ];
    testDb.users = [
      { id: 1, name: 'Dr. Rajesh Kumar', email: 'hod@polymer.edu', password_hash: hash('Admin@123'), role: 'hod', user_id: 'HOD001', phone: '9876543210', department: 'Plastic Polymer Testing', created_at: new Date().toISOString() },
      { id: 2, name: 'Amit Patel', email: 'amit.patel@student.edu', password_hash: hash('Password123'), role: 'student', user_id: 'STU2023001', phone: '9876543214', department: 'Plastic Polymer Testing', created_at: new Date().toISOString() }
    ];
    testDb.counters = { userId: 2, locationId: 3, machineId: 5, complaintId: 0, imageId: 0, updateId: 0, assignmentId: 0, notificationId: 0, messageId: 0 };
  };
  const loadStore = () => {
    if (!fs.existsSync(DATA_FILE)) {
      seedStore();
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      testDb = { ...emptyStore(), ...raw, counters: { ...emptyStore().counters, ...(raw.counters || {}) } };
    } catch (error) {
      console.error('Could not read data store, starting from seed data:', error.message);
      seedStore();
    }
  };
  const persist = () => fs.writeFileSync(DATA_FILE, JSON.stringify(testDb, null, 2));
  const nextId = (key) => { testDb.counters[key] = (testDb.counters[key] || 0) + 1; return testDb.counters[key]; };
  testDb = emptyStore();
  loadStore();
  return { testDb, nextId, persist };
}

// ── Connection pool from environment (PostgreSQL) ──────────────────────────
let pool = null;
let q = null;

if (!TEST_MODE) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL || undefined,
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'polymer',
    user: process.env.DB_USER || 'polymer',
    password: process.env.DB_PASSWORD || 'polymerpass',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
  q = (text, params) => pool.query(text, params);
  pool.connect().catch((err) => {
    console.error('[db] Failed to connect to PostgreSQL:', err.message);
    console.error('[db] Set DATABASE_URL or DB_HOST/DB_NAME/DB_USER/DB_PASSWORD env vars.');
    process.exit(1);
  });
}

/**
 * A database handle that mirrors the original in-memory `db` object's
 * collection-based API but routes every operation to PostgreSQL.
 * When TEST_MODE is true (DATA_FILE is set), falls back to JSON file store.
 */
class Database {
  constructor() {
    if (TEST_MODE) {
      const { testDb, nextId, persist } = getTestStore();
      this._testDb = testDb;
      this._nextId = nextId;
      this._persist = persist;
    }
  }
  // ── seed / migrate ───────────────────────────────────────────────────────

  async seed() {
    const bcrypt = require('bcryptjs');
    const hash = (p) => bcrypt.hashSync(p, 10);

    await q('BEGIN');
    try {
      // Ensure all tables exist (idempotent)
      await q(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          role VARCHAR(50) NOT NULL,
          user_id VARCHAR(100),
          phone VARCHAR(20),
          department VARCHAR(255) DEFAULT 'Plastic Polymer Testing',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS locations (
          id SERIAL PRIMARY KEY,
          building VARCHAR(100),
          hall VARCHAR(100),
          room_number VARCHAR(50),
          floor VARCHAR(20),
          description TEXT
        );
        CREATE TABLE IF NOT EXISTS machines (
          id SERIAL PRIMARY KEY,
          machine_code VARCHAR(100) UNIQUE NOT NULL,
          machine_name VARCHAR(255) NOT NULL,
          manufacturer VARCHAR(255),
          model VARCHAR(255),
          category VARCHAR(100),
          location_id INTEGER REFERENCES locations(id),
          status VARCHAR(50) DEFAULT 'Operational',
          installation_date DATE,
          last_maintenance_date DATE,
          next_maintenance_date DATE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS complaints (
          id SERIAL PRIMARY KEY,
          ticket_number VARCHAR(50) UNIQUE NOT NULL,
          reporter_id INTEGER NOT NULL REFERENCES users(id),
          complaint_type VARCHAR(100),
          machine_id INTEGER REFERENCES machines(id),
          location_id INTEGER REFERENCES locations(id),
          general_location VARCHAR(255),
          category VARCHAR(100) NOT NULL,
          title VARCHAR(255) NOT NULL,
          description TEXT NOT NULL,
          priority VARCHAR(20) DEFAULT 'Medium',
          status VARCHAR(50) DEFAULT 'Submitted',
          problem_occurred_at TIMESTAMP,
          machine_unusable BOOLEAN DEFAULT FALSE,
          submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          resolved_at TIMESTAMP,
          closed_at TIMESTAMP,
          ai_suggested_priority VARCHAR(20),
          ai_confidence_score INTEGER,
          ai_analysis TEXT,
          ai_reasons TEXT,
          previous_ticket VARCHAR(50)
        );
        CREATE TABLE IF NOT EXISTS complaint_images (
          id SERIAL PRIMARY KEY,
          complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
          image_url VARCHAR(500) NOT NULL,
          uploaded_by INTEGER NOT NULL REFERENCES users(id),
          uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS assignments (
          id SERIAL PRIMARY KEY,
          complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
          assigned_to INTEGER NOT NULL REFERENCES users(id),
          assigned_by INTEGER NOT NULL REFERENCES users(id),
          assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          due_date DATE,
          instructions TEXT,
          completed_at TIMESTAMP,
          completion_notes TEXT
        );
        CREATE TABLE IF NOT EXISTS complaint_updates (
          id SERIAL PRIMARY KEY,
          complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id),
          old_status VARCHAR(50),
          new_status VARCHAR(50),
          comment TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          complaint_id INTEGER REFERENCES complaints(id) ON DELETE CASCADE,
          title VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          read_status BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          recipient_id INTEGER,
          recipient_name VARCHAR(255),
          recipient_email VARCHAR(255),
          recipient_phone VARCHAR(50),
          delivery_channel VARCHAR(100),
          delivery_status VARCHAR(50),
          delivery_attempts JSONB,
          delivered_at TIMESTAMP,
          last_attempt_at TIMESTAMP,
          retry_count INTEGER DEFAULT 0,
          subject TEXT,
          body TEXT,
          kind VARCHAR(50),
          complaint_id INTEGER REFERENCES complaints(id) ON DELETE SET NULL,
          ticket_number VARCHAR(50),
          read_status BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Truncate everything (with cascade) for a clean seed
      await q('TRUNCATE TABLE messages, notifications, complaint_updates, complaint_images, assignments, complaints, machines, locations, users RESTART IDENTITY CASCADE');

      await q(`INSERT INTO locations (building, hall, room_number, floor, description) VALUES
        ('Main Block','Polymer Testing Laboratory','101','Ground Floor','Primary testing facility'),
        ('Main Block','Material Testing Laboratory','102','Ground Floor','Material characterization lab'),
        ('Main Block','Processing Laboratory','201','First Floor','Polymer processing equipment')`);

      await q(`INSERT INTO machines (machine_code, machine_name, manufacturer, model, category, location_id, status) VALUES
        ('UTM-001','Universal Testing Machine','Instron','5900 Series','Mechanical Testing',1,'Operational'),
        ('MFI-001','Melt Flow Index Tester','Tinius Olsen','MP600','Rheology Testing',1,'Operational'),
        ('IZD-001','Izod Impact Tester','Zwick/Roell','HIT50P','Impact Testing',2,'Operational'),
        ('EXT-001','Extrusion Machine','Brabender','DSE 20/40','Processing',3,'Operational'),
        ('INJ-001','Injection Moulding Machine','Haitian','MA600','Processing',3,'Out of Service')`);

      await q('INSERT INTO users (name, email, password_hash, role, user_id, phone, department) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        ['Dr. Rajesh Kumar', 'hod@polymer.edu', hash('Admin@123'), 'hod', 'HOD001', '9876543210', 'Plastic Polymer Testing']);
      await q('INSERT INTO users (name, email, password_hash, role, user_id, phone, department) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        ['Amit Patel', 'amit.patel@student.edu', hash('Password123'), 'student', 'STU2023001', '9876543214', 'Plastic Polymer Testing']);

      await q('COMMIT');
      // Reset sequences explicitly after truncate restart identity
      console.log('[db] Seed complete');
    } catch (err) {
      await q('ROLLBACK');
      throw err;
    }
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  async usersFindById(id) {
    if (TEST_MODE) return this._testDb.users.find(u => u.id === id) || null;
    const { rows } = await q('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async usersFindByEmail(email) {
    if (TEST_MODE) return this._testDb.users.find(u => u.email === String(email).toLowerCase()) || null;
    const { rows } = await q('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
    return rows[0] || null;
  }

  async usersFindByEmailCaseInsensitive(email) {
    if (TEST_MODE) return this._testDb.users.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
    const { rows } = await q('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    return rows[0] || null;
  }

  async usersSome(predicate) {
    if (TEST_MODE) return this._testDb.users.filter(predicate);
    const { rows } = await q('SELECT * FROM users');
    return rows.filter(predicate);
  }

  async usersExistsByEmail(email) {
    if (TEST_MODE) return this._testDb.users.some(u => u.email.toLowerCase() === email.toLowerCase());
    const { rows } = await q('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    return rows.length > 0;
  }

  async usersCreate(user) {
    if (TEST_MODE) {
      const newUser = { ...user, id: this._nextId('userId') };
      this._testDb.users.push(newUser);
      this._persist();
      return newUser;
    }
    const { rows } = await q(
      `INSERT INTO users (name, email, password_hash, role, user_id, phone, department, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [user.name, user.email, user.password_hash, user.role, user.user_id, user.phone, user.department, user.created_at]
    );
    return rows[0];
  }

  async usersUpdate(id, fields) {
    if (TEST_MODE) {
      const idx = this._testDb.users.findIndex(u => u.id === id);
      if (idx === -1) return null;
      this._testDb.users[idx] = { ...this._testDb.users[idx], ...fields };
      this._persist();
      return this._testDb.users[idx];
    }
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [key, val] of Object.entries(fields)) {
      sets.push(`${key} = $${i}`);
      vals.push(val);
      i++;
    }
    if (sets.length === 0) return this.usersFindById(id);
    vals.push(id);
    const { rows } = await q(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    return rows[0] || null;
  }

  async usersDelete(id) {
    if (TEST_MODE) {
      this._testDb.users = this._testDb.users.filter(u => u.id !== id);
      this._testDb.notifications = this._testDb.notifications.filter(n => n.user_id !== id);
      this._persist();
      return true;
    }
    await q('DELETE FROM users WHERE id = $1', [id]);
    return true;
  }

  async usersAll() {
    if (TEST_MODE) return this._testDb.users;
    const { rows } = await q('SELECT * FROM users ORDER BY created_at DESC');
    return rows;
  }

  async usersCount() {
    if (TEST_MODE) return this._testDb.users.length;
    const { rows } = await q('SELECT COUNT(*)::int AS count FROM users');
    return rows[0].count;
  }

  // ── Locations ─────────────────────────────────────────────────────────────

  async locationsAll() {
    if (TEST_MODE) return this._testDb.locations;
    const { rows } = await q('SELECT * FROM locations');
    return rows;
  }

  async locationsCount() {
    if (TEST_MODE) return this._testDb.locations.length;
    const { rows } = await q('SELECT COUNT(*)::int AS count FROM locations');
    return rows[0].count;
  }

  async locationsFindById(id) {
    if (TEST_MODE) return this._testDb.locations.find(l => l.id === id) || null;
    const { rows } = await q('SELECT * FROM locations WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async locationsExists(id) {
    if (TEST_MODE) return this._testDb.locations.some(l => l.id === id);
    const { rows } = await q('SELECT 1 FROM locations WHERE id = $1', [id]);
    return rows.length > 0;
  }

  async locationsFindByMachineId(machineId) {
    if (TEST_MODE) {
      const machine = this._testDb.machines.find(m => m.id === machineId);
      if (!machine) return null;
      return this._testDb.locations.find(l => l.id === machine.location_id) || null;
    }
    const { rows } = await q('SELECT * FROM locations WHERE id = (SELECT location_id FROM machines WHERE id = $1)', [machineId]);
    return rows[0] || null;
  }

  async locationsHasMachines(id) {
    if (TEST_MODE) return this._testDb.machines.some(m => m.location_id === id);
    const { rows } = await q('SELECT COUNT(*)::int AS count FROM machines WHERE location_id = $1', [id]);
    return rows[0].count > 0;
  }

  async locationsCreate(location) {
    if (TEST_MODE) {
      const newLocation = { ...location, id: this._nextId('locationId') };
      this._testDb.locations.push(newLocation);
      this._persist();
      return newLocation;
    }
    const { rows } = await q(
      `INSERT INTO locations (building, hall, room_number, floor, description)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [location.building, location.hall, location.room_number, location.floor, location.description]
    );
    return rows[0];
  }

  async locationsDelete(id) {
    if (TEST_MODE) {
      this._testDb.locations = this._testDb.locations.filter(l => l.id !== id);
      this._persist();
      return true;
    }
    await q('DELETE FROM locations WHERE id = $1', [id]);
    return true;
  }

  // ── Machines ──────────────────────────────────────────────────────────────

  async machinesAllActive() {
    const { rows } = await q(`SELECT * FROM machines WHERE status != 'Retired' ORDER BY machine_name`);
    return rows;
  }

  async machinesCount() {
    const { rows } = await q('SELECT COUNT(*)::int AS count FROM machines WHERE status != \'Retired\'');
    return rows[0].count;
  }

  async machinesFindById(id) {
    if (TEST_MODE) return this._testDb.machines.find(m => m.id === id) || null;
    const { rows } = await q('SELECT * FROM machines WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async machinesFindByCode(code) {
    if (TEST_MODE) return this._testDb.machines.find(m => m.machine_code.toUpperCase() === code.toUpperCase()) || null;
    const { rows } = await q('SELECT * FROM machines WHERE UPPER(machine_code) = UPPER($1)', [code]);
    return rows[0] || null;
  }

  async machinesExistsByCode(code) {
    if (TEST_MODE) return this._testDb.machines.some(m => m.machine_code.toUpperCase() === code.toUpperCase());
    const { rows } = await q('SELECT 1 FROM machines WHERE UPPER(machine_code) = UPPER($1)', [code]);
    return rows.length > 0;
  }

  async machinesCreate(machine) {
    if (TEST_MODE) {
      const newMachine = { ...machine, id: this._nextId('machineId') };
      this._testDb.machines.push(newMachine);
      this._persist();
      return newMachine;
    }
    const { rows } = await q(
      `INSERT INTO machines (machine_code, machine_name, manufacturer, model, category, location_id, status, installation_date, last_maintenance_date, next_maintenance_date, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [machine.machine_code, machine.machine_name, machine.manufacturer, machine.model, machine.category,
       machine.location_id, machine.status, machine.installation_date, machine.last_maintenance_date, machine.next_maintenance_date, machine.created_at]
    );
    return rows[0];
  }

  async machinesUpdate(id, fields) {
    if (TEST_MODE) {
      const idx = this._testDb.machines.findIndex(m => m.id === id);
      if (idx === -1) return null;
      this._testDb.machines[idx] = { ...this._testDb.machines[idx], ...fields };
      this._persist();
      return this._testDb.machines[idx];
    }
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [key, val] of Object.entries(fields)) {
      sets.push(`${key} = $${i}`);
      vals.push(val);
      i++;
    }
    vals.push(id);
    const { rows } = await q(`UPDATE machines SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    return rows[0] || null;
  }

  async machinesRetire(id) {
    if (TEST_MODE) {
      const idx = this._testDb.machines.findIndex(m => m.id === id);
      if (idx !== -1) {
        this._testDb.machines[idx].status = 'Retired';
        this._persist();
      }
      return true;
    }
    await q("UPDATE machines SET status = 'Retired' WHERE id = $1", [id]);
    return true;
  }

  async machinesDelete(id) {
    if (TEST_MODE) {
      this._testDb.machines = this._testDb.machines.filter(m => m.id !== id);
      this._persist();
      return true;
    }
    await q('DELETE FROM machines WHERE id = $1', [id]);
    return true;
  }

  async machinesWithLocation() {
    if (TEST_MODE) {
      return this._testDb.machines
        .filter(m => m.status !== 'Retired')
        .map(m => {
          const loc = this._testDb.locations.find(l => l.id === m.location_id);
          return { ...m, building: loc?.building, hall: loc?.hall, room_number: loc?.room_number, floor: loc?.floor };
        })
        .sort((a, b) => a.machine_name.localeCompare(b.machine_name));
    }
    // Returns machines joined with their location info (for /api/machines)
    const { rows } = await q(`
      SELECT m.*, l.building, l.hall, l.room_number, l.floor
      FROM machines m
      LEFT JOIN locations l ON m.location_id = l.id
      WHERE m.status != 'Retired'
      ORDER BY m.machine_name
    `);
    return rows;
  }

  // ── Complaints ────────────────────────────────────────────────────────────

  async complaintsAll() {
    const { rows } = await q('SELECT * FROM complaints ORDER BY submitted_at DESC');
    return rows;
  }

  async complaintsCount() {
    const { rows } = await q('SELECT COUNT(*)::int AS count FROM complaints');
    return rows[0].count;
  }

  async complaintsCountByStatus(status) {
    const { rows } = await q('SELECT COUNT(*)::int AS count FROM complaints WHERE status = $1', [status]);
    return rows[0].count;
  }

  async complaintsCountByPriority() {
    const { rows } = await q(`SELECT COUNT(*)::int AS count FROM complaints WHERE priority IN ('High','Critical')`);
    return rows[0].count;
  }

  async complaintsFindByReporter(reporterId) {
    const { rows } = await q('SELECT * FROM complaints WHERE reporter_id = $1 ORDER BY submitted_at DESC', [reporterId]);
    return rows;
  }

  async complaintsFindById(id) {
    const { rows } = await q('SELECT * FROM complaints WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async complaintsFindRelated(machineId) {
    const { rows } = await q('SELECT * FROM complaints WHERE machine_id = $1 ORDER BY submitted_at DESC', [machineId]);
    return rows;
  }

  async complaintsCreate(complaint) {
    if (TEST_MODE) {
      const newComplaint = { ...complaint, id: this._nextId('complaintId') };
      this._testDb.complaints.push(newComplaint);
      this._persist();
      return newComplaint;
    }
    const { rows } = await q(
      `INSERT INTO complaints (
        ticket_number, reporter_id, complaint_type, machine_id, location_id, general_location,
        category, title, description, priority, status, problem_occurred_at, machine_unusable,
        submitted_at, updated_at, resolved_at, closed_at, ai_suggested_priority, ai_confidence_score,
        ai_analysis, ai_reasons, previous_ticket
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [
        complaint.ticket_number, complaint.reporter_id, complaint.complaint_type,
        complaint.machine_id, complaint.location_id, complaint.general_location,
        complaint.category, complaint.title, complaint.description, complaint.priority, complaint.status,
        complaint.problem_occurred_at, complaint.machine_unusable,
        complaint.submitted_at, complaint.updated_at, complaint.resolved_at, complaint.closed_at,
        complaint.ai_suggested_priority, complaint.ai_confidence_score,
        complaint.ai_analysis, complaint.ai_reasons, complaint.previous_ticket
      ]
    );
    return rows[0];
  }

  async complaintsUpdate(id, fields) {
    if (TEST_MODE) {
      const idx = this._testDb.complaints.findIndex(c => c.id === id);
      if (idx === -1) return null;
      this._testDb.complaints[idx] = { ...this._testDb.complaints[idx], ...fields };
      this._persist();
      return this._testDb.complaints[idx];
    }
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [key, val] of Object.entries(fields)) {
      sets.push(`${key} = $${i}`);
      vals.push(val);
      i++;
    }
    vals.push(id);
    const { rows } = await q(`UPDATE complaints SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    return rows[0] || null;
  }

  async complaintsWithFilters(filters) {
    /**
     * filters: { status, priority, machine_id, search, reporter_id }
     * Returns complaints joined with machine + location for complaintView.
     * Sorting: DESC by submitted_at.
     */
    const where = [];
    const params = [];
    let i = 1;

    if (filters.status) { where.push(`status = $${i++}`); params.push(filters.status); }
    if (filters.priority) { where.push(`priority = $${i++}`); params.push(filters.priority); }
    if (filters.machine_id) { where.push(`machine_id = $${i++}`); params.push(parseInt(filters.machine_id, 10)); }
    if (filters.reporter_id) { where.push(`reporter_id = $${i++}`); params.push(filters.reporter_id); }
    if (filters.search) {
      const term = `%${String(filters.search).toLowerCase()}%`;
      // Use LOWER() for case-insensitive match on ticket_number, title; machine_name via join
      where.push(`(LOWER(ticket_number) LIKE $${i} OR LOWER(title) LIKE $${i})`);
      params.push(term);
      // machine_name search will be applied client-side after join
      const searchTerm = String(filters.search).toLowerCase();
      params.push(searchTerm); // stored for client-side machine_name filter
    }

    let sql = `
      SELECT c.*, m.machine_name, m.machine_code, m.status as machine_status,
             l.building, l.hall, l.room_number, l.floor
      FROM complaints c
      LEFT JOIN machines m ON c.machine_id = m.id
      LEFT JOIN locations l ON c.location_id = l.id
    `;
    if (where.length) sql += ' WHERE ' + where.slice(0, where.length - (filters.search ? 1 : 0)).join(' AND ');
    sql += ' ORDER BY c.submitted_at DESC';

    const { rows } = await q(sql, params.filter((_, idx) => {
      // If search, we have an extra param at the end for machine_name filter (client-side)
      return true;
    }));

    let results = rows;

    // Client-side machine_name filter (since we can't easily reference joined column in WHERE without alias)
    if (filters.search) {
      const searchTerm = params[params.length - 1];
      results = rows.filter(r => r.machine_name && r.machine_name.toLowerCase().includes(searchTerm));
    }

    return results;
  }

  async complaintsWithDetails(id) {
    /** Returns complaint joined with machine, location, reporter + related arrays */
    const complaint = await this.complaintsFindById(id);
    if (!complaint) return null;

    const machine = complaint.machine_id ? await this.machinesFindById(complaint.machine_id) : null;
    const location = complaint.location_id ? await this.locationsFindById(complaint.location_id) : null;
    const reporter = await this.usersFindById(complaint.reporter_id);
    const images = await this.complaintImagesFindByComplaint(complaint.id);
    const updates = await this.complaintUpdatesFindByComplaint(complaint.id);
    const assignment = await this.assignmentsLatestByComplaint(complaint.id);

    return { complaint, machine, location, reporter, images, updates, assignment };
  }

  // ── Complaint Images ──────────────────────────────────────────────────────

  async complaintImagesFindByComplaint(complaintId) {
    const { rows } = await q('SELECT * FROM complaint_images WHERE complaint_id = $1', [complaintId]);
    return rows;
  }

  async complaintImagesCountByComplaint(complaintId) {
    const { rows } = await q('SELECT COUNT(*)::int AS count FROM complaint_images WHERE complaint_id = $1', [complaintId]);
    return rows[0].count;
  }

  async complaintImagesCreate(image) {
    const { rows } = await q(
      `INSERT INTO complaint_images (id, complaint_id, image_url, uploaded_by, uploaded_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [image.id, image.complaint_id, image.image_url, image.uploaded_by, image.uploaded_at]
    );
    return rows[0];
  }

  // ── Complaint Updates ────────────────────────────────────────────────────

  async complaintUpdatesFindByComplaint(complaintId) {
    const { rows } = await q(
      `SELECT cu.*, u.name as user_name
       FROM complaint_updates cu
       LEFT JOIN users u ON cu.user_id = u.id
       WHERE cu.complaint_id = $1 ORDER BY cu.created_at ASC`,
      [complaintId]
    );
    return rows;
  }

  async complaintUpdatesCreate(update) {
    if (TEST_MODE) {
      const newUpdate = { ...update, id: this._nextId('updateId') };
      this._testDb.complaintUpdates.push(newUpdate);
      this._persist();
      return newUpdate;
    }
    const { rows } = await q(
      `INSERT INTO complaint_updates (complaint_id, user_id, old_status, new_status, comment, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [update.complaint_id, update.user_id, update.old_status, update.new_status, update.comment, update.created_at]
    );
    return rows[0];
  }

  // ── Assignments ──────────────────────────────────────────────────────────

  async assignmentsFindByComplaint(complaintId) {
    const { rows } = await q('SELECT * FROM assignments WHERE complaint_id = $1 ORDER BY assigned_at DESC', [complaintId]);
    return rows;
  }

  async assignmentsLatestByComplaint(complaintId) {
    const { rows } = await q('SELECT * FROM assignments WHERE complaint_id = $1 ORDER BY assigned_at DESC LIMIT 1', [complaintId]);
    return rows[0] || null;
  }

  async assignmentsFindByAssignee(userId) {
    const { rows } = await q('SELECT * FROM assignments WHERE assigned_to = $1 ORDER BY assigned_at DESC', [userId]);
    return rows;
  }

  async assignmentsExists(complaintId, userId) {
    const { rows } = await q('SELECT 1 FROM assignments WHERE complaint_id = $1 AND assigned_to = $2 AND completed_at IS NULL', [complaintId, userId]);
    return rows.length > 0;
  }

  async assignmentsCreate(assignment) {
    const { rows } = await q(
      `INSERT INTO assignments (id, complaint_id, assigned_to, assigned_by, assigned_at, due_date, instructions, completed_at, completion_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [assignment.id, assignment.complaint_id, assignment.assigned_to, assignment.assigned_by, assignment.assigned_at,
       assignment.due_date, assignment.instructions, assignment.completed_at, assignment.completion_notes]
    );
    return rows[0];
  }

  async assignmentsClose(complaintId, completedAt, completionNotes) {
    await q(
      'UPDATE assignments SET completed_at = $1, completion_notes = $2 WHERE complaint_id = $3 AND completed_at IS NULL',
      [completedAt, completionNotes, complaintId]
    );
  }

  async assignmentsCountByAssignee(userId) {
    const { rows } = await q('SELECT COUNT(*)::int AS count FROM assignments WHERE assigned_to = $1', [userId]);
    return rows[0].count;
  }

  async assignmentsHasOpen(assigneeId) {
    const { rows } = await q(
      `SELECT COUNT(*)::int AS count FROM assignments a
       JOIN complaints c ON a.complaint_id = c.id
       WHERE a.assigned_to = $1 AND a.completed_at IS NULL AND c.status NOT IN ('Resolved','Closed')`,
      [assigneeId]
    );
    return rows[0].count > 0;
  }

  // ── Notifications ────────────────────────────────────────────────────────

  async notificationsFindByUser(userId) {
    const { rows } = await q('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]);
    return rows;
  }

  async notificationsCountByUser(userId) {
    const { rows } = await q('SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_status = false', [userId]);
    return rows[0].count;
  }

  async notificationsCreate(notification) {
    if (TEST_MODE) {
      const newNotification = { ...notification, id: this._nextId('notificationId') };
      this._testDb.notifications.push(newNotification);
      this._persist();
      return newNotification;
    }
    const { rows } = await q(
      `INSERT INTO notifications (user_id, complaint_id, title, message, read_status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [notification.user_id, notification.complaint_id, notification.title, notification.message, notification.read_status, notification.created_at]
    );
    return rows[0];
  }

  async notificationsMarkRead(id, userId) {
    if (TEST_MODE) {
      const idx = this._testDb.notifications.findIndex(n => n.id === id && n.user_id === userId);
      if (idx !== -1) {
        this._testDb.notifications[idx].read_status = true;
        this._persist();
      }
      return;
    }
    await q('UPDATE notifications SET read_status = true WHERE id = $1 AND user_id = $2', [id, userId]);
  }

  async notificationsMarkAllRead(userId) {
    if (TEST_MODE) {
      this._testDb.notifications.filter(n => n.user_id === userId).forEach(n => n.read_status = true);
      this._persist();
      return;
    }
    await q('UPDATE notifications SET read_status = true WHERE user_id = $1 AND read_status = false', [userId]);
  }

  async notificationsDeleteByUser(userId) {
    if (TEST_MODE) {
      this._testDb.notifications = this._testDb.notifications.filter(n => n.user_id !== userId);
      this._persist();
      return;
    }
    await q('DELETE FROM notifications WHERE user_id = $1', [userId]);
  }

  async notificationsCountByStatus(status) {
    return this.complaintsCountByStatus(status);
  }

  // ── Messages (outbox) ────────────────────────────────────────────────────

  async messagesAll() {
    const { rows } = await q('SELECT * FROM messages ORDER BY created_at DESC');
    return rows;
  }

  async messagesCount() {
    const { rows } = await q('SELECT COUNT(*)::int AS count FROM messages');
    return rows[0].count;
  }

  async messagesFindByRecipient(userId) {
    const { rows } = await q('SELECT * FROM messages WHERE recipient_id = $1 ORDER BY created_at DESC', [userId]);
    return rows;
  }

  async messagesCountRetryable() {
    const { rows } = await q(`SELECT COUNT(*)::int AS count FROM messages WHERE delivery_status IN ('failed','partial','queued')
      OR (delivery_status = 'skipped' AND (recipient_email IS NOT NULL OR recipient_phone IS NOT NULL))`);
    return rows[0].count;
  }

  async messagesFindByStatus(statuses) {
    const placeholders = statuses.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await q(`SELECT * FROM messages WHERE delivery_status IN (${placeholders})`, statuses);
    return rows;
  }

  async messagesFindById(id) {
    const { rows } = await q('SELECT * FROM messages WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async messagesCreate(message) {
    const { rows } = await q(
      `INSERT INTO messages (
        id, recipient_id, recipient_name, recipient_email, recipient_phone, delivery_channel, delivery_status,
        delivery_attempts, delivered_at, last_attempt_at, retry_count, subject, body, kind, complaint_id,
        ticket_number, read_status, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        message.id, message.recipient_id, message.recipient_name, message.recipient_email, message.recipient_phone,
        message.delivery_channel, message.delivery_status, message.delivery_attempts, message.delivered_at,
        message.last_attempt_at, message.retry_count, message.subject, message.body, message.kind,
        message.complaint_id, message.ticket_number, message.read_status, message.created_at
      ]
    );
    return rows[0];
  }

  async messagesUpdate(id, fields) {
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [key, val] of Object.entries(fields)) {
      sets.push(`${key} = $${i}`);
      vals.push(val);
      i++;
    }
    vals.push(id);
    const { rows } = await q(`UPDATE messages SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    return rows[0] || null;
  }

  async messagesMarkRead(id, userId) {
    await q('UPDATE messages SET read_status = true WHERE id = $1 AND recipient_id = $2', [id, userId]);
    return true;
  }

  // ── Analytics helpers ────────────────────────────────────────────────────

  async analyticsByCategory(startDate, endDate) {
    const { rows } = await q(
      `SELECT category, COUNT(*)::int AS count FROM complaints WHERE submitted_at >= $1 AND submitted_at < $2 GROUP BY category`,
      [startDate, endDate]
    );
    return rows;
  }

  async analyticsByStatus(startDate, endDate) {
    const { rows } = await q(
      `SELECT status, COUNT(*)::int AS count FROM complaints WHERE submitted_at >= $1 AND submitted_at < $2 GROUP BY status`,
      [startDate, endDate]
    );
    return rows;
  }

  async analyticsByPriority(startDate, endDate) {
    const { rows } = await q(
      `SELECT priority, COUNT(*)::int AS count FROM complaints WHERE submitted_at >= $1 AND submitted_at < $2 GROUP BY priority`,
      [startDate, endDate]
    );
    return rows;
  }

  async analyticsByType(startDate, endDate) {
    const { rows } = await q(
      `SELECT complaint_type, COUNT(*)::int AS count FROM complaints WHERE submitted_at >= $1 AND submitted_at < $2 GROUP BY complaint_type`,
      [startDate, endDate]
    );
    return rows;
  }

  async analyticsByMachine(startDate, endDate) {
    const { rows } = await q(
      `SELECT m.machine_name, COUNT(*)::int AS count
       FROM complaints c
       JOIN machines m ON c.machine_id = m.id
       WHERE c.submitted_at >= $1 AND c.submitted_at < $2 AND c.machine_id IS NOT NULL
       GROUP BY m.machine_name
       ORDER BY count DESC LIMIT 8`,
      [startDate, endDate]
    );
    return rows;
  }

  async analyticsStaffWorkload() {
    const { rows } = await q(
      `SELECT u.name, u.role,
       COUNT(a.id) FILTER (WHERE a.completed_at IS NULL AND c.status NOT IN ('Resolved','Closed')) AS open,
       COUNT(a.id) FILTER (WHERE a.completed_at IS NOT NULL OR c.status IN ('Resolved','Closed')) AS completed
       FROM users u
       LEFT JOIN assignments a ON a.assigned_to = u.id AND a.completed_at IS NULL
       LEFT JOIN complaints c ON a.complaint_id = c.id
       WHERE u.role = ANY($1)
       GROUP BY u.id, u.name, u.role
       ORDER BY open DESC, completed DESC`,
      [ASSIGNEE_ROLES]
    );
    return rows;
  }

  async analyticsAllTimeCounts() {
    const { rows } = await q('SELECT COUNT(*)::int AS total FROM complaints');
    return { total: rows[0].total };
  }

  async analyticsOpenAssignments() {
    const { rows } = await q(`
      SELECT COUNT(*)::int AS count FROM assignments a
      JOIN complaints c ON a.complaint_id = c.id
      WHERE a.completed_at IS NULL AND c.status NOT IN ('Resolved','Closed')`);
    return rows[0].count;
  }

  async analyticsOverdueAssignments(now) {
    const { rows } = await q(
      `SELECT COUNT(*)::int AS count FROM assignments a
       JOIN complaints c ON a.complaint_id = c.id
       WHERE a.completed_at IS NULL AND a.due_date IS NOT NULL AND a.due_date < $1 AND c.status NOT IN ('Resolved','Closed')`,
      [now]
    );
    return rows[0].count;
  }

  async analyticsComplaintsInWindow(startDate, endDate) {
    const { rows } = await q(
      'SELECT * FROM complaints WHERE submitted_at >= $1 AND submitted_at < $2',
      [startDate, endDate]
    );
    return rows;
  }

  // ── Staff profile ────────────────────────────────────────────────────────

  async staffProfile(userId) {
    // Assignments for staff member with complaint details
    const { rows: assignments } = await q(
      `SELECT a.*, c.id as complaint_id, c.ticket_number, c.machine_id, c.location_id, c.complaint_type, c.category,
       c.title, c.description, c.priority, c.status, c.problem_occurred_at, c.machine_unusable, c.machine_unusable,
       c.ai_suggested_priority, c.ai_confidence_score, c.submitted_at, c.updated_at, c.resolved_at, c.closed_at,
       m.machine_name, m.machine_code, m.status as machine_status,
       l.building, l.hall, l.room_number, l.floor
       FROM assignments a
       JOIN complaints c ON a.complaint_id = c.id
       LEFT JOIN machines m ON c.machine_id = m.id
       LEFT JOIN locations l ON c.location_id = l.id
       WHERE a.assigned_to = $1
       ORDER BY a.assigned_at DESC`,
      [userId]
    );

    const messages = await this.messagesFindByRecipient(userId);
    const user = await this.usersFindById(userId);

    return { user, assignments, messages };
  }

  async usersWithAssignmentsAndMessages() {
    // Get all users with their assignments and messages for admin staff view
    const { rows: users } = await q('SELECT * FROM users');
    const { rows: assignments } = await q(
      `SELECT a.*, c.id as complaint_id, c.ticket_number, c.machine_id, c.location_id, c.complaint_type, c.category,
       c.title, c.description, c.priority, c.status, c.problem_occurred_at, c.machine_unusable,
       c.ai_suggested_priority, c.ai_confidence_score, c.submitted_at, c.updated_at, c.resolved_at, c.closed_at,
       m.machine_name, m.machine_code, m.status as machine_status,
       l.building, l.hall, l.room_number, l.floor
       FROM assignments a
       JOIN complaints c ON a.complaint_id = c.id
       LEFT JOIN machines m ON c.machine_id = m.id
       LEFT JOIN locations l ON c.location_id = l.id
       ORDER BY a.assigned_at DESC`
    );
    const { rows: messages } = await q('SELECT * FROM messages ORDER BY created_at DESC');

    // Group assignments and messages by user
    const assignmentsByUser = {};
    for (const a of assignments) {
      if (!assignmentsByUser[a.assigned_to]) assignmentsByUser[a.assigned_to] = [];
      assignmentsByUser[a.assigned_to].push(a);
    }
    const messagesByUser = {};
    for (const m of messages) {
      if (!messagesByUser[m.recipient_id]) messagesByUser[m.recipient_id] = [];
      messagesByUser[m.recipient_id].push(m);
    }

    return users.map(u => ({
      ...u,
      assignments: assignmentsByUser[u.id] || [],
      messages: messagesByUser[u.id] || [],
      complaints: {} // placeholder for any complaint lookups
    }));
  }

  // ── Bulk migration from JSON store ───────────────────────────────────────

  async migrateFromStore(store) {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');

      // Clear existing data first (seed.sql may have pre-populated)
      await tx.query('TRUNCATE TABLE messages, notifications, complaint_updates, complaint_images, assignments, complaints, machines, locations, users RESTART IDENTITY CASCADE');

      // Users (with explicit IDs to preserve references)
      for (const u of store.users) {
        await tx.query(
          `INSERT INTO users (id, name, email, password_hash, role, user_id, phone, department, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name, email=EXCLUDED.email, password_hash=EXCLUDED.password_hash,
           role=EXCLUDED.role, user_id=EXCLUDED.user_id, phone=EXCLUDED.phone, department=EXCLUDED.department, created_at=EXCLUDED.created_at`,
          [u.id, u.name, u.email, u.password_hash, u.role, u.user_id, u.phone, u.department, u.created_at]
        );
      }

      // Locations
      for (const l of store.locations) {
        await tx.query(
          `INSERT INTO locations (id, building, hall, room_number, floor, description)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET
           building=EXCLUDED.building, hall=EXCLUDED.hall, room_number=EXCLUDED.room_number,
           floor=EXCLUDED.floor, description=EXCLUDED.description`,
          [l.id, l.building, l.hall, l.room_number, l.floor, l.description]
        );
      }

      // Machines
      for (const m of store.machines) {
        await tx.query(
          `INSERT INTO machines (id, machine_code, machine_name, manufacturer, model, category, location_id, status,
           installation_date, last_maintenance_date, next_maintenance_date, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO UPDATE SET
           machine_code=EXCLUDED.machine_code, machine_name=EXCLUDED.machine_name,
           manufacturer=EXCLUDED.manufacturer, model=EXCLUDED.model, category=EXCLUDED.category,
           location_id=EXCLUDED.location_id, status=EXCLUDED.status,
           installation_date=EXCLUDED.installation_date, last_maintenance_date=EXCLUDED.last_maintenance_date,
           next_maintenance_date=EXCLUDED.next_maintenance_date, created_at=EXCLUDED.created_at`,
          [m.id, m.machine_code, m.machine_name, m.manufacturer, m.model, m.category, m.location_id, m.status,
           m.installation_date ?? null, m.last_maintenance_date ?? null, m.next_maintenance_date ?? null, m.created_at ?? null]
        );
      }

      // Complaints
      for (const c of store.complaints) {
        await tx.query(
          `INSERT INTO complaints (id, ticket_number, reporter_id, complaint_type, machine_id, location_id, general_location,
           category, title, description, priority, status, problem_occurred_at, machine_unusable, submitted_at, updated_at,
           resolved_at, closed_at, ai_suggested_priority, ai_confidence_score, ai_analysis, ai_reasons, previous_ticket)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
           ON CONFLICT (id) DO UPDATE SET
           ticket_number=EXCLUDED.ticket_number, complaint_type=EXCLUDED.complaint_type,
           machine_id=EXCLUDED.machine_id, location_id=EXCLUDED.location_id, general_location=EXCLUDED.general_location,
           category=EXCLUDED.category, title=EXCLUDED.title, description=EXCLUDED.description, priority=EXCLUDED.priority,
           status=EXCLUDED.status, problem_occurred_at=EXCLUDED.problem_occurred_at, machine_unusable=EXCLUDED.machine_unusable,
           submitted_at=EXCLUDED.submitted_at, updated_at=EXCLUDED.updated_at, resolved_at=EXCLUDED.resolved_at,
           closed_at=EXCLUDED.closed_at, ai_suggested_priority=EXCLUDED.ai_suggested_priority,
           ai_confidence_score=EXCLUDED.ai_confidence_score, ai_analysis=EXCLUDED.ai_analysis, ai_reasons=EXCLUDED.ai_reasons,
           previous_ticket=EXCLUDED.previous_ticket`,
          [c.id, c.ticket_number, c.reporter_id, c.complaint_type, c.machine_id, c.location_id, c.general_location,
           c.category, c.title, c.description, c.priority, c.status, c.problem_occurred_at, c.machine_unusable,
           c.submitted_at, c.updated_at, c.resolved_at, c.closed_at, c.ai_suggested_priority, c.ai_confidence_score,
           c.ai_analysis, c.ai_reasons, c.previous_ticket]
        );
      }

      // Complaint images
      for (const img of store.complaintImages) {
        await tx.query(
          `INSERT INTO complaint_images (id, complaint_id, image_url, uploaded_by, uploaded_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET
           complaint_id=EXCLUDED.complaint_id, image_url=EXCLUDED.image_url,
           uploaded_by=EXCLUDED.uploaded_by, uploaded_at=EXCLUDED.uploaded_at`,
          [img.id, img.complaint_id, img.image_url, img.uploaded_by, img.uploaded_at]
        );
      }

      // Complaint updates
      for (const upd of store.complaintUpdates) {
        await tx.query(
          `INSERT INTO complaint_updates (id, complaint_id, user_id, old_status, new_status, comment, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET
           complaint_id=EXCLUDED.complaint_id, user_id=EXCLUDED.user_id,
           old_status=EXCLUDED.old_status, new_status=EXCLUDED.new_status, comment=EXCLUDED.comment, created_at=EXCLUDED.created_at`,
          [upd.id, upd.complaint_id, upd.user_id, upd.old_status, upd.new_status, upd.comment, upd.created_at]
        );
      }

      // Assignments
      for (const a of store.assignments) {
        await tx.query(
          `INSERT INTO assignments (id, complaint_id, assigned_to, assigned_by, assigned_at, due_date, instructions, completed_at, completion_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET
           complaint_id=EXCLUDED.complaint_id, assigned_to=EXCLUDED.assigned_to, assigned_by=EXCLUDED.assigned_by,
           assigned_at=EXCLUDED.assigned_at, due_date=EXCLUDED.due_date, instructions=EXCLUDED.instructions,
           completed_at=EXCLUDED.completed_at, completion_notes=EXCLUDED.completion_notes`,
          [a.id, a.complaint_id, a.assigned_to, a.assigned_by, a.assigned_at, a.due_date, a.instructions, a.completed_at, a.completion_notes]
        );
      }

      // Notifications
      for (const n of store.notifications) {
        await tx.query(
          `INSERT INTO notifications (id, user_id, complaint_id, title, message, read_status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET
           user_id=EXCLUDED.user_id, complaint_id=EXCLUDED.complaint_id, title=EXCLUDED.title,
           message=EXCLUDED.message, read_status=EXCLUDED.read_status, created_at=EXCLUDED.created_at`,
          [n.id, n.user_id, n.complaint_id, n.title, n.message, n.read_status, n.created_at]
        );
      }

      // Messages
      for (const m of store.messages) {
        await tx.query(
          `INSERT INTO messages (id, recipient_id, recipient_name, recipient_email, recipient_phone, delivery_channel,
           delivery_status, delivery_attempts, delivered_at, last_attempt_at, retry_count, subject, body, kind,
           complaint_id, ticket_number, read_status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
           ON CONFLICT (id) DO UPDATE SET
           recipient_id=EXCLUDED.recipient_id, recipient_name=EXCLUDED.recipient_name,
           recipient_email=EXCLUDED.recipient_email, recipient_phone=EXCLUDED.recipient_phone,
           delivery_channel=EXCLUDED.delivery_channel, delivery_status=EXCLUDED.delivery_status,
           delivery_attempts=EXCLUDED.delivery_attempts, delivered_at=EXCLUDED.delivered_at,
           last_attempt_at=EXCLUDED.last_attempt_at, retry_count=EXCLUDED.retry_count, subject=EXCLUDED.subject,
           body=EXCLUDED.body, kind=EXCLUDED.kind, complaint_id=EXCLUDED.complaint_id,
           ticket_number=EXCLUDED.ticket_number, read_status=EXCLUDED.read_status, created_at=EXCLUDED.created_at`,
          [m.id, m.recipient_id, m.recipient_name, m.recipient_email, m.recipient_phone, m.delivery_channel,
           m.delivery_status, JSON.stringify(m.delivery_attempts), m.delivered_at, m.last_attempt_at, m.retry_count,
           m.subject, m.body, m.kind, m.complaint_id, m.ticket_number, m.read_status, m.created_at]
        );
      }

      // Update sequences to the max id used
      for (const [table, col] of [['users','id'],['locations','id'],['machines','id'],['complaints','id'],
                                  ['complaint_images','id'],['complaint_updates','id'],['assignments','id'],
                                  ['notifications','id'],['messages','id']]) {
        await tx.query(`SELECT setval(pg_get_serial_sequence('${table}','${col}'), COALESCE((SELECT MAX(${col}) FROM ${table}), 1, 1), true)`);
      }

      await tx.query('COMMIT');
      return { users: store.users.length, locations: store.locations.length, machines: store.machines.length,
               complaints: store.complaints.length, images: store.complaintImages.length,
               updates: store.complaintUpdates.length, assignments: store.assignments.length,
               notifications: store.notifications.length, messages: store.messages.length };
    } catch (err) {
      await tx.query('ROLLBACK');
      console.error('[db] Migration error:', err.message);
      throw err;
    } finally {
      tx.release();
    }
  }

  // ── Health ───────────────────────────────────────────────────────────────

  async health() {
    const { rows } = await q('SELECT 1 as ok');
    return rows[0];
  }
}

const ASSIGNEE_ROLES = ['staff', 'technician', 'worker', 'faculty', 'teacher'];

module.exports = { Database, pool, q };
