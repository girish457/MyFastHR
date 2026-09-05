#!/usr/bin/env node
/**
 * Reports employees whose shift roster is broken, and prints the SQL that would fix it.
 *
 * assignShift() only ever appended to employee_shift_assignments until this branch, so an
 * admin reassigning someone left the old open-ended row in place. Which shift then "wins" is
 * whichever row has the highest id - not what the person works. Measured at Hotel Highway
 * King on 2026-08-31: 169 of 221 active employees carried more than one currently-active
 * open-ended assignment, up to 11 each, and 25 who had punched in the previous three days
 * carried none at all and silently fell back to employees.shift_id.
 *
 * That data is the root cause of the punches this engine still cannot place: a punch 9h
 * outside the resolved window is correctly skipped, the code is right and the roster is
 * wrong. The engine fix stops NEW overlaps being created; it cannot repair the existing ones.
 *
 * THIS SCRIPT NEVER WRITES. It prints what it would do and exits. Repairing the rows changes
 * computed attendance - and therefore month-end payroll - for everyone it touches, so the
 * statements below are for a human to review, run against a restorable backup, and own.
 *
 * Usage:
 *   node scripts/auditShiftAssignments.js                # every company
 *   node scripts/auditShiftAssignments.js --company 27   # one tenant
 *   node scripts/auditShiftAssignments.js --company 27 --sql   # also emit the repair SQL
 */

const db = require('../src/config/db');

const args = process.argv.slice(2);
const companyArgIndex = args.indexOf('--company');
const COMPANY_ID = companyArgIndex !== -1 ? parseInt(args[companyArgIndex + 1], 10) : null;
const EMIT_SQL = args.includes('--sql');

const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });

function scopeCompany(query, column = 'company_id') {
    return COMPANY_ID ? query.where(column, COMPANY_ID) : query;
}

async function main() {
    console.log(`Shift assignment audit  as of ${today} IST  scope=${COMPANY_ID ? `company ${COMPANY_ID}` : 'all companies'}`);
    console.log('This script does not modify anything.\n');

    const active = await scopeCompany(
        db('employees').whereIn('status', ['active']).orWhere('status', null)
    ).select('id', 'company_id', 'employee_id_number', 'first_name', 'last_name', 'shift_id');

    const scoped = COMPANY_ID ? active.filter(e => e.company_id === COMPANY_ID) : active;
    const employeeIds = scoped.map(e => e.id);
    if (employeeIds.length === 0) {
        console.log('No active employees in scope.');
        return;
    }

    const assignments = await db('employee_shift_assignments as esa')
        .join('shifts as s', 'esa.shift_id', 's.id')
        .whereIn('esa.employee_id', employeeIds)
        .where('esa.from_date', '<=', today)
        .andWhere(qb => qb.where('esa.to_date', '>=', today).orWhereNull('esa.to_date'))
        .select('esa.id', 'esa.employee_id', 'esa.shift_id', 'esa.from_date', 'esa.to_date',
            's.name as shift_name', 's.start_time', 's.end_time');

    const byEmployee = new Map();
    for (const a of assignments) {
        if (!byEmployee.has(a.employee_id)) byEmployee.set(a.employee_id, []);
        byEmployee.get(a.employee_id).push(a);
    }

    const overlapping = [];
    const unassigned = [];
    for (const emp of scoped) {
        const rows = (byEmployee.get(emp.id) || []).sort((x, y) => y.id - x.id);
        if (rows.length === 0) unassigned.push(emp);
        else if (rows.length > 1) overlapping.push({ emp, rows });
    }

    const histogram = new Map();
    for (const emp of scoped) {
        const n = (byEmployee.get(emp.id) || []).length;
        histogram.set(n, (histogram.get(n) || 0) + 1);
    }

    console.log('Active assignments per employee');
    for (const n of [...histogram.keys()].sort((a, b) => a - b)) {
        console.log(`  ${String(n).padStart(2)} assignment(s): ${histogram.get(n)} employees${n === 1 ? '  (correct)' : ''}`);
    }

    console.log(`\n${overlapping.length} employees with overlapping active assignments`);
    for (const { emp, rows } of overlapping.slice(0, 40)) {
        const winner = rows[0];
        console.log(`  ${emp.employee_id_number} ${(emp.first_name || '').slice(0, 14).padEnd(14)} resolves to "${winner.shift_name.trim()}" (row ${winner.id}), also holds ${rows.slice(1).map(r => `${r.id}:${r.shift_name.trim()}`).join(', ')}`);
    }
    if (overlapping.length > 40) console.log(`  ... and ${overlapping.length - 40} more`);

    console.log(`\n${unassigned.length} employees with NO active assignment (falling back to employees.shift_id)`);
    for (const emp of unassigned.slice(0, 40)) {
        console.log(`  ${emp.employee_id_number} ${(emp.first_name || '').slice(0, 14).padEnd(14)} fallback shift_id=${emp.shift_id ?? 'NULL'}`);
    }
    if (unassigned.length > 40) console.log(`  ... and ${unassigned.length - 40} more`);

    if (!EMIT_SQL) {
        console.log('\nRe-run with --sql to print the statements that would close the stale rows.');
        return;
    }

    console.log('\n-- Review every line before running. Take a restorable backup first.');
    console.log('-- Closing a stale row changes which shift the engine resolves for past days,');
    console.log('-- which changes the muster and therefore payroll for those days.');
    console.log(`-- Generated ${new Date().toISOString()} for ${COMPANY_ID ? `company ${COMPANY_ID}` : 'all companies'}.`);
    for (const { emp, rows } of overlapping) {
        const keep = rows[0];
        const stale = rows.slice(1).map(r => r.id);
        console.log(`-- ${emp.employee_id_number} ${emp.first_name || ''}: keeping row ${keep.id} ("${keep.shift_name.trim()}")`);
        console.log(`UPDATE employee_shift_assignments SET to_date = DATE_SUB('${today}', INTERVAL 1 DAY) WHERE id IN (${stale.join(', ')}) AND to_date IS NULL;`);
    }
    if (unassigned.length) {
        console.log(`\n-- ${unassigned.length} employees need an assignment created by an admin who knows the roster.`);
        console.log('-- Do not guess these from punch history in SQL: pick them in the Shift Override screen,');
        console.log('-- with from_date set to tomorrow so already-computed days are not rewritten.');
    }
}

main()
    .catch(error => {
        console.error('Audit failed:', error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await db.destroy();
    });
