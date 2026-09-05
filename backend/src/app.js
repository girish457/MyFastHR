// Backend Entry Point - MyFastHR SaaS
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { isMasterKey } = require('./utils/masterKeys');

// Fail fast in production on a missing/weak JWT secret. A guessable secret makes
// tokens forgeable for any user/role, so we refuse to boot rather than run insecurely.
if (process.env.NODE_ENV === 'production') {
    const weakSecrets = ['dev_jwt_secret_change_me', 'secret', 'changeme'];
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret || jwtSecret.length < 32 || weakSecrets.includes(jwtSecret)) {
        console.error('[BOOT-FATAL]: JWT_SECRET is missing or weak. Set a strong (>=32 char) random JWT_SECRET before starting in production.');
        process.exit(1);
    }
}

const db = require('./config/db');

const authRoutes = require('./routes/authRoutes');
const attendanceRoutes = require('./routes/attendanceRoutes');
const employeeRoutes = require('./routes/employeeRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const payrollRoutes = require('./routes/payrollRoutes');
const leaveRoutes = require('./routes/leaveRoutes');
const profileRoutes = require('./routes/profileRoutes');
const adminRoutes = require('./routes/adminRoutes');
const orgRoutes = require('./routes/orgRoutes');
const complianceRoutes = require('./routes/complianceRoutes');
const documentRoutes = require('./routes/documentRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const taskRoutes = require('./routes/taskRoutes');
const regularizationRoutes = require('./routes/regularizationRoutes');
const announcementsRoutes = require('./routes/announcementsRoutes');
console.log('>>> [BOOT]: Task Routes Module Loaded');

const { authenticateToken } = require('./middlewares/authMiddleware');
const tenantFilter = require('./middlewares/tenantMiddleware');
const tenantGuard = require('./middlewares/tenantGuard');

// Database Schema Sync (Auto-Fix)
const syncDatabaseSchema = async () => {
    try {
        console.log('>>> [DB-SYNC]: Checking employees table schema...');
        const hasEmployees = await db.schema.hasTable('employees');
        if (!hasEmployees) return;

        const columnsToCheck = [
            'father_name', 'mother_name', 'spouse_name', 'pan_number', 'aadhaar_number',
            'bank_name', 'account_number', 'ifsc_code', 'bank_branch', 'dd_payable_at',
            'uan_number', 'pf_number', 'esi_number', 'include_pf', 'include_esi', 'include_lwf', 'include_gratuity', 'pf_excess_contribution',
            'payment_type', 'probation_period', 'confirmation_date', 'contract_start_date', 'contract_end_date', 'referred_by', 'shift',
            'emergency_contact_name', 'emergency_contact_number', 'emergency_contact_relation',
            'emergency_email', 'emergency_contact_address', 'emergency_city',
            'photo', 'onboarding_token', 'onboarding_token_created_at', 'onboarding_status', 'onboarding_filled_fields', 'attendance_scheme_id',
            'nick_name', 'extension', 'blood_group', 'marital_status', 'marriage_date',
            'nationality', 'residential_status', 'birth_place', 'origin_country', 'religion', 'is_disabled',
            'present_address', 'city', 'district', 'state', 'country', 'pincode',
            'permanent_address', 'permanent_city', 'permanent_country', 'permanent_pincode',
            'department_id', 'gender', 'date_of_birth', 'resignation_date', 'office_location',
            'applicable_statutory_rules'
        ];

        const missingColumns = [];
        for (const col of columnsToCheck) {
            const exists = await db.schema.hasColumn('employees', col);
            if (!exists) {
                missingColumns.push(col);
            }
        }

        if (missingColumns.length > 0) {
            console.log(`>>> [DB-SYNC]: Adding ${missingColumns.length} missing columns...`);
            await db.schema.alterTable('employees', (table) => {
                if (missingColumns.includes('father_name')) table.string('father_name').nullable();
                if (missingColumns.includes('mother_name')) table.string('mother_name').nullable();
                if (missingColumns.includes('spouse_name')) table.string('spouse_name').nullable();
                if (missingColumns.includes('pan_number')) table.string('pan_number').nullable();
                if (missingColumns.includes('aadhaar_number')) table.string('aadhaar_number').nullable();

                if (missingColumns.includes('bank_name')) table.string('bank_name').nullable();
                if (missingColumns.includes('account_number')) table.string('account_number').nullable();
                if (missingColumns.includes('ifsc_code')) table.string('ifsc_code').nullable();
                if (missingColumns.includes('bank_branch')) table.string('bank_branch').nullable();
                if (missingColumns.includes('dd_payable_at')) table.string('dd_payable_at').nullable();

                if (missingColumns.includes('uan_number')) table.string('uan_number').nullable();
                if (missingColumns.includes('pf_number')) table.string('pf_number').nullable();
                if (missingColumns.includes('esi_number')) table.string('esi_number').nullable();
                if (missingColumns.includes('include_pf')) table.boolean('include_pf').defaultTo(false);
                if (missingColumns.includes('include_esi')) table.boolean('include_esi').defaultTo(false);
                if (missingColumns.includes('include_lwf')) table.boolean('include_lwf').defaultTo(false);
                if (missingColumns.includes('include_gratuity')) table.boolean('include_gratuity').defaultTo(false);
                if (missingColumns.includes('pf_excess_contribution')) table.boolean('pf_excess_contribution').defaultTo(false);

                if (missingColumns.includes('payment_type')) table.string('payment_type').nullable();
                if (missingColumns.includes('probation_period')) table.string('probation_period').nullable();
                if (missingColumns.includes('confirmation_date')) table.date('confirmation_date').nullable();
                if (missingColumns.includes('contract_start_date')) table.date('contract_start_date').nullable();
                if (missingColumns.includes('contract_end_date')) table.date('contract_end_date').nullable();
                if (missingColumns.includes('referred_by')) table.string('referred_by').nullable();
                if (missingColumns.includes('shift')) table.string('shift').nullable();

                if (missingColumns.includes('emergency_contact_name')) table.string('emergency_contact_name').nullable();
                if (missingColumns.includes('emergency_contact_number')) table.string('emergency_contact_number').nullable();
                if (missingColumns.includes('emergency_contact_relation')) table.string('emergency_contact_relation').nullable();
                if (missingColumns.includes('emergency_email')) table.string('emergency_email').nullable();
                if (missingColumns.includes('emergency_contact_address')) table.text('emergency_contact_address').nullable();
                if (missingColumns.includes('emergency_city')) table.string('emergency_city').nullable();

                if (missingColumns.includes('photo')) table.string('photo').nullable();
                if (missingColumns.includes('attendance_scheme_id')) table.integer('attendance_scheme_id').unsigned().nullable();
                if (missingColumns.includes('onboarding_token')) table.string('onboarding_token').nullable();
                if (missingColumns.includes('onboarding_token_created_at')) table.timestamp('onboarding_token_created_at').nullable();
                if (missingColumns.includes('onboarding_status')) table.string('onboarding_status').defaultTo('pending');
                if (missingColumns.includes('onboarding_filled_fields')) table.text('onboarding_filled_fields').nullable();

                if (missingColumns.includes('nick_name')) table.string('nick_name').nullable();
                if (missingColumns.includes('extension')) table.string('extension').nullable();
                if (missingColumns.includes('blood_group')) table.string('blood_group').nullable();
                if (missingColumns.includes('marital_status')) table.string('marital_status').nullable();
                if (missingColumns.includes('marriage_date')) table.date('marriage_date').nullable();
                if (missingColumns.includes('nationality')) table.string('nationality').nullable();
                if (missingColumns.includes('residential_status')) table.string('residential_status').nullable();
                if (missingColumns.includes('birth_place')) table.string('birth_place').nullable();
                if (missingColumns.includes('origin_country')) table.string('origin_country').nullable();
                if (missingColumns.includes('religion')) table.string('religion').nullable();
                if (missingColumns.includes('is_disabled')) table.boolean('is_disabled').defaultTo(false);
                if (missingColumns.includes('personal_email')) table.string('personal_email').nullable();
                if (missingColumns.includes('height')) table.string('height').nullable();
                if (missingColumns.includes('weight')) table.string('weight').nullable();
                if (missingColumns.includes('id_mark')) table.string('id_mark').nullable();
                if (missingColumns.includes('hobby')) table.string('hobby').nullable();
                if (missingColumns.includes('caste')) table.string('caste').nullable();
                if (missingColumns.includes('present_address')) table.text('present_address').nullable();
                if (missingColumns.includes('city')) table.string('city').nullable();
                if (missingColumns.includes('district')) table.string('district').nullable();
                if (missingColumns.includes('state')) table.string('state').nullable();
                if (missingColumns.includes('country')) table.string('country').nullable();
                if (missingColumns.includes('pincode')) table.string('pincode').nullable();
                if (missingColumns.includes('permanent_address')) table.text('permanent_address').nullable();
                if (missingColumns.includes('permanent_city')) table.string('permanent_city').nullable();
                if (missingColumns.includes('permanent_country')) table.string('permanent_country').nullable();
                if (missingColumns.includes('permanent_pincode')) table.string('permanent_pincode').nullable();
                if (missingColumns.includes('department_id')) table.integer('department_id').unsigned().nullable();
                if (missingColumns.includes('gender')) table.enu('gender', ['Male', 'Female', 'Other']).nullable();
                if (missingColumns.includes('date_of_birth')) table.date('date_of_birth').nullable();
                if (missingColumns.includes('resignation_date')) table.date('resignation_date').nullable();
                if (missingColumns.includes('office_location')) table.string('office_location', 100).nullable();
                if (missingColumns.includes('applicable_statutory_rules')) table.text('applicable_statutory_rules').nullable();
            });

            // Force drop unique constraint on employee_id_number to allow duplicates as requested
            try {
                await db.schema.alterTable('employees', (table) => {
                    table.dropUnique(['employee_id_number']).catch(() => {
                        // Ignore if index doesn't exist
                    });
                });
            } catch (e) { /* Ignore */ }

            console.log('>>> [DB-SYNC]: Schema updated successfully.');
        } else {
            // Even if no missing columns, try to drop unique constraint if it still exists
            try {
                await db.schema.alterTable('employees', (table) => {
                    table.dropUnique(['employee_id_number']).catch(() => { });
                });
            } catch (e) { }
            console.log('>>> [DB-SYNC]: Employees table schema is already up to date.');
        }

        // Auto-fix for employee_number_series missing auto_increment
        try {
            const hasSeriesTable = await db.schema.hasTable('employee_number_series');
            if (hasSeriesTable) {
                await db.raw('ALTER TABLE employee_number_series MODIFY COLUMN id INT AUTO_INCREMENT').catch(() => { });
            }
        } catch (e) { /* ignore */ }

        // Add login_otps table for email login
        const hasOtpsTable = await db.schema.hasTable('login_otps');
        if (!hasOtpsTable) {
            console.log('>>> [DB-SYNC]: Creating login_otps table...');
            await db.schema.createTable('login_otps', (table) => {
                table.increments('id').primary();
                table.string('email').notNullable();
                table.string('otp').notNullable();
                table.timestamp('expires_at').notNullable();
                table.boolean('is_used').defaultTo(false);
                table.timestamp('created_at').defaultTo(db.fn.now());
            });
            console.log('>>> [DB-SYNC]: login_otps table created.');
        }

        // Add system_settings table for global branding config
        const hasSettingsTable = await db.schema.hasTable('system_settings');
        if (!hasSettingsTable) {
            console.log('>>> [DB-SYNC]: Creating system_settings table...');
            await db.schema.createTable('system_settings', (table) => {
                table.increments('id').primary();
                table.string('key_name', 100).unique().notNullable();
                table.text('value_text').nullable();
                table.timestamp('created_at').defaultTo(db.fn.now());
                table.timestamp('updated_at').defaultTo(db.fn.now());
            });
            console.log('>>> [DB-SYNC]: system_settings table created.');

            await db('system_settings').insert([
                { key_name: 'logo_url', value_text: '/uploads/branding/logo.png' },
                { key_name: 'favicon_url', value_text: '/uploads/branding/favicon.png' },
                { key_name: 'logo_height', value_text: '36' }
            ]);
            console.log('>>> [DB-SYNC]: Default branding settings initialized.');
        } else {
            // Ensure all keys exist
            const keys = await db('system_settings').select('key_name');
            const keyNames = keys.map(k => k.key_name);
            if (!keyNames.includes('logo_url')) {
                await db('system_settings').insert({ key_name: 'logo_url', value_text: '/uploads/branding/logo.png' });
            }
            if (!keyNames.includes('favicon_url')) {
                await db('system_settings').insert({ key_name: 'favicon_url', value_text: '/uploads/branding/favicon.png' });
            }
            if (!keyNames.includes('logo_height')) {
                await db('system_settings').insert({ key_name: 'logo_height', value_text: '36' });
            }
        }

        // Add tenant_invoices table for billing logs
        const hasInvoicesTable = await db.schema.hasTable('tenant_invoices');
        if (!hasInvoicesTable) {
            console.log('>>> [DB-SYNC]: Creating tenant_invoices table...');
            await db.schema.createTable('tenant_invoices', (table) => {
                table.increments('id').primary();
                table.integer('company_id').unsigned().notNullable();
                table.decimal('amount', 10, 2).notNullable();
                table.string('plan', 50).notNullable();
                table.string('billing_period', 50).notNullable();
                table.string('status', 20).defaultTo('Unpaid');
                table.timestamp('paid_at').nullable();
                table.timestamp('created_at').defaultTo(db.fn.now());
            });
            console.log('>>> [DB-SYNC]: tenant_invoices table created.');
        }

        // Add case_studies table
        const hasCaseStudiesTable = await db.schema.hasTable('case_studies');
        if (!hasCaseStudiesTable) {
            console.log('>>> [DB-SYNC]: Creating case_studies table...');
            await db.schema.createTable('case_studies', (table) => {
                table.increments('id').primary();
                table.string('title').notNullable();
                table.string('sector').notNullable();
                table.string('size').nullable();
                table.text('challenge').notNullable();
                table.text('solution').notNullable();
                table.text('metrics').nullable(); // JSON string of metrics
                table.string('color').nullable();
                table.string('bg').nullable();
                table.text('summaryText').nullable();
                table.timestamp('created_at').defaultTo(db.fn.now());
                table.timestamp('updated_at').defaultTo(db.fn.now());
            });
            console.log('>>> [DB-SYNC]: case_studies table created.');

            // Seed with default case studies
            await db('case_studies').insert([
                {
                    title: 'Highway King Enterprises',
                    sector: 'logistics',
                    size: '250+ Employees',
                    challenge: 'Manual attendance log mismatch from 3 hubs and 4 days of payroll compile delay.',
                    solution: 'Automated biometric API synchronizer with Isolated Database instances.',
                    metrics: JSON.stringify([
                        { label: 'Payroll compiling time', before: '32 Hours', after: '20 Minutes', status: 'saved' },
                        { label: 'Biometric discrepancies', before: '14%', after: '0%', status: 'prevented' }
                    ]),
                    color: '#7A3F91',
                    bg: '#F2EAF7',
                    summaryText: `CASE STUDY: HIGHWAY KING ENTERPRISES\nSector: Logistics & Operations\nSize: 250+ Employees\n\nCHALLENGE:\nHighway King had manual attendance discrepancies across multiple physical hubs. Payroll took 4 whole operational days each month.\n\nSOLUTION:\nDeploying MyFastHR Biometric Sync Node. Real-time logging of punch coordinates directly with Knex schema updates.\n\nIMPACT:\n- Payroll compiler processing down from 32 hours to 20 minutes.\n- Biometric discrepancy rating dropped from 14% to 0%.`
                },
                {
                    title: 'First Attempt Skills Training',
                    sector: 'education',
                    size: '120+ Staff members',
                    challenge: 'PAN & Aadhaar physical audits took weekly management loops with compliance issues.',
                    solution: 'Secure Client KYC Approval screen and Encrypted Document Vault storage.',
                    metrics: JSON.stringify([
                        { label: 'Compliance Audit loop', before: '5 Days', after: '30 Seconds', status: 'saved' },
                        { label: 'Document vault storage', before: 'Unencrypted', after: 'AES-256 Nodes', status: 'secured' }
                    ]),
                    color: '#0F766E',
                    bg: '#CCFBF1',
                    summaryText: `CASE STUDY: FIRST ATTEMPT SKILLS TRAINING\nSector: Education / Professional Training\nSize: 120+ Staff members\n\nCHALLENGE:\nManual document checks and compliance audits caused massive back-and-forth communication loops.\n\nSOLUTION:\nKYC Approval Vault in MyFastHR. Allowed direct staff uploads with approval indicators.\n\nIMPACT:\n- Audit approval times reduced from 5 days to 30 seconds.\n- Fully secure Document Vault storage running AES-256 encryptions.`
                },
                {
                    title: 'Divyanshu Tech Labs',
                    sector: 'it',
                    size: '80+ Developers',
                    challenge: 'Spreadsheet shift planning, weekend overrides, and timezone adjustments for remote developers.',
                    solution: 'Rosters with Weekend Overrides & automated Leave workflows.',
                    metrics: JSON.stringify([
                        { label: 'Overtime calculation errors', before: '8.4%', after: '0.1%', status: 'prevented' },
                        { label: 'Regularization requests', before: '48 Hrs SLA', after: 'Real-time Approval', status: 'approved' }
                    ]),
                    color: '#D97706',
                    bg: '#FEF3C7',
                    summaryText: `CASE STUDY: DIVYANSHU TECH LABS\nSector: IT Services\nSize: 80+ Developers\n\nCHALLENGE:\nTimezone offsets and multi-shift rosters led to constant manual overrides.\n\nSOLUTION:\nInteractive shifts dashboard with custom weekend overrides and manager telemetry approval.\n\nIMPACT:\n- Overtime discrepancies dropped from 8.4% to 0.1%.\n- SLA for leave regularizations reduced to real-time approvals.`
                }
            ]);
            console.log('>>> [DB-SYNC]: Seeding default case studies complete.');
        }

        // Ensure shifts table has split shift columns
        const hasShiftsTable = await db.schema.hasTable('shifts');
        if (hasShiftsTable) {
            const shiftColumns = [
                'total_punches_required',
                'session2_start_time',
                'session2_end_time',
                'session1_grace_out',
                'session2_grace_in',
                'session2_grace_out',
                'session1_in_margin',
                'session1_out_margin',
                'session2_in_margin',
                'session2_out_margin',
                'terminate_hour',
                'grace_count_limit'
            ];
            const missingShiftCols = [];
            for (const col of shiftColumns) {
                const exists = await db.schema.hasColumn('shifts', col);
                if (!exists) {
                    missingShiftCols.push(col);
                }
            }

            if (missingShiftCols.length > 0) {
                console.log(`>>> [DB-SYNC]: Adding ${missingShiftCols.length} missing columns to shifts table...`);
                await db.schema.alterTable('shifts', (table) => {
                    if (missingShiftCols.includes('total_punches_required')) table.integer('total_punches_required').defaultTo(2);
                    if (missingShiftCols.includes('session2_start_time')) table.string('session2_start_time', 10).nullable();
                    if (missingShiftCols.includes('session2_end_time')) table.string('session2_end_time', 10).nullable();
                    if (missingShiftCols.includes('session1_grace_out')) table.integer('session1_grace_out').defaultTo(0);
                    if (missingShiftCols.includes('session2_grace_in')) table.integer('session2_grace_in').defaultTo(15);
                    if (missingShiftCols.includes('session2_grace_out')) table.integer('session2_grace_out').defaultTo(0);
                    if (missingShiftCols.includes('session1_in_margin')) table.integer('session1_in_margin').defaultTo(0);
                    if (missingShiftCols.includes('session1_out_margin')) table.integer('session1_out_margin').defaultTo(0);
                    if (missingShiftCols.includes('session2_in_margin')) table.integer('session2_in_margin').defaultTo(0);
                    if (missingShiftCols.includes('session2_out_margin')) table.integer('session2_out_margin').defaultTo(0);
                    if (missingShiftCols.includes('terminate_hour')) table.integer('terminate_hour').nullable();
                    if (missingShiftCols.includes('grace_count_limit')) table.integer('grace_count_limit').defaultTo(3);
                });
                console.log('>>> [DB-SYNC]: shifts table columns updated.');
            }
        }

        // 1. Ensure departments table exists
        const hasDepartments = await db.schema.hasTable('departments');
        if (!hasDepartments) {
            console.log('>>> [DB-SYNC]: Creating departments table...');
            await db.schema.createTable('departments', (table) => {
                table.increments('id').primary();
                table.integer('company_id').unsigned().notNullable();
                table.string('name', 100).notNullable();
                table.integer('manager_id').unsigned().nullable();
                table.timestamp('created_at').defaultTo(db.fn.now());
                table.foreign('company_id').references('companies.id').onDelete('CASCADE');
                table.foreign('manager_id').references('users.id').onDelete('SET NULL');
            });
            console.log('>>> [DB-SYNC]: departments table created.');
        }

        // 2. Ensure permissions table exists
        const hasPermissions = await db.schema.hasTable('permissions');
        if (!hasPermissions) {
            console.log('>>> [DB-SYNC]: Creating permissions table...');
            await db.schema.createTable('permissions', (table) => {
                table.increments('id').primary();
                table.string('name', 100).unique().notNullable();
                table.text('description').nullable();
            });
            console.log('>>> [DB-SYNC]: permissions table created.');
        }

        // 3. Ensure role_permissions table exists
        const hasRolePermissions = await db.schema.hasTable('role_permissions');
        if (!hasRolePermissions) {
            console.log('>>> [DB-SYNC]: Creating role_permissions table...');
            await db.schema.createTable('role_permissions', (table) => {
                table.integer('role_id').unsigned().notNullable();
                table.integer('permission_id').unsigned().notNullable();
                table.primary(['role_id', 'permission_id']);
                table.foreign('role_id').references('roles.id').onDelete('CASCADE');
                table.foreign('permission_id').references('permissions.id').onDelete('CASCADE');
            });
            console.log('>>> [DB-SYNC]: role_permissions table created.');
        }

        // Seed default permissions and role mappings
        try {
            const existingPermsCount = await db('permissions').count('id as cnt').first();
            if (existingPermsCount && (existingPermsCount.cnt === 0 || existingPermsCount['cnt'] === 0)) {
                console.log('>>> [DB-SYNC]: Seeding permissions and mapping to roles...');
                const defaultPerms = [
                    { name: 'view_global_analytics', description: 'Access to global Saas metrics (Super Admin)' },
                    { name: 'manage_tenants', description: 'Create and manage global companies' },
                    { name: 'configure_organization', description: 'Manage departments and org-wide settings' },
                    { name: 'manage_staff', description: 'Hire, edit, and terminate employees' },
                    { name: 'process_payroll', description: 'Run payroll and generate salary slips' },
                    { name: 'approve_attendance', description: 'Approve or reject team attendance logs' },
                    { name: 'approve_leaves', description: 'Approve or reject team leave requests' },
                    { name: 'view_self', description: 'Access personal dashboard and self-service portal' }
                ];
                await db('permissions').insert(defaultPerms);

                const roles = await db('roles').select('id', 'name');
                const superRole = roles.find(r => r.name === 'super_admin');
                const adminRole = roles.find(r => r.name === 'company_admin');
                const managerRole = roles.find(r => r.name === 'manager');
                const empRole = roles.find(r => r.name === 'employee');

                const allPerms = await db('permissions').select('id', 'name');

                const mappings = [];
                for (const perm of allPerms) {
                    if (superRole) {
                        mappings.push({ role_id: superRole.id, permission_id: perm.id });
                    }
                    if (adminRole && ['configure_organization', 'manage_staff', 'process_payroll', 'approve_attendance', 'approve_leaves', 'view_self'].includes(perm.name)) {
                        mappings.push({ role_id: adminRole.id, permission_id: perm.id });
                    }
                    if (managerRole && ['manage_staff', 'approve_attendance', 'approve_leaves', 'view_self'].includes(perm.name)) {
                        mappings.push({ role_id: managerRole.id, permission_id: perm.id });
                    }
                    if (empRole && ['view_self'].includes(perm.name)) {
                        mappings.push({ role_id: empRole.id, permission_id: perm.id });
                    }
                }
                if (mappings.length > 0) {
                    await db('role_permissions').insert(mappings).catch(() => { });
                }
                console.log('>>> [DB-SYNC]: Seeding permissions and role mappings completed.');
            }
        } catch (e) {
            console.error('>>> [DB-SYNC-ERROR]: Seeding permissions failed:', e.message);
        }

        // 4. Ensure salary_history table exists
        try {
            const hasSalaryHistory = await db.schema.hasTable('salary_history');
            if (!hasSalaryHistory) {
                console.log('>>> [DB-SYNC]: Creating salary_history table...');
                await db.schema.createTable('salary_history', (table) => {
                    table.increments('id').primary();
                    table.integer('employee_id').notNullable();
                    table.integer('company_id').notNullable();
                    table.decimal('old_salary', 15, 2).nullable();
                    table.decimal('new_salary', 15, 2).notNullable();
                    table.date('change_date').notNullable();
                    table.string('reason', 255).nullable();
                    table.timestamp('created_at').defaultTo(db.fn.now());
                    table.foreign('employee_id').references('employees.id').onDelete('CASCADE');
                    table.foreign('company_id').references('companies.id').onDelete('CASCADE');
                });
                console.log('>>> [DB-SYNC]: salary_history table created.');
            }
        } catch (e) {
            console.error('>>> [DB-SYNC-ERROR]: salary_history sync failed:', e.message);
        }

        // 5. Ensure loans table has loan_date column
        try {
            const hasLoansTable = await db.schema.hasTable('loans');
            if (hasLoansTable) {
                const hasLoanDate = await db.schema.hasColumn('loans', 'loan_date');
                if (!hasLoanDate) {
                    console.log('>>> [DB-SYNC]: Adding loan_date column to loans table...');
                    await db.schema.alterTable('loans', (table) => {
                        table.date('loan_date').nullable();
                    });
                    console.log('>>> [DB-SYNC]: loan_date column added to loans table.');
                }
            }
        } catch (e) {
            console.error('>>> [DB-SYNC-ERROR]: loans column sync failed:', e.message);
        }

        // 6. Ensure working_rules table has late_deduction_value column
        try {
            const hasWorkingRulesTable = await db.schema.hasTable('working_rules');
            if (hasWorkingRulesTable) {
                const hasDeductionValue = await db.schema.hasColumn('working_rules', 'late_deduction_value');
                if (!hasDeductionValue) {
                    console.log('>>> [DB-SYNC]: Adding late_deduction_value column to working_rules table...');
                    await db.schema.alterTable('working_rules', (table) => {
                        table.decimal('late_deduction_value', 15, 2).defaultTo(0);
                    });
                    console.log('>>> [DB-SYNC]: late_deduction_value column added to working_rules table.');
                }
                const hasEffectiveDate = await db.schema.hasColumn('working_rules', 'late_penalty_effective_date');
                if (!hasEffectiveDate) {
                    console.log('>>> [DB-SYNC]: Adding late_penalty_effective_date column to working_rules table...');
                    await db.schema.alterTable('working_rules', (table) => {
                        table.date('late_penalty_effective_date').nullable();
                    });
                    console.log('>>> [DB-SYNC]: late_penalty_effective_date column added to working_rules table.');
                }
            }
        } catch (e) {
            console.error('>>> [DB-SYNC-ERROR]: working_rules column sync failed:', e.message);
        }

        // 7. Ensure audit_logs table exists
        // Written by 5 sites in adminController (impersonation, backup create/restore,
        // SQL sandbox, system freeze) and read by getAuditLogs, but never part of this
        // sync - it exists in prod by some other means, so a fresh environment had no
        // self-heal. Shape mirrors exactly what those call sites insert and select.
        // Deliberately no foreign keys: an audit trail must outlive the company/user rows
        // it references, and company_id is null for platform-level actions.
        try {
            const hasAuditLogs = await db.schema.hasTable('audit_logs');
            if (!hasAuditLogs) {
                console.log('>>> [DB-SYNC]: Creating audit_logs table...');
                await db.schema.createTable('audit_logs', (table) => {
                    table.increments('id').primary();
                    table.integer('company_id').nullable();
                    table.integer('user_id').nullable();
                    table.string('action', 100).notNullable();
                    table.text('details').nullable();
                    table.string('ip_address', 45).nullable();
                    table.timestamp('created_at').defaultTo(db.fn.now());
                    table.index('company_id');
                    table.index('user_id');
                    table.index('created_at');
                });
                console.log('>>> [DB-SYNC]: audit_logs table created.');
            }
        } catch (e) {
            console.error('>>> [DB-SYNC-ERROR]: audit_logs sync failed:', e.message);
        }

        // 8. Ensure notifications table exists
        // Written by notificationService.createNotification (the single insert site, fed by
        // leave/payroll/document/attendance/regularization flows) and read by
        // notificationRoutes + the AppShell bell. It has never been part of this sync, so a
        // fresh environment had no self-heal. Shape mirrors exactly what those sites touch:
        // no updated_at, because nothing anywhere writes one.
        // Deliberately no foreign keys, matching audit_logs above.
        // Column types verified against production 2026-08-09 (SHOW CREATE TABLE), not
        // inferred from call sites — an earlier revision guessed company_id/message as
        // nullable and both are NOT NULL in prod.
        // ⚠️ company_id being NOT NULL is a live constraint worth knowing: createNotification
        // writes whatever companyId its caller passes, and callers that resolve it from an
        // unimpersonating super_admin's context can pass null. Today no employee row has a
        // NULL company_id in prod (verified: 0 of 262), so the path isn't reachable via
        // notifyAction — but a null from any other caller would throw on insert rather
        // than write a NULL. Not introduced here; flagged because this DDL makes it explicit.
        try {
            const hasNotifications = await db.schema.hasTable('notifications');
            if (!hasNotifications) {
                console.log('>>> [DB-SYNC]: Creating notifications table...');
                await db.schema.createTable('notifications', (table) => {
                    // Signed int in prod, unlike employee_kudos/attendance_regularizations
                    // whose ids are unsigned. knex's increments() always emits unsigned, so
                    // the column is spelled out to reproduce prod exactly.
                    table.specificType('id', 'int NOT NULL AUTO_INCREMENT').primary();
                    table.integer('user_id').notNullable();
                    // NOT NULL, verified against prod 2026-08-09 via SHOW CREATE TABLE.
                    // This contradicts the earlier assumption that company_id is nullable
                    // here: prod rejects a NULL. See the caveat comment above the block.
                    table.integer('company_id').notNullable();
                    table.string('title', 255).notNullable();
                    table.text('message').notNullable();
                    // Free-form, not an enum: call sites emit 'info' / 'success' / 'error' /
                    // 'warning', and AppShell additionally tests for a 'leave' type.
                    table.string('type', 50).defaultTo('info');
                    table.boolean('is_read').defaultTo(false);
                    table.timestamp('created_at').notNullable().defaultTo(db.fn.now());
                    // Composite, not per-column: every read is keyed on user_id first
                    // (see scopeToUser in notificationService). The bell polls every 30s
                    // for EVERY logged-in user, so these two are the hot paths:
                    //   getNotifications  -> where user_id .. order by created_at desc
                    //   getUnreadCount    -> where user_id .. and is_read = false
                    // A standalone index('user_id') would be a redundant prefix of the
                    // first of these. company_id is only ever an additional filter
                    // alongside user_id, never a lookup key on its own here.
                    table.index(['user_id', 'created_at'], 'notifications_user_created_idx');
                    table.index(['user_id', 'is_read'], 'notifications_user_read_idx');
                });
                console.log('>>> [DB-SYNC]: notifications table created.');
            }
        } catch (e) {
            console.error('>>> [DB-SYNC-ERROR]: notifications sync failed:', e.message);
        }

        // 9. Ensure employee_kudos table exists
        // Written and read only by routes/kudosRoutes.js, and row-counted by
        // adminController.getSystemTables. Never part of this sync until now.
        // badge/message widths match the MAX_BADGE_LENGTH (50) and MAX_MESSAGE_LENGTH (500)
        // caps the route validates against, so the DB can't silently truncate what the
        // route just accepted.
        // Types verified against production 2026-08-09 (SHOW CREATE TABLE). An earlier
        // revision assumed company_id was nullable "because pre-fix rows carry NULL" —
        // prod declares it unsigned NOT NULL, so no such row can exist.
        try {
            const hasEmployeeKudos = await db.schema.hasTable('employee_kudos');
            if (!hasEmployeeKudos) {
                console.log('>>> [DB-SYNC]: Creating employee_kudos table...');
                await db.schema.createTable('employee_kudos', (table) => {
                    table.increments('id').primary();
                    // unsigned + NOT NULL throughout, and badge is varchar(100) with message
                    // as TEXT — all verified against prod 2026-08-09 via SHOW CREATE TABLE.
                    // The route's 50/500 caps are stricter than the column, which is the
                    // safe direction: validation rejects before the DB could truncate.
                    table.integer('company_id').unsigned().notNullable();
                    table.integer('sender_id').unsigned().notNullable();
                    table.integer('recipient_id').unsigned().notNullable();
                    table.string('badge', 100).notNullable();
                    table.text('message').nullable();
                    table.timestamp('created_at').notNullable().defaultTo(db.fn.now());
                    table.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
                    // The feed is `where company_id = ? order by created_at desc limit/offset`
                    // (kudosRoutes), so the composite serves filter + sort in one index and
                    // makes a standalone index('company_id') a redundant prefix.
                    // sender_id/recipient_id back the two employees joins.
                    table.index(['company_id', 'created_at'], 'employee_kudos_company_created_idx');
                    table.index('sender_id');
                    table.index('recipient_id');
                });
                console.log('>>> [DB-SYNC]: employee_kudos table created.');
            }
        } catch (e) {
            console.error('>>> [DB-SYNC-ERROR]: employee_kudos sync failed:', e.message);
        }

        // 10. Ensure attendance_regularizations table exists
        // Written by regularizationService (apply + approve/reject) and read by
        // regularizationService, attendanceService (muster day-detail), attendanceRepository
        // and analyticsRepository. Never part of this sync until now.
        // check_in/check_out are TIME, not DATETIME: the client posts 'HH:MM:00', the approval
        // path concatenates them onto a date string, and the UI slices the first 5 chars.
        // approved_by holds a users.id (attendanceService left-joins users on it), not an employee id.
        // Types verified against production 2026-08-09 (SHOW CREATE TABLE): company_id is
        // unsigned NOT NULL (not nullable as previously assumed) and check_in/check_out are
        // varchar(50), not TIME.
        try {
            const hasRegularizations = await db.schema.hasTable('attendance_regularizations');
            if (!hasRegularizations) {
                console.log('>>> [DB-SYNC]: Creating attendance_regularizations table...');
                await db.schema.createTable('attendance_regularizations', (table) => {
                    table.increments('id').primary();
                    table.integer('employee_id').unsigned().notNullable();
                    table.integer('company_id').unsigned().notNullable();
                    // Present in prod but referenced by ZERO code in backend/src. Kept so a
                    // fresh environment is a faithful copy of prod and a schema diff shows
                    // no phantom difference — not because anything reads it.
                    table.integer('attendance_id').unsigned().nullable();
                    table.date('date').notNullable();
                    // varchar(50), NOT time. Verified against prod 2026-08-09 — the earlier
                    // TIME inference from call sites was wrong. This is why
                    // regularizationService.js:177-195 carries three-way string
                    // normalization: it has always been handling free-form strings.
                    table.string('check_in', 50).nullable();
                    table.string('check_out', 50).nullable();
                    table.text('reason').notNullable();
                    // 'pending' | 'approved' | 'rejected'
                    table.string('status', 50).defaultTo('pending');
                    // 'full_day' | 'half_day'
                    table.string('regularization_type', 50).defaultTo('full_day');
                    table.integer('approved_by').unsigned().nullable();
                    table.timestamp('created_at').notNullable().defaultTo(db.fn.now());
                    table.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
                    // Two access shapes, both composite:
                    //   employee + day  -> attendanceService muster day-detail, and the
                    //                      overlap check in regularizationService.apply
                    //   tenant + status -> the review queue (listReviewRequests)
                    // Standalone employee_id / company_id indexes would be redundant
                    // prefixes of these.
                    table.index(['employee_id', 'date'], 'attendance_regularizations_emp_date_idx');
                    table.index(['company_id', 'status'], 'attendance_regularizations_company_status_idx');
                });
                console.log('>>> [DB-SYNC]: attendance_regularizations table created.');
            }
        } catch (e) {
            console.error('>>> [DB-SYNC-ERROR]: attendance_regularizations sync failed:', e.message);
        }

        // 11. Ensure employees table has company_id column
        // Every tenant-scoped query keys off employees.company_id, but the column was never
        // declared anywhere in this routine - the employees section above only ALTERs the
        // table and assumes company_id already exists. Nullable to match reality: employees
        // created by a super_admin are persisted with company_id NULL
        // (employeeController.create passes req.user.company_id), and notificationService
        // explicitly treats that NULL as "not foreign" rather than as a data error.
        try {
            const hasEmployeesTable = await db.schema.hasTable('employees');
            if (hasEmployeesTable) {
                const hasEmployeeCompanyId = await db.schema.hasColumn('employees', 'company_id');
                if (!hasEmployeeCompanyId) {
                    console.log('>>> [DB-SYNC]: Adding company_id column to employees table...');
                    await db.schema.alterTable('employees', (table) => {
                        table.integer('company_id').unsigned().nullable();
                    });
                    console.log('>>> [DB-SYNC]: company_id column added to employees table.');
                }
            }
        } catch (e) {
            console.error('>>> [DB-SYNC-ERROR]: employees company_id sync failed:', e.message);
        }

        // 12. Ensure attendance table carries logical_date + review_reason
        // The attendance table pre-exists in every environment (it is older than this
        // routine), so this block only ever ALTERs — it must never try to create it.
        //
        // logical_date is the shift day a row belongs to, stamped at punch-ingestion time.
        // Today every reader re-derives it from check_in via getLogicalDateStr(), which
        // resolves the employee's shift at read time and is therefore order-dependent
        // whenever an employee has overlapping shift assignments — and that is the norm in
        // this data, not the exception: measured on production 2026-09-05, 164 of 231 active
        // employees at one client
        // hold more than one open-ended assignment, so "newest id wins" decides the day.
        // Persisting the value at write time freezes the grouping the ingestion engine
        // actually used, and lets a row sit on the correct day even when its check_in is
        // not, on its own, a reliable indicator of that day (night shifts, rescued punches
        // that landed in the checkout window, a lone punch after midnight).
        //
        // review_reason is set by the ingestion engine when a row was written under an
        // ambiguous or rescued condition and a human should confirm it before it is treated
        // as fact. Known values:
        //   'checkout_window_unpaired'  - a sole punch inside the checkout window that was
        //                                 rescued as a check-in with no partner punch.
        //   'early_before_in_margin'    - a punch that arrived before the shift's allowed
        //                                 early-in margin and was accepted anyway.
        //   'closed_after_termination'  - the row was auto-closed by termination handling
        //                                 rather than by a real out-punch.
        // NULL is the overwhelming majority case and means "nothing to review".
        //
        try {
            const hasAttendanceTable = await db.schema.hasTable('attendance');
            if (hasAttendanceTable) {
                const hasLogicalDate = await db.schema.hasColumn('attendance', 'logical_date');
                if (!hasLogicalDate) {
                    console.log('>>> [DB-SYNC]: Adding logical_date column to attendance table...');
                    await db.schema.alterTable('attendance', (table) => {
                        // Nullable: every row that pre-dates this column has no stamped value,
                        // and readers must keep falling back to getLogicalDateStr(check_in)
                        // for those. A backfill is a separate, deliberate operation.
                        table.date('logical_date').nullable();
                    });
                    console.log('>>> [DB-SYNC]: logical_date column added to attendance table.');
                }

                const hasReviewReason = await db.schema.hasColumn('attendance', 'review_reason');
                if (!hasReviewReason) {
                    console.log('>>> [DB-SYNC]: Adding review_reason column to attendance table...');
                    await db.schema.alterTable('attendance', (table) => {
                        // varchar(64) is comfortably wider than the longest known value
                        // ('closed_after_termination', 24 chars), leaving room for future
                        // reasons without another ALTER. Deliberately a plain string, not an
                        // enum: the value set is expected to grow as more rescue paths are
                        // identified, and an enum would turn each addition into a table
                        // rebuild on every environment.
                        table.string('review_reason', 64).nullable();
                    });
                    console.log('>>> [DB-SYNC]: review_reason column added to attendance table.');
                }

                // NON-UNIQUE composite index on (employee_id, logical_date).
                //
                // Deliberately NOT unique, for two independent reasons — either alone is
                // disqualifying:
                //   (a) 4-punch split/session shifts legitimately write TWO attendance rows
                //       for the same employee on the same logical day (session 1 and
                //       session 2). A unique index would make the second session's insert
                //       fail, i.e. it would break a supported shift type by design.
                //   (b) production held ~920 rows that would violate it (measured 2026-09-05), so the
                //       CREATE UNIQUE INDEX would simply fail at boot and this whole sync
                //       block would log-and-skip forever, silently leaving the plain index
                //       missing too.
                // Concurrent-insert protection is therefore NOT the index's job: the
                // ingestion path takes a SELECT ... FOR UPDATE row lock before deciding
                // whether to insert or update, which is what actually serialises two punches
                // racing for the same employee/day.
                //
                // knex exposes no hasIndex(), so probe information_schema.statistics by name
                // and only create when absent — re-running CREATE INDEX on an existing name
                // is a hard error, not a no-op.
                const [idxRows] = await db.raw(
                    `SELECT COUNT(*) AS cnt FROM information_schema.statistics
                     WHERE table_schema = DATABASE()
                       AND table_name = 'attendance'
                       AND index_name = 'attendance_emp_logical_date_idx'`
                );
                const idxExists = Array.isArray(idxRows) && idxRows.length > 0 && Number(idxRows[0].cnt) > 0;
                if (!idxExists) {
                    console.log('>>> [DB-SYNC]: Creating attendance_emp_logical_date_idx on attendance...');
                    await db.schema.alterTable('attendance', (table) => {
                        // employee + shift day is the access shape for the muster grid, the
                        // day-detail drill-down and the ingestion engine's "is there already
                        // a row for this employee on this day?" lookup.
                        table.index(['employee_id', 'logical_date'], 'attendance_emp_logical_date_idx');
                    });
                    console.log('>>> [DB-SYNC]: attendance_emp_logical_date_idx created.');
                }
            }
        } catch (e) {
            console.error('>>> [DB-SYNC-ERROR]: attendance logical_date/review_reason sync failed:', e.message);
        }

        // 13. Ensure attendance_entry_requests table exists
        // Written by machineAttendanceService (the biometric ingestion path raises the
        // request), attendanceService.preApproveException (admin pre-approval) and
        // attendanceService.approveRejectEntryExitRequest, and read by
        // attendanceService.getEntryExitRequests, the muster day-detail and
        // attendanceRepository. Despite being on the hot attendance path it had NO block in
        // this routine until now, which violates the "schema is self-healing here or nowhere"
        // convention — a fresh environment simply had no such table and every entry-request
        // write threw.
        //
        // Shape verified against production today (SHOW CREATE TABLE), not inferred from
        // call sites:
        //   - `date` is the SHIFT day the request belongs to, not the calendar day of
        //     punch_time. They diverge for night shifts and for punches rescued across
        //     midnight, and conflating the two is exactly the bug that made an approval land
        //     on the wrong attendance row.
        //   - approved_by holds a users.id (the approver's login), NOT an employee id — the
        //     read path left-joins users on it.
        //   - status is nullable with a 'pending' default; older rows written before the
        //     default was in place can carry NULL, so readers must treat NULL as pending.
        //   - request_type has NO enum and NO CHECK constraint in prod: it is a plain
        //     varchar(50) validated only by string comparison at the call sites
        //     ('late_in' | 'early_out' | 'missing_in'). 'missing_in' is a newly added third
        //     value, which is precisely why the column must stay a free string here — an
        //     enum would have required a coordinated schema change to ship it.
        try {
            const hasEntryRequests = await db.schema.hasTable('attendance_entry_requests');
            if (!hasEntryRequests) {
                console.log('>>> [DB-SYNC]: Creating attendance_entry_requests table...');
                await db.schema.createTable('attendance_entry_requests', (table) => {
                    table.increments('id').primary();
                    table.integer('company_id').unsigned().notNullable();
                    table.integer('employee_id').unsigned().notNullable();
                    // The shift day, not the calendar day of punch_time — see above.
                    table.date('date').notNullable();
                    // 'late_in' | 'early_out' | 'missing_in' — enforced only in JS.
                    table.string('request_type', 50).notNullable();
                    // The actual punch that triggered the request, full DATETIME: for a night
                    // shift this can fall on the calendar day either side of `date`.
                    table.datetime('punch_time').notNullable();
                    // Free-form JSON/text blob captured from the mobile punch when available.
                    table.text('location_data').nullable();
                    // 'pending' | 'approved' | 'rejected'
                    table.string('status', 50).defaultTo('pending');
                    // A users.id, not an employee id.
                    table.integer('approved_by').unsigned().nullable();
                    table.timestamp('created_at').notNullable().defaultTo(db.fn.now());
                    table.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
                    // Two access shapes, both composite, mirroring attendance_regularizations:
                    //   employee + day  -> the ingestion engine's duplicate-request check and
                    //                      the muster day-detail lookup
                    //   tenant + status -> the admin review queue (getEntryExitRequests)
                    // Standalone employee_id / company_id indexes would be redundant prefixes
                    // of these.
                    table.index(['employee_id', 'date'], 'attendance_entry_requests_emp_date_idx');
                    table.index(['company_id', 'status'], 'attendance_entry_requests_company_status_idx');
                });
                console.log('>>> [DB-SYNC]: attendance_entry_requests table created.');
            }
        } catch (e) {
            console.error('>>> [DB-SYNC-ERROR]: attendance_entry_requests sync failed:', e.message);
        }

    } catch (err) {
        console.error('>>> [DB-SYNC-ERROR]:', err.message);
    }
};

// Run sync on startup
syncDatabaseSchema();

const path = require('path');
const fs = require('fs');

// Ensure upload directories exist
const uploadDirs = [
    path.join(__dirname, '../uploads'),
    path.join(__dirname, '../uploads/kyc'),
    path.join(__dirname, '../uploads/profile_photos'),
    path.join(__dirname, '../uploads/branding'),
    path.join(__dirname, '../uploads/tenants')
];

uploadDirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

const app = express();

app.set('trust proxy', 1);

// Security Middlewares (Set security headers first)
app.use(helmet({
    crossOriginResourcePolicy: false, // Allow cross-origin images/files
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            'upgrade-insecure-requests': null, // Stop upgrading HTTP requests to HTTPS
        },
    },
    hsts: false, // Disable HSTS (Strict-Transport-Security) for HTTP development/testing
}));

// 1. Serve frontend static files immediately (Bypasses CORS, rate limiting, and api logic)
app.use(express.static(path.join(__dirname, '../public')));

// 2. Virtual Router for multi-tenant file separation (Served early before CORS)
app.get('/uploads/kyc/:filename', (req, res, next) => {
    const filename = req.params.filename;
    const uploadsBase = path.join(__dirname, '../uploads');

    // 1. Try legacy path first (backwards compatibility)
    const legacyPath = path.join(uploadsBase, 'kyc', filename);
    if (fs.existsSync(legacyPath) && fs.lstatSync(legacyPath).isFile()) {
        return res.sendFile(legacyPath);
    }

    // 2. Scan company-isolated folders
    if (fs.existsSync(uploadsBase)) {
        const dirs = fs.readdirSync(uploadsBase);
        for (const dir of dirs) {
            if (dir.startsWith('company_')) {
                const filePath = path.join(uploadsBase, dir, 'kyc', filename);
                if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
                    return res.sendFile(filePath);
                }
            }
        }
    }
    next();
});

// Task attachments (and legacy top-level files) are NOT public: they were previously
// downloadable unauthenticated with guessable names, and the company-folder scan let any
// caller read another tenant's files. Now require auth and scope the scan to the caller's
// own company (super_admin may access any). No frontend renders these via <img>/<a>, so
// gating them here breaks nothing.
app.get('/uploads/:filename', authenticateToken, (req, res, next) => {
    const filename = req.params.filename;
    if (filename.includes('/') || filename.includes('\\')) {
        return next();
    }

    const uploadsBase = path.join(__dirname, '../uploads');
    const isSuperAdmin = req.user && req.user.role_name === 'super_admin';
    const userCompanyId = req.user ? req.user.company_id : null;

    // 1. Legacy top-level file (backwards compatibility, now authenticated)
    const legacyPath = path.join(uploadsBase, filename);
    if (fs.existsSync(legacyPath) && fs.lstatSync(legacyPath).isFile()) {
        return res.sendFile(legacyPath);
    }

    // 2. Task attachments in company-isolated folders — only the caller's own company.
    if (fs.existsSync(uploadsBase)) {
        const dirs = fs.readdirSync(uploadsBase);
        for (const dir of dirs) {
            if (!dir.startsWith('company_')) continue;
            if (!isSuperAdmin && dir !== `company_${userCompanyId}`) continue;
            const filePath = path.join(uploadsBase, dir, 'tasks', filename);
            if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
                return res.sendFile(filePath);
            }
        }
    }
    next();
});

// 3. Public static assets ONLY. The previous blanket express.static('/uploads') exposed
// every file under uploads/ (profile_photos, per-company kyc/tasks folders, arbitrary
// paths). Serve just the genuinely public subtrees; KYC is served by the dedicated route
// above, task attachments by the authenticated route above.
app.use('/uploads/branding', express.static(path.join(__dirname, '../uploads/branding')));
app.use('/uploads/tenants', express.static(path.join(__dirname, '../uploads/tenants')));

// 4. CORS Setup and allowed origins
const allowedOrigins = [
    'https://myfasthr.com',
    'https://www.myfasthr.com',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost',
    'capacitor://localhost',
    'app://localhost'
];

if (process.env.FRONTEND_URL) {
    const customOrigin = process.env.FRONTEND_URL.replace(/\/$/, '');
    if (!allowedOrigins.includes(customOrigin)) {
        allowedOrigins.push(customOrigin);
    }
}

app.use(cors((req, callback) => {
    const origin = req.header('Origin');

    // NOTE: we intentionally do NOT trust an Origin-matches-Host ("same origin") check here.
    // Both the Origin and Host headers are fully attacker-controlled on a cross-site request,
    // so comparing them would let any site have its origin reflected back with credentials.
    // Allow only the explicit allowlist (+ private LAN IPs for on-prem/biometric access).
    const isLocalIP = origin && (
        origin.startsWith('http://192.168.') ||
        origin.startsWith('http://10.') ||
        origin.startsWith('http://172.16.') ||
        origin.startsWith('http://172.17.') ||
        origin.startsWith('http://172.18.') ||
        origin.startsWith('http://172.19.') ||
        origin.startsWith('http://172.20.') ||
        origin.startsWith('http://172.21.') ||
        origin.startsWith('http://172.22.') ||
        origin.startsWith('http://172.23.') ||
        origin.startsWith('http://172.24.') ||
        origin.startsWith('http://172.25.') ||
        origin.startsWith('http://172.26.') ||
        origin.startsWith('http://172.27.') ||
        origin.startsWith('http://172.28.') ||
        origin.startsWith('http://172.29.') ||
        origin.startsWith('http://172.30.') ||
        origin.startsWith('http://172.31.')
    );

    const isAllowed = !origin || allowedOrigins.includes(origin) || isLocalIP;

    if (isAllowed) {
        callback(null, {
            origin: origin || true,
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            // Added biometric machine headers: ocp-apim-subscription-key and x-api-key
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-Delete-Security-Key', 'ocp-apim-subscription-key', 'Ocp-Apim-Subscription-Key', 'x-api-key', 'X-Api-Key']
        });
    } else {
        console.warn(`>>> [CORS BLOCKED]: Unauthorized origin attempt: ${origin}`);
        callback(null, {
            origin: false, // Return origin: false instead of throwing an Error to prevent server-side 500 crash
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-Delete-Security-Key', 'ocp-apim-subscription-key', 'Ocp-Apim-Subscription-Key', 'x-api-key', 'X-Api-Key']
        });
    }
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(require('./middlewares/errorResponseSanitizer'));

// Rate Limiting - Increased for dashboard stability
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5000, // Increased limit to prevent polling/refresh blocking
    message: { message: 'Too many requests from this IP, please try again after 15 minutes' }
});
app.use(limiter);

// Global Request Logger. Logs req.path, never req.url — the query string can
// carry a biometric api_key (see /Device/SaveDevice and /api/attendance/machine-log,
// plus flexibleAuth in machineRoutes.js), and req.url would write it to disk.
app.use((req, res, next) => {
    console.log(`>>> [NET]: ${req.method} ${req.path}`);
    next();
});

const deleteSecurityGuard = require('./middlewares/deleteSecurityMiddleware');
app.use(deleteSecurityGuard);

// Emergency system freeze middleware to intercept write requests
app.use(async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
        try {
            // Biometric machine routes always bypass system freeze
            const isBiometricRoute = req.path === '/Device/SaveDevice' || req.path.startsWith('/api/v1/machine');
            if (isBiometricRoute) return next();

            const freezeRecord = await db.centralDb('global_settings').where({ key: 'system_freeze' }).first();
            if (freezeRecord && freezeRecord.value === 'true') {
                let token = null;
                const authHeader = req.headers.authorization;
                if (authHeader && authHeader.startsWith('Bearer ')) {
                    token = authHeader.split(' ')[1];
                }

                let isSuperAdmin = false;
                if (token) {
                    if (token === 'test.super.token' && process.env.NODE_ENV !== 'production') {
                        isSuperAdmin = true;
                    } else if (!token.startsWith('test.')) {
                        const jwt = require('jsonwebtoken');
                        try {
                            const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
                            if (decoded.role_name === 'super_admin') {
                                isSuperAdmin = true;
                            }
                        } catch (err) {
                            // Ignore decoding error
                        }
                    }
                }

                const isAuthRoute = req.path.startsWith('/api/auth');
                const isFreezeToggleRoute = req.path === '/api/admin/system/freeze';

                if (!isSuperAdmin && !isAuthRoute && !isFreezeToggleRoute) {
                    return res.status(403).json({ message: 'System under emergency freeze. All modifications are suspended.' });
                }
            }
        } catch (e) {
            console.error('System freeze middleware check error:', e);
        }
    }
    next();
});

const categoryRoutes = require('./routes/categoryRoutes');

// Routes
const machineRoutes = require('./routes/machineRoutes');
app.use('/api/v1/machine', machineRoutes);

// Biometric vendor endpoint mapping (ZKTeco / Compatible machines)
app.post('/Device/SaveDevice', async (req, res) => {
    try {
        console.log('>>> [BIOMETRIC-MACHINE-HIT]: POST /Device/SaveDevice | IP:', req.ip);

        // Sanitize sensitive values for logging
        const logHeaders = { ...req.headers };
        ['x-api-key', 'ocp-apim-subscription-key', 'authorization'].forEach(h => {
            if (logHeaders[h]) logHeaders[h] = '***REDACTED***';
            if (logHeaders[h.toLowerCase()]) logHeaders[h.toLowerCase()] = '***REDACTED***';
        });
        const logBody = { ...req.body };
        if (logBody.api_key) logBody.api_key = '***REDACTED***';
        
        console.log('>>> [BIOMETRIC-MACHINE-HIT] Headers:', logHeaders);
        console.log('>>> [BIOMETRIC-MACHINE-HIT] Body:', logBody);

        // Accept ocp-apim-subscription-key (machine standard) OR x-api-key OR query param
        const apiKey = req.headers['ocp-apim-subscription-key']
            || req.headers['Ocp-Apim-Subscription-Key']
            || req.headers['x-api-key']
            || req.headers['X-Api-Key']
            || req.query.api_key
            || req.body?.api_key;

        const transId = req.headers['trans_id'] || req.headers['trans-id'] || req.query.trans_id || req.body?.trans_id;

        if (!apiKey) {
            console.warn('>>> [BIOMETRIC-MACHINE]: Missing subscription key from IP:', req.ip);
            res.setHeader('response_code', 'ERROR_UNAUTHORIZED');
            if (transId) res.setHeader('trans_id', transId);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', '0');
            return res.status(401).end();
        }

        // Extract device serial - try multiple field names used by different machines
        const deviceSerial = req.body.deviceSerialno
            || req.body.deviceID
            || req.body.device_serial
            || req.body.DeviceSN
            || req.body.serialno;

        if (!deviceSerial) {
            console.warn('>>> [BIOMETRIC-MACHINE]: Missing device serial in payload.');
            res.setHeader('response_code', 'ERROR_INVALID_SERIAL');
            if (transId) res.setHeader('trans_id', transId);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', '0');
            return res.status(400).end();
        }

        // Extract employee ID - try multiple field names
        const employeeID = req.body.employeeID
            || req.body.employee_id
            || req.body.EnrollNumber
            || req.body.enrollNumber;

        if (!employeeID) {
            console.warn('>>> [BIOMETRIC-MACHINE]: Missing employeeID in payload.');
            res.setHeader('response_code', 'ERROR_INVALID_USER_ID');
            if (transId) res.setHeader('trans_id', transId);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', '0');
            return res.status(400).end();
        }

        // Extract date and time - try multiple formats
        const dateStr = req.body.date || req.body.Date;
        const timeStr = req.body.time || req.body.Time;

        if (!dateStr || !timeStr) {
            console.warn('>>> [BIOMETRIC-MACHINE]: Missing date or time in payload.');
            res.setHeader('response_code', 'ERROR_INVALID_IO_TIME');
            if (transId) res.setHeader('trans_id', transId);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', '0');
            return res.status(400).end();
        }

        // Skip failed punches if machine sends PunchStatus (could be 'success', 'True', or true)
        const punchStatus = req.body.PunchStatus || req.body.punchStatus || req.body.punch_status;
        if (punchStatus !== undefined && punchStatus !== null) {
            const statusStr = String(punchStatus).toLowerCase().trim();
            const isSuccess = statusStr === 'success' || statusStr === 'true' || statusStr === '1';
            if (!isSuccess) {
                console.warn('>>> [BIOMETRIC-MACHINE]: Skipping punch with status:', punchStatus);
                res.setHeader('response_code', 'OK');
                if (transId) res.setHeader('trans_id', transId);
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Content-Length', '0');
                return res.status(200).end();
            }
        }

        // Lookup device by serial
        let device = await db('biometric_devices').where({ device_serial: deviceSerial }).first();

        if (!device) {
            if (isMasterKey(apiKey)) {
                console.warn(`>>> [BIOMETRIC-MACHINE]: Device ${deviceSerial} not registered. Master key used - attempting auto-registration.`);
                const firstCompany = await db('companies').orderBy('id', 'asc').first();
                if (firstCompany) {
                    const crypto = require('crypto');
                    const newApiKey = `mfhr_device_live_${crypto.randomBytes(32).toString('hex')}`;
                    const [newDeviceId] = await db('biometric_devices').insert({
                        company_id: firstCompany.id,
                        device_name: `Auto-Registered Device (${deviceSerial})`,
                        device_serial: deviceSerial,
                        ip_address: req.ip,
                        port: 80,
                        status: 'online',
                        api_key: newApiKey,
                        last_ping_at: db.fn.now()
                    });
                    device = await db('biometric_devices').where({ id: newDeviceId }).first();
                } else {
                    res.setHeader('response_code', 'ERROR_DB_ACCESS');
                    if (transId) res.setHeader('trans_id', transId);
                    res.setHeader('Content-Type', 'application/octet-stream');
                    res.setHeader('Content-Length', '0');
                    return res.status(404).end();
                }
            } else {
                res.setHeader('response_code', 'ERROR_INVALID_SERIAL');
                if (transId) res.setHeader('trans_id', transId);
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Content-Length', '0');
                return res.status(404).end();
            }
        }

        // Validate API key
        const configuredSubKey = process.env.BIOMETRIC_SUBSCRIPTION_KEY;
        const isValidKey = isMasterKey(apiKey) || (apiKey === device.api_key) || (!!configuredSubKey && apiKey === configuredSubKey);
        if (!isValidKey) {
            console.warn(`>>> [BIOMETRIC-MACHINE]: Invalid key for device ${deviceSerial}.`);
            res.setHeader('response_code', 'ERROR_UNAUTHORIZED');
            if (transId) res.setHeader('trans_id', transId);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', '0');
            return res.status(401).end();
        }

        // Build punch object
        const punch = {
            employee_code: String(employeeID).trim(),
            timestamp: `${dateStr} ${timeStr}`
        };

        console.log(`>>> [BIOMETRIC-MACHINE]: Processing punch for employee '${punch.employee_code}' at '${punch.timestamp}' on device '${deviceSerial}' (company: ${device.company_id})`);

        const machineAttendanceService = require('./services/machineAttendanceService');
        const result = await machineAttendanceService.processPunch(device.company_id, device.device_serial, punch);

        // Update device online status
        await db('biometric_devices')
            .where({ id: device.id })
            .update({
                status: 'online',
                last_ping_at: db.fn.now()
            });

        console.log(`>>> [BIOMETRIC-MACHINE]: Punch result for employee '${punch.employee_code}':`, result);

        if (result.status === 'failed') {
            res.setHeader('response_code', 'ERROR_FAILED');
            if (transId) res.setHeader('trans_id', transId);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', '0');
            return res.status(400).end();
        }

        // Success ACK response
        res.setHeader('response_code', 'OK');
        if (transId) res.setHeader('trans_id', transId);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', '0');
        res.status(200).end();

    } catch (err) {
        console.error('[BIOMETRIC-VENDOR-PUSH-ERROR]:', { code: err.code, errno: err.errno });
        res.setHeader('response_code', 'ERROR_DB_ACCESS');
        const transId = req.headers['trans_id'] || req.headers['trans-id'] || req.query.trans_id || req.body?.trans_id;
        if (transId) res.setHeader('trans_id', transId);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', '0');
        res.status(500).end();
    }
});

// Alias: /Device/ and /Device also forward to SaveDevice handler
// (TimeWatch machine URL shows: http://myfasthr.com/Device/ - missing SaveDevice)
app.post(['/Device', '/Device/'], (req, res) => {
    console.log(`>>> [BIOMETRIC-MACHINE]: ${req.path} hit - treating as /Device/SaveDevice`);
    // Forward to the same SaveDevice logic by rewriting the URL and re-dispatching.
    // Carry the query string across: on Express 5 req.query is a lazy getter derived from
    // req.url, so a bare rewrite silently drops it. SaveDevice accepts the biometric key
    // as req.query.api_key, so a device pointed at /Device?api_key=... was failing auth.
    const queryStart = req.url.indexOf('?');
    req.url = '/Device/SaveDevice' + (queryStart === -1 ? '' : req.url.slice(queryStart));
    app.handle(req, res);
});

app.use('/api/auth', authRoutes);

const employeeController = require('./controllers/employeeController');

// High Priority Onboarding Token Route
app.post('/api/employees/:id/generate-token', authenticateToken, tenantFilter, tenantGuard, employeeController.generateToken);

// Public Branding Route
const brandingController = require('./controllers/brandingController');
app.get('/api/public/branding', brandingController.getPublicBranding);
app.get('/api/public/branding/manifest.json', (req, res) => brandingController.getPublicManifest(req, res));
app.get('/manifest.json', (req, res) => brandingController.getPublicManifest(req, res));

// Public Case Studies Route
app.get('/api/public/case-studies', async (req, res) => {
    try {
        const studies = await db('case_studies').select('*').orderBy('id', 'desc');
        const parsedStudies = studies.map(s => {
            try {
                return {
                    ...s,
                    metrics: s.metrics ? JSON.parse(s.metrics) : []
                };
            } catch (e) {
                return { ...s, metrics: [] };
            }
        });
        res.json(parsedStudies);
    } catch (err) {
        console.error('Failed to get public case studies:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// Public Book Demo Route to Register Trial Company (so it displays on Super Admin Dashboard)
app.post('/api/public/book-demo', async (req, res) => {
    try {
        const { name, email, headcount, selectedModules, guide, selectedDate, selectedTime } = req.body;
        if (!name || !email) {
            return res.status(400).json({ message: 'Company name and email are required.' });
        }

        // Generate unique slug
        const baseSlug = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');

        let uniqueSlug = baseSlug || `company-${Date.now()}`;
        let suffix = 1;
        while (true) {
            const existing = await db('companies').where({ slug: uniqueSlug }).first();
            if (!existing) break;
            uniqueSlug = `${baseSlug}-${suffix++}`;
        }

        // Insert trial company so it appears on Super Admin Dashboard as Recent Signup
        const [companyId] = await db('companies').insert({
            name,
            email,
            slug: uniqueSlug,
            subscription_status: 'trial',
            settings: JSON.stringify({ theme: 'light', currency: 'INR' }),
            created_at: db.fn.now(),
            updated_at: db.fn.now()
        });

        // Initialize tenant DB schemas
        const { initTenantDb } = require('./config/db');
        await initTenantDb(companyId);

        // Raise support ticket for Super Admin review
        await db('tickets').insert({
            company_id: companyId,
            employee_id: 0, // Indicates a guest booking request
            title: `Demo Booking: ${name}`,
            description: `A new demo booking request has been submitted by ${name} (${email}).

Modules Interested:
${selectedModules && selectedModules.length > 0 ? selectedModules.map(m => `- ${m}`).join('\n') : '- None selected'}

Expected Team Size:
${headcount || 'Not specified'}

Assigned Specialist:
${guide || 'Not specified'}

Scheduled Slot:
${selectedDate || 'Not specified'} at ${selectedTime || 'Not specified'}`,
            category: 'Platform',
            priority: 'Medium',
            status: 'Open',
            created_at: db.fn.now(),
            updated_at: db.fn.now()
        });

        res.status(201).json({ success: true, companyId });
    } catch (err) {
        console.error('Failed public book-demo registration:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// Public Onboarding Routes (No Auth Required)
// Public Onboarding Routes (No Auth Required)
app.get('/api/public/onboarding/:token', employeeController.getOnboardingProfile);
app.patch('/api/public/onboarding/:token', employeeController.submitOnboarding);
app.post('/api/public/onboarding/:token/confirm', employeeController.submitFinalOnboarding);
app.post('/api/public/onboarding/:token/finalize', employeeController.finalizeSection);
app.delete('/api/public/onboarding/:token/education/:id', employeeController.deleteEducation);
app.delete('/api/public/onboarding/:token/course/:id', employeeController.deleteCourse);
app.delete('/api/public/onboarding/:token/document/:id', employeeController.deleteDocument);

const { upload } = require('./services/documentService');
app.post('/api/public/onboarding/:token/upload', upload.single('file'), employeeController.publicUploadDocument);

// Public Biometric Log Route (Bypasses JWT authentication token)
const attendanceService = require('./services/attendanceService');
app.get('/api/attendance/machine-log', (req, res) => {
    res.json({ status: 'online', message: 'MyFastHR Biometric Sync Webhook is active. Please use POST request to push logs.' });
});
app.post('/api/attendance/machine-log', async (req, res) => {
    try {
        const apiKey = req.headers['x-api-key'] || req.query.api_key || req.body.api_key;

        if (!isMasterKey(apiKey)) {
            console.warn('>>> [BIOMETRIC]: Unauthorized machine punch attempt. Invalid API Key.');
            return res.status(401).json({ message: 'Unauthorized. Invalid or missing API key.' });
        }

        const result = await attendanceService.processMachineLog(req.body);
        res.json(result);
    } catch (err) {
        console.error('>>> [BIOMETRIC]: Webhook processing failed:', err.message);
        res.status(400).json({ message: err.message });
    }
});

app.use('/api/document-categories', authenticateToken, tenantFilter, tenantGuard, categoryRoutes);

const kudosRoutes = require('./routes/kudosRoutes');

// Apply Tenancy Guards to all internal operations
app.use('/api/kudos', authenticateToken, tenantFilter, tenantGuard, kudosRoutes);
app.use('/api/attendance', authenticateToken, tenantFilter, tenantGuard, attendanceRoutes);
app.use('/api/leaves', authenticateToken, tenantFilter, tenantGuard, leaveRoutes);
app.use('/api/regularizations', authenticateToken, tenantFilter, tenantGuard, regularizationRoutes);
app.use('/api/employees', authenticateToken, tenantFilter, tenantGuard, employeeRoutes);
app.use('/api/admin', authenticateToken, adminRoutes); // Admin routes often global or specific
app.use('/api/org', authenticateToken, tenantFilter, tenantGuard, orgRoutes);
app.use('/api/documents', authenticateToken, tenantFilter, tenantGuard, documentRoutes);
app.use('/api/notifications', authenticateToken, tenantFilter, tenantGuard, notificationRoutes);
app.use('/api/compliance', authenticateToken, tenantFilter, tenantGuard, complianceRoutes);
app.use('/api/payroll', authenticateToken, tenantFilter, tenantGuard, payrollRoutes);
app.use('/api/analytics', authenticateToken, tenantFilter, tenantGuard, analyticsRoutes);
app.use('/api/settings', authenticateToken, tenantFilter, tenantGuard, settingsRoutes);
app.use('/api/tasks', authenticateToken, tenantFilter, tenantGuard, taskRoutes);
app.use('/api/profile', authenticateToken, profileRoutes);
app.use('/api/announcements', authenticateToken, announcementsRoutes);

const ticketRoutes = require('./routes/ticketRoutes');
app.use('/api/tickets', authenticateToken, tenantFilter, tenantGuard, ticketRoutes);

// Base API route
app.get('/api', (req, res) => res.send('MyFastHR SaaS API is running...'));

// Catch-all for React Router (Using regex to avoid Express 5 path-to-regexp crash)
app.get(/(.*)/, (req, res) => {
    // Prevent non-existent assets, APIs, or uploads from returning index.html (returns 404 instead)
    if (req.path.startsWith('/assets/') || req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
        return res.status(404).send('Not Found');
    }
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        message: 'Internal Server Error',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

module.exports = app;
