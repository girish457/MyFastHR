#!/usr/bin/env node
/**
 * Punch-engine regression harness.
 *
 * Replays synthetic punch sequences through the REAL machineAttendanceService.processPunch()
 * and asserts the resulting attendance rows, statuses and regularization requests. It exists
 * because every attendance fix in this repo so far has been verified with a throwaway replay
 * script that was then discarded, so the next fix started from zero and the previous fix had
 * no guard against being undone. The scenarios below encode the bugs we have actually shipped
 * and actually fixed; if you change the engine, this is the thing that tells you which of
 * them you just brought back.
 *
 * SAFETY: refuses to run against a database whose name is not clearly a scratch database.
 * It creates and drops its own fixture rows, so pointing it at real data would destroy them.
 *
 * Usage:
 *   npm run punch:replay                 (from backend/, uses myfasthr_replay by default)
 *   DB_NAME=my_scratch_db npm run punch:replay
 *
 * Set up the scratch database once (schema only, no data):
 *   docker exec myfasthr-mysql mysqldump -uroot --no-data --no-tablespaces myfasthr_db \
 *     > /tmp/schema.sql
 *   docker exec myfasthr-mysql mysql -uroot -e "DROP DATABASE IF EXISTS myfasthr_replay; \
 *     CREATE DATABASE myfasthr_replay"
 *   docker exec -i myfasthr-mysql mysql -uroot myfasthr_replay < /tmp/schema.sql
 *
 * TZ matters. Production runs UTC while all attendance logic is written against
 * Asia/Kolkata, and several past bugs only reproduced under one of the two. The npm script
 * pins TZ=Etc/UTC to match production; run it a second time with TZ=Asia/Kolkata when you
 * touch date handling, and expect identical results.
 */

const DB_NAME = process.env.DB_NAME || 'myfasthr_replay';

// Guard before anything requires the knex instance: config/db.js reads the env at import
// time, so a late check would already have connected to the wrong database.
if (!/(_replay|_test|_verify|_scratch)$/.test(DB_NAME)) {
    console.error(
        `Refusing to run against database "${DB_NAME}".\n` +
        'This harness inserts and deletes fixture rows. Point DB_NAME at a scratch database\n' +
        'whose name ends in _replay, _test, _verify or _scratch. See the header of this file.'
    );
    process.exit(2);
}
process.env.DB_NAME = DB_NAME;

const db = require('../src/config/db');
const machineAttendanceService = require('../src/services/machineAttendanceService');

// Fixture identifiers, chosen high enough not to collide with anything a schema dump carries.
const CO = 990001;
const DEVICE = 'REPLAY-DEVICE-0001';
const SHIFT_DAY = 990010;      // 06:00-16:00, the shift most Highway King staff sit on
const SHIFT_NIGHT = 990011;    // 16:00-02:00, crosses midnight
const SHIFT_FLEXI = 990012;
const SHIFT_SPLIT = 990013;    // 4-punch
const SHIFT_LATE = 990014;     // 12:00-21:00, starts later than SHIFT_DAY and ends later
const SHIFT_SPLIT_LATE = 990015; // 4-punch, 09:00-13:00 / 19:00-23:30
// 20:00-05:00 with a 4h terminate_hour, so its checkout window reaches 09:00 the next
// morning - far enough to swallow an ordinary day-shift arrival, which is the point.
const SHIFT_NIGHT_LONG = 990016;
// The ordinary 09:00-18:00 office shift. Its 09:00 start sits inside the 00:00-09:59 window
// the night-shift lookback watches, so an arrival on it is exactly the punch a night
// rotation can steal onto the previous day.
const SHIFT_GENERAL = 990017;

let employeeSeq = 990100;

const results = [];
let failures = 0;

function check(scenario, label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    results.push({ scenario, label, ok, actual, expected });
}

async function resetFixtures() {
    // Order matters only for readability; there are no FK constraints on these tables.
    await db('attendance').where({ company_id: CO }).del();
    await db('biometric_raw_logs').where({ company_id: CO }).del();
    await db('attendance_entry_requests').where({ company_id: CO }).del();
    await db('employee_shift_assignments').where({ company_id: CO }).del();
    await db('employees').where({ company_id: CO }).del();
    await db('employee_biometric_mapping').where({ company_id: CO }).del();
    await db('working_rules').where({ company_id: CO }).del();
    await db('shifts').where({ company_id: CO }).del();
    await db('companies').where({ id: CO }).del();
}

async function seedCommon() {
    // companies.email and employees.first_name/last_name are NOT NULL with no default in the
    // real schema, so every fixture must supply them even though nothing here reads them.
    await db('companies').insert({ id: CO, name: 'Replay Harness Co', email: 'replay@harness.invalid' });
    await db('working_rules').insert({
        company_id: CO, shift_start: '09:00', shift_end: '18:00', grace_period: 15, half_day_hours: 4
    });

    const baseShift = {
        company_id: CO, grace_period: 15, grace_count_limit: 30, is_flexi: 0, min_hours: 10.0,
        total_punches_required: 2, session1_in_margin: 45, session1_out_margin: 5, terminate_hour: 2
    };
    await db('shifts').insert([
        { ...baseShift, id: SHIFT_DAY, name: 'Replay 06-16', start_time: '06:00', end_time: '16:00' },
        { ...baseShift, id: SHIFT_NIGHT, name: 'Replay 16-02', start_time: '16:00', end_time: '02:00' },
        { ...baseShift, id: SHIFT_FLEXI, name: 'Replay Flexi', start_time: '00:00', end_time: '23:59', is_flexi: 1, session1_in_margin: 0, session1_out_margin: 0, terminate_hour: null },
        { ...baseShift, id: SHIFT_SPLIT, name: 'Replay Split', start_time: '07:00', end_time: '12:00', total_punches_required: 4, session2_start_time: '18:00', session2_end_time: '23:00', session2_in_margin: 30, session2_out_margin: 5 },
        { ...baseShift, id: SHIFT_LATE, name: 'Replay 12-21', start_time: '12:00', end_time: '21:00' },
        { ...baseShift, id: SHIFT_SPLIT_LATE, name: 'Replay Split Late', start_time: '09:00', end_time: '13:00', total_punches_required: 4, session2_start_time: '19:00', session2_end_time: '23:30', session2_in_margin: 30, session2_out_margin: 5 },
        { ...baseShift, id: SHIFT_NIGHT_LONG, name: 'Replay 20-05', start_time: '20:00', end_time: '05:00', terminate_hour: 4 },
        { ...baseShift, id: SHIFT_GENERAL, name: 'Replay 09-18', start_time: '09:00', end_time: '18:00' }
    ]);
}

/**
 * Creates one employee. `assignedShift` is what the roster SAYS they work - deliberately
 * separable from what the scenario then makes them actually punch, because that mismatch is
 * the single most common root cause in this system.
 */
async function makeEmployee(assignedShift, { fromDate = '2026-01-01', assign = true } = {}) {
    const id = employeeSeq++;
    const code = String(id);
    await db('employees').insert({
        id, company_id: CO, employee_id_number: code, first_name: `Emp${id}`, last_name: 'Replay',
        email: `emp${id}@harness.invalid`, status: 'active', shift_id: assignedShift
    });
    if (assign) {
        await db('employee_shift_assignments').insert({
            company_id: CO, employee_id: id, shift_id: assignedShift, from_date: fromDate, to_date: null
        });
    }
    return { id, code };
}

/**
 * Reproduces what attendanceService.assignShift does for a PERMANENT reassignment - close the
 * running open-ended assignment the day before the new one starts, drop any open assignment
 * that starts on or after it, then insert the new one. Written out here rather than calling
 * the service so this stays a pure punch-engine harness with no HTTP/auth surface, but it must
 * keep matching that method: an admin editing a roster mid-day is the scenario under test.
 */
async function reassign(employeeId, shiftId, fromDate) {
    const prevDay = new Date(new Date(`${fromDate}T12:00:00Z`).getTime() - 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
    await db('employee_shift_assignments')
        .where({ company_id: CO, employee_id: employeeId })
        .whereNull('to_date')
        .where('from_date', '<', fromDate)
        .update({ to_date: prevDay });
    await db('employee_shift_assignments')
        .where({ company_id: CO, employee_id: employeeId })
        .whereNull('to_date')
        .where('from_date', '>=', fromDate)
        .del();
    await db('employee_shift_assignments').insert({
        company_id: CO, employee_id: employeeId, shift_id: shiftId, from_date: fromDate, to_date: null
    });
}

const punch = (code, timestamp) => machineAttendanceService.processPunch(CO, DEVICE, { employee_code: code, timestamp });

async function rowsFor(employeeId) {
    const rows = await db('attendance').where({ employee_id: employeeId, company_id: CO }).orderBy('check_in', 'asc');
    return rows.map(r => ({
        in: String(r.check_in).slice(0, 19),
        out: r.check_out ? String(r.check_out).slice(0, 19) : null,
        status: r.status,
        source: r.punch_source,
        review: r.review_reason || null
    }));
}

/** The shift pinned to each of an employee's rows, in check-in order. */
async function shiftIdsFor(employeeId) {
    const rows = await db('attendance').where({ employee_id: employeeId, company_id: CO }).orderBy('check_in', 'asc');
    return rows.map(r => (r.shift_id === null || r.shift_id === undefined ? null : Number(r.shift_id)));
}

/** The logical day each of an employee's rows was filed under, in check-in order. */
async function logicalDatesFor(employeeId) {
    const rows = await db('attendance').where({ employee_id: employeeId, company_id: CO }).orderBy('check_in', 'asc');
    return rows.map(r => (r.logical_date ? String(r.logical_date).slice(0, 10) : null));
}

async function requestsFor(employeeId) {
    const rows = await db('attendance_entry_requests').where({ employee_id: employeeId, company_id: CO }).orderBy('id', 'asc');
    return rows.map(r => ({ type: r.request_type, date: String(r.date).slice(0, 10), status: r.status }));
}

// ---------------------------------------------------------------------------- scenarios

/**
 * The defect that destroys real checkouts. A night worker sitting on a day-shift assignment:
 * arrives 16:00, leaves 02:00. Termination for the assigned 06:00-16:00 shift is 18:00, so
 * the 02:00 exit used to be re-read as a next-day check-in and then discarded by the
 * in-margin guard, leaving the row open forever and the punch only in biometric_raw_logs.
 * Employee 10290 at Hotel Highway King lost his exit this way every single night.
 */
async function scenarioLateTerminationCheckout() {
    const s = 'late-termination checkout';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 16:00:00');
    const exit = await punch(e.code, '2026-09-11 02:00:00');

    check(s, 'exit is recorded as a checkout', exit.status, 'check-out');
    check(s, 'one row, closed, flagged for review', await rowsFor(e.id), [
        { in: '2026-09-10 16:00:00', out: '2026-09-11 02:00:00', status: 'present', source: 'biometric', review: 'closed_after_termination' }
    ]);
    // The arrival was ambiguous when it stood alone, so a missing_in was raised. The exit
    // answered the question, so the manager must not be left holding the request.
    check(s, 'missing_in withdrawn once the day paired', await requestsFor(e.id), [
        { type: 'missing_in', date: '2026-09-10', status: 'withdrawn' }
    ]);
}

/**
 * The same guard must STILL fire for a genuinely unrelated punch. Check in Monday, never
 * check out, then arrive Tuesday morning: 22h later is not a worked shift, so Tuesday's
 * punch must open its own row rather than closing Monday's.
 */
async function scenarioStaleRowNotAbsorbed() {
    const s = 'stale row not absorbed';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 06:00:00');
    await punch(e.code, '2026-09-11 06:05:00');

    const rows = await rowsFor(e.id);
    check(s, 'two separate rows', rows.length, 2);
    check(s, 'Monday stays open', rows[0].out, null);
    check(s, 'Tuesday opens its own row', rows[1].in, '2026-09-11 06:05:00');
}

/**
 * The inverted early-out check. session1_out_margin is 5 minutes, so leaving at 15:57 on a
 * 06:00-16:00 shift is on time. Every early_out row at Hotel Highway King on Sep 1-5 2026
 * was 1-4 minutes early against that 5-minute margin.
 */
async function scenarioOutMarginIsNotEarly() {
    const s = 'out-margin is not early';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 06:00:00');
    await punch(e.code, '2026-09-10 15:57:00');

    check(s, 'present, not early_out', (await rowsFor(e.id))[0].status, 'present');
    check(s, 'no early_out request raised', await requestsFor(e.id), []);
}

/** Leaving well before the margin is still early, and still raises a request. */
async function scenarioGenuineEarlyOut() {
    const s = 'genuine early out';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 06:00:00');
    await punch(e.code, '2026-09-10 13:30:00');

    check(s, 'row is pending approval', (await rowsFor(e.id))[0].status, 'pending');
    check(s, 'early_out request on the shift day', await requestsFor(e.id), [
        { type: 'early_out', date: '2026-09-10', status: 'pending' }
    ]);
}

/**
 * The Banti case (employee 10105, 2026-09-05). A single punch at 17:00 on a 07:00-17:00
 * shift, morning punch never delivered. Direction is unknowable, so the row must be flagged
 * and the request must ask for the arrival time rather than asserting 17:00 as the arrival.
 */
async function scenarioLoneCheckoutWindowPunch() {
    const s = 'lone checkout-window punch';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 15:30:00');

    check(s, 'row flagged as unpaired', await rowsFor(e.id), [
        { in: '2026-09-10 15:30:00', out: null, status: 'pending', source: 'biometric', review: 'checkout_window_unpaired' }
    ]);
    check(s, 'missing_in raised, not late_in', await requestsFor(e.id), [
        { type: 'missing_in', date: '2026-09-10', status: 'pending' }
    ]);
}

/**
 * ...but that flagged row must still self-heal. If the 15:30 punch really was a late
 * arrival, the employee's later exit closes the row and clears the flag, with no manager
 * intervention. This is why the punch is recorded in check_in rather than check_out.
 */
async function scenarioUnpairedRowSelfHeals() {
    const s = 'unpaired row self-heals';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 15:30:00');
    await punch(e.code, '2026-09-10 23:00:00');

    const rows = await rowsFor(e.id);
    check(s, 'one row only', rows.length, 1);
    check(s, 'closed by the later punch', rows[0].out, '2026-09-10 23:00:00');
    // The ambiguity is gone. A different flag may replace it - this exit is past the
    // assigned shift's termination hour, which is worth recording - but the row must no
    // longer claim its check-in might be missing, and it must not be stuck pending.
    check(s, 'no longer flagged unpaired', rows[0].review === 'checkout_window_unpaired', false);
    check(s, 'not stranded pending', rows[0].status === 'pending', false);
    check(s, 'missing_in withdrawn', (await requestsFor(e.id)).map(r => r.status), ['withdrawn']);
}

/**
 * A rescued EARLY check-in stays flagged after the day closes. The checkout answers only
 * "did the check-in stand alone" - it says nothing about whether a punch 75 minutes before
 * the allowed window was really this person's arrival, which is the question this flag
 * exists to put in front of a human. Clearing it on checkout would retire every such flag
 * before anyone saw it, since these rows nearly always get closed later the same day.
 */
async function scenarioEarlyRescueFlagSurvivesCheckout() {
    const s = 'early rescue flag survives checkout';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 04:45:00');   // in-margin allows 05:15; rescue floor is 04:00
    await punch(e.code, '2026-09-10 16:05:00');

    const rows = await rowsFor(e.id);
    check(s, 'early punch was rescued as a check-in', rows.length, 1);
    check(s, 'flag still set after the day closes', rows[0].review, 'early_before_in_margin');
    check(s, 'day is otherwise normal', rows[0].status, 'present');
}

/** An ordinary late arrival must still raise late_in, not missing_in. */
async function scenarioOrdinaryLateArrival() {
    const s = 'ordinary late arrival';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 06:40:00');

    check(s, 'row pending, unflagged', (await rowsFor(e.id))[0].review, null);
    check(s, 'late_in raised', await requestsFor(e.id), [
        { type: 'late_in', date: '2026-09-10', status: 'pending' }
    ]);
}

/** A punch inside the grace period is simply present, with no request and no flag. */
async function scenarioOnTimeDayShift() {
    const s = 'on-time day shift';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 06:10:00');
    await punch(e.code, '2026-09-10 16:05:00');

    check(s, 'clean present row', await rowsFor(e.id), [
        { in: '2026-09-10 06:10:00', out: '2026-09-10 16:05:00', status: 'present', source: 'biometric', review: null }
    ]);
    check(s, 'no requests', await requestsFor(e.id), []);
}

/**
 * Night shift on its correct assignment: the 02:00 exit belongs to the PREVIOUS logical day
 * and must close that row rather than opening a new one.
 */
async function scenarioNightShiftCrossesMidnight() {
    const s = 'night shift crosses midnight';
    const e = await makeEmployee(SHIFT_NIGHT);
    await punch(e.code, '2026-09-10 16:05:00');
    await punch(e.code, '2026-09-11 01:55:00');

    const rows = await rowsFor(e.id);
    check(s, 'single row', rows.length, 1);
    check(s, 'closed across midnight', rows[0].out, '2026-09-11 01:55:00');
    check(s, 'logical day is the start day', String((await db('attendance').where({ employee_id: e.id }).first()).logical_date).slice(0, 10), '2026-09-10');
}

/**
 * The duplicate-row race. A device re-sending the same person's arrival seconds apart used
 * to open a row per copy, because the 2-minute dedup read state that no copy had written
 * yet. Employee 10234 got five rows for 06:04:29-06:04:51 on 2026-09-05. Fired truly
 * concurrently here, which is the only way this reproduces.
 */
async function scenarioConcurrentRetryFlood() {
    const s = 'concurrent retry flood';
    const e = await makeEmployee(SHIFT_DAY);
    await Promise.all([
        punch(e.code, '2026-09-10 06:04:29'),
        punch(e.code, '2026-09-10 06:04:39'),
        punch(e.code, '2026-09-10 06:04:43'),
        punch(e.code, '2026-09-10 06:04:46'),
        punch(e.code, '2026-09-10 06:04:51')
    ]);

    check(s, 'exactly one attendance row', (await rowsFor(e.id)).length, 1);
}

/** The identical punch delivered twice must be idempotent even under concurrency. */
async function scenarioConcurrentIdenticalPunch() {
    const s = 'concurrent identical punch';
    const e = await makeEmployee(SHIFT_DAY);
    await Promise.all([
        punch(e.code, '2026-09-10 06:05:00'),
        punch(e.code, '2026-09-10 06:05:00')
    ]);

    check(s, 'one row', (await rowsFor(e.id)).length, 1);
    check(s, 'one raw log for that timestamp', (await db('biometric_raw_logs')
        .where({ company_id: CO, employee_code: e.code, punch_time: '2026-09-10 06:05:00' })).length, 1);
}

/**
 * A rotation must not let the late-checkout rescue swallow two days at once. Night shift on
 * 2026-09-10 with no exit punch, then the employee rotates onto mornings and arrives 08:00 on
 * 09-11. The gap is 12h, which is a plausible worked span, but 08:00 is also a credible
 * arrival for the morning shift now in force - so it has to open its own row, not close the
 * stale one at 08:00 and erase the new day's check-in.
 */
async function scenarioRotationArrivalNotSwallowed() {
    const s = 'rotation arrival not swallowed';
    const e = await makeEmployee(SHIFT_NIGHT);
    await punch(e.code, '2026-09-10 20:00:00');   // night shift check-in, never closed
    // Roster moves them to mornings from 09-11 (the assignment the engine will resolve there).
    await db('employee_shift_assignments')
        .where({ company_id: CO, employee_id: e.id })
        .update({ to_date: '2026-09-10' });
    await db('employee_shift_assignments').insert({
        company_id: CO, employee_id: e.id, shift_id: SHIFT_DAY, from_date: '2026-09-11', to_date: null
    });
    await punch(e.code, '2026-09-11 08:00:00');

    const rows = await rowsFor(e.id);
    check(s, 'two rows, not one inflated row', rows.length, 2);
    check(s, 'the night row stays open rather than closing at 08:00', rows[0].out, null);
    check(s, 'the morning arrival opens its own row', rows[1].in, '2026-09-11 08:00:00');
}

/**
 * A settled day must stay settled. `activeLog` on the checkout path is routinely a CLOSED row
 * (the 2-punch fallback takes the latest row whether or not it has a check_out), so a stray
 * evening punch must not be read as that row's late checkout and rewrite a finished day into
 * a 13-hour one.
 */
async function scenarioStrayPunchDoesNotReopenSettledDay() {
    const s = 'stray punch does not reopen a settled day';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 06:00:00');
    await punch(e.code, '2026-09-10 16:05:00');
    await punch(e.code, '2026-09-10 19:00:00');   // past the 18:00 termination, row already closed

    check(s, 'checkout time untouched', await rowsFor(e.id), [
        { in: '2026-09-10 06:00:00', out: '2026-09-10 16:05:00', status: 'present', source: 'biometric', review: null }
    ]);
}

/**
 * A punch whose processing threw must remain retryable. The duplicate guard keys on the
 * timestamp, so counting a 'failed' audit row as a duplicate would poison that punch forever -
 * every device resend dismissed, the punch lost. The per-employee lock added here makes a
 * transient rollback a real possibility, so this is no longer hypothetical.
 */
async function scenarioFailedPunchStaysRetryable() {
    const s = 'failed punch stays retryable';
    const e = await makeEmployee(SHIFT_DAY);
    await db('biometric_raw_logs').insert({
        company_id: CO, device_serial: DEVICE, employee_code: e.code,
        punch_time: '2026-09-10 06:00:00', status: 'failed', error_details: 'simulated transient failure'
    });
    const retry = await punch(e.code, '2026-09-10 06:00:00');

    check(s, 'retry is processed, not dismissed', retry.status, 'check-in');
    check(s, 'the punch produced a row', (await rowsFor(e.id)).length, 1);
}

/**
 * A flexi employee with NO assignment row resolves their shift from employees.shift_id, and
 * min_hours has to come with it. It was never projected onto that object, so the checkout
 * routine fell back to a hardcoded 8h - invisible until the flexi branch started running.
 * This fixture's flexi shift is 10h, so 9h worked is a short day, not a full one.
 */
async function scenarioFlexiWithoutAssignmentUsesShiftMinHours() {
    const s = 'flexi without assignment uses its shift min_hours';
    const e = await makeEmployee(SHIFT_FLEXI, { assign: false });
    await punch(e.code, '2026-09-10 09:00:00');
    await punch(e.code, '2026-09-10 18:00:00');   // 9h against min_hours 10

    check(s, 'half-day, not present', (await rowsFor(e.id))[0].status, 'half-day');
}

/** Flexi shifts judge the day on hours worked, not on clock times. */
async function scenarioFlexiShift() {
    const s = 'flexi shift';
    const e = await makeEmployee(SHIFT_FLEXI);
    await punch(e.code, '2026-09-10 11:00:00');
    await punch(e.code, '2026-09-10 21:30:00');

    check(s, 'full flexi day is present', (await rowsFor(e.id))[0].status, 'present');
    check(s, 'no early_out request for flexi', await requestsFor(e.id), []);
}

/** Half-day on a flexi shift: over the half-day floor, under min_hours. */
async function scenarioFlexiHalfDay() {
    const s = 'flexi half day';
    const e = await makeEmployee(SHIFT_FLEXI);
    await punch(e.code, '2026-09-10 09:00:00');
    await punch(e.code, '2026-09-10 15:00:00');

    check(s, 'half-day', (await rowsFor(e.id))[0].status, 'half-day');
}

/** An employee with no shift assignment at all falls back to employees.shift_id. */
async function scenarioNoAssignmentFallback() {
    const s = 'no assignment fallback';
    const e = await makeEmployee(SHIFT_DAY, { assign: false });
    await punch(e.code, '2026-09-10 06:10:00');
    await punch(e.code, '2026-09-10 16:05:00');

    check(s, 'still produces a clean day', (await rowsFor(e.id))[0].status, 'present');
}

/** An unmapped enroll id is audited and never reaches the attendance table. */
async function scenarioUnmappedCode() {
    const s = 'unmapped code';
    const res = await punch('999999999', '2026-09-10 06:00:00');
    check(s, 'skipped', res.status, 'skipped');
    check(s, 'audited as invalid_user', (await db('biometric_raw_logs')
        .where({ company_id: CO, employee_code: '999999999' }).first()).status, 'invalid_user');
}

/** Split (4-punch) shifts still write one row per session. */
async function scenarioSplitShift() {
    const s = 'split shift';
    const e = await makeEmployee(SHIFT_SPLIT);
    await punch(e.code, '2026-09-10 07:00:00');
    await punch(e.code, '2026-09-10 12:00:00');
    await punch(e.code, '2026-09-10 18:00:00');
    await punch(e.code, '2026-09-10 23:00:00');

    const rows = await rowsFor(e.id);
    check(s, 'two rows, one per session', rows.length, 2);
    check(s, 'session 1 closed', rows[0].out, '2026-09-10 12:00:00');
    check(s, 'session 2 closed', rows[1].out, '2026-09-10 23:00:00');
}

/**
 * The defect that discards a checkout when the roster moves under an open session.
 *
 * Reproduced live twice, 2026-09-22, employee QA023: in at 09:00 on a 09:00-18:00 shift, admin
 * reassigns them to a 22:00-06:00 night shift effective the SAME day, out at 18:00 ->
 * { status: 'skipped', reason: 'Punch out prior to shift start' } and the row orphaned open
 * forever. The shift was re-resolved by date on every punch, so the checkout was judged
 * against a shift the employee had not worked. Entering a rotation mid-day is routine admin
 * work, which is why this is worth a column on the table.
 *
 * Here: day session, reassigned mid-session to a LATER-starting shift.
 */
async function scenarioMidSessionReassignLaterShift() {
    const s = 'mid-session reassignment to a later shift';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 06:00:00');
    await reassign(e.id, SHIFT_NIGHT, '2026-09-10');   // 16:00-02:00, effective mid-session
    const exit = await punch(e.code, '2026-09-10 15:57:00');

    check(s, 'the exit is recorded, not skipped', exit.status, 'check-out');
    // Judged against the 06:00-16:00 shift actually worked: 15:57 is inside its 5-minute
    // out-margin, so this is an ordinary complete day with nothing to review.
    check(s, 'closed against the ORIGINAL shift', await rowsFor(e.id), [
        { in: '2026-09-10 06:00:00', out: '2026-09-10 15:57:00', status: 'present', source: 'biometric', review: null }
    ]);
    check(s, 'the row stays pinned to the shift it opened under', await shiftIdsFor(e.id), [SHIFT_DAY]);
    check(s, 'no request raised', await requestsFor(e.id), []);
}

/**
 * The mirror case: reassigned mid-session to an EARLIER-starting shift. Nothing here would be
 * skipped even unfixed, so the assertion is about which shift the day is judged by. Leaving at
 * 19:00 is two hours early against the 12:00-21:00 shift actually worked (early_out, pending
 * approval); against the 06:00-16:00 shift the roster now claims it is a late exit past
 * termination. Only one of those is the truth about the employee's day.
 */
async function scenarioMidSessionReassignEarlierShift() {
    const s = 'mid-session reassignment to an earlier shift';
    const e = await makeEmployee(SHIFT_LATE);
    await punch(e.code, '2026-09-10 12:00:00');
    await reassign(e.id, SHIFT_DAY, '2026-09-10');   // 06:00-16:00, effective mid-session
    await punch(e.code, '2026-09-10 19:00:00');

    const rows = await rowsFor(e.id);
    check(s, 'closed by the real exit', rows[0].out, '2026-09-10 19:00:00');
    check(s, 'early against the shift worked, so pending approval', rows[0].status, 'pending');
    check(s, 'not flagged as a post-termination rescue', rows[0].review, null);
    check(s, 'early_out raised on the shift day', await requestsFor(e.id), [
        { type: 'early_out', date: '2026-09-10', status: 'pending' }
    ]);
    check(s, 'pinned to the shift it opened under', await shiftIdsFor(e.id), [SHIFT_LATE]);
}

/**
 * A night session whose assignment is rewritten while it is still open. The 16:00-02:00 shift
 * is replaced mid-session by a 06:00-16:00 one, so date-based resolution reads the 01:55 exit
 * as arriving eight hours after termination and closes the row with a review flag. Pinned, it
 * is simply an on-time night exit - and the row must still sit on the day the shift STARTED.
 */
async function scenarioNightSessionReassignedMidShift() {
    const s = 'night session reassigned mid-shift';
    const e = await makeEmployee(SHIFT_NIGHT);
    await punch(e.code, '2026-09-10 16:05:00');
    await reassign(e.id, SHIFT_DAY, '2026-09-10');
    await punch(e.code, '2026-09-11 01:55:00');

    const rows = await rowsFor(e.id);
    check(s, 'single row', rows.length, 1);
    check(s, 'closed across midnight', rows[0].out, '2026-09-11 01:55:00');
    check(s, 'on time against the night shift, not a termination rescue', rows[0].status, 'present');
    check(s, 'nothing to review', rows[0].review, null);
    check(s, 'logical day is still the start day', String((await db('attendance').where({ employee_id: e.id }).first()).logical_date).slice(0, 10), '2026-09-10');
    check(s, 'pinned to the night shift', await shiftIdsFor(e.id), [SHIFT_NIGHT]);
}

/**
 * The before-shift-start guard must STILL fire for the case it was written for: a punch that
 * really does land before the shift start with no open row to close. The day here is already
 * settled (06:00-15:57) and the roster has since moved to a 16:00 shift, so the stray 15:59 tap
 * reads as "before shift start" - and with nothing open, discarding it is correct. Recording it
 * would rewrite a finished day's checkout.
 */
async function scenarioBeforeShiftStartWithNoOpenRow() {
    const s = 'before shift start with no open row';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 06:00:00');
    await punch(e.code, '2026-09-10 15:57:00');
    await reassign(e.id, SHIFT_NIGHT, '2026-09-10');   // now judged against a 16:00 start
    const stray = await punch(e.code, '2026-09-10 15:59:00');

    check(s, 'still skipped', stray, { status: 'skipped', reason: 'Punch out prior to shift start' });
    check(s, 'the settled day is untouched', await rowsFor(e.id), [
        { in: '2026-09-10 06:00:00', out: '2026-09-10 15:57:00', status: 'present', source: 'biometric', review: null }
    ]);
    check(s, 'audited as skipped', (await db('biometric_raw_logs')
        .where({ company_id: CO, employee_code: e.code, punch_time: '2026-09-10 15:59:00' }).first()).status, 'skipped');
}

/**
 * Backward compatibility, and the reason the guard was relaxed rather than just fixed upstream.
 * Every attendance row written before attendance.shift_id existed carries NULL there, so its
 * session shift has to be re-resolved by date - and if the roster changed since, that
 * resolution can put the shift start AFTER the employee's real exit. Such a punch used to be
 * discarded and the row left open forever. It must now close the row and be flagged instead:
 * a real punch is never silently lost.
 */
async function scenarioUnpinnedRowStillClosed() {
    const s = 'unpinned legacy row is still closed';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 06:00:00');
    // Exactly what production holds today: a row with no pinned shift.
    await db('attendance').where({ employee_id: e.id, company_id: CO }).update({ shift_id: null });
    await reassign(e.id, SHIFT_NIGHT, '2026-09-10');
    const exit = await punch(e.code, '2026-09-10 15:57:00');

    const rows = await rowsFor(e.id);
    check(s, 'the exit is recorded, not skipped', exit.status, 'check-out');
    check(s, 'the row is closed', rows[0].out, '2026-09-10 15:57:00');
    check(s, 'and flagged for a human', rows[0].review, 'closed_before_shift_start');
    // Against the 16:00-02:00 shift it is now judged by, 15:57 is a very early exit, so the
    // normal early-out path runs. That is the honest reading of an unpinnable row.
    check(s, 'early against the resolved shift', rows[0].status, 'pending');
    check(s, 'early_out raised', await requestsFor(e.id), [
        { type: 'early_out', date: '2026-09-10', status: 'pending' }
    ]);
}

/**
 * Split (4-punch) shifts write TWO rows for one logical day by design, and a roster edit
 * between the sessions must not collapse that. Session 1 is already settled when the
 * reassignment lands, so it must stay exactly as it was and keep pointing at the shift it ran
 * under; session 2 opens afterwards and belongs to the new shift. Each session is
 * self-describing, which is the whole point of pinning.
 */
async function scenarioSplitShiftReassignedBetweenSessions() {
    const s = 'split shift reassigned between sessions';
    const e = await makeEmployee(SHIFT_SPLIT);
    await punch(e.code, '2026-09-10 07:00:00');
    await punch(e.code, '2026-09-10 12:00:00');
    await reassign(e.id, SHIFT_SPLIT_LATE, '2026-09-10');   // 09:00-13:00 / 19:00-23:30
    await punch(e.code, '2026-09-10 19:00:00');
    await punch(e.code, '2026-09-10 23:25:00');

    const rows = await rowsFor(e.id);
    check(s, 'still two rows, one per session', rows.length, 2);
    check(s, 'session 1 is untouched by the reassignment', rows[0], {
        in: '2026-09-10 07:00:00', out: '2026-09-10 12:00:00', status: 'present', source: 'biometric', review: null
    });
    check(s, 'session 2 runs on the new shift', rows[1], {
        in: '2026-09-10 19:00:00', out: '2026-09-10 23:25:00', status: 'present', source: 'biometric', review: null
    });
    check(s, 'each row remembers its own shift', await shiftIdsFor(e.id), [SHIFT_SPLIT, SHIFT_SPLIT_LATE]);
}

/**
 * Overlapping open-ended assignments must resolve by from_date, not by insertion order.
 *
 * ATTENDANCE_TROUBLESHOOTING.md records this as the "Shift Assignment Priority Bug": an
 * employee accumulates several assignments with no to_date, and ordering them by id means the
 * shift that wins is whichever row was inserted last rather than the rotation that started most
 * recently. 164 of 231 active employees at one client were in that state (measured 2026-09-05),
 * and attendanceService already orders by from_date - so an ingestion path that did not was
 * judging days by a different shift than the muster displayed them under.
 *
 * The fixture inserts the STALE assignment second so it carries the higher id: id order picks
 * the 16:00-02:00 night shift and throws the 06:00 arrival away as "before allowed margin",
 * from_date order picks the 06:00-16:00 rotation that actually started this month.
 */
async function scenarioOverlappingAssignmentsResolveByFromDate() {
    const s = 'overlapping assignments resolve by from_date';
    const e = await makeEmployee(SHIFT_DAY, { assign: false });
    await db('employee_shift_assignments').insert({
        company_id: CO, employee_id: e.id, shift_id: SHIFT_DAY, from_date: '2026-09-01', to_date: null
    });
    await db('employee_shift_assignments').insert({   // older rotation, higher id
        company_id: CO, employee_id: e.id, shift_id: SHIFT_NIGHT, from_date: '2026-01-01', to_date: null
    });

    await punch(e.code, '2026-09-10 06:00:00');
    await punch(e.code, '2026-09-10 15:57:00');

    check(s, 'the newest rotation wins, so the day is clean', await rowsFor(e.id), [
        { in: '2026-09-10 06:00:00', out: '2026-09-10 15:57:00', status: 'present', source: 'biometric', review: null }
    ]);
    check(s, 'and it is the shift pinned to the row', await shiftIdsFor(e.id), [SHIFT_DAY]);
}

/**
 * A settled day must survive a rotation entered ON TOP of it - and the next day must still
 * get its own row.
 *
 * 09-10 is worked and closed under the 06:00-16:00 shift. An admin then enters a night
 * rotation covering 09-10 (routine: rosters are usually filled in after the fact). The
 * night shift's checkout window runs to 09:00 on 09-11, so the employee's ordinary 06:00
 * arrival the next morning was pulled back onto 09-10, adopted that day's CLOSED row and
 * rewrote it: 06:00-15:57 present became 06:00 -> 09-11 06:00 absent, and 09-11 got no row
 * at all. Two days destroyed by one roster edit, and both punches involved were real.
 *
 * The night-shift lookback now asks what 09-10 was actually RECORDED under - its own pinned
 * row - instead of what the roster now says about it.
 */
async function scenarioNightRotationEnteredOverSettledDay() {
    const s = 'night rotation entered over a settled day';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 06:00:00');
    await punch(e.code, '2026-09-10 15:57:00');

    // The rotation covers only 09-10, so 09-11 still resolves to the standing day shift.
    await db('employee_shift_assignments').insert({
        company_id: CO, employee_id: e.id, shift_id: SHIFT_NIGHT_LONG,
        from_date: '2026-09-10', to_date: '2026-09-10'
    });

    const arrival = await punch(e.code, '2026-09-11 06:00:00');

    const rows = await rowsFor(e.id);
    check(s, 'the arrival opens a row, it is not read as yesterday\'s exit', arrival.status, 'check-in');
    check(s, 'two rows, one per day', rows.length, 2);
    check(s, 'the settled day is byte-for-byte untouched', rows[0], {
        in: '2026-09-10 06:00:00', out: '2026-09-10 15:57:00', status: 'present', source: 'biometric', review: null
    });
    check(s, 'the next morning gets its own row', rows[1].in, '2026-09-11 06:00:00');
    const newest = await db('attendance').where({ employee_id: e.id, company_id: CO }).orderBy('check_in', 'desc').first();
    check(s, 'dated to its own day, not pulled back onto the settled one',
        String(newest.logical_date).slice(0, 10), '2026-09-11');
    check(s, 'and pinned to the shift 09-11 actually resolves to', Number(newest.shift_id), SHIFT_DAY);
}

/**
 * The backstop, exercised on its own: a punch that reads as this person's ARRIVAL on its own
 * day must never be written onto a previous day's settled row - even when the previous day
 * genuinely WAS the night shift, so nothing upstream is wrong.
 *
 * 09-10 is worked and closed as a real 20:00 -> 04:55 night. That shift's checkout window
 * runs to 09:00, and the employee then rotates onto mornings and arrives 06:00 on 09-11. The
 * 2-punch fallback hands the closed 09-10 row over as activeLog, the punch is not past
 * termination so the post-termination skip never fires, and the checkout routine rewrote a
 * finished night into 20:00 -> 06:00 while 09-11 got no row. It is an arrival, so it opens
 * its own row and the night keeps its real exit.
 */
async function scenarioArrivalNeverOverwritesSettledRow() {
    const s = 'arrival never overwrites a settled row';
    const e = await makeEmployee(SHIFT_NIGHT_LONG);
    await punch(e.code, '2026-09-10 20:00:00');
    await punch(e.code, '2026-09-11 04:55:00');   // 09-10 settled, closed across midnight
    await reassign(e.id, SHIFT_DAY, '2026-09-11');
    await punch(e.code, '2026-09-11 06:00:00');

    const rows = await rowsFor(e.id);
    check(s, 'two rows', rows.length, 2);
    check(s, 'the night keeps its real exit', rows[0], {
        in: '2026-09-10 20:00:00', out: '2026-09-11 04:55:00', status: 'present', source: 'biometric', review: null
    });
    check(s, 'the morning arrival opens its own row', rows[1].in, '2026-09-11 06:00:00');
    check(s, 'on the shift it actually arrived for', await shiftIdsFor(e.id), [SHIFT_NIGHT_LONG, SHIFT_DAY]);
}

/**
 * Split (4-punch) days are shaped by the day, not by the roster's current shift.
 *
 * Session 1 (09:00-13:00) is worked and closed, then an admin reassigns the employee to a
 * 2-punch 12:00-21:00 shift effective the SAME day. total_punches_required then read 2, so
 * session 2's arrival took the 2-punch fallback and landed on session 1's SETTLED row: the
 * 4h+4h day collapsed into a single 09:00-19:00 row, session 2 never got a row, and the
 * final 23:25 exit was thrown away as past-termination. A control run of the identical day
 * without the reassignment produces two rows, which is what isolates the roster edit.
 *
 * The day already declared its shape by pinning session 1 to a 4-punch shift; a 2-punch
 * shift has no session 2 to route into, so the day's own shift governs the rest of it.
 */
async function scenarioSplitDayReassignedToTwoPunchShift() {
    const s = 'split day reassigned to a 2-punch shift';
    const e = await makeEmployee(SHIFT_SPLIT_LATE);
    await punch(e.code, '2026-09-10 09:00:00');
    await punch(e.code, '2026-09-10 13:00:00');            // session 1 closes correctly
    await reassign(e.id, SHIFT_LATE, '2026-09-10');        // 12:00-21:00, 2 punches, same day
    await punch(e.code, '2026-09-10 19:00:00');
    await punch(e.code, '2026-09-10 23:25:00');

    const rows = await rowsFor(e.id);
    check(s, 'still two rows, one per session', rows.length, 2);
    check(s, 'session 1 is untouched by the reassignment', rows[0], {
        in: '2026-09-10 09:00:00', out: '2026-09-10 13:00:00', status: 'present', source: 'biometric', review: null
    });
    check(s, 'session 2 opens and closes its own row', rows[1], {
        in: '2026-09-10 19:00:00', out: '2026-09-10 23:25:00', status: 'present', source: 'biometric', review: null
    });
    check(s, 'both sessions keep the shift the day ran under', await shiftIdsFor(e.id), [SHIFT_SPLIT_LATE, SHIFT_SPLIT_LATE]);
    check(s, 'no request raised', await requestsFor(e.id), []);
}

/** The control for the scenario above: the same split day with no roster edit. */
async function scenarioSplitDayControlWithoutReassignment() {
    const s = 'split day control, no reassignment';
    const e = await makeEmployee(SHIFT_SPLIT_LATE);
    await punch(e.code, '2026-09-10 09:00:00');
    await punch(e.code, '2026-09-10 13:00:00');
    await punch(e.code, '2026-09-10 19:00:00');
    await punch(e.code, '2026-09-10 23:25:00');

    const rows = await rowsFor(e.id);
    check(s, 'two rows', rows.length, 2);
    check(s, 'session 1 closed at 13:00', rows[0].out, '2026-09-10 13:00:00');
    check(s, 'session 2 closed at 23:25', rows[1].out, '2026-09-10 23:25:00');
}

/**
 * Protecting settled rows must not mean freezing them. A closed row is still correctable by
 * a genuine later exit on the same day - the self-healing shipped in ec630fd.
 *
 * A stray tap an hour after arrival is past the 2-minute dedup, so it settles the row at
 * 07:00 and the day reads absent (under half a day). The real 15:57 exit then has to move
 * check_out to the truth and restore the day to present. If the new guard refused every write
 * to a closed row, this employee would keep a one-hour day forever.
 */
async function scenarioSettledRowStillCorrectedBySameDayExit() {
    const s = 'settled row still corrected by the same day\'s real exit';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 06:00:00');
    await punch(e.code, '2026-09-10 07:00:00');   // stray tap: closes the row at 1h worked

    check(s, 'the stray tap settles the row short', (await rowsFor(e.id))[0], {
        in: '2026-09-10 06:00:00', out: '2026-09-10 07:00:00', status: 'absent', source: 'biometric', review: null
    });

    await punch(e.code, '2026-09-10 15:57:00');   // the real exit

    check(s, 'the real exit corrects the same row', await rowsFor(e.id), [
        { in: '2026-09-10 06:00:00', out: '2026-09-10 15:57:00', status: 'present', source: 'biometric', review: null }
    ]);
}

/**
 * A SAME-DAY rotation must not reopen a settled day either.
 *
 * scenarioStrayPunchDoesNotReopenSettledDay covers the control: 06:00-15:57 settled under the
 * 06:00-16:00 shift, a 19:00 stray tap is past that shift's 18:00 termination and is refused.
 * Enter a rotation to a 12:00-21:00 shift effective the SAME day and the identical punch was
 * accepted, because termination was measured against the shift the ROSTER now names (which
 * terminates at 23:00) rather than the one attendance.shift_id says the row was recorded
 * under. check_out was rewritten to 19:00, the day flipped to 'pending' awaiting an early-out
 * approval it never needed, and nothing on the row said why.
 *
 * A settled row is judged by the shift it ran under. The refused punch is flagged onto that
 * row, because a punch a roster edit would have used to destroy a finished day is exactly the
 * thing a human should see rather than have to find in biometric_raw_logs.
 */
async function scenarioSameDayRotationCannotReopenSettledDay() {
    const s = 'same-day rotation cannot reopen a settled day';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 06:00:00');
    await punch(e.code, '2026-09-10 15:57:00');           // settled under 06:00-16:00
    await reassign(e.id, SHIFT_LATE, '2026-09-10');       // 12:00-21:00, terminates 23:00
    const stray = await punch(e.code, '2026-09-10 19:00:00');

    check(s, 'the stray punch is refused', stray, { status: 'skipped', reason: 'Shift terminated' });
    check(s, 'the settled checkout survives the rotation', (await rowsFor(e.id)).map(r => ({ in: r.in, out: r.out, status: r.status })), [
        { in: '2026-09-10 06:00:00', out: '2026-09-10 15:57:00', status: 'present' }
    ]);
    check(s, 'and the refusal is visible on the row', (await rowsFor(e.id))[0].review, 'stray_after_settled_day');
    check(s, 'no early_out request invented', await requestsFor(e.id), []);
    check(s, 'the row keeps the shift it ran under', await shiftIdsFor(e.id), [SHIFT_DAY]);
}

/**
 * A night-to-day rotation must file the new day on its OWN date.
 *
 * The employee is on a 20:00-05:00 night shift and is rotated onto 09:00-18:00 from 09-11.
 * 09-10 is not worked. Their 09:00 arrival on 09-11 falls in the 00:00-09:59 window the
 * night-shift lookback watches, and 09-10's roster shift is a night one whose checkout window
 * runs to exactly 09:00 - so the arrival was pulled back onto 09-10 and pinned to the night
 * shift. 09-11 then read Absent while 09-10, a day nobody worked, carried a 09:00-18:00 row.
 *
 * The lookback only ever asked "was yesterday a night shift, and is this punch still inside
 * its checkout window". looksLikeArrivalOnPunchDay answers the question it never asked: this
 * punch is a credible arrival for the shift in force on its OWN day, so it belongs to that
 * day whatever yesterday was.
 */
async function scenarioNightToDayRotationFilesOnItsOwnDay() {
    const s = 'night-to-day rotation files the day on its own date';
    const e = await makeEmployee(SHIFT_NIGHT_LONG);        // 20:00-05:00, window reaches 09:00
    await reassign(e.id, SHIFT_GENERAL, '2026-09-11');     // 09:00-18:00 from the next day
    await punch(e.code, '2026-09-11 09:00:00');
    await punch(e.code, '2026-09-11 18:00:00');

    check(s, 'one clean row for the day actually worked', await rowsFor(e.id), [
        { in: '2026-09-11 09:00:00', out: '2026-09-11 18:00:00', status: 'present', source: 'biometric', review: null }
    ]);
    check(s, 'filed on its own day, not pulled back onto the unworked one', await logicalDatesFor(e.id), ['2026-09-11']);
    check(s, 'pinned to the shift the rotation moved them to', await shiftIdsFor(e.id), [SHIFT_GENERAL]);
    check(s, 'nothing for a manager to resolve', await requestsFor(e.id), []);
}

/**
 * A post-rotation exit beyond MAX_PLAUSIBLE_WORKED_HOURS must never be both lost and silent.
 *
 * In at 09:00 on a 09:00-18:00 shift; an admin rotates them onto 16:00-02:00 effective the
 * SAME day; they leave at 02:00, seventeen hours later. Seventeen hours is more than one
 * worked shift, so the row is released as stale and the punch is re-read as a fresh arrival -
 * and then thrown away by the in-margin guard, because 02:00 is nowhere near a 16:00 start.
 * Net effect: the punch survived only in biometric_raw_logs and the row sat open, 'present'
 * and unflagged, so no review queue could ever surface it.
 *
 * The punch cannot open a day of its own and it is the only candidate exit the row has, so it
 * closes the row and hands the day to a human, rather than disappearing.
 */
async function scenarioLongPostRotationExitIsNotDiscarded() {
    const s = 'long post-rotation exit is not discarded';
    const e = await makeEmployee(SHIFT_GENERAL);           // 09:00-18:00
    await punch(e.code, '2026-09-10 09:00:00');
    await reassign(e.id, SHIFT_NIGHT, '2026-09-10');       // 16:00-02:00, effective mid-session
    const exit = await punch(e.code, '2026-09-11 02:00:00');   // 17h after check-in

    check(s, 'the exit is recorded, not discarded', exit.status, 'check-out');
    check(s, 'it closes the row it came from, flagged for review', await rowsFor(e.id), [
        {
            in: '2026-09-10 09:00:00', out: '2026-09-11 02:00:00', status: 'pending',
            source: 'biometric', review: 'open_row_punch_unplaceable'
        }
    ]);
    check(s, 'no second row invented for a day nobody arrived on', (await rowsFor(e.id)).length, 1);
}

/**
 * A night rotation entered over a settled day must not destroy the NEXT day either.
 *
 * 09-10 is worked and closed under the 06:00-16:00 shift, then an admin enters an open-ended
 * 20:00-05:00 rotation from 09-10. 97e7527 made 09-10 survive that, by asking what the day was
 * RECORDED under instead of what the roster now claims. 09-11 was still lost: the roster says
 * night there, so the employee's ordinary 06:00 arrival lands fourteen hours before a 20:00
 * start, misses the in-margin rescue floor, and is discarded outright - the day reads Absent
 * and the punch exists only in biometric_raw_logs.
 *
 * The same pin that saved 09-10 answers this too: the shift this employee's last recorded day
 * actually ran under is a 06:00 one, and 06:00 is that shift's arrival. With no row on 09-11
 * to be confused with, recording the punch and flagging it keeps the day; discarding it does
 * not make the roster any less wrong.
 */
async function scenarioArrivalSurvivesARosterThatDoesNotDescribeIt() {
    const s = 'arrival survives a roster that does not describe it';
    const e = await makeEmployee(SHIFT_DAY);
    await punch(e.code, '2026-09-10 06:00:00');
    await punch(e.code, '2026-09-10 15:57:00');            // 09-10 settled under 06:00-16:00
    await reassign(e.id, SHIFT_NIGHT_LONG, '2026-09-10');  // open-ended night from 09-10

    const arrival = await punch(e.code, '2026-09-11 06:00:00');
    check(s, 'the arrival is recorded, not discarded', arrival.status, 'check-in');
    check(s, 'flagged so the wrong roster is visible', (await rowsFor(e.id))[1].review, 'arrival_outside_roster_shift');
    check(s, 'filed on its own day', await logicalDatesFor(e.id), ['2026-09-10', '2026-09-11']);

    await punch(e.code, '2026-09-11 16:00:00');
    const rows = await rowsFor(e.id);
    check(s, 'two rows, one per day', rows.length, 2);
    check(s, 'the settled day is untouched', rows[0], {
        in: '2026-09-10 06:00:00', out: '2026-09-10 15:57:00', status: 'present', source: 'biometric', review: null
    });
    check(s, 'and the new day keeps both its punches', { in: rows[1].in, out: rows[1].out },
        { in: '2026-09-11 06:00:00', out: '2026-09-11 16:00:00' });
}

const SCENARIOS = [
    scenarioLateTerminationCheckout,
    scenarioStaleRowNotAbsorbed,
    scenarioOutMarginIsNotEarly,
    scenarioGenuineEarlyOut,
    scenarioLoneCheckoutWindowPunch,
    scenarioUnpairedRowSelfHeals,
    scenarioEarlyRescueFlagSurvivesCheckout,
    scenarioOrdinaryLateArrival,
    scenarioOnTimeDayShift,
    scenarioNightShiftCrossesMidnight,
    scenarioConcurrentRetryFlood,
    scenarioConcurrentIdenticalPunch,
    scenarioRotationArrivalNotSwallowed,
    scenarioStrayPunchDoesNotReopenSettledDay,
    scenarioFailedPunchStaysRetryable,
    scenarioFlexiWithoutAssignmentUsesShiftMinHours,
    scenarioFlexiShift,
    scenarioFlexiHalfDay,
    scenarioNoAssignmentFallback,
    scenarioUnmappedCode,
    scenarioSplitShift,
    scenarioMidSessionReassignLaterShift,
    scenarioMidSessionReassignEarlierShift,
    scenarioNightSessionReassignedMidShift,
    scenarioBeforeShiftStartWithNoOpenRow,
    scenarioUnpinnedRowStillClosed,
    scenarioSplitShiftReassignedBetweenSessions,
    scenarioOverlappingAssignmentsResolveByFromDate,
    scenarioNightRotationEnteredOverSettledDay,
    scenarioArrivalNeverOverwritesSettledRow,
    scenarioSplitDayReassignedToTwoPunchShift,
    scenarioSplitDayControlWithoutReassignment,
    scenarioSettledRowStillCorrectedBySameDayExit,
    scenarioSameDayRotationCannotReopenSettledDay,
    scenarioNightToDayRotationFilesOnItsOwnDay,
    scenarioLongPostRotationExitIsNotDiscarded,
    scenarioArrivalSurvivesARosterThatDoesNotDescribeIt
];

async function main() {
    console.log(`Punch replay harness  db=${DB_NAME}  TZ=${process.env.TZ || '(system)'}\n`);
    await resetFixtures();
    await seedCommon();

    for (const scenario of SCENARIOS) {
        try {
            await scenario();
        } catch (error) {
            failures++;
            results.push({ scenario: scenario.name, label: 'threw', ok: false, actual: error.message, expected: 'no error' });
        }
    }

    let currentScenario = null;
    for (const r of results) {
        if (r.scenario !== currentScenario) {
            currentScenario = r.scenario;
            console.log(`\n  ${currentScenario}`);
        }
        console.log(`    ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}`);
        if (!r.ok) {
            console.log(`          expected ${JSON.stringify(r.expected)}`);
            console.log(`          actual   ${JSON.stringify(r.actual)}`);
        }
    }

    const total = results.length;
    console.log(`\n${total - failures}/${total} assertions passed.`);

    if (process.env.KEEP_FIXTURES !== '1') await resetFixtures();
    await db.destroy();
    process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
    console.error('Harness failed to run:', error);
    try { await db.destroy(); } catch { /* already closed */ }
    process.exit(1);
});
