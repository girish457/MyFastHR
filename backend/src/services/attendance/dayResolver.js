/**
 * What a stored attendance day MEANS. Pure judgment, nothing else.
 *
 * ============================================================================================
 * THE ONE RULE FOR THIS FILE: it must never require `../../config/db`, knex, or anything that
 * performs I/O, and it must never read the clock. Everything it needs - shift config, the day's
 * rows, weekoffs, holidays, leaves, request states, and the current instant - arrives as an
 * argument. Two reasons, both concrete:
 *
 *   1. A query inside day-judgment logic is impossible to reintroduce if there is no connection
 *      to reach for. That is what lets this same resolver eventually be called from inside the
 *      punch engine's `FOR UPDATE` transaction (machineAttendanceService.processPunch), where an
 *      await on a database round-trip would let another transaction interleave and undo the
 *      serialization 570b2d6 exists to provide. (Wiring ingestion through here is NOT done yet.)
 *
 *   2. It makes the combinatorial space cheap to test. backend/scripts/testDayResolver.js drives
 *      every shift type x pinned/unpinned shift x status letter x overlay x request state through
 *      these functions with plain objects, no MySQL, in milliseconds. The integration harness
 *      (scripts/replayReadPath.js) needs a seeded scratch database and can only sample.
 * ============================================================================================
 *
 * Four screens render these same rows - the muster grid (getMatrix), the employee history sheet
 * (getEmployeeAttendanceHistory), the date-wise screen (getDateWiseAttendance) and the day-detail
 * drawer (getDayDetail). Each of them used to decide for itself what a row meant, and they drifted:
 * one day read OFF on the grid, Absent on the history sheet, and the drawer showed a status letter
 * next to a sentence contradicting it. 480ef43 and 955b500 routed all four through the functions
 * below; this file is where they now live.
 *
 * Extraction note: these functions moved out of attendanceService.js VERBATIM. The only edits were
 * mechanical - `new Date()` / `istTodayStr()` became the `now` / `todayStr` arguments, so the
 * decision is a function of a supplied instant rather than of when it happened to run. Nothing
 * about what any of them decides changed.
 */

const {
    dbDateToUTC,
    toLocalYMD,
    dateToISTMins,
    safeFormatTime
} = require('./time');

// The clock is an argument here, never a global read. A caller that forgets one would otherwise
// get a silently wrong answer - `undefined > someDate` is false, so a terminated shift would read
// as still running and a real absence would render as a blank cell. In this subsystem a loud
// crash beats a quietly wrong attendance letter, which is what payroll multiplies.
function requireNow(now, fnName) {
    if (!(now instanceof Date) || isNaN(now.getTime())) {
        throw new TypeError(`${fnName}: \`now\` must be a Date (the resolver never reads the clock itself)`);
    }
    return now;
}

function requireTodayStr(todayStr, fnName) {
    if (typeof todayStr !== 'string' || !todayStr) {
        throw new TypeError(`${fnName}: \`todayStr\` must be an IST 'YYYY-MM-DD' string`);
    }
    return todayStr;
}

function isNightShift(shift) {
    if (!shift || !shift.start_time || !shift.end_time) return false;
    const [sH, sM] = shift.start_time.split(':').map(Number);
    const [eH, eM] = shift.end_time.split(':').map(Number);
    const sMins = sH * 60 + sM;
    const eMins = eH * 60 + eM;
    return eMins < sMins;
}

function getLogicalDateStr(checkIn, employeeShifts = [], defaultShift = null) {
    if (!checkIn) return null;
    const d = dbDateToUTC(checkIn);
    if (!d || isNaN(d.getTime())) return null;

    const checkInYMD = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
    const istStr = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
    const hour = parseInt(istStr, 10);

    if (hour >= 0 && hour < 10) {
        const prevDate = new Date(d.getTime() - 24 * 60 * 60 * 1000);
        const prevDateStr = prevDate.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });

        // Check current date's shift assignment first. If it is a day shift, map to current date.
        const currentShift = employeeShifts.find(s => {
            const fromStr = s.from_date instanceof Date ? s.from_date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' }) : String(s.from_date || '').split('T')[0];
            const toStr = s.to_date instanceof Date ? s.to_date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' }) : (s.to_date ? String(s.to_date).split('T')[0] : null);
            return checkInYMD >= fromStr && (!toStr || checkInYMD <= toStr);
        }) || defaultShift;

        if (currentShift && !isNightShift(currentShift)) {
            return checkInYMD;
        }

        // Otherwise check if there was a night shift on the previous date (prevDateStr)
        const prevShift = employeeShifts.find(s => {
            const fromStr = s.from_date instanceof Date ? s.from_date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' }) : String(s.from_date || '').split('T')[0];
            const toStr = s.to_date instanceof Date ? s.to_date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' }) : (s.to_date ? String(s.to_date).split('T')[0] : null);
            return prevDateStr >= fromStr && (!toStr || prevDateStr <= toStr);
        }) || defaultShift;

        if (prevShift && isNightShift(prevShift)) {
            return prevDateStr;
        }
    }

    return checkInYMD;
}

// Rows written since ingestion started stamping attendance.logical_date already carry the
// shift day the engine decided they belong to. Re-deriving it from check_in here re-runs the
// night-shift guess against whatever shift assignment happens to resolve TODAY, which is how a
// rotation entered after the punch moves an old row to a different column. Trust the stamp when
// it is there; every pre-existing row has it NULL, so those still fall back to the derivation.
function rowLogicalDate(row, employeeShifts = [], defaultShift = null) {
    if (!row) return null;
    const persisted = row.logical_date;
    if (persisted) {
        // dateStrings:true in knexfile.js means this is normally already 'YYYY-MM-DD', but a
        // driver/pool without that flag hands back a Date, so normalise both shapes.
        if (persisted instanceof Date) return toLocalYMD(persisted);
        const str = String(persisted).trim();
        if (str) return str.split('T')[0].split(' ')[0];
    }
    return getLogicalDateStr(row.check_in, employeeShifts, defaultShift);
}

// Which of a day's attendance rows represents the day.
//
// A day should have one row, but device retries and stale open rows routinely produce more -
// 120 duplicate groups at one client over 60 days (measured 2026-09-05), and employee 10234 got five rows for
// punches spanning 22 seconds. dayLogs is sorted ascending by check-in, so the plain
// dayLogs[0] these call sites used to take picked the EARLIEST row, which is precisely the one
// nobody ever closed: the cell then read "checked in, no checkout" or Absent while the real
// completed row sat beside it. That is the "he checked in but it shows as absent" report.
//
// Split (4-punch) shifts are the deliberate exception. Two rows a day is their correct shape,
// session 1 first, and the callers read [0] and [1] as exactly those sessions - so preferring
// a closed row there would hand back session 2 and break what it is meant to fix.
function primaryDayLog(dayLogs, resolvedShift = null) {
    if (!dayLogs || dayLogs.length === 0) return null;

    // An admin's explicit edit outranks any punch, duplicated or not.
    const manual = dayLogs.find(a => a.punch_source === 'manual' || a.punch_source === 'manual_override');
    if (manual) return manual;

    const reqPunches = parseInt(resolvedShift?.total_punches_required || resolvedShift?.shift_total_punches || 2);
    if (reqPunches === 4) return dayLogs[0];

    return dayLogs.find(a => a.check_out) || dayLogs[0];
}

// The shift a DAY was recorded under, or null.
//
// attendance.shift_id is stamped at check-in by the ingestion engine (89b9968) and is the only
// record of which shift a session was actually judged against. employee_shift_assignments is
// editable at any moment, including retroactively over days already worked, so re-resolving a
// settled day from the roster is how a correct `09:00->18:00 present` row starts rendering Late
// days later - or Half Day, which silently halves that day's pay - after an ordinary rotation
// entry. Every pre-existing production row has shift_id NULL and still falls back to the
// date-based roster lookup, which is exactly today's behaviour. A NULL pin means "this row
// predates the pin", NEVER "this day had no shift".
function pinnedShiftForDay(dayLogs, shiftsById) {
    if (!dayLogs || !shiftsById) return null;
    for (const log of dayLogs) {
        if (log && log.shift_id && shiftsById[log.shift_id]) return shiftsById[log.shift_id];
    }
    return null;
}

// What the day must be judged by: its own pin, else the roster assignment covering the date,
// else the employee's profile shift.
function shiftForDay(dayLogs, shiftsById, rosterAssignment, fallbackShift = null) {
    return pinnedShiftForDay(dayLogs, shiftsById) || rosterAssignment || fallbackShift || null;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The weekday of a 'YYYY-MM-DD' string. Built at UTC noon so no server timezone can push the
// date onto its neighbour, which is the difference between an employee's weekoff landing on
// Sunday and landing on Saturday.
function dayNameForDateStr(dateStr) {
    if (!dateStr) return null;
    const [y, m, d] = String(dateStr).split('-').map(Number);
    if (!y || !m || !d) return null;
    return WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
}

// Has TODAY's shift run far enough past its end that a no-show is settled? Until it has, the
// muster leaves the cell blank rather than accusing someone who is still inside their window.
function shiftDayIsTerminated(dateStr, shift, now) {
    if (!shift) return false;
    requireNow(now, 'shiftDayIsTerminated');
    const startStr = shift.start_time || shift.shift_start || '09:00';
    const endStr = shift.end_time || shift.shift_end || '18:00';
    const [sH, sM] = String(startStr).split(':').map(Number);
    const [eH, eM] = String(endStr).split(':').map(Number);
    if ([sH, sM, eH, eM].some(n => Number.isNaN(n))) return false;

    const at = (h, m) => new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
    const start = at(sH, sM);
    let end = at(eH, eM);
    if (end < start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);

    const terminateHour = parseInt(shift.terminate_hour || 2);
    return now > new Date(end.getTime() + terminateHour * 60 * 60 * 1000);
}

// The single place where a day with NO attendance at all becomes a status letter.
//
// The muster had this chain inline while the history sheet and the date-wise screen ran
// `resolveDayStatus(...) || 'A'` with no chain whatsoever. Measured on one employee's
// November, 27 of 30 cells disagreed because of it: five Sundays the grid drew OFF, the one
// company holiday it drew H, and twenty-one days that had not happened yet and that the grid
// left blank all printed Absent on the history sheet and the date-wise screen. An approved
// leave read A there against the grid's PL by the same route. All three call this now.
//
// Returns { status, amount }. `amount` is what the day is worth to the stat it lands in and
// is only ever 0.5, for a half-day leave. '-' means "nothing to say about this day yet" -
// a future date, or today before its shift can be judged - and counts towards nothing.
function resolveNoLogStatus(dateStr, ctx = {}) {
    const {
        weekoffs = [],
        holidays = [],
        leaves = [],
        shift = null,
        todayStr,
        now
    } = ctx;

    if (!dateStr) return { status: '-', amount: 0 };

    requireTodayStr(todayStr, 'resolveNoLogStatus');
    requireNow(now, 'resolveNoLogStatus');

    // 1. Week off
    const dayName = dayNameForDateStr(dateStr);
    if (dayName && weekoffs.includes(dayName)) return { status: 'OFF', amount: 1 };

    // 2. Holiday. The muster compared only the day-of-month, which is correct exactly as long
    //    as `holidays` was fetched month-scoped - a precondition that is invisible at the call
    //    site and that two of the three callers here do not satisfy. Compare the whole date.
    if (holidays.some(h => toLocalYMD(h.date) === dateStr)) return { status: 'H', amount: 1 };

    // 3. Approved leave
    const onLeave = leaves.find(l => {
        const from = toLocalYMD(l.start_date);
        const to = toLocalYMD(l.end_date);
        return from && to && dateStr >= from && dateStr <= to;
    });
    if (onLeave) {
        const typeName = String(onLeave.leave_type_name || '').toLowerCase();
        const isPaid = !typeName.includes('unpaid') && !typeName.includes('lop');
        const isHalfDay = Number(onLeave.days) === 0.5 &&
            toLocalYMD(onLeave.start_date) === toLocalYMD(onLeave.end_date);
        return { status: isPaid ? 'PL' : 'UL', amount: isHalfDay ? 0.5 : 1 };
    }

    // 4. Absent - but only once the day is genuinely over.
    if (dateStr < todayStr) return { status: 'A', amount: 1 };
    if (dateStr > todayStr) return { status: '-', amount: 0 };
    return shiftDayIsTerminated(dateStr, shift, now) ? { status: 'A', amount: 1 } : { status: '-', amount: 0 };
}

const STATUS_LABEL = {
    P: 'Present', A: 'Absent', L: 'Late In', E: 'Early Out', HD: 'Half Day',
    R: 'Regularized', CI: 'Checked In', OFF: 'Week Off', H: 'Holiday'
};

// When the resolved letter overrides what the punches alone compute to, say why - and keep the
// punch-level sentence after it, because that is what the drawer exists to show.
function overrideExplanation(status, reason, base) {
    const label = STATUS_LABEL[status] || status;
    const detail = base && base.explanation ? ` | ${base.explanation}` : '';
    return `${label} (${reason})${detail}`;
}

function mapDbStatusToFrontend(status) {
    if (status === null || status === undefined) return 'A';
    const s = String(status).trim().toLowerCase();
    if (s === 'pending') return '-';
    if (s === '') return 'P';
    if (s === 'present' || s === 'p') return 'P';
    if (s === 'absent' || s === 'a') return 'A';
    if (s === 'short') return 'HD';
    if (s === 'late' || s === 'l' || s === 'late_in' || s === 'late-in') return 'L';
    if (s === 'early_out' || s === 'early-out' || s === 'eo' || s === 'earlyout') return 'E';
    if (s === 'off') return 'OFF';
    if (s === 'regularized' || s === 'r') return 'R';
    if (s === 'half-day' || s === 'hd' || s === 'half_day') return 'HD';
    if (s === 'checked_in' || s === 'ci' || s === 'checked-in') return 'CI';
    return 'P';
}

function mapFrontendStatusToDb(status) {
    if (!status) return 'absent';
    const s = status.toUpperCase();
    if (s === 'P') return 'present';
    if (s === 'A') return 'absent';
    if (s === 'OFF') return 'off';
    if (s === 'R') return 'regularized';
    if (s === 'HD') return 'half-day';
    if (s === 'CI') return 'present';
    if (s === 'E' || s === 'EO') return 'early_out';
    // No silent default. This used to fall through to 'present' for anything unrecognized,
    // which is how a caller sending the full word "Absent" instead of the letter "A" ended up
    // marking someone Present - the opposite of what was asked, with no error to notice it by.
    // L is deliberately NOT accepted here: Late is derived from comparing a punch time against
    // the shift, never a status this write path stores, so there is no honest way to "set" it.
    throw new Error(`Unrecognized manual attendance status: "${status}"`);
}

// The single place where a worked day becomes a status letter.
//
// The muster recomputed this inline, the history sheet trusted attendance.status untouched, and
// the day-detail drawer recomputed it a third way through calculateSplitShiftStatus - so the
// same row read L on the muster, P on history and E in the drawer. Three screens over one
// database row must not be able to disagree, so they all call this now.
//
// `resolvedShift` must already be the shift the day was RECORDED under (see shiftForDay), not
// whatever the roster says today. Returns null when the day has no attendance at all, which is
// the caller's cue to fall through to resolveNoLogStatus.
function resolveDayStatus(dayLogs, resolvedShift, rules, ctx = {}) {
    return resolveDayStatusDetail(dayLogs, resolvedShift, rules, ctx).status;
}

// The same decision, plus the sentence that explains it.
//
// The day-detail drawer overwrote only `splitShiftDetails.status` from this resolver and left
// the sentence calculateSplitShiftStatus had produced, so the panel contradicted itself in two
// adjacent fields: a rejected early-out read status E beside "S1: On-Time (06:00 - 11:00)".
// The letter and the text come from the same place now, so they cannot drift apart.
//
// Pass ctx.explain = true to build the sentence. The muster throws it away and calls this once
// per employee per day, so it stays off by default and the punch-level computation is only
// done when a branch actually needs the letter from it.
function resolveDayStatusDetail(dayLogs, resolvedShift, rules, ctx = {}) {
    const { regularization = false, earlyOutRequest = false, explain = false, todayStr, now } = ctx;

    if (!dayLogs || dayLogs.length === 0) {
        if (regularization) return { status: 'R', explanation: explain ? 'Regularized (approved, no punch recorded)' : null };
        if (earlyOutRequest) return { status: 'E', explanation: explain ? 'Early Out (request approved, no punch recorded)' : null };
        return { status: null, explanation: null };
    }

    requireTodayStr(todayStr, 'resolveDayStatusDetail');
    requireNow(now, 'resolveDayStatusDetail');

    const shift = resolvedShift || {};
    const firstLog = primaryDayLog(dayLogs, shift);
    const dbStatus = firstLog.status ? String(firstLog.status).toLowerCase() : '';

    // What the punches alone say. Memoised: several branches need only the letter, the rest
    // need it only to write the sentence.
    let computed;
    const base = () => (computed || (computed = calculateSplitShiftStatus(dayLogs, shift, rules, now)));

    // A resolved letter plus the reason it overrode `base`. When the two already agree, the
    // punch-level sentence is the better explanation and is kept as-is.
    const decide = (status, reason) => {
        if (!explain) return { status, explanation: null };
        const b = base();
        if (b && b.status === status) return { status, explanation: b.explanation };
        return { status, explanation: overrideExplanation(status, reason, b) };
    };

    const logCheckInDate = dbDateToUTC(firstLog.check_in);
    const logCheckInYMD = logCheckInDate ? logCheckInDate.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' }) : null;
    const curTodayYMD = todayStr;
    const isTodayActive = (logCheckInYMD === curTodayYMD);

    if (dbStatus === 'pending') {
        if (firstLog.check_out) return decide(base().status, 'awaiting approval');
        return decide(isTodayActive ? 'CI' : 'A', 'awaiting approval, no punch out');
    }

    if (!firstLog.check_out && isTodayActive &&
        firstLog.punch_source !== 'manual' &&
        firstLog.punch_source !== 'manual_override' &&
        firstLog.punch_source !== 'regularization' &&
        dbStatus !== 'regularized' && dbStatus !== 'r' && !regularization) {
        return decide('CI', 'no punch out yet');
    }

    if (firstLog.punch_source === 'manual' || firstLog.punch_source === 'manual_override') {
        return decide(mapDbStatusToFrontend(dbStatus), 'manual override by an admin');
    }

    if (regularization || dbStatus === 'regularized' || dbStatus === 'r' || firstLog.punch_source === 'regularization') {
        return decide('R', 'regularization approved');
    }

    // A settled decision an approver made. The row's own status is the answer; recomputing it
    // from the clock is how an approved late_in still drew E in the day-detail drawer.
    if (firstLog.punch_source === 'entry_request' || earlyOutRequest) {
        const reason = 'approver decision applied';
        if (dbStatus === 'half-day' || dbStatus === 'half_day' || dbStatus === 'hd') return decide('HD', reason);
        if (dbStatus === 'late-in' || dbStatus === 'late_in' || dbStatus === 'late' || dbStatus === 'l') return decide('L', reason);
        if (dbStatus === 'present' || dbStatus === 'p') return decide('P', reason);
        if (dbStatus === 'absent' || dbStatus === 'a') return decide('A', reason);
        return decide('E', reason);
    }

    const asRecorded = `recorded as ${dbStatus || 'unknown'}`;
    if (dbStatus === 'absent' || dbStatus === 'a') return decide('A', asRecorded);
    if (dbStatus === 'off') return decide('OFF', asRecorded);
    if (dbStatus === 'half-day' || dbStatus === 'half_day' || dbStatus === 'hd' || dbStatus === 'short') return decide('HD', asRecorded);
    if (dbStatus === 'early-out' || dbStatus === 'early_out' || dbStatus === 'eo' || dbStatus === 'e') return decide('E', asRecorded);
    if (shift.is_flexi) return decide('P', 'flexi shift, judged on hours worked');

    const b = base();
    return { status: b.status, explanation: explain ? b.explanation : null };
}

// What an Early Out day is worth to payroll.
//
// payrollService computes paidDays = stats.P + stats.L + stats.OFF + stats.H + stats.PL, so a
// day counted at 1 here is a day paid in full, and every day short of the employee's tenure
// becomes unpaid leave. E was counted at 1 unconditionally. Two consequences, both measured:
// a REJECTED early-out request and an APPROVED one with byte-identical punches both banked a
// whole day - 92e238b moved the letter and nothing else, so the rejection was invisible in the
// only number payroll reads - and a request nobody had decided yet was already banked in full
// before the approver opened it.
//
// MyFastHR_Attendance_Master_Prompt.md's payroll rules have no early-out line at all, so this
// deliberately does not invent a rate. It reuses the one partial-day weight the system already
// documents (Half Day, 0.5) for the days an approver has refused or has not yet granted, and
// leaves every other early-out day at exactly the weight it carries today:
//   approved           1.0  the shortfall was excused (such a row normally settles to P anyway)
//   no request at all  1.0  unchanged - nobody has ruled on it, and nothing here should quietly
//                           start deducting for days that pay in full today
//   rejected           0.5  an approver ruled the departure unexcused; it must not equal approved
//   pending            0.5  undecided. 1.0 pre-approves it; 0.0 turns the day into unpaid leave
//                           in payrollService and so pre-rejects it. The partial day is neither.
function earlyOutDayWeight(requestStatus) {
    const state = requestStatus ? String(requestStatus).toLowerCase() : null;
    if (state === 'rejected' || state === 'pending') return 0.5;
    return 1;
}

// The stats increments the muster used to copy-paste five times, each copy covering a slightly
// different subset of the statuses it could actually be handed.
//
// `amount` carries a half-day leave; `earlyOutRequest` carries the approval state, which this
// cannot infer - the letter E is the same one whether a manager approved, refused or has not
// yet looked at the request behind it.
function bumpDayStats(stats, status, ctx = {}) {
    const { amount = 1, earlyOutRequest = null } = ctx;
    if (status === 'P' || status === 'R') stats.P += 1;
    else if (status === 'E') stats.P += earlyOutDayWeight(earlyOutRequest);
    else if (status === 'HD') stats.P += 0.5;
    else if (status === 'L') stats.L++;
    else if (status === 'A') stats.A++;
    else if (status === 'OFF') stats.OFF++;
    else if (status === 'H') stats.H++;
    else if (status === 'PL') stats.PL += amount;
    else if (status === 'UL') stats.UL += amount;
}

function checkIfLogUsedGrace(log, employee, rules) {
    if (!log.check_in) return false;
    const logCheckIn = dbDateToUTC(log.check_in);
    if (!logCheckIn) return false;

    const shiftStart = employee?.shift_start || rules.shift_start || '09:00';
    const grace = employee?.scheme_grace ?? employee?.shift_grace ?? rules.grace_period ?? 15;

    const [sHours, sMins] = shiftStart.split(':').map(Number);

    const istStr = logCheckIn.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
    const hour = parseInt(istStr, 10);

    let logicalDateStr = logCheckIn.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
    const [sH, sM] = shiftStart.split(':').map(Number);
    const [eH, eM] = (employee?.shift_end || '18:00').split(':').map(Number);
    const isNight = eH * 60 + eM < sH * 60 + sM;

    if (isNight && hour >= 0 && hour < 10) {
        const prevDate = new Date(logCheckIn.getTime() - 24 * 60 * 60 * 1000);
        logicalDateStr = prevDate.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
    }

    const shiftStartActual = new Date(`${logicalDateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
    const shiftStartLimit = new Date(shiftStartActual.getTime() + grace * 60 * 1000);

    return logCheckIn > shiftStartActual && logCheckIn <= shiftStartLimit;
}

// How a completed session reads. Every violation it has, not only the arrival.
function punchMarks(isLate, isEarly) {
    const marks = [];
    if (isLate) marks.push('Late In');
    if (isEarly) marks.push('Early Out');
    return marks.length ? marks.join(', ') : 'On-Time';
}

// What the punches ALONE say, before any approver decision is layered on top: the letter plus
// the per-session sentence the day-detail drawer renders. `now` decides only whether an open
// row is still live (CI) or has run past its terminate_hour.
function calculateSplitShiftStatus(dayLogs, shift, rules, now) {
    requireNow(now, 'calculateSplitShiftStatus');
    const reqPunches = parseInt(shift.total_punches_required || shift.shift_total_punches || 2);

    // A flexi shift has no clock to be late or early against - min_hours is the entire rule, and
    // the ingestion engine already applied it when it wrote the row (570b2d6). Judging one by
    // start_time/end_time is why every flexi employee's day-detail panel read "Late": the shift is
    // stored as 00:00-23:59 with grace 0, so any arrival after midnight is late. The muster
    // short-circuits flexi before it ever gets here, which is exactly how the two screens came to
    // contradict each other on a clean flexi day with no reassignment at all.
    const isFlexi = !!(shift.is_flexi === 1 || shift.is_flexi === true ||
                       shift.shift_is_flexi === 1 || shift.shift_is_flexi === true);
    if (isFlexi) {
        const log = dayLogs && dayLogs[0];
        if (!log) return { status: 'A', explanation: 'Flexi: Missed', punch_count: 0 };

        const punchCount = dayLogs.reduce((acc, l) => acc + (l.check_in ? 1 : 0) + (l.check_out ? 1 : 0), 0);
        const closed = dayLogs.filter(l => l.check_in && l.check_out);
        if (closed.length === 0) {
            const isToday = toLocalYMD(log.check_in) === toLocalYMD(now);
            return {
                status: isToday ? 'CI' : 'A',
                explanation: `Flexi: No Out (${safeFormatTime(log.check_in)} - --:--)`,
                punch_count: punchCount
            };
        }

        const workedH = closed.reduce(
            (acc, l) => acc + (dbDateToUTC(l.check_out) - dbDateToUTC(l.check_in)), 0
        ) / 3600000;
        const minHours = parseFloat(shift.min_hours ?? shift.shift_min_hours ?? 0) || 0;
        return {
            status: 'P',
            explanation: `Flexi: ${workedH.toFixed(1)}h worked${minHours ? ` of ${minHours}h required` : ''} (${safeFormatTime(log.check_in)} - ${safeFormatTime(closed[closed.length - 1].check_out)})`,
            punch_count: punchCount
        };
    }

    const timeToMins = (timeStr) => {
        if (!timeStr) return 0;
        const [h, m] = timeStr.split(':').map(Number);
        return h * 60 + m;
    };

    const dateToMins = (dateVal) => {
        return dateToISTMins(dateVal);
    };

    const s1Start = timeToMins(shift.start_time || shift.shift_start || '09:00');
    const s1End = timeToMins(shift.end_time || shift.shift_end || '18:00');
    const grace1In = parseInt(shift.scheme_grace ?? shift.grace_period ?? shift.shift_grace ?? rules.grace_period ?? 15);
    // The muster does not trust a stored 'present' - it recomputes the cell here - so this
    // threshold has to agree with the one the ingestion engine used, or the grid contradicts
    // the row it is rendering. machineAttendanceService judges an early departure against
    // session1_OUT_MARGIN; this only ever read session1_GRACE_OUT, a different column. At
    // Hotel Highway King the first is 5 minutes and the second is 0, so a 15:57 checkout on a
    // 16:00 shift stored 'present' and still drew E on the grid.
    // Both columns express allowed slack at the end of a shift, so take whichever is larger:
    // that guarantees the grid is never STRICTER than the engine. A genuinely early departure
    // is already stored as early_out and is matched above without reaching this function.
    const grace1Out = Math.max(
        parseInt(shift.session1_out_margin || shift.shift_out_margin || 0),
        parseInt(shift.session1_grace_out || shift.shift_session1_grace_out || 0)
    );

    if (reqPunches === 4) {
        const s2Start = timeToMins(shift.session2_start_time || shift.shift_session2_start || '14:00');
        const s2End = timeToMins(shift.session2_end_time || shift.shift_session2_end || '18:00');
        const grace2In = parseInt(shift.session2_grace_in || shift.shift_session2_grace_in || 15);
        // Same reasoning as grace1Out above, for the second session of a 4-punch shift.
        const grace2Out = Math.max(
            parseInt(shift.session2_out_margin || shift.shift_session2_out_margin || 0),
            parseInt(shift.session2_grace_out || shift.shift_session2_grace_out || 0)
        );
        const s2InMargin = parseInt(shift.session2_in_margin || shift.shift_session2_in_margin || 30);

        // Classify logs using the dynamic Session 2 In Margin
        const s1Logs = dayLogs.filter(log => dateToMins(log.check_in) < (s2Start - s2InMargin));
        const s2Logs = dayLogs.filter(log => dateToMins(log.check_in) >= (s2Start - s2InMargin));

        let s1Present = false;
        let s1Late = false;
        let s1Early = false;
        let s1PunchText = 'S1: Missed';
        let s1Active = false;

        const s1Log = s1Logs.find(l => l.check_out) || s1Logs[0];
        if (s1Log) {
            const inMins = dateToMins(s1Log.check_in);
            s1Late = inMins > (s1Start + grace1In);

            if (s1Log.check_out) {
                const outMins = dateToMins(s1Log.check_out);
                s1Early = outMins < (s1End - grace1Out);
                s1Present = true;
                // Both violations, not just the arrival. A day whose status is E because the
                // employee left early used to be described as "On-Time" - the letter and the
                // sentence beside it in the day-detail drawer contradicted each other.
                s1PunchText = `S1: ${punchMarks(s1Late, s1Early)} (${safeFormatTime(s1Log.check_in)} - ${safeFormatTime(s1Log.check_out)})`;
            } else {
                const isS1Today = toLocalYMD(s1Log.check_in) === toLocalYMD(now);
                if (isS1Today) {
                    s1Active = true;
                }
                s1PunchText = `S1: No Out (${safeFormatTime(s1Log.check_in)} - --:--)`;
            }
        }

        let s2Present = false;
        let s2Late = false;
        let s2Early = false;
        let s2PunchText = 'S2: Missed';
        let s2Active = false;

        const s2Log = s2Logs.find(l => l.check_out) || s2Logs[0];
        if (s2Log) {
            const inMins = dateToMins(s2Log.check_in);
            s2Late = inMins > (s2Start + grace2In);

            if (s2Log.check_out) {
                const outMins = dateToMins(s2Log.check_out);
                s2Early = outMins < (s2End - grace2Out);
                s2Present = true;
                s2PunchText = `S2: ${punchMarks(s2Late, s2Early)} (${safeFormatTime(s2Log.check_in)} - ${safeFormatTime(s2Log.check_out)})`;
            } else {
                let isS2Terminated = false;
                if (shift.terminate_hour) {
                    const checkInDateStr = toLocalYMD(s2Log.check_in);
                    const [sHours, sMins] = (shift.session2_start_time || shift.shift_session2_start || '14:00').split(':').map(Number);
                    const [eHours, eMins] = (shift.session2_end_time || shift.shift_session2_end || '18:00').split(':').map(Number);
                    const shiftStartDate = new Date(`${checkInDateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
                    let shiftEndDate = new Date(`${checkInDateStr} ${String(eHours).padStart(2, '0')}:${String(eMins).padStart(2, '0')}:00 +05:30`);
                    if (shiftEndDate < shiftStartDate) {
                        shiftEndDate = new Date(shiftEndDate.getTime() + 24 * 60 * 60 * 1000);
                    }
                    const terminationDate = new Date(shiftEndDate.getTime() + parseInt(shift.terminate_hour) * 60 * 60 * 1000);
                    if (now > terminationDate) {
                        isS2Terminated = true;
                    }
                }
                const isS2Today = toLocalYMD(s2Log.check_in) === toLocalYMD(now);
                if (!isS2Terminated && isS2Today) {
                    s2Active = true;
                }
                s2PunchText = `S2: ${isS2Terminated ? 'Terminated (No Out)' : 'No Out'} (${safeFormatTime(s2Log.check_in)} - --:--)`;
            }
        }

        let status = 'A';
        if (s1Active || s2Active) {
            status = 'CI';
        } else if (s1Present && s2Present) {
            if (s1Late || s2Late) {
                status = 'L';
            } else if (s1Early || s2Early) {
                status = 'E';
            } else {
                status = 'P';
            }
        } else if (s1Present || s2Present) {
            status = 'HD';
        } else {
            status = 'A';
        }

        return {
            status,
            session1_status: s1Present ? (s1Late ? 'Late' : 'Present') : (s1Active ? 'Checked In' : 'Absent'),
            session2_status: s2Present ? (s2Late ? 'Late' : 'Present') : (s2Active ? 'Checked In' : 'Absent'),
            explanation: `${s1PunchText} | ${s2PunchText}`,
            punch_count: dayLogs.reduce((acc, log) => acc + (log.check_in ? 1 : 0) + (log.check_out ? 1 : 0), 0)
        };
    } else {
        // Standard 2-punch shift.
        //
        // primaryDayLog, NOT dayLogs[0]. resolveDayStatusDetail already picks the primary row
        // for its own checks and then calls this function for the letter itself - so taking
        // [0] here quietly overrode that choice and judged the day by the abandoned duplicate
        // anyway. Measured on Hotel Highway King employee 2549, 2026-08-21: an entry_request row
        // at 06:18:03 that nobody ever closed sat one second in front of the real biometric
        // row 06:18:04 -> 16:13:42, and the day a man worked 9h55m of read Absent.
        const log = primaryDayLog(dayLogs, shift);
        if (!log) {
            return { status: 'A', explanation: 'Missed', punch_count: 0 };
        }

        const inMins = dateToMins(log.check_in);
        const isLate = inMins > (s1Start + grace1In);

        if (log.check_out) {
            const outMins = dateToMins(log.check_out);
            const isEarly = outMins < (s1End - grace1Out);
            let status = 'P';
            if (isLate) status = 'L';
            else if (isEarly) status = 'E';

            return {
                status,
                explanation: `S1: ${punchMarks(isLate, isEarly)} (${safeFormatTime(log.check_in)} - ${safeFormatTime(log.check_out)})`,
                punch_count: 2
            };
        } else {
            // Check if this punch is for today
            const checkInYMD = toLocalYMD(log.check_in);
            const todayYMD = toLocalYMD(now);
            const isToday = (checkInYMD === todayYMD);

            let isTerminated = false;
            if (shift.terminate_hour) {
                const checkInDateStr = toLocalYMD(log.check_in);
                const [sHours, sMins] = (shift.start_time || shift.shift_start || '09:00').split(':').map(Number);
                const [eHours, eMins] = (shift.end_time || shift.shift_end || '18:00').split(':').map(Number);
                const shiftStartDate = new Date(`${checkInDateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
                let shiftEndDate = new Date(`${checkInDateStr} ${String(eHours).padStart(2, '0')}:${String(eMins).padStart(2, '0')}:00 +05:30`);
                if (shiftEndDate < shiftStartDate) {
                    shiftEndDate = new Date(shiftEndDate.getTime() + 24 * 60 * 60 * 1000);
                }
                const terminationDate = new Date(shiftEndDate.getTime() + parseInt(shift.terminate_hour) * 60 * 60 * 1000);
                if (now > terminationDate) {
                    isTerminated = true;
                }
            }

            if (isTerminated) {
                return {
                    status: 'A',
                    explanation: `S1: Terminated (No Out) (${safeFormatTime(log.check_in)} - --:--)`,
                    punch_count: 1
                };
            } else if (isToday) {
                return {
                    status: 'CI',
                    explanation: `S1: Checked In (${isLate ? 'Late' : 'On-Time'}) (${safeFormatTime(log.check_in)} - --:--)`,
                    punch_count: 1
                };
            } else {
                return {
                    status: 'A',
                    explanation: `S1: Incomplete (${safeFormatTime(log.check_in)} - --:--)`,
                    punch_count: 1
                };
            }
        }
    }
}

module.exports = {
    // Which day a row belongs to, and which shift judges it
    isNightShift,
    getLogicalDateStr,
    rowLogicalDate,
    primaryDayLog,
    pinnedShiftForDay,
    shiftForDay,

    // Calendar
    WEEKDAY_NAMES,
    dayNameForDateStr,
    shiftDayIsTerminated,

    // The letter, the sentence, and what the day is worth
    STATUS_LABEL,
    overrideExplanation,
    resolveNoLogStatus,
    resolveDayStatus,
    resolveDayStatusDetail,
    calculateSplitShiftStatus,
    punchMarks,
    earlyOutDayWeight,
    bumpDayStats,
    checkIfLogUsedGrace,

    // Status vocabulary
    mapDbStatusToFrontend,
    mapFrontendStatusToDb
};
