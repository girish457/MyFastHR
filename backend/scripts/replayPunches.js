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
        { ...baseShift, id: SHIFT_SPLIT, name: 'Replay Split', start_time: '07:00', end_time: '12:00', total_punches_required: 4, session2_start_time: '18:00', session2_end_time: '23:00', session2_in_margin: 30, session2_out_margin: 5 }
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
    scenarioSplitShift
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
