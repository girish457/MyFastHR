#!/usr/bin/env node
/**
 * Pure unit tests for src/services/attendance/dayResolver.js.
 *
 * NO DATABASE. This runs in a checkout with MySQL stopped, uninstalled, or never configured -
 * that is the whole point. replayPunches.js and replayReadPath.js both need a seeded scratch
 * database and a booted schema-sync before they can assert anything, which is why the read path
 * went years with no test at all and why the two harnesses can only ever SAMPLE the space. The
 * resolver is a pure function of plain objects, so the space can be enumerated instead:
 *
 *   shift type      standard 2-punch / split 4-punch / flexi
 *   x shift pin     attendance.shift_id set vs NULL (a NULL pin means "predates the pin",
 *                   NOT "no shift" - every pre-89b9968 production row is NULL)
 *   x letter        P L E HD A R CI OFF H PL UL '-'
 *   x overlay       weekoff / holiday / paid leave / unpaid leave / half-day leave / future date
 *   x request state approved / rejected / pending / none, for early_out and late_in
 *   x midnight      night shift crossing 00:00
 *
 * and each case asserts all three things a screen renders from one day: the LETTER, the
 * EXPLANATION SENTENCE the day-detail drawer prints beside it, and the STATS WEIGHT payroll
 * multiplies (payrollService: paidDays = P + L + OFF + H + PL).
 *
 * The clock is an argument here, never a global. Every case fixes `now` and `todayStr`, so
 * "is this day over", "is this row still live" and "has terminate_hour passed" are decided by
 * the test and not by when the test happens to run. That is also why this file is TZ-proof:
 * run it under TZ=Etc/UTC and TZ=Asia/Kolkata and it must produce the same numbers.
 *
 * Usage:
 *   npm run resolver:test          (from backend/)
 *   node scripts/testDayResolver.js
 */

const R = require('../src/services/attendance/dayResolver');
const T = require('../src/services/attendance/time');

// ---------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------
let passed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
    currentGroup = name;
    console.log(`\n${name}`);
}

function eq(label, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
    } else {
        failures.push(`${currentGroup} :: ${label}\n      expected ${e}\n      actual   ${a}`);
        console.log(`    FAIL  ${label}  expected ${e}, got ${a}`);
    }
}

// ---------------------------------------------------------------------------------------------
// fixtures - plain objects, exactly the shape the service marshals out of MySQL
// ---------------------------------------------------------------------------------------------

// dateStrings:true in knexfile.js, so every timestamp reaching the resolver is a string.
const at = (dateStr, hhmm) => `${dateStr} ${hhmm}:00`;

const SHIFT_STANDARD = {
    id: 100, name: 'General 09-18',
    start_time: '09:00', end_time: '18:00',
    grace_period: 15, total_punches_required: 2,
    session1_in_margin: 0, session1_out_margin: 0, session1_grace_out: 0,
    terminate_hour: 2, is_flexi: 0, min_hours: 8
};

const SHIFT_SPLIT = {
    id: 101, name: 'Split 09-13 / 17-21',
    start_time: '09:00', end_time: '13:00',
    session2_start_time: '17:00', session2_end_time: '21:00',
    grace_period: 15, session2_grace_in: 15,
    session1_out_margin: 0, session1_grace_out: 0,
    session2_out_margin: 0, session2_grace_out: 0, session2_in_margin: 30,
    total_punches_required: 4, terminate_hour: 2, is_flexi: 0, min_hours: 8
};

const SHIFT_FLEXI = {
    id: 102, name: 'Anytime Shift',
    start_time: '00:00', end_time: '23:59',
    grace_period: 0, total_punches_required: 2,
    terminate_hour: null, is_flexi: 1, min_hours: 8
};

const SHIFT_NIGHT = {
    id: 103, name: 'Night 22-06',
    start_time: '22:00', end_time: '06:00',
    grace_period: 15, total_punches_required: 2,
    session1_out_margin: 0, session1_grace_out: 0,
    terminate_hour: 4, is_flexi: 0, min_hours: 8
};

const RULES = { shift_start: '09:00', grace_period: 15, weekoffs: '["Sunday"]' };

// A settled past day and a fixed "now" well after it. Nothing in these tests depends on the
// wall clock.
const D_PAST = '2026-05-12';         // a Tuesday
const D_SUN = '2026-05-10';          // a Sunday
const D_TODAY = '2026-05-20';        // a Wednesday - the fixed "today"
const D_FUTURE = '2026-05-25';
const TODAY_STR = D_TODAY;
// 2026-05-20 14:30 IST
const NOW = new Date('2026-05-20T14:30:00+05:30');
// 2026-05-20 23:30 IST - past a 09:00-18:00 shift's terminate_hour of 2 (20:00)
const NOW_LATE = new Date('2026-05-20T23:30:00+05:30');

const ctx = (over = {}) => Object.assign({ todayStr: TODAY_STR, now: NOW }, over);

const row = (over = {}) => Object.assign({
    id: 1, employee_id: 7, company_id: 27,
    check_in: at(D_PAST, '09:00'), check_out: at(D_PAST, '18:00'),
    status: 'present', punch_source: 'biometric',
    shift_id: null, logical_date: null
}, over);

function letter(dayLogs, shift, c = {}) {
    return R.resolveDayStatus(dayLogs, shift, RULES, ctx(c));
}
function detail(dayLogs, shift, c = {}) {
    return R.resolveDayStatusDetail(dayLogs, shift, RULES, ctx(Object.assign({ explain: true }, c)));
}
function weight(status, c = {}) {
    const stats = { P: 0, L: 0, A: 0, PL: 0, UL: 0, OFF: 0, H: 0 };
    R.bumpDayStats(stats, status, c);
    return stats;
}
const S = (o) => ({ P: o.P || 0, L: o.L || 0, A: o.A || 0, PL: o.PL || 0, UL: o.UL || 0, OFF: o.OFF || 0, H: o.H || 0 });

// =============================================================================================

group('purity: the module cannot reach a database and cannot read a clock');
{
    // Comments talk ABOUT the database and the clock; code must not reach either. Strip them.
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const src = strip(require('fs').readFileSync(require.resolve('../src/services/attendance/dayResolver.js'), 'utf8'));
    const timeSrc = strip(require('fs').readFileSync(require.resolve('../src/services/attendance/time.js'), 'utf8'));
    const requires = (s) => (s.match(/require\((['"])(.*?)\1\)/g) || []);
    eq('dayResolver requires only ./time', requires(src), ["require('./time')"]);
    eq('time requires nothing', requires(timeSrc), []);
    eq('dayResolver code names no db, knex or repository', /config\/db|knex|repositories\//.test(src) === false, true);
    // `new Date(` appears for arithmetic on supplied values; `new Date()` with no argument -
    // reading the wall clock - must not.
    eq('dayResolver never calls new Date()', /new Date\(\s*\)/.test(src) === false, true);
    eq('dayResolver never calls Date.now()', /Date\.now\(/.test(src) === false, true);
    eq('time.js never calls new Date()', /new Date\(\s*\)/.test(timeSrc) === false, true);
    // The decisive check: after loading the resolver, nothing database-shaped is in the module
    // cache. If a query ever creeps back in, knex/mysql2 shows up here and this fails.
    const loaded = Object.keys(require.cache).filter(f => /node_modules\/(knex|mysql2|tarn)\/|src\/config\/db|repositories\//.test(f));
    eq('loading dayResolver pulls in no database machinery', loaded, []);

    // And it refuses to guess when the caller forgets the clock, rather than answering wrongly.
    let threw = false;
    try { R.resolveDayStatus([row()], SHIFT_STANDARD, RULES, {}); } catch (e) { threw = e instanceof TypeError; }
    eq('resolveDayStatusDetail refuses a missing clock', threw, true);
    threw = false;
    try { R.resolveNoLogStatus(D_PAST, { todayStr: TODAY_STR }); } catch (e) { threw = e instanceof TypeError; }
    eq('resolveNoLogStatus refuses a missing clock', threw, true);
    threw = false;
    try { R.calculateSplitShiftStatus([row()], SHIFT_STANDARD, RULES); } catch (e) { threw = e instanceof TypeError; }
    eq('calculateSplitShiftStatus refuses a missing clock', threw, true);
}

group('standard 2-punch shift: every letter the punches alone can produce');
{
    const on = detail([row()], SHIFT_STANDARD);
    eq('on time -> P', on.status, 'P');
    eq('on time sentence', on.explanation, 'S1: On-Time (09:00 - 18:00)');

    const late = detail([row({ check_in: at(D_PAST, '09:16') })], SHIFT_STANDARD);
    eq('16 min past a 15 min grace -> L', late.status, 'L');
    eq('late sentence', late.explanation, 'S1: Late In (09:16 - 18:00)');

    eq('exactly on the grace boundary is not late', letter([row({ check_in: at(D_PAST, '09:15') })], SHIFT_STANDARD), 'P');

    const early = detail([row({ check_in: at(D_PAST, '09:00'), check_out: at(D_PAST, '17:30') })], SHIFT_STANDARD);
    eq('left before end -> E', early.status, 'E');
    eq('early sentence', early.explanation, 'S1: Early Out (09:00 - 17:30)');

    const both = detail([row({ check_in: at(D_PAST, '10:00'), check_out: at(D_PAST, '17:00') })], SHIFT_STANDARD);
    eq('late AND early -> L (arrival wins the letter)', both.status, 'L');
    eq('...but the sentence names BOTH violations', both.explanation, 'S1: Late In, Early Out (10:00 - 17:00)');

    // out_margin and grace_out both express end-of-shift slack; the larger one wins, so the
    // grid can never be stricter than the ingestion engine that stored the row.
    eq('session1_out_margin 5 forgives a 17:56 exit',
        letter([row({ check_out: at(D_PAST, '17:56') })], Object.assign({}, SHIFT_STANDARD, { session1_out_margin: 5 })), 'P');
    eq('session1_grace_out 5 forgives it too',
        letter([row({ check_out: at(D_PAST, '17:56') })], Object.assign({}, SHIFT_STANDARD, { session1_grace_out: 5 })), 'P');
    eq('neither margin -> E', letter([row({ check_out: at(D_PAST, '17:56') })], SHIFT_STANDARD), 'E');

    const openPast = detail([row({ check_in: at(D_PAST, '09:00'), check_out: null })], SHIFT_STANDARD);
    eq('open row on a day long gone -> A', openPast.status, 'A');
    eq('open past sentence names termination', openPast.explanation, 'S1: Terminated (No Out) (09:00 - --:--)');

    const openToday = detail([row({ check_in: at(D_TODAY, '09:00'), check_out: null })], SHIFT_STANDARD);
    eq('open row on today, shift still running -> CI', openToday.status, 'CI');
    eq('CI sentence', openToday.explanation, 'S1: Checked In (On-Time) (09:00 - --:--)');

    // Same row, same shift, clock moved past 18:00 + terminate_hour 2. The punch-level
    // computation flips to Terminated - but the resolver's "open row, today, no punch out"
    // branch runs FIRST and holds the cell at CI for the rest of the calendar day. Both halves
    // are asserted so neither can be changed silently.
    const openTodayRow = [row({ check_in: at(D_TODAY, '09:00'), check_out: null })];
    eq('punches alone: past terminate_hour the row reads Terminated',
        R.calculateSplitShiftStatus(openTodayRow, SHIFT_STANDARD, RULES, NOW_LATE).status, 'A');
    const openTodayLate = R.resolveDayStatusDetail(openTodayRow, SHIFT_STANDARD, RULES,
        { todayStr: TODAY_STR, now: NOW_LATE, explain: true });
    eq('...but the resolver still shows CI for the rest of today', openTodayLate.status, 'CI');

    const noTerm = detail([row({ check_in: at(D_PAST, '09:00'), check_out: null })],
        Object.assign({}, SHIFT_STANDARD, { terminate_hour: null }));
    eq('no terminate_hour, past day, no out -> A (incomplete)', noTerm.status, 'A');
    eq('incomplete sentence', noTerm.explanation, 'S1: Incomplete (09:00 - --:--)');
}

group('split 4-punch shift: two rows a day, and the sessions are read as sessions');
{
    const s1 = row({ id: 1, check_in: at(D_PAST, '09:00'), check_out: at(D_PAST, '13:00') });
    const s2 = row({ id: 2, check_in: at(D_PAST, '17:00'), check_out: at(D_PAST, '21:00') });

    const full = detail([s1, s2], SHIFT_SPLIT);
    eq('both sessions clean -> P', full.status, 'P');
    eq('both-session sentence', full.explanation, 'S1: On-Time (09:00 - 13:00) | S2: On-Time (17:00 - 21:00)');

    const s1Only = detail([s1], SHIFT_SPLIT);
    eq('session 1 only -> HD', s1Only.status, 'HD');
    eq('missing session 2 is named', s1Only.explanation, 'S1: On-Time (09:00 - 13:00) | S2: Missed');
    eq('HD banks half a day', S(weight('HD')), S({ P: 0.5 }));

    eq('session 2 only -> HD', letter([s2], SHIFT_SPLIT), 'HD');
    eq('late in session 2 -> L for the whole day',
        letter([s1, row({ id: 2, check_in: at(D_PAST, '17:16'), check_out: at(D_PAST, '21:00') })], SHIFT_SPLIT), 'L');
    eq('early out of session 1 -> E for the whole day',
        letter([row({ id: 1, check_in: at(D_PAST, '09:00'), check_out: at(D_PAST, '12:30') }), s2], SHIFT_SPLIT), 'E');
    eq('late beats early when both happen',
        letter([row({ id: 1, check_in: at(D_PAST, '09:30'), check_out: at(D_PAST, '12:30') }), s2], SHIFT_SPLIT), 'L');
    eq('neither session -> A', letter([], SHIFT_SPLIT), null);

    // session2_in_margin decides which session a punch belongs to: 17:00 - 30 min = 16:30.
    const boundary = detail([row({ id: 1, check_in: at(D_PAST, '16:29'), check_out: at(D_PAST, '21:00') })], SHIFT_SPLIT);
    eq('16:29 lands in session 1 (and so reads late + missing S2)', boundary.status, 'HD');
    eq('16:29 is classified as S1', boundary.explanation, 'S1: Late In (16:29 - 21:00) | S2: Missed');
    const boundary2 = detail([row({ id: 1, check_in: at(D_PAST, '16:30'), check_out: at(D_PAST, '21:00') })], SHIFT_SPLIT);
    eq('16:30 lands in session 2', boundary2.explanation, 'S1: Missed | S2: On-Time (16:30 - 21:00)');

    // primaryDayLog must NOT prefer a closed row here - the callers read [0] and [1] as the
    // two sessions, so preferring the closed one would hand back session 2.
    const openS1 = row({ id: 1, check_in: at(D_PAST, '09:00'), check_out: null });
    eq('4-punch: primaryDayLog keeps session 1 even when session 2 is the closed row',
        R.primaryDayLog([openS1, s2], SHIFT_SPLIT).id, 1);
    eq('2-punch: primaryDayLog prefers the CLOSED row over the earliest',
        R.primaryDayLog([openS1, row({ id: 9, check_in: at(D_PAST, '09:02'), check_out: at(D_PAST, '18:00') })], SHIFT_STANDARD).id, 9);
    eq('...and a manual edit outranks every punch',
        R.primaryDayLog([openS1, row({ id: 9, check_out: at(D_PAST, '18:00') }), row({ id: 5, punch_source: 'manual' })], SHIFT_STANDARD).id, 5);
    eq('primaryDayLog on an empty day', R.primaryDayLog([], SHIFT_STANDARD), null);
}

group('flexi shift: min_hours is the whole rule, there is no clock to be late against');
{
    // A flexi shift is stored 00:00-23:59 with grace 0, so judging it by start_time makes every
    // arrival after midnight "Late". That is the bug; is_flexi short-circuits it.
    const worked = detail([row({ check_in: at(D_PAST, '11:00'), check_out: at(D_PAST, '19:30') })], SHIFT_FLEXI);
    eq('an 11:00 arrival on a flexi shift is P, not L', worked.status, 'P');
    eq('flexi sentence reports hours, not lateness', worked.explanation, 'Flexi: 8.5h worked of 8h required (11:00 - 19:30)');

    eq('shift_is_flexi (the projected alias) is honoured too - employees.is_flexi does not exist',
        letter([row({ check_in: at(D_PAST, '11:00'), check_out: at(D_PAST, '19:30') })],
            { start_time: '00:00', end_time: '23:59', grace_period: 0, shift_is_flexi: 1, shift_min_hours: 8 }), 'P');

    // A flexi row with no punch out: the punch-level computation calls it A, but the row was
    // STORED 'present' (the engine already applied min_hours), and the resolver's flexi
    // short-circuit trusts that. This is the branch that stops the muster calling a clean flexi
    // day Late; both halves are asserted so the short-circuit cannot be removed silently.
    const flexiNoOut = [row({ check_in: at(D_PAST, '11:00'), check_out: null })];
    eq('punches alone: flexi with no out on a past day is A',
        R.calculateSplitShiftStatus(flexiNoOut, SHIFT_FLEXI, RULES, NOW).status, 'A');
    eq('flexi no-out sentence',
        R.calculateSplitShiftStatus(flexiNoOut, SHIFT_FLEXI, RULES, NOW).explanation, 'Flexi: No Out (11:00 - --:--)');
    const openFlexiPast = detail(flexiNoOut, SHIFT_FLEXI);
    eq('a row stored present on a flexi shift stays P', openFlexiPast.status, 'P');
    eq('...and says why, keeping the punch sentence', openFlexiPast.explanation,
        'Present (flexi shift, judged on hours worked) | Flexi: No Out (11:00 - --:--)');
    eq('a flexi row stored absent is A, not rescued by the short-circuit',
        letter([row({ check_in: at(D_PAST, '11:00'), check_out: null, status: 'absent' })], SHIFT_FLEXI), 'A');
    eq('flexi, no out, today -> CI',
        detail([row({ check_in: at(D_TODAY, '11:00'), check_out: null })], SHIFT_FLEXI).status, 'CI');

    eq('flexi below min_hours is still P (the engine already applied min_hours when it wrote the row)',
        letter([row({ check_in: at(D_PAST, '11:00'), check_out: at(D_PAST, '13:00') })], SHIFT_FLEXI), 'P');
    eq('flexi with no min_hours omits the requirement clause',
        detail([row({ check_in: at(D_PAST, '11:00'), check_out: at(D_PAST, '19:30') })],
            Object.assign({}, SHIFT_FLEXI, { min_hours: 0 })).explanation,
        'Flexi: 8.5h worked (11:00 - 19:30)');
}

group('night shift crossing midnight');
{
    eq('a 22:00-06:00 shift is a night shift', R.isNightShift(SHIFT_NIGHT), true);
    eq('a 09:00-18:00 shift is not', R.isNightShift(SHIFT_STANDARD), false);
    eq('a shift with no times is not', R.isNightShift({}), false);

    // The logical day of a 02:00 punch depends on which shift covered the PREVIOUS day.
    const nightAssignment = [{ from_date: '2026-05-01', to_date: null, start_time: '22:00', end_time: '06:00' }];
    const dayAssignment = [{ from_date: '2026-05-01', to_date: null, start_time: '09:00', end_time: '18:00' }];
    eq('02:00 under a night roster belongs to the previous day',
        R.getLogicalDateStr(at('2026-05-13', '02:00'), nightAssignment), '2026-05-12');
    eq('02:00 under a day roster belongs to its own day',
        R.getLogicalDateStr(at('2026-05-13', '02:00'), dayAssignment), '2026-05-13');
    eq('10:00 is never pulled back, night roster or not',
        R.getLogicalDateStr(at('2026-05-13', '10:00'), nightAssignment), '2026-05-13');
    eq('a null check_in has no logical date', R.getLogicalDateStr(null, nightAssignment), null);

    // A persisted logical_date beats the re-derivation. This is what stops a rotation entered
    // AFTER the punch from moving an old row into a different column.
    eq('persisted logical_date wins over the derivation',
        R.rowLogicalDate({ check_in: at('2026-05-13', '02:00'), logical_date: '2026-05-13' }, nightAssignment), '2026-05-13');
    eq('persisted logical_date as a Date is normalised',
        R.rowLogicalDate({ check_in: at('2026-05-13', '02:00'), logical_date: new Date('2026-05-13T12:00:00+05:30') }, nightAssignment), '2026-05-13');
    eq('an unstamped row falls back to the derivation',
        R.rowLogicalDate({ check_in: at('2026-05-13', '02:00'), logical_date: null }, nightAssignment), '2026-05-12');

    // The night row itself: in 22:00, out 06:00 the next morning, judged as one clean day.
    const nightRow = row({ check_in: at('2026-05-12', '22:00'), check_out: at('2026-05-13', '06:00'), logical_date: '2026-05-12' });
    const night = detail([nightRow], SHIFT_NIGHT);
    eq('a clean night shift is P', night.status, 'P');
    eq('night sentence shows both wall-clock times', night.explanation, 'S1: On-Time (22:00 - 06:00)');
    eq('leaving at 05:00 on a night shift is E',
        letter([row({ check_in: at('2026-05-12', '22:00'), check_out: at('2026-05-13', '05:00') })], SHIFT_NIGHT), 'E');
    eq('arriving 22:30 on a night shift is L',
        letter([row({ check_in: at('2026-05-12', '22:30'), check_out: at('2026-05-13', '06:00') })], SHIFT_NIGHT), 'L');

    // shiftDayIsTerminated must add a day to the end time before comparing.
    eq('a night shift day is not over at 03:00 the next morning',
        R.shiftDayIsTerminated('2026-05-12', SHIFT_NIGHT, new Date('2026-05-13T03:00:00+05:30')), false);
    eq('...and is over at 11:00 (06:00 + terminate_hour 4)',
        R.shiftDayIsTerminated('2026-05-12', SHIFT_NIGHT, new Date('2026-05-13T11:00:00+05:30')), true);
    eq('a day shift is over at 20:01 (18:00 + 2)',
        R.shiftDayIsTerminated(D_TODAY, SHIFT_STANDARD, new Date('2026-05-20T20:01:00+05:30')), true);
    eq('...and not at 19:59', R.shiftDayIsTerminated(D_TODAY, SHIFT_STANDARD, new Date('2026-05-20T19:59:00+05:30')), false);
    eq('no shift at all is never terminated', R.shiftDayIsTerminated(D_TODAY, null, NOW), false);
}

group('pinned vs NULL attendance.shift_id');
{
    const shiftsById = { 100: SHIFT_STANDARD, 101: SHIFT_SPLIT, 102: SHIFT_FLEXI };
    const pinnedRow = row({ shift_id: 101 });
    const unpinnedRow = row({ shift_id: null });

    eq('a pinned row is judged by its pin, not by the roster',
        R.shiftForDay([pinnedRow], shiftsById, SHIFT_STANDARD).id, 101);
    eq('a NULL pin falls back to the roster - it means "predates the pin", not "no shift"',
        R.shiftForDay([unpinnedRow], shiftsById, SHIFT_STANDARD).id, 100);
    eq('...and then to the profile shift when the roster has nothing',
        R.shiftForDay([unpinnedRow], shiftsById, null, SHIFT_FLEXI).id, 102);
    eq('a pin to a shift that no longer exists falls back too',
        R.shiftForDay([row({ shift_id: 999 })], shiftsById, SHIFT_STANDARD).id, 100);
    eq('no rows, no roster, no profile -> null', R.shiftForDay([], shiftsById, null, null), null);
    eq('the first PINNED row wins, even if it is not the first row',
        R.pinnedShiftForDay([unpinnedRow, pinnedRow], shiftsById).id, 101);

    // The bug this exists for: the roster is rotated AFTER a clean day was worked and settled.
    const cleanDay = [row({ shift_id: 100, check_in: at(D_PAST, '09:00'), check_out: at(D_PAST, '18:00') })];
    eq('roster rotated to a split shift; the pin keeps the day P',
        letter(cleanDay, R.shiftForDay(cleanDay, shiftsById, SHIFT_SPLIT)), 'P');
    eq('...whereas judging it by the new roster would have made it HD and halved the day',
        letter(cleanDay, SHIFT_SPLIT), 'HD');
    // Exactly the same row with the pin removed IS re-judged by the roster - today's behaviour
    // for every pre-89b9968 production row, deliberately unchanged.
    const legacyDay = [row({ shift_id: null, check_in: at(D_PAST, '09:00'), check_out: at(D_PAST, '18:00') })];
    eq('an unpinned legacy row still takes the roster path',
        letter(legacyDay, R.shiftForDay(legacyDay, shiftsById, SHIFT_SPLIT)), 'HD');
}

group('stored status and punch_source override the recomputation');
{
    eq('manual override: the admin edit is the answer',
        letter([row({ status: 'half-day', punch_source: 'manual' })], SHIFT_STANDARD), 'HD');
    eq('manual_override too',
        letter([row({ status: 'absent', punch_source: 'manual_override' })], SHIFT_STANDARD), 'A');
    const manual = detail([row({ status: 'absent', punch_source: 'manual_override' })], SHIFT_STANDARD);
    eq('a manual override says so, and keeps the punch sentence after it',
        manual.explanation, 'Absent (manual override by an admin) | S1: On-Time (09:00 - 18:00)');

    eq('regularized status -> R', letter([row({ status: 'regularized' })], SHIFT_STANDARD), 'R');
    eq('regularization punch_source -> R', letter([row({ punch_source: 'regularization' })], SHIFT_STANDARD), 'R');
    eq('an approved regularization with no punch at all -> R', letter([], SHIFT_STANDARD, { regularization: true }), 'R');
    eq('...and says so', detail([], SHIFT_STANDARD, { regularization: true }).explanation,
        'Regularized (approved, no punch recorded)');
    eq('an approved early out with no punch at all -> E', letter([], SHIFT_STANDARD, { earlyOutRequest: true }), 'E');
    eq('a day with nothing on it at all -> null (the caller falls through to resolveNoLogStatus)',
        letter([], SHIFT_STANDARD), null);

    eq('stored early_out -> E', letter([row({ status: 'early_out' })], SHIFT_STANDARD), 'E');
    eq('stored late -> the punches decide (a stored `late` is not in the override list)',
        letter([row({ status: 'late', check_in: at(D_PAST, '09:30') })], SHIFT_STANDARD), 'L');
    eq('stored short -> HD', letter([row({ status: 'short' })], SHIFT_STANDARD), 'HD');
    eq('stored absent -> A', letter([row({ status: 'absent' })], SHIFT_STANDARD), 'A');
    eq('stored off -> OFF', letter([row({ status: 'off' })], SHIFT_STANDARD), 'OFF');

    // A held 'pending' row: the engine stamps it purely to hold the day for an approver.
    eq('pending WITH a checkout is recomputed from the punches',
        letter([row({ status: 'pending', check_in: at(D_PAST, '09:30') })], SHIFT_STANDARD), 'L');
    eq('pending with no checkout, on a past day -> A',
        letter([row({ status: 'pending', check_out: null })], SHIFT_STANDARD), 'A');
    eq('pending with no checkout, today -> CI',
        letter([row({ status: 'pending', check_in: at(D_TODAY, '09:00'), check_out: null })], SHIFT_STANDARD), 'CI');
}

group('approver decisions: the row that carries them is not recomputed from the clock');
{
    // punch_source 'entry_request' or an approved early-out means an approver settled this day.
    const approvedLate = detail([row({ status: 'late', punch_source: 'entry_request', check_in: at(D_PAST, '09:45') })], SHIFT_STANDARD);
    eq('approved late_in -> L', approvedLate.status, 'L');
    eq('approved present -> P',
        letter([row({ status: 'present', punch_source: 'entry_request' })], SHIFT_STANDARD), 'P');
    eq('approved half-day -> HD',
        letter([row({ status: 'half-day', punch_source: 'entry_request' })], SHIFT_STANDARD), 'HD');
    eq('approved absent -> A',
        letter([row({ status: 'absent', punch_source: 'entry_request' })], SHIFT_STANDARD), 'A');
    eq('anything else on an approver-settled row -> E',
        letter([row({ status: 'early_out', punch_source: 'entry_request' })], SHIFT_STANDARD), 'E');

    // 955b500's drawer fix: an APPROVED early out reads P and the sentence says why, while a
    // rejected/pending one reads E and keeps the punch sentence. The letter and the sentence
    // beside it must never contradict each other again.
    const earlyPunches = [row({ status: 'early_out', check_in: at(D_PAST, '09:00'), check_out: at(D_PAST, '13:30') })];
    const approved = detail(earlyPunches.map(r => Object.assign({}, r, { status: 'present' })), SHIFT_STANDARD, { earlyOutRequest: true });
    eq('approved early out -> P', approved.status, 'P');
    eq('approved early out explains the override and keeps the punch sentence',
        approved.explanation, 'Present (approver decision applied) | S1: Early Out (09:00 - 13:30)');
    const notApproved = detail(earlyPunches, SHIFT_STANDARD);
    eq('un-approved early out -> E', notApproved.status, 'E');
    eq('...and its sentence reports the early departure, not "On-Time"',
        notApproved.explanation, 'S1: Early Out (09:00 - 13:30)');
    eq('rejected and approved do not share an explanation', approved.explanation === notApproved.explanation, false);
}

group('early-out payroll weight: approved 1.0, rejected 0.5, pending 0.5, no request 1.0');
{
    // payrollService: paidDays = P + L + OFF + H + PL. The letter E is identical in all four
    // cases, so the request state has to travel separately or a refusal is invisible to payroll.
    eq('approved', R.earlyOutDayWeight('approved'), 1);
    eq('rejected', R.earlyOutDayWeight('rejected'), 0.5);
    eq('pending', R.earlyOutDayWeight('pending'), 0.5);
    eq('no request at all', R.earlyOutDayWeight(null), 1);
    eq('unknown state is treated as no request', R.earlyOutDayWeight('withdrawn'), 1);
    eq('case is not significant', R.earlyOutDayWeight('REJECTED'), 0.5);

    eq('E + approved banks a full day', S(weight('E', { earlyOutRequest: 'approved' })), S({ P: 1 }));
    eq('E + rejected banks half', S(weight('E', { earlyOutRequest: 'rejected' })), S({ P: 0.5 }));
    eq('E + pending banks half', S(weight('E', { earlyOutRequest: 'pending' })), S({ P: 0.5 }));
    eq('E + no request banks a full day', S(weight('E')), S({ P: 1 }));
}

group('stats weights for every letter');
{
    eq('P', S(weight('P')), S({ P: 1 }));
    eq('R counts as a present day', S(weight('R')), S({ P: 1 }));
    eq('HD', S(weight('HD')), S({ P: 0.5 }));
    eq('L lands in its own bucket (paid)', S(weight('L')), S({ L: 1 }));
    eq('A', S(weight('A')), S({ A: 1 }));
    eq('OFF', S(weight('OFF')), S({ OFF: 1 }));
    eq('H', S(weight('H')), S({ H: 1 }));
    eq('PL', S(weight('PL')), S({ PL: 1 }));
    eq('UL', S(weight('UL')), S({ UL: 1 }));
    eq('a half-day paid leave', S(weight('PL', { amount: 0.5 })), S({ PL: 0.5 }));
    eq('a half-day unpaid leave', S(weight('UL', { amount: 0.5 })), S({ UL: 0.5 }));
    eq('CI counts towards nothing - the day is not over', S(weight('CI')), S({}));
    eq("'-' counts towards nothing", S(weight('-')), S({}));
}

group('days with no attendance at all: weekoff -> holiday -> leave -> absent/blank');
{
    const base = { weekoffs: ['Sunday'], holidays: [], leaves: [], shift: SHIFT_STANDARD, todayStr: TODAY_STR, now: NOW };
    const no = (dateStr, over = {}) => R.resolveNoLogStatus(dateStr, Object.assign({}, base, over));

    eq('a Sunday is OFF', no(D_SUN), { status: 'OFF', amount: 1 });
    eq('a weekday with nothing on it is A', no(D_PAST), { status: 'A', amount: 1 });
    eq('the weekday name is computed at UTC noon so no timezone can shift it',
        R.dayNameForDateStr(D_SUN), 'Sunday');
    eq('...for the whole week', ['2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15', '2026-05-16', '2026-05-17'].map(R.dayNameForDateStr),
        ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    eq('a malformed date has no day name', R.dayNameForDateStr('not-a-date'), null);

    // The holiday test compares the WHOLE date. The muster compared day-of-month only, which is
    // correct only while `holidays` is month-scoped - a precondition two of the three callers
    // do not meet.
    eq('a holiday is H', no(D_PAST, { holidays: [{ date: D_PAST }] }), { status: 'H', amount: 1 });
    eq('a holiday in ANOTHER month with the same day-of-month is not this day',
        no(D_PAST, { holidays: [{ date: '2026-04-12' }] }), { status: 'A', amount: 1 });
    eq('a weekoff outranks a holiday', no(D_SUN, { holidays: [{ date: D_SUN }] }), { status: 'OFF', amount: 1 });

    const paid = [{ start_date: '2026-05-11', end_date: '2026-05-13', days: 3, leave_type_name: 'Casual Leave' }];
    const unpaid = [{ start_date: '2026-05-11', end_date: '2026-05-13', days: 3, leave_type_name: 'Unpaid Leave' }];
    const lop = [{ start_date: D_PAST, end_date: D_PAST, days: 1, leave_type_name: 'LOP' }];
    const half = [{ start_date: D_PAST, end_date: D_PAST, days: 0.5, leave_type_name: 'Casual Leave' }];
    const halfUnpaid = [{ start_date: D_PAST, end_date: D_PAST, days: 0.5, leave_type_name: 'Unpaid Leave' }];

    eq('a paid leave day is PL', no(D_PAST, { leaves: paid }), { status: 'PL', amount: 1 });
    eq('an unpaid leave day is UL', no(D_PAST, { leaves: unpaid }), { status: 'UL', amount: 1 });
    eq('LOP is unpaid too', no(D_PAST, { leaves: lop }), { status: 'UL', amount: 1 });
    eq('a half-day paid leave is PL worth 0.5', no(D_PAST, { leaves: half }), { status: 'PL', amount: 0.5 });
    eq('a half-day unpaid leave is UL worth 0.5', no(D_PAST, { leaves: halfUnpaid }), { status: 'UL', amount: 0.5 });
    eq('a multi-day leave covers its interior days', no('2026-05-12', { leaves: paid }), { status: 'PL', amount: 1 });
    eq('...and not the day after it', no('2026-05-14', { leaves: paid }), { status: 'A', amount: 1 });
    eq('a 0.5-day leave spanning two dates is NOT a half day', no(D_PAST, {
        leaves: [{ start_date: D_PAST, end_date: '2026-05-13', days: 0.5, leave_type_name: 'Casual Leave' }]
    }), { status: 'PL', amount: 1 });
    eq('a holiday outranks a leave', no(D_PAST, { holidays: [{ date: D_PAST }], leaves: paid }), { status: 'H', amount: 1 });

    // The class of bug this whole function exists for: a date that has not happened yet must be
    // blank, not Absent. The history sheet used to print 24 x "A" for a future September.
    eq('a future date is blank, not Absent', no(D_FUTURE), { status: '-', amount: 0 });
    eq('a future date still shows an approved leave', no('2026-05-25', {
        leaves: [{ start_date: '2026-05-25', end_date: '2026-05-25', days: 1, leave_type_name: 'Casual Leave' }]
    }), { status: 'PL', amount: 1 });
    eq('TODAY, before the shift is over, is blank rather than an accusation', no(D_TODAY), { status: '-', amount: 0 });
    eq('TODAY, once terminate_hour has passed, is Absent',
        R.resolveNoLogStatus(D_TODAY, Object.assign({}, base, { now: NOW_LATE })), { status: 'A', amount: 1 });
    eq('with no shift to judge by, today stays blank',
        R.resolveNoLogStatus(D_TODAY, Object.assign({}, base, { shift: null, now: NOW_LATE })), { status: '-', amount: 0 });
    eq('an empty date is blank', no(null), { status: '-', amount: 0 });
}

group('status vocabulary mapping');
{
    [['present', 'P'], ['p', 'P'], ['absent', 'A'], ['a', 'A'], ['short', 'HD'], ['half-day', 'HD'],
     ['half_day', 'HD'], ['hd', 'HD'], ['late', 'L'], ['late_in', 'L'], ['late-in', 'L'], ['l', 'L'],
     ['early_out', 'E'], ['early-out', 'E'], ['eo', 'E'], ['earlyout', 'E'], ['off', 'OFF'],
     ['regularized', 'R'], ['r', 'R'], ['checked_in', 'CI'], ['ci', 'CI'], ['checked-in', 'CI'],
     ['pending', '-'], ['', 'P'], ['  PRESENT  ', 'P'], ['gibberish', 'P']]
        .forEach(([db, ui]) => eq(`db '${db}' -> ${ui}`, R.mapDbStatusToFrontend(db), ui));
    eq('null -> A', R.mapDbStatusToFrontend(null), 'A');
    eq('undefined -> A', R.mapDbStatusToFrontend(undefined), 'A');

    [['P', 'present'], ['A', 'absent'], ['OFF', 'off'], ['R', 'regularized'], ['HD', 'half-day'],
     ['CI', 'present'], ['E', 'early_out'], ['EO', 'early_out'], ['L', 'present']]
        .forEach(([ui, db]) => eq(`ui '${ui}' -> ${db}`, R.mapFrontendStatusToDb(ui), db));
    eq('nothing -> absent', R.mapFrontendStatusToDb(null), 'absent');
}

group('sentence fragments');
{
    eq('no violations', R.punchMarks(false, false), 'On-Time');
    eq('late only', R.punchMarks(true, false), 'Late In');
    eq('early only', R.punchMarks(false, true), 'Early Out');
    eq('both, in that order', R.punchMarks(true, true), 'Late In, Early Out');
    eq('an override keeps the punch sentence after it',
        R.overrideExplanation('P', 'approver decision applied', { explanation: 'S1: Early Out (09:00 - 13:30)' }),
        'Present (approver decision applied) | S1: Early Out (09:00 - 13:30)');
    eq('...and copes with no punch sentence', R.overrideExplanation('HD', 'why', null), 'Half Day (why)');
    eq('an unknown letter falls back to itself', R.overrideExplanation('XX', 'why', null), 'XX (why)');
}

group('grace-period arrival test');
{
    const emp = { shift_start: '09:00', shift_end: '18:00', shift_grace: 15 };
    eq('09:10 used the grace', R.checkIfLogUsedGrace({ check_in: at(D_PAST, '09:10') }, emp, RULES), true);
    eq('09:00 exactly did not (not yet late)', R.checkIfLogUsedGrace({ check_in: at(D_PAST, '09:00') }, emp, RULES), false);
    eq('09:15 is the last grace minute', R.checkIfLogUsedGrace({ check_in: at(D_PAST, '09:15') }, emp, RULES), true);
    eq('09:16 is past it', R.checkIfLogUsedGrace({ check_in: at(D_PAST, '09:16') }, emp, RULES), false);
    eq('a scheme grace overrides the shift grace',
        R.checkIfLogUsedGrace({ check_in: at(D_PAST, '09:25') }, { shift_start: '09:00', shift_end: '18:00', scheme_grace: 30 }, RULES), true);
    eq('no check_in, no grace', R.checkIfLogUsedGrace({ check_in: null }, emp, RULES), false);
    // A night shift's 22:00 start with a 02:00 arrival belongs to the previous logical day.
    const nightEmp = { shift_start: '22:00', shift_end: '06:00', shift_grace: 15 };
    eq('a night shift 02:00 arrival is not within a 22:00 grace window',
        R.checkIfLogUsedGrace({ check_in: at('2026-05-13', '02:00') }, nightEmp, RULES), false);
    eq('a night shift 22:10 arrival is', R.checkIfLogUsedGrace({ check_in: at('2026-05-12', '22:10') }, nightEmp, RULES), true);
}

group('the datetime primitives the whole path is written against');
{
    eq('a DB string is read as IST wall-clock', T.toLocalYMD('2026-05-12 23:45:00'), '2026-05-12');
    eq('...and does not slide to the next day under any server timezone', T.toLocalYMD('2026-05-12 00:15:00'), '2026-05-12');
    eq('minutes since IST midnight', T.dateToISTMins('2026-05-12 09:30:00'), 570);
    eq('midnight is 0', T.dateToISTMins('2026-05-12 00:00:00'), 0);
    eq('null is 0', T.dateToISTMins(null), 0);
    eq('a formatted time is IST HH:mm', T.safeFormatTime('2026-05-12 09:05:00'), '09:05');
    eq('null formats to null', T.safeFormatTime(null), null);
    eq('a full timestamp round-trips', T.toLocalYYYYMMDDHHmmss('2026-05-12 09:05:07'), '2026-05-12 09:05:07');
    eq('an IST day string from an instant', T.istDateStr(new Date('2026-05-20T23:59:00+05:30')), '2026-05-20');
    eq('...and from the instant one minute later', T.istDateStr(new Date('2026-05-21T00:01:00+05:30')), '2026-05-21');
    // An approver types a bare time; it belongs to the request's SHIFT day, not to the calendar
    // day an ambiguous night punch landed on.
    eq('a bare HH:mm is anchored to the shift day', T.resolveRequestPunchTime('20:10', '2026-05-12'), '2026-05-12 20:10:00');
    eq('a bare H:mm too', T.resolveRequestPunchTime('9:05', '2026-05-12'), '2026-05-12 09:05:00');
    eq('HH:mm:ss too', T.resolveRequestPunchTime('20:10:30', '2026-05-12'), '2026-05-12 20:10:30');
    eq('a full timestamp is taken as given', T.resolveRequestPunchTime('2026-05-13 02:00:00', '2026-05-12'), '2026-05-13 02:00:00');
    eq('nothing in, nothing out', T.resolveRequestPunchTime(null, '2026-05-12'), null);
}

group('every letter x every no-log overlay, exhaustively');
{
    // The grid is what the four screens actually render. Walk it once so a change to any single
    // branch shows up as a named failure rather than as a silently different cell.
    const shifts = [['standard', SHIFT_STANDARD], ['split', SHIFT_SPLIT], ['flexi', SHIFT_FLEXI], ['night', SHIFT_NIGHT]];
    const pins = [['pinned', 100], ['null-pin', null]];
    const shiftsById = { 100: SHIFT_STANDARD };

    // A clean full day under each shift type, pinned and not. The pin resolves to the standard
    // shift, so a pinned split/flexi/night day must read as a STANDARD day - that is the point.
    const expect = {
        'standard|pinned': 'P', 'standard|null-pin': 'P',
        'split|pinned': 'P', 'split|null-pin': 'HD',
        'flexi|pinned': 'P', 'flexi|null-pin': 'P',
        // 09:00-18:00 punches judged against a 22:00-06:00 shift read P: 09:00 is not "after
        // 22:00 + grace", and 18:00 is not "before 06:00". The letter says nothing is wrong even
        // though the employee worked an entirely different shift - which is exactly why the pin
        // matters more than the letter looks like it should.
        'night|pinned': 'P', 'night|null-pin': 'P'
    };
    for (const [sName, shift] of shifts) {
        for (const [pName, pin] of pins) {
            const logs = [row({ shift_id: pin, check_in: at(D_PAST, '09:00'), check_out: at(D_PAST, '18:00') })];
            const resolved = R.shiftForDay(logs, shiftsById, shift);
            eq(`${sName} x ${pName}`, letter(logs, resolved), expect[`${sName}|${pName}`]);
        }
    }

    // Every letter a stats bucket can receive, from a day with no punches.
    const overlays = [
        ['weekoff', { weekoffs: ['Tuesday'] }, 'OFF', { OFF: 1 }],
        ['holiday', { holidays: [{ date: D_PAST }] }, 'H', { H: 1 }],
        ['paid leave', { leaves: [{ start_date: D_PAST, end_date: D_PAST, days: 1, leave_type_name: 'Casual' }] }, 'PL', { PL: 1 }],
        ['unpaid leave', { leaves: [{ start_date: D_PAST, end_date: D_PAST, days: 1, leave_type_name: 'Unpaid' }] }, 'UL', { UL: 1 }],
        ['half-day leave', { leaves: [{ start_date: D_PAST, end_date: D_PAST, days: 0.5, leave_type_name: 'Casual' }] }, 'PL', { PL: 0.5 }],
        ['nothing', {}, 'A', { A: 1 }]
    ];
    for (const [name, over, expectedStatus, expectedStats] of overlays) {
        const base = { weekoffs: [], holidays: [], leaves: [], shift: SHIFT_STANDARD, todayStr: TODAY_STR, now: NOW };
        const res = R.resolveNoLogStatus(D_PAST, Object.assign({}, base, over));
        eq(`no-log overlay: ${name} letter`, res.status, expectedStatus);
        eq(`no-log overlay: ${name} weight`, S(weight(res.status, { amount: res.amount })), S(expectedStats));
    }
}

// =============================================================================================
console.log('');
if (failures.length) {
    console.log(`${passed}/${passed + failures.length} assertions passed. ${failures.length} FAILED:\n`);
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
}
console.log(`${passed}/${passed} assertions passed. (no database was used)`);
