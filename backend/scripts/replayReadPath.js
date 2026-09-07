#!/usr/bin/env node
/**
 * Read-path regression harness — the muster / history sheet / date-wise / day-detail /
 * my-attendance analogue of replayPunches.js.
 *
 * replayPunches.js guards the WRITE path: what processPunch() stores for a sequence of
 * punches. Nothing guarded the READ path, and that is where the last round of bugs lived:
 * five screens render the same stored row and each one used to decide for itself what the
 * row meant. A day could read OFF on the admin grid, Absent on the employee's history sheet
 * and Absent again on the date-wise screen, with the day-detail drawer showing a status
 * letter next to a sentence that contradicted it — all from one unchanged database row. The
 * employee's own "My Attendance" screen was worse still: it did no resolution at all and
 * printed the raw database word (`pending`, `late`) at the person it was about.
 *
 * So this harness seeds deterministic days (every shift type x pinned vs unpinned shift_id x
 * weekoff / holiday / leave / future-date overlay x the status letters), then asks all five
 * read functions about the same employee-month and asserts they agree cell for cell. A screen
 * that starts answering differently from the other four fails here.
 *
 * SAFETY: refuses to run against a database whose name is not clearly a scratch database.
 * It creates and drops its own fixture rows, so pointing it at real data would destroy them.
 *
 * Usage:
 *   npm run readpath:replay              (from backend/, uses myfasthr_readpath_replay)
 *   DB_NAME=my_scratch_db npm run readpath:replay
 *
 * Set up the scratch database once:
 *   docker exec myfasthr-mysql mysqldump -uroot --no-data --no-tablespaces myfasthr_db \
 *     > /tmp/schema.sql
 *   docker exec myfasthr-mysql mysql -uroot -e "DROP DATABASE IF EXISTS myfasthr_readpath_replay; \
 *     CREATE DATABASE myfasthr_readpath_replay"
 *   docker exec -i myfasthr-mysql mysql -uroot myfasthr_readpath_replay < /tmp/schema.sql
 *   DB_NAME=myfasthr_readpath_replay PORT=5062 node src/server.js   # once, so
 *     syncDatabaseSchema() adds attendance.shift_id / logical_date, then Ctrl-C
 *
 * TZ matters. Production runs UTC while all attendance logic is written against
 * Asia/Kolkata, and several past bugs only reproduced under one of the two. The npm script
 * pins TZ=Etc/UTC to match production; run it a second time with TZ=Asia/Kolkata when you
 * touch date handling, and expect identical results.
 *
 * The month under test is the PREVIOUS calendar month, so every day in it is settled and the
 * expectations do not move with the clock. A second, smaller sweep over the CURRENT month
 * covers the future-date column, which is the one the history sheet used to call Absent.
 */

const DB_NAME = process.env.DB_NAME || 'myfasthr_readpath_replay';

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
const attendanceService = require('../src/services/attendanceService');

// Fixture identifiers, chosen high enough not to collide with anything a schema dump carries.
const CO = 990201;
const SH_GEN = 990210;     // 09:00-18:00, 2 punches
const SH_NIGHT = 990211;   // 22:00-06:00, crosses midnight
const SH_SPLIT = 990212;   // 09:00-13:00 / 17:00-21:00, 4 punches
const SH_FLEXI = 990213;   // min_hours only, no clock to be late against
const LT_PAID = 990220;
const LT_UNPAID = 990221;

const ADMIN = { company_id: CO, role_name: 'company_admin' };

const results = [];
let failures = 0;

function check(scenario, label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    results.push({ scenario, label, ok, actual, expected });
}

// ---------------------------------------------------------------------------
// Dates. Built at UTC noon so no server timezone can push a fixture off its
// calendar date, which is the whole class of bug this file exists to catch.
// ---------------------------------------------------------------------------
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = n => String(n).padStart(2, '0');

function ymd(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
function dayNameOf(y, m, d) { return DAY_NAMES[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()]; }
function daysIn(y, m) { return new Date(Date.UTC(y, m, 0, 12)).getUTCDate(); }

const TODAY = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
const [CUR_Y, CUR_M, CUR_D] = TODAY.split('-').map(Number);
const PAST_M = CUR_M === 1 ? 12 : CUR_M - 1;
const PAST_Y = CUR_M === 1 ? CUR_Y - 1 : CUR_Y;
const PAST_DIM = daysIn(PAST_Y, PAST_M);
const CUR_DIM = daysIn(CUR_Y, CUR_M);

const P = d => ymd(PAST_Y, PAST_M, d);
const isSunday = d => dayNameOf(PAST_Y, PAST_M, d) === 'Sunday';

const ALL_DAYS = Array.from({ length: PAST_DIM }, (_, i) => i + 1);
const WORKDAYS = ALL_DAYS.filter(d => !isSunday(d));

// Scenario days. Taken from the non-Sunday days so the weekoff rule never masks a fixture.
const D_ONTIME = WORKDAYS[0];
const D_LATE = WORKDAYS[1];
const D_EARLY = WORKDAYS[2];
const D_HALF = WORKDAYS[3];
// WORKDAYS[4] is deliberately left bare: a plain past workday with no punch, which must read A.
const D_PENDING = WORKDAYS[5];
const D_REJECTED = WORKDAYS[6];
const D_APPROVED = WORKDAYS[7];
const D_REGULARIZED = WORKDAYS[8];
const D_PAID_LEAVE = WORKDAYS[9];
const D_UNPAID_LEAVE = WORKDAYS[10];
const D_HALF_LEAVE = WORKDAYS[11];
const D_HOLIDAY = WORKDAYS[WORKDAYS.length - 1];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function resetFixtures() {
    await db('attendance').where({ company_id: CO }).del();
    await db('attendance_entry_requests').where({ company_id: CO }).del();
    await db('attendance_regularizations').where({ company_id: CO }).del();
    await db('employee_shift_assignments').where({ company_id: CO }).del();
    await db('leaves').where({ company_id: CO }).del();
    await db('leave_types').where({ company_id: CO }).del();
    await db('holidays').where({ company_id: CO }).del();
    await db('employees').where({ company_id: CO }).del();
    await db('working_rules').where({ company_id: CO }).del();
    await db('shifts').where({ company_id: CO }).del();
    await db('companies').where({ id: CO }).del();
}

async function seedCommon() {
    await db('companies').insert({ id: CO, name: 'Read Path Harness Co', email: 'readpath@harness.invalid' });
    await db('working_rules').insert({
        company_id: CO, shift_start: '09:00', shift_end: '18:00', grace_period: 15,
        half_day_hours: 4, weekoffs: JSON.stringify(['Sunday'])
    });

    const base = {
        company_id: CO, grace_period: 15, grace_count_limit: 30, is_flexi: 0,
        total_punches_required: 2, session1_in_margin: 30, session1_out_margin: 5, terminate_hour: 2
    };
    await db('shifts').insert([
        { ...base, id: SH_GEN, name: 'RP General 09-18', start_time: '09:00', end_time: '18:00', min_hours: 9.0 },
        { ...base, id: SH_NIGHT, name: 'RP Night 22-06', start_time: '22:00', end_time: '06:00', min_hours: 8.0 },
        {
            ...base, id: SH_SPLIT, name: 'RP Split 09-13/17-21', start_time: '09:00', end_time: '13:00',
            min_hours: 8.0, total_punches_required: 4,
            session2_start_time: '17:00', session2_end_time: '21:00',
            session2_in_margin: 30, session2_out_margin: 5, session2_grace_in: 15
        },
        {
            ...base, id: SH_FLEXI, name: 'RP Flexi 8h', start_time: '00:00', end_time: '23:59',
            is_flexi: 1, min_hours: 8.0, session1_in_margin: 0, session1_out_margin: 0, terminate_hour: null
        }
    ]);

    await db('leave_types').insert([
        { id: LT_PAID, company_id: CO, name: 'RP Privilege Leave' },
        { id: LT_UNPAID, company_id: CO, name: 'RP Unpaid Leave' }
    ]);

    await db('holidays').insert({
        company_id: CO, name: 'RP Founders Day', date: P(D_HOLIDAY), type: 'fixed'
    });
}

let empSeq = 990300;
async function makeEmployee(shiftId) {
    const id = empSeq++;
    await db('employees').insert({
        id, company_id: CO, employee_id_number: String(id), first_name: `RP${id}`, last_name: 'Harness',
        email: `rp${id}@harness.invalid`, status: 'active', shift_id: shiftId
    });
    await db('employee_shift_assignments').insert({
        company_id: CO, employee_id: id, shift_id: shiftId,
        // Starts well before the month under test so the roster covers every fixture day.
        from_date: ymd(PAST_Y, PAST_M, 1), to_date: null
    });
    return id;
}

/**
 * One attendance row. `pin` writes attendance.shift_id — the pin 89b9968 added. Passing
 * pin:null reproduces every row that predates it, which must still render identically via
 * the date-based roster fallback.
 */
async function punchRow(empId, logicalDay, inTime, outTime, status, opts = {}) {
    const { pin = null, source = 'biometric', outDay = logicalDay } = opts;
    await db('attendance').insert({
        employee_id: empId,
        company_id: CO,
        check_in: `${P(logicalDay)} ${inTime}`,
        check_out: outTime ? `${P(outDay)} ${outTime}` : null,
        status,
        punch_source: source,
        logical_date: P(logicalDay),
        shift_id: pin
    });
}

// ---------------------------------------------------------------------------
// The employees and what each of their days must read on every screen.
// ---------------------------------------------------------------------------
const EMPLOYEES = {};   // key -> { id, shift, expectPast: {day: letter}, expectStats }

function baselinePast() {
    const grid = {};
    for (const d of ALL_DAYS) {
        if (isSunday(d)) grid[d] = 'OFF';
        else if (d === D_HOLIDAY) grid[d] = 'H';
        else grid[d] = 'A';
    }
    return grid;
}

async function seedEmployees() {
    // --- 1. General 2-punch shift, rows PINNED to the shift they were worked under -------
    const genPinned = await makeEmployee(SH_GEN);
    await punchRow(genPinned, D_ONTIME, '09:00:00', '18:05:00', 'present', { pin: SH_GEN });
    await punchRow(genPinned, D_LATE, '09:30:00', '18:05:00', 'late', { pin: SH_GEN });
    await punchRow(genPinned, D_EARLY, '09:00:00', '13:30:00', 'early_out', { pin: SH_GEN });
    await punchRow(genPinned, D_HALF, '09:00:00', '12:00:00', 'half-day', { pin: SH_GEN });
    await db('leaves').insert([
        {
            employee_id: genPinned, company_id: CO, leave_type_id: LT_PAID,
            start_date: P(D_PAID_LEAVE), end_date: P(D_PAID_LEAVE), days: 1,
            reason: 'rp paid', status: 'approved'
        },
        {
            employee_id: genPinned, company_id: CO, leave_type_id: LT_UNPAID,
            start_date: P(D_UNPAID_LEAVE), end_date: P(D_UNPAID_LEAVE), days: 1,
            reason: 'rp unpaid', status: 'approved'
        },
        {
            employee_id: genPinned, company_id: CO, leave_type_id: LT_PAID,
            start_date: P(D_HALF_LEAVE), end_date: P(D_HALF_LEAVE), days: 0.5,
            reason: 'rp half paid', status: 'approved'
        }
    ]);
    const genPinnedGrid = baselinePast();
    genPinnedGrid[D_ONTIME] = 'P';
    genPinnedGrid[D_LATE] = 'L';
    genPinnedGrid[D_EARLY] = 'E';
    genPinnedGrid[D_HALF] = 'HD';
    genPinnedGrid[D_PAID_LEAVE] = 'PL';
    genPinnedGrid[D_UNPAID_LEAVE] = 'UL';
    genPinnedGrid[D_HALF_LEAVE] = 'PL';
    EMPLOYEES.gen_pinned = { id: genPinned, expectPast: genPinnedGrid };

    // --- 2. Same shift, same punches, shift_id NULL: every pre-89b9968 production row -----
    const genUnpinned = await makeEmployee(SH_GEN);
    await punchRow(genUnpinned, D_ONTIME, '09:00:00', '18:05:00', 'present');
    await punchRow(genUnpinned, D_LATE, '09:30:00', '18:05:00', 'late');
    await punchRow(genUnpinned, D_EARLY, '09:00:00', '13:30:00', 'early_out');
    await punchRow(genUnpinned, D_HALF, '09:00:00', '12:00:00', 'half-day');
    const genUnpinnedGrid = baselinePast();
    genUnpinnedGrid[D_ONTIME] = 'P';
    genUnpinnedGrid[D_LATE] = 'L';
    genUnpinnedGrid[D_EARLY] = 'E';
    genUnpinnedGrid[D_HALF] = 'HD';
    EMPLOYEES.gen_unpinned = { id: genUnpinned, expectPast: genUnpinnedGrid };

    // --- 3. Night shift: check-out lands on the next calendar day ------------------------
    const night = await makeEmployee(SH_NIGHT);
    await punchRow(night, D_ONTIME, '22:00:00', '06:05:00', 'present', { pin: SH_NIGHT, outDay: D_ONTIME + 1 });
    await punchRow(night, D_LATE, '22:30:00', '06:05:00', 'late', { pin: SH_NIGHT, outDay: D_LATE + 1 });
    await punchRow(night, D_EARLY, '22:00:00', '03:00:00', 'early_out', { pin: SH_NIGHT, outDay: D_EARLY + 1 });
    const nightGrid = baselinePast();
    nightGrid[D_ONTIME] = 'P';
    nightGrid[D_LATE] = 'L';
    nightGrid[D_EARLY] = 'E';
    EMPLOYEES.night = { id: night, expectPast: nightGrid };

    // --- 4. Split / 4-punch: two rows are the CORRECT shape of one day -------------------
    const split = await makeEmployee(SH_SPLIT);
    await punchRow(split, D_ONTIME, '09:00:00', '13:00:00', 'present', { pin: SH_SPLIT });
    await punchRow(split, D_ONTIME, '17:00:00', '21:00:00', 'present', { pin: SH_SPLIT });
    await punchRow(split, D_LATE, '09:30:00', '13:00:00', 'late', { pin: SH_SPLIT });
    await punchRow(split, D_LATE, '17:00:00', '21:00:00', 'present', { pin: SH_SPLIT });
    await punchRow(split, D_HALF, '09:00:00', '13:00:00', 'present', { pin: SH_SPLIT });
    const splitGrid = baselinePast();
    splitGrid[D_ONTIME] = 'P';
    splitGrid[D_LATE] = 'L';
    splitGrid[D_HALF] = 'HD';
    EMPLOYEES.split = { id: split, expectPast: splitGrid };

    // --- 5. Flexi: min_hours is the entire rule ------------------------------------------
    const flexi = await makeEmployee(SH_FLEXI);
    await punchRow(flexi, D_ONTIME, '11:20:00', '20:40:00', 'present', { pin: SH_FLEXI });
    await punchRow(flexi, D_HALF, '11:20:00', '14:00:00', 'half-day', { pin: SH_FLEXI });
    const flexiGrid = baselinePast();
    flexiGrid[D_ONTIME] = 'P';
    flexiGrid[D_HALF] = 'HD';
    EMPLOYEES.flexi = { id: flexi, expectPast: flexiGrid };

    // --- 6. The request states. Identical 09:00 -> 13:30 punches on all three, and only ---
    //        the approver's decision separates them.
    const req = await makeEmployee(SH_GEN);
    await punchRow(req, D_ONTIME, '09:00:00', '18:05:00', 'present', { pin: SH_GEN });
    await punchRow(req, D_LATE, '09:30:00', '18:05:00', 'late', { pin: SH_GEN });
    await punchRow(req, D_EARLY, '09:00:00', '13:30:00', 'early_out', { pin: SH_GEN });
    await punchRow(req, D_HALF, '09:00:00', '12:00:00', 'half-day', { pin: SH_GEN });
    // Nobody has decided yet: the engine holds the row at 'pending'.
    await punchRow(req, D_PENDING, '09:00:00', '13:30:00', 'pending', { pin: SH_GEN });
    // Rejected: 92e238b settles the held row on what the device recorded.
    await punchRow(req, D_REJECTED, '09:00:00', '13:30:00', 'early_out', { pin: SH_GEN });
    // Approved: the shortfall is excused and the row settles to present.
    await punchRow(req, D_APPROVED, '09:00:00', '13:30:00', 'present', { pin: SH_GEN });
    await punchRow(req, D_REGULARIZED, '09:00:00', '18:00:00', 'regularized', { pin: SH_GEN, source: 'regularization' });
    await db('attendance_entry_requests').insert([
        { company_id: CO, employee_id: req, date: P(D_PENDING), request_type: 'early_out', punch_time: `${P(D_PENDING)} 13:30:00`, status: 'pending' },
        { company_id: CO, employee_id: req, date: P(D_REJECTED), request_type: 'early_out', punch_time: `${P(D_REJECTED)} 13:30:00`, status: 'rejected' },
        { company_id: CO, employee_id: req, date: P(D_APPROVED), request_type: 'early_out', punch_time: `${P(D_APPROVED)} 13:30:00`, status: 'approved' }
    ]);
    await db('attendance_regularizations').insert({
        company_id: CO, employee_id: req, date: P(D_REGULARIZED),
        reason: 'rp regularization', status: 'approved'
    });
    const reqGrid = baselinePast();
    reqGrid[D_ONTIME] = 'P';
    reqGrid[D_LATE] = 'L';
    reqGrid[D_EARLY] = 'E';
    reqGrid[D_HALF] = 'HD';
    reqGrid[D_PENDING] = 'E';
    reqGrid[D_REJECTED] = 'E';
    reqGrid[D_APPROVED] = 'P';
    reqGrid[D_REGULARIZED] = 'R';
    EMPLOYEES.req = { id: req, expectPast: reqGrid };
}

// ---------------------------------------------------------------------------
// Reading the four screens
// ---------------------------------------------------------------------------
async function readMatrix(month, year) {
    const { matrix } = await attendanceService.getMatrix(ADMIN, month, year);
    const byEmp = {};
    matrix.forEach(m => { byEmp[m.id] = m; });
    return byEmp;
}

async function readHistory(empId, month, year) {
    const dim = daysIn(year, month);
    const sheet = await attendanceService.getEmployeeAttendanceHistory(
        CO, empId, ymd(year, month, 1), ymd(year, month, dim)
    );
    const byDay = {};
    sheet.forEach(row => { byDay[parseInt(row.date.split('-')[2], 10)] = row.status; });
    return byDay;
}

async function readDateWise(month, year) {
    const dim = daysIn(year, month);
    const byDay = {};
    for (let d = 1; d <= dim; d++) {
        const rows = await attendanceService.getDateWiseAttendance(CO, ymd(year, month, d));
        const byEmp = {};
        rows.forEach(r => { byEmp[r.id] = r.status; });
        byDay[d] = byEmp;
    }
    return byDay;
}

/**
 * The fifth screen: "My Attendance", what the EMPLOYEE reads about themselves
 * (attendanceService.getHistory -> GET /api/attendance/history).
 *
 * It was the read path never fixed - a raw `SELECT *` with no shift and no status resolution,
 * printing the database word `pending` / `late` straight at the employee while the muster
 * beside it said E / L, and carrying no row at all for a weekoff, a holiday, a leave day or a
 * future date. It is asserted here so it can never drift back out of alignment.
 *
 * The service takes `user`; `employee_id` on it short-circuits getEmployeeId, so the fixtures
 * do not need a linked `users` row.
 */
async function readMyAttendance(empId, month, year) {
    const rows = await attendanceService.getHistory(
        { id: null, employee_id: empId }, CO, month, year
    );
    const byDay = {};
    rows.forEach(r => { byDay[parseInt(r.date.split('-')[2], 10)] = r.status; });
    return byDay;
}

/** Only the cells that differ, so a failure names the disagreement instead of dumping a month. */
function diffGrid(actual, expected, days) {
    const out = {};
    for (const d of days) {
        const e = expected[d];
        if (e === undefined || e === null) continue;   // deliberately unasserted (e.g. today)
        const a = actual[d];
        if (String(a) !== String(e)) out[d] = `${a} != ${e}`;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * R1: the muster, the history sheet and the date-wise screen must render the same letter for
 * the same day. Before the shared no-log resolver, history and date-wise had no
 * weekoff / holiday / leave / future-date chain at all and called every one of those days
 * Absent.
 */
async function scenarioPastMonthAgreement() {
    const s = 'past month: four screens, one answer';
    const matrix = await readMatrix(PAST_M, PAST_Y);
    const dateWise = await readDateWise(PAST_M, PAST_Y);

    for (const [key, emp] of Object.entries(EMPLOYEES)) {
        const grid = matrix[emp.id] ? matrix[emp.id].days : {};
        const history = await readHistory(emp.id, PAST_M, PAST_Y);
        const mine = await readMyAttendance(emp.id, PAST_M, PAST_Y);
        const dw = {};
        for (const d of ALL_DAYS) dw[d] = dateWise[d][emp.id];

        check(s, `${key}: muster matches the seeded fixtures`, diffGrid(grid, emp.expectPast, ALL_DAYS), {});
        check(s, `${key}: history sheet matches the muster`, diffGrid(history, grid, ALL_DAYS), {});
        check(s, `${key}: date-wise screen matches the muster`, diffGrid(dw, grid, ALL_DAYS), {});
        check(s, `${key}: my-attendance matches the muster`, diffGrid(mine, grid, ALL_DAYS), {});
    }
}

/**
 * The future-date column. The muster leaves a day that has not happened yet blank; the other
 * two screens used to print Absent against it, which is what made 21 of one employee's 30
 * November cells disagree.
 */
async function scenarioCurrentMonthFutureDays() {
    const s = 'current month: future days are blank, not Absent';
    const matrix = await readMatrix(CUR_M, CUR_Y);
    const dateWise = await readDateWise(CUR_M, CUR_Y);
    const days = Array.from({ length: CUR_DIM }, (_, i) => i + 1);

    // Today itself depends on the wall clock (it turns Absent only once the shift has
    // terminated), so it is asserted for cross-screen agreement but not against a letter.
    const expected = {};
    for (const d of days) {
        if (dayNameOf(CUR_Y, CUR_M, d) === 'Sunday') expected[d] = 'OFF';
        else if (d < CUR_D) expected[d] = 'A';
        else if (d > CUR_D) expected[d] = '-';
        else expected[d] = null;
    }

    for (const [key, emp] of Object.entries(EMPLOYEES)) {
        const grid = matrix[emp.id] ? matrix[emp.id].days : {};
        const history = await readHistory(emp.id, CUR_M, CUR_Y);
        const mine = await readMyAttendance(emp.id, CUR_M, CUR_Y);
        const dw = {};
        for (const d of days) dw[d] = dateWise[d][emp.id];

        check(s, `${key}: muster leaves future days blank`, diffGrid(grid, expected, days), {});
        check(s, `${key}: history sheet matches the muster`, diffGrid(history, grid, days), {});
        check(s, `${key}: date-wise screen matches the muster`, diffGrid(dw, grid, days), {});
        check(s, `${key}: my-attendance matches the muster`, diffGrid(mine, grid, days), {});
    }
}

/**
 * A pre-89b9968 row (attendance.shift_id NULL) must render exactly as the same day pinned to
 * its shift. shift_id NULL means "predates the pin", never "no shift".
 */
async function scenarioUnpinnedRowsRenderIdentically() {
    const s = 'unpinned rows (shift_id NULL) render as before';
    const matrix = await readMatrix(PAST_M, PAST_Y);
    const pinned = matrix[EMPLOYEES.gen_pinned.id].days;
    const unpinned = matrix[EMPLOYEES.gen_unpinned.id].days;

    const punchDays = [D_ONTIME, D_LATE, D_EARLY, D_HALF];
    check(s, 'the four punched days read the same pinned and unpinned',
        punchDays.map(d => unpinned[d]),
        punchDays.map(d => pinned[d]));

    const pinnedCount = await db('attendance').where({ company_id: CO, employee_id: EMPLOYEES.gen_unpinned.id }).whereNotNull('shift_id').count({ n: '*' }).first();
    check(s, 'the fixture really is unpinned', Number(pinnedCount.n), 0);
}

/**
 * R3: what an Early Out day is worth to payroll. payrollService computes
 * paidDays = stats.P + L + OFF + H + PL, so a day counted at 1 here is a day paid in full.
 */
async function scenarioEarlyOutPayrollWeight() {
    const s = 'early out: the approver decision reaches the number payroll reads';
    const matrix = await readMatrix(PAST_M, PAST_Y);
    const stats = matrix[EMPLOYEES.req.id].stats;

    // P: on-time 1 + engine early-out 1 + half day 0.5 + pending 0.5 + rejected 0.5
    //    + approved 1 + regularized 1
    check(s, 'stats.P for the request employee', stats.P, 5.5);
    check(s, 'stats.L', stats.L, 1);
    check(s, 'stats.H', stats.H, 1);
    check(s, 'stats.OFF', stats.OFF, ALL_DAYS.filter(isSunday).length);

    // The letters are the same on the rejected and the pending day; only the weight differs.
    const grid = matrix[EMPLOYEES.req.id].days;
    check(s, 'rejected, pending and un-requested early outs all still read E',
        [grid[D_REJECTED], grid[D_PENDING], grid[D_EARLY]], ['E', 'E', 'E']);
    check(s, 'the approved one reads P', grid[D_APPROVED], 'P');

    // The leave employee proves half-day leave still lands as 0.5 in the right bucket.
    const leaveStats = matrix[EMPLOYEES.gen_pinned.id].stats;
    check(s, 'paid leave, incl. one half day', leaveStats.PL, 1.5);
    check(s, 'unpaid leave', leaveStats.UL, 1);
}

/**
 * R4: the day-detail drawer must not print a status letter next to a sentence that
 * contradicts it. The measured symptom was status E beside "S1: On-Time (06:00 - 11:00)".
 */
async function scenarioDayDetailAgreesWithItself() {
    const s = 'day detail: letter and explanation cannot diverge';
    const matrix = await readMatrix(PAST_M, PAST_Y);

    for (const [key, emp] of Object.entries(EMPLOYEES)) {
        const grid = matrix[emp.id].days;
        const statusMismatches = {};
        const textMismatches = {};

        for (const d of ALL_DAYS) {
            const detail = await attendanceService.getDayDetail(CO, emp.id, P(d));
            const ssd = detail.split_shift_details;
            if (!ssd) continue;   // no punches that day; the drawer shows leave/holiday fields
            if (ssd.status !== grid[d]) statusMismatches[d] = `${ssd.status} != ${grid[d]}`;

            const text = String(ssd.explanation || '');
            // A day the drawer calls Early Out or Late In must never be described as On-Time,
            // and a day it calls Present must not be explained by an unexcused violation.
            if ((ssd.status === 'E' || ssd.status === 'L') && /On-Time/.test(text) && !/Late|Early Out/.test(text)) {
                textMismatches[d] = `${ssd.status} explained as "${text}"`;
            }
            if (ssd.status === 'P' && /^S\d: (Late|Early Out)/.test(text)) {
                textMismatches[d] = `${ssd.status} explained as "${text}"`;
            }
        }

        check(s, `${key}: drawer status matches the muster on every punched day`, statusMismatches, {});
        check(s, `${key}: drawer explanation never contradicts its own letter`, textMismatches, {});
    }
}

/** The three request states, read straight off the drawer, side by side. */
async function scenarioRequestStatesInTheDrawer() {
    const s = 'day detail: the three early-out decisions read differently';
    const empId = EMPLOYEES.req.id;
    const read = async (day) => {
        const detail = await attendanceService.getDayDetail(CO, empId, P(day));
        return {
            status: detail.split_shift_details.status,
            explanation: detail.split_shift_details.explanation
        };
    };

    const rejected = await read(D_REJECTED);
    const approved = await read(D_APPROVED);
    const pending = await read(D_PENDING);
    const late = await read(D_LATE);

    check(s, 'rejected early out is E and says so', [rejected.status, /Early Out/.test(rejected.explanation)], ['E', true]);
    check(s, 'approved early out is P and says so', [approved.status, /^Present/.test(approved.explanation)], ['P', true]);
    check(s, 'pending early out is E and says so', [pending.status, /Early Out/.test(pending.explanation)], ['E', true]);
    check(s, 'a late arrival is L and says so', [late.status, /Late/.test(late.explanation)], ['L', true]);
    check(s, 'rejected and approved do not share an explanation',
        rejected.explanation === approved.explanation, false);
}

/**
 * The employee's own screen, read as a payload rather than as a grid.
 *
 * The cell-for-cell checks above prove it AGREES with the muster. This proves the thing the
 * employee actually sees: never a raw database word, and a row for every day of the month
 * including the ones with no punch at all - the weekoff, the holiday, the approved leave and
 * the date that has not happened yet, none of which existed in this payload before.
 */
const STATUS_LETTERS = ['P', 'A', 'L', 'E', 'HD', 'R', 'CI', 'OFF', 'H', 'PL', 'UL', '-'];

async function scenarioMyAttendancePayload() {
    const s = 'my attendance: the employee never reads a raw database word';

    const reqRows = await attendanceService.getHistory(
        { id: null, employee_id: EMPLOYEES.req.id }, CO, PAST_M, PAST_Y
    );
    const byDate = {};
    reqRows.forEach(r => { byDate[r.date] = r; });

    check(s, 'one entry per calendar day of the month', reqRows.length, PAST_DIM);
    check(s, 'newest first, the order the screen has always rendered',
        [reqRows[0].date, reqRows[reqRows.length - 1].date], [P(PAST_DIM), P(1)]);

    const strays = reqRows.filter(r => !STATUS_LETTERS.includes(r.status)).map(r => `${r.date}=${r.status}`);
    check(s, 'every status is a resolved letter, never `pending` / `late` / `early_out`', strays, []);

    // The two rows the employee used to read the database word off.
    check(s, 'the held row reads E to the employee while the row still says pending',
        [byDate[P(D_PENDING)].status, byDate[P(D_PENDING)].status_raw], ['E', 'pending']);
    check(s, 'the late row reads L to the employee while the row still says late',
        [byDate[P(D_LATE)].status, byDate[P(D_LATE)].status_raw], ['L', 'late']);

    // Days with no attendance row at all. None of these existed in the payload before.
    const sunday = ALL_DAYS.find(isSunday);
    check(s, 'the weekoff is present and reads OFF',
        [byDate[P(sunday)].status, byDate[P(sunday)].check_in], ['OFF', null]);
    check(s, 'the company holiday is present and reads H',
        [byDate[P(D_HOLIDAY)].status, byDate[P(D_HOLIDAY)].check_in], ['H', null]);
    check(s, 'a bare past workday still reads A', byDate[P(WORKDAYS[4])].status, 'A');

    const leaveRows = await attendanceService.getHistory(
        { id: null, employee_id: EMPLOYEES.gen_pinned.id }, CO, PAST_M, PAST_Y
    );
    const leaveByDate = {};
    leaveRows.forEach(r => { leaveByDate[r.date] = r; });
    check(s, 'approved paid leave reads PL, not Absent', leaveByDate[P(D_PAID_LEAVE)].status, 'PL');
    check(s, 'unpaid leave reads UL', leaveByDate[P(D_UNPAID_LEAVE)].status, 'UL');

    // The future column, which had no row at all and so rendered as nothing.
    const curRows = await attendanceService.getHistory(
        { id: null, employee_id: EMPLOYEES.gen_pinned.id }, CO, CUR_M, CUR_Y
    );
    const future = curRows.filter(r => r.date > TODAY);
    // A future weekoff is still OFF on the muster, so it is OFF here too; every other future
    // day must be blank. Printing Absent against a day that has not happened is the bug.
    const futureWorkdays = future.filter(r => dayNameOf(CUR_Y, CUR_M, parseInt(r.date.split('-')[2], 10)) !== 'Sunday');
    check(s, 'every future date is present, and none of them reads Absent',
        [future.length, futureWorkdays.every(r => r.status === '-')],
        [CUR_DIM - CUR_D, true]);

    // The hours column: `work_hours` is not a database column, so the screen printed
    // "undefinedH" for every row it ever rendered.
    check(s, 'a worked day carries real hours',
        byDate[P(D_ONTIME)].work_hours, '9.1');
    check(s, 'a day with no punch carries no hours',
        byDate[P(sunday)].work_hours, null);
    check(s, 'the day is labelled with the shift it was judged by',
        byDate[P(D_ONTIME)].shift_code, 'RP General 09-18');

    // Times are pre-formatted IST 'HH:mm'. A raw datetime handed to the browser is re-parsed in
    // the VIEWER's timezone, which shifts the clock an employee outside IST reads.
    check(s, 'arrival and departure are IST HH:mm, not a datetime the browser must parse',
        [byDate[P(D_ONTIME)].in_time, byDate[P(D_ONTIME)].out_time], ['09:00', '18:05']);

    // A 4-punch day: the departure is session 2's, and the hours are both sessions.
    const splitRows = await attendanceService.getHistory(
        { id: null, employee_id: EMPLOYEES.split.id }, CO, PAST_M, PAST_Y
    );
    const splitDay = splitRows.find(r => r.date === P(D_ONTIME));
    check(s, 'a split shift spans both sessions',
        [splitDay.status, splitDay.in_time, splitDay.out_time, splitDay.work_hours],
        ['P', '09:00', '21:00', '8.0']);
}


/**
 * A company that has NOT configured working rules yet.
 *
 * Every screen falls back to a default `working_rules` object when the company has no row,
 * and there used to be FOUR different inline versions of that object in attendanceService:
 * the muster's carried weekoffs: ['Sunday'], the history sheet's and the date-wise screen's
 * were bare `{}`. So a company with no working_rules row resolved its Sundays against an
 * EMPTY weekoff list on four of the five screens: every past Sunday read OFF on the admin
 * muster and Absent on the employee's own "My Attendance". A freshly onboarded tenant is
 * exactly the tenant with no working_rules row, so this hit new customers and nobody else.
 *
 * This harness seeds working_rules, which is why it never caught it. So take the row away.
 */
async function scenarioNoWorkingRulesRow() {
    const s = 'a company that has not configured working rules yet';
    const saved = await db('working_rules').where({ company_id: CO }).first();
    await db('working_rules').where({ company_id: CO }).del();

    try {
        const emp = EMPLOYEES.gen_pinned.id;
        const sundays = ALL_DAYS.filter(isSunday);

        const matrix = await readMatrix(PAST_M, PAST_Y);
        const sheet = await readHistory(emp, PAST_M, PAST_Y);
        const dateWise = await readDateWise(PAST_M, PAST_Y);
        const mine = await attendanceService.getHistory({ id: null, employee_id: emp }, CO, PAST_M, PAST_Y);
        const mineByDay = {};
        mine.forEach(r => { mineByDay[parseInt(r.date.split('-')[2], 10)] = r.status; });

        check(s, 'the muster still reads OFF on every Sunday with no working_rules row',
            sundays.map(d => matrix[emp].days[d]), sundays.map(() => 'OFF'));
        check(s, 'the history sheet agrees instead of printing Absent',
            sundays.map(d => sheet[d]), sundays.map(() => 'OFF'));
        check(s, 'the date-wise screen agrees',
            sundays.map(d => dateWise[d][emp]), sundays.map(() => 'OFF'));
        check(s, "and the employee's own screen agrees",
            sundays.map(d => mineByDay[d]), sundays.map(() => 'OFF'));
    } finally {
        if (saved) await db('working_rules').insert(saved);
    }
}

/**
 * A LEGACY night-shift row - no logical_date, opening in the small hours - must land on the
 * same day on the date-wise screen as it does on the other four.
 *
 * Found in production on 2026-09-07, one row out of 233: employee on a 16:00-02:00 shift whose
 * row opened at 02:00, shown Present by date-wise on the calendar day and Absent by the muster,
 * the history sheet, the day detail and the employee's own screen - which had it on the night
 * shift's day, correctly.
 *
 * getDateWiseAttendance was handing the resolver assignments whose validity window it had
 * rewritten to the single rendered date. getLogicalDateStr needs to ask what shift the employee
 * was on the day BEFORE the punch; a one-day window cannot answer that, so the lookup fell
 * through to employees.shift_id. Two conditions are therefore both required to reproduce, and
 * the fixture sets both deliberately:
 *   - the roster assignment is a NIGHT shift (so the row really does belong to the day before), and
 *   - employees.shift_id is a DAY shift (so the fallback gives the wrong answer rather than
 *     accidentally the right one).
 * An employee whose default shift is also the night shift passes even with the bug present.
 *
 * Rows written since attendance.logical_date exists are immune - rowLogicalDate prefers the
 * persisted column - so the fixture row is inserted raw, with logical_date NULL, to stand for
 * the ~200 legacy rows still in production.
 */
async function scenarioLegacyNightRowOnDateWise() {
    const s = 'a legacy 02:00 night row lands on the same day on all five screens';

    // A day whose successor is also an ordinary workday, so neither cell is a weekoff or the
    // seeded holiday and the assertion is about the logical date and nothing else.
    const day = WORKDAYS.find(d => d + 1 <= PAST_DIM && !isSunday(d + 1) && d !== D_HOLIDAY && d + 1 !== D_HOLIDAY);
    const nextDay = day + 1;

    const id = empSeq++;
    await db('employees').insert({
        id, company_id: CO, employee_id_number: String(id), first_name: `RP${id}`, last_name: 'Harness',
        email: `rp${id}@harness.invalid`, status: 'active',
        // The DAY shift, deliberately disagreeing with the roster below.
        shift_id: SH_GEN
    });
    await db('employee_shift_assignments').insert({
        company_id: CO, employee_id: id, shift_id: SH_NIGHT,
        from_date: ymd(PAST_Y, PAST_M, 1), to_date: null
    });
    // Legacy shape: logical_date and shift_id both NULL, as every row written before this
    // column existed. Opens at 02:00, inside the tail of the 22:00-06:00 shift that started
    // on `day`, and never closes - the unpaired-punch shape the engine now records on purpose.
    await db('attendance').insert({
        employee_id: id, company_id: CO,
        check_in: `${P(nextDay)} 02:00:00`,
        check_out: null,
        status: 'present',
        punch_source: 'biometric',
        logical_date: null,
        shift_id: null
    });

    // WHICH DAY the row is attributed to is the thing under test, and the status LETTER does not
    // reveal it: a never-closed row reads A on both days, so a screen can file the punch under
    // the wrong date and still print a letter that matches. The arrival time does reveal it -
    // it appears against exactly one of the two days - so that is what is asserted.
    const arrivalOn = async (dayNum) => {
        const rows = await attendanceService.getDateWiseAttendance(CO, P(dayNum));
        return (rows.find(r => r.id === id) || {}).first_in ?? null;
    };
    const sheet = await attendanceService.getEmployeeAttendanceHistory(CO, id, P(day), P(nextDay));
    const sheetArrival = d => (sheet.find(r => r.date === P(d)) || {}).first_in ?? null;

    check(s, 'the history sheet files the 02:00 punch under the night shift\'s own day',
        [sheetArrival(day), sheetArrival(nextDay)], ['02:00', null]);
    check(s, 'date-wise files it under the same day, not the calendar day',
        [await arrivalOn(day), await arrivalOn(nextDay)], ['02:00', null]);

    // ...and having moved it, every screen must still agree on the letter for both days.
    const matrix = await readMatrix(PAST_M, PAST_Y);
    const grid = matrix[id].days;
    const dateWise = await readDateWise(PAST_M, PAST_Y);
    const history = await readHistory(id, PAST_M, PAST_Y);
    const mine = await readMyAttendance(id, PAST_M, PAST_Y);
    check(s, 'all five screens still agree on the letter for both days',
        [dateWise[day][id], history[day], mine[day], dateWise[nextDay][id], history[nextDay], mine[nextDay]],
        [grid[day], grid[day], grid[day], grid[nextDay], grid[nextDay], grid[nextDay]]);
}

/**
 * A punch in the small hours of the 1st must be counted in ONE month, not both.
 *
 * The muster loads attendance past the month end - a night shift worked on the last day closes
 * in the small hours of the 1st - but used to load the roster only up to the month end. The
 * resolver was therefore shown the row without the assignment that governs it, fell back to an
 * older open-ended night assignment and filed the punch under the last day of the month it was
 * rendering. The following month, whose window did include that assignment, filed the same row
 * under the 1st. One punch, two Present days, and stats.P is the number payroll pays on.
 *
 * Found on production 2026-09-07 while fixing the date-wise placement bug: employee 10203 read
 * P on both 31 Aug and 01 Sep off a single 05:45-16:11 day.
 *
 * The fixture is that exact shape: a night-shift employee rotated onto a DAY shift for the 1st
 * alone, who works that day shift. The rotation row is what the month-scoped window used to
 * miss.
 */
async function scenarioMonthBoundaryNotCountedTwice() {
    const s = 'a punch on the 1st is counted in one month, not both';

    const id = empSeq++;
    await db('employees').insert({
        id, company_id: CO, employee_id_number: String(id), first_name: `RP${id}`, last_name: 'Harness',
        email: `rp${id}@harness.invalid`, status: 'active', shift_id: SH_NIGHT
    });
    await db('employee_shift_assignments').insert([
        // The standing night roster, open-ended - the row the resolver used to fall back to.
        { company_id: CO, employee_id: id, shift_id: SH_NIGHT, from_date: ymd(PAST_Y, PAST_M, 1), to_date: null },
        // ...and a one-day rotation onto the DAY shift for the 1st of the FOLLOWING month, which
        // a window ending at the month end cannot see.
        { company_id: CO, employee_id: id, shift_id: SH_GEN, from_date: ymd(CUR_Y, CUR_M, 1), to_date: ymd(CUR_Y, CUR_M, 1) }
    ]);
    // Worked the day shift on the 1st: 09:00-18:05, opening at 09:00 which is inside the
    // 00:00-10:00 window where the night-shift lookback runs. Legacy shape on purpose.
    await db('attendance').insert({
        employee_id: id, company_id: CO,
        check_in: `${ymd(CUR_Y, CUR_M, 1)} 09:00:00`,
        check_out: `${ymd(CUR_Y, CUR_M, 1)} 18:05:00`,
        status: 'present', punch_source: 'biometric',
        logical_date: null, shift_id: null
    });

    const pastGrid = (await readMatrix(PAST_M, PAST_Y))[id].days;
    const curGrid = (await readMatrix(CUR_M, CUR_Y))[id].days;

    // Assert on WHERE the arrival shows, not on the letter: the last day of the previous month
    // may itself be the seeded holiday, and both H and A mean "carried no punch", so a letter
    // comparison would be testing the calendar rather than the attribution.
    const arrivalOn = async (dateStr) => {
        const rows = await attendanceService.getDateWiseAttendance(CO, dateStr);
        return (rows.find(r => r.id === id) || {}).first_in ?? null;
    };
    check(s, 'the last day of the previous month carries no arrival',
        await arrivalOn(P(PAST_DIM)), null);
    check(s, 'the 1st carries it',
        [await arrivalOn(ymd(CUR_Y, CUR_M, 1)), curGrid[1]], ['09:00', 'P']);
    check(s, 'and it is counted once, not once per month',
        (await readMatrix(PAST_M, PAST_Y))[id].stats.P + (await readMatrix(CUR_M, CUR_Y))[id].stats.P,
        1);
    check(s, 'date-wise agrees with the muster on both days',
        [(await readDateWise(PAST_M, PAST_Y))[PAST_DIM][id], (await readDateWise(CUR_M, CUR_Y))[1][id]],
        [pastGrid[PAST_DIM], curGrid[1]]);
}

const SCENARIOS = [
    scenarioPastMonthAgreement,
    scenarioCurrentMonthFutureDays,
    scenarioUnpinnedRowsRenderIdentically,
    scenarioEarlyOutPayrollWeight,
    scenarioDayDetailAgreesWithItself,
    scenarioRequestStatesInTheDrawer,
    scenarioMyAttendancePayload,
    scenarioNoWorkingRulesRow,
    scenarioLegacyNightRowOnDateWise,
    scenarioMonthBoundaryNotCountedTwice
];

async function main() {
    console.log(`Read-path replay harness  db=${DB_NAME}  TZ=${process.env.TZ || '(system)'}`);
    console.log(`  month under test: ${PAST_Y}-${pad(PAST_M)} (settled)  |  current: ${CUR_Y}-${pad(CUR_M)}, today ${TODAY}`);
    console.log(`  fixture days: ontime=${D_ONTIME} late=${D_LATE} early=${D_EARLY} half=${D_HALF} ` +
        `pending=${D_PENDING} rejected=${D_REJECTED} approved=${D_APPROVED} regularized=${D_REGULARIZED}`);
    console.log(`                paid-leave=${D_PAID_LEAVE} unpaid-leave=${D_UNPAID_LEAVE} half-leave=${D_HALF_LEAVE} holiday=${D_HOLIDAY}\n`);

    await resetFixtures();
    await seedCommon();
    await seedEmployees();

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
