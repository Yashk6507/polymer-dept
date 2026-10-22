-- Seed Data for Polymer Department Complaint Management System

-- Insert Locations
INSERT INTO locations (building, hall, room_number, floor, description) VALUES
('Main Block', 'Polymer Testing Laboratory', '101', 'Ground Floor', 'Primary testing facility'),
('Main Block', 'Material Testing Laboratory', '102', 'Ground Floor', 'Material characterization lab'),
('Main Block', 'Processing Laboratory', '201', 'First Floor', 'Polymer processing equipment'),
('Annexe Block', 'Advanced Testing Lab', '301', 'Third Floor', 'Advanced instrumentation'),
('Main Block', 'Quality Control Lab', '103', 'Ground Floor', 'QC and analysis');

-- Insert Machines
INSERT INTO machines (machine_code, machine_name, manufacturer, model, category, location_id, status, installation_date, last_maintenance_date, next_maintenance_date) VALUES
('UTM-001', 'Universal Testing Machine', 'Instron', '5900 Series', 'Mechanical Testing', 1, 'Operational', '2020-05-15', '2026-07-20', '2027-01-20'),
('MFI-001', 'Melt Flow Index Tester', 'Tinius Olsen', 'MP600', 'Rheology Testing', 1, 'Operational', '2019-08-10', '2026-06-15', '2026-12-15'),
('IZD-001', 'Izod Impact Tester', 'Zwick/Roell', 'HIT50P', 'Impact Testing', 2, 'Operational', '2021-01-20', '2026-08-01', '2027-02-01'),
('CHY-001', 'Charpy Impact Tester', 'Testing Machines Inc.', 'TMI Monitor', 'Impact Testing', 2, 'Under Maintenance', '2020-11-05', '2026-08-25', '2027-02-25'),
('CTM-001', 'Compression Testing Machine', 'Shimadzu', 'AGS-X', 'Mechanical Testing', 1, 'Operational', '2022-03-12', '2026-09-10', '2027-03-10'),
('HDT-001', 'Hardness Tester', 'Durometer Corp', 'Shore-D', 'Surface Testing', 2, 'Operational', '2018-06-30', '2026-05-20', '2026-11-20'),
('EXT-001', 'Extrusion Machine', 'Brabender', 'DSE 20/40', 'Processing', 3, 'Operational', '2021-09-01', '2026-08-15', '2027-02-15'),
('INJ-001', 'Injection Moulding Machine', 'Haitian', 'MA600', 'Processing', 3, 'Out of Service', '2019-02-14', '2026-06-10', '2026-12-10'),
('MST-001', 'Moisture Analyzer', 'Mettler Toledo', 'HB43-S', 'Analysis', 5, 'Operational', '2020-07-22', '2026-07-01', '2027-01-01'),
('WBL-001', 'Digital Weighing Balance', 'Sartorius', 'SECURA225D-1S', 'Analysis', 5, 'Operational', '2022-01-10', '2026-09-05', '2027-03-05'),
('TST-001', 'Tensile Strength Tester', 'Lloyd Instruments', 'LR30K', 'Mechanical Testing', 1, 'Operational', '2021-04-18', '2026-08-20', '2027-02-20'),
('VIS-001', 'Viscosity Meter', 'Brookfield', 'DV2T', 'Rheology Testing', 4, 'Operational', '2020-10-25', '2026-07-30', '2027-01-30');

-- Insert Users (password is hashed 'Password123' for demo purposes)
-- In production, these should be properly hashed using bcrypt
INSERT INTO users (name, email, password_hash, role, user_id, phone, department) VALUES
('Dr. Rajesh Kumar', 'hod@polymer.edu', '$2a$10$rWqV3zfJWEKxZ4kYqZ4Z4OWZ4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4', 'hod', 'HOD001', '9876543210', 'Plastic Polymer Testing'),
('Prof. Anita Sharma', 'anita.sharma@polymer.edu', '$2a$10$rWqV3zfJWEKxZ4kYqZ4Z4OWZ4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4', 'faculty', 'FAC001', '9876543211', 'Plastic Polymer Testing'),
('Mr. Vikram Singh', 'vikram.singh@polymer.edu', '$2a$10$rWqV3zfJWEKxZ4kYqZ4Z4OWZ4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4', 'technician', 'TECH001', '9876543212', 'Plastic Polymer Testing'),
('Ms. Priya Verma', 'priya.verma@polymer.edu', '$2a$10$rWqV3zfJWEKxZ4kYqZ4Z4OWZ4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4', 'technician', 'TECH002', '9876543213', 'Plastic Polymer Testing'),
('Amit Patel', 'amit.patel@student.edu', '$2a$10$rWqV3zfJWEKxZ4kYqZ4Z4OWZ4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4', 'student', 'STU2023001', '9876543214', 'Plastic Polymer Testing'),
('Neha Gupta', 'neha.gupta@student.edu', '$2a$10$rWqV3zfJWEKxZ4kYqZ4Z4OWZ4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4', 'student', 'STU2023002', '9876543215', 'Plastic Polymer Testing'),
('Rahul Mehta', 'rahul.mehta@student.edu', '$2a$10$rWqV3zfJWEKxZ4kYqZ4Z4OWZ4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4', 'student', 'STU2023003', '9876543216', 'Plastic Polymer Testing'),
('Mr. Suresh Kumar', 'suresh.kumar@polymer.edu', '$2a$10$rWqV3zfJWEKxZ4kYqZ4Z4OWZ4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4Z4', 'staff', 'STAFF001', '9876543217', 'Plastic Polymer Testing');

-- Insert Sample Complaints
INSERT INTO complaints (ticket_number, reporter_id, machine_id, location_id, category, title, description, priority, status, problem_occurred_at, machine_unusable) VALUES
('PPD-2026-000001', 5, 1, 1, 'Machine malfunction', 'Universal Testing Machine showing error code E45', 'The UTM is displaying error code E45 and stopping mid-test. This happened during tensile strength testing of PP samples. The machine stops after reaching 50% load.', 'High', 'Assigned', '2026-09-10 10:30:00', true),
('PPD-2026-000002', 6, 3, 2, 'Calibration issue', 'Izod Impact Tester readings inconsistent', 'Getting varying readings for the same standard sample. Readings differ by more than 15% which is beyond acceptable range. Suspect calibration drift.', 'Medium', 'In Progress', '2026-09-11 14:15:00', false),
('PPD-2026-000003', 7, 8, 3, 'Mechanical defect', 'Injection Moulding Machine hydraulic pressure dropping', 'Hydraulic pressure drops suddenly during injection cycle. Noticed oil leakage near the pump assembly. Machine is making unusual noise.', 'Critical', 'Under Review', '2026-09-12 09:00:00', true),
('PPD-2026-000004', 5, 10, 5, 'Electrical problem', 'Digital Weighing Balance display flickering', 'Display keeps flickering and occasionally shows random numbers. Power connection seems stable. Issue started after a power fluctuation yesterday.', 'Low', 'Submitted', '2026-09-12 16:45:00', false),
('PPD-2026-000005', 6, 7, 3, 'Maintenance required', 'Extrusion Machine routine maintenance due', 'Machine is due for scheduled maintenance. Temperature zones showing slight variation. Screw and barrel may need inspection and cleaning.', 'Medium', 'Resolved', '2026-09-05 11:00:00', false),
('PPD-2026-000006', 7, 4, 2, 'Safety issue', 'Charpy Impact Tester safety guard not locking', 'Safety interlock guard is not engaging properly. Machine starts even when guard is slightly open. This is a serious safety concern.', 'Critical', 'Closed', '2026-09-01 13:30:00', true);

-- Insert Complaint Images (placeholder paths)
INSERT INTO complaint_images (complaint_id, image_url, uploaded_by) VALUES
(1, '/uploads/complaints/001_error_display.jpg', 5),
(1, '/uploads/complaints/001_machine_view.jpg', 5),
(2, '/uploads/complaints/002_reading_screen.jpg', 6),
(3, '/uploads/complaints/003_oil_leakage.jpg', 7),
(3, '/uploads/complaints/003_pump_area.jpg', 7),
(4, '/uploads/complaints/004_flickering_display.jpg', 5),
(5, '/uploads/complaints/005_temperature_panel.jpg', 6);

-- Insert Assignments
INSERT INTO assignments (complaint_id, assigned_to, assigned_by, assigned_at, due_date, instructions) VALUES
(1, 3, 1, '2026-09-10 15:00:00', '2026-09-13', 'Check error code in manual. Inspect load cell connections and control unit. Report findings before proceeding with repairs.'),
(2, 4, 1, '2026-09-11 16:30:00', '2026-09-14', 'Perform full calibration using standard samples. If calibration fails, check sensor alignment and pendulum assembly.'),
(3, 3, 1, '2026-09-12 10:00:00', '2026-09-15', 'URGENT: Inspect hydraulic system for leaks. Check pump seals and pressure valves. Machine must remain OFF until inspection complete.');

-- Insert Complaint Updates
INSERT INTO complaint_updates (complaint_id, user_id, old_status, new_status, comment) VALUES
(1, 1, 'Submitted', 'Under Review', 'Complaint reviewed. Issue verified as critical.'),
(1, 1, 'Under Review', 'Verified', 'Machine error confirmed. Assigning to technician.'),
(1, 1, 'Verified', 'Assigned', 'Assigned to Mr. Vikram Singh for inspection and repair.'),
(2, 1, 'Submitted', 'Under Review', 'Complaint under review.'),
(2, 1, 'Under Review', 'Verified', 'Calibration issue confirmed.'),
(2, 1, 'Verified', 'Assigned', 'Assigned to Ms. Priya Verma for recalibration.'),
(2, 4, 'Assigned', 'In Progress', 'Calibration work started. Standard samples being tested.'),
(3, 1, 'Submitted', 'Under Review', 'CRITICAL SAFETY ISSUE: Machine inspection required immediately.'),
(5, 3, 'Assigned', 'In Progress', 'Maintenance work in progress. Temperature control system being serviced.'),
(5, 3, 'In Progress', 'Resolved', 'Maintenance completed. All temperature zones calibrated. Machine tested successfully.'),
(5, 1, 'Resolved', 'Closed', 'Work verified. Machine operational.'),
(6, 1, 'Submitted', 'Verified', 'Critical safety issue verified.'),
(6, 1, 'Verified', 'Assigned', 'Emergency repair assigned.'),
(6, 3, 'Assigned', 'In Progress', 'Safety interlock mechanism replaced.'),
(6, 3, 'In Progress', 'Resolved', 'New safety guard installed and tested. All safety checks passed.'),
(6, 1, 'Resolved', 'Closed', 'Safety verification complete. Machine operational.');

-- Insert Maintenance Records
INSERT INTO maintenance_records (machine_id, complaint_id, technician_id, maintenance_type, description, parts_used, maintenance_date, next_maintenance_date, remarks) VALUES
(7, 5, 3, 'Scheduled Maintenance', 'Full maintenance service of extrusion machine', 'Heating element cleaning, Screw cleaning, Lubrication', '2026-09-08', '2027-03-08', 'All zones tested and working properly. Temperature variance within acceptable limits.'),
(4, 6, 3, 'Emergency Repair', 'Safety guard replacement', 'Safety interlock switch, Guard mounting bracket', '2026-09-02', '2027-03-02', 'Complete safety system inspection performed. All emergency stops tested.');

-- Insert Notifications
INSERT INTO notifications (user_id, complaint_id, title, message, read_status) VALUES
(5, 1, 'Complaint Assigned', 'Your complaint PPD-2026-000001 has been assigned to a technician.', true),
(5, 1, 'Status Update', 'Complaint PPD-2026-000001 status changed to: Assigned', true),
(3, 1, 'New Task Assigned', 'You have been assigned complaint PPD-2026-000001: Universal Testing Machine showing error code E45', false),
(6, 2, 'Complaint Verified', 'Your complaint PPD-2026-000002 has been verified and assigned.', true),
(4, 2, 'New Task Assigned', 'You have been assigned complaint PPD-2026-000002: Izod Impact Tester readings inconsistent', false),
(7, 3, 'Complaint Received', 'Your complaint PPD-2026-000003 has been received and is under review.', false),
(5, 4, 'Complaint Submitted', 'Your complaint PPD-2026-000004 has been submitted successfully. Ticket ID: PPD-2026-000004', false),
(6, 5, 'Complaint Resolved', 'Your complaint PPD-2026-000005 has been resolved.', true),
(6, 5, 'Complaint Closed', 'Your complaint PPD-2026-000005 has been closed. Thank you for reporting.', true);
