const attendanceRepository = require('../repositories/attendanceRepository');
const db = require('../config/db');
const notificationService = require('./notificationService');

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

// The one ordering every employee_shift_assignments lookup must use.
//
// ATTENDANCE_TROUBLESHOOTING.md records `from_date DESC, id DESC` as the fix for the shift
// assignment priority bug: an assignment must resolve by the period it COVERS first and only
// then by insertion order. `id desc` alone picks the most recently CREATED row, which is a
// different row whenever an employee holds overlapping open-ended assignments - 164 of 231
// active employees at one client. Screens that ordered differently resolved different shifts
// for the same day: measured on one 09:00-18:00 row, the muster said E / QA Evening while the
// day-detail drawer and the history sheet said L / QA Morning.
function byEffectiveAssignment(query) {
    return query.orderBy('esa.from_date', 'desc').orderBy('esa.id', 'desc');
}

// Load the `shifts` rows a set of attendance rows is PINNED to, keyed by id.
// Returns {} when nothing is pinned, so pre-existing rows cost no query.
async function loadPinnedShifts(attendanceRows, conn = db) {
    const ids = [...new Set((attendanceRows || []).map(r => r && r.shift_id).filter(Boolean))];
    if (ids.length === 0) return {};
    const rows = await conn('shifts').whereIn('id', ids);
    const byId = {};
    rows.forEach(s => { byId[s.id] = s; });
    return byId;
}

// The shift a DAY was recorded under, or null.
//
// attendance.shift_id is stamped at check-in by the ingestion engine (89b9968) and is the only
// record of which shift a session was actually judged against. employee_shift_assignments is
// editable at any moment, including retroactively over days already worked, so re-resolving a
// settled day from the roster is how a correct `09:00->18:00 present` row starts rendering Late
// days later - or Half Day, which silently halves that day's pay - after an ordinary rotation
// entry. Every pre-existing production row has shift_id NULL and still falls back to the
// date-based roster lookup, which is exactly today's behaviour.
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

// The single place where a worked day becomes a status letter.
//
// The muster recomputed this inline, the history sheet trusted attendance.status untouched, and
// the day-detail drawer recomputed it a third way through calculateSplitShiftStatus - so the
// same row read L on the muster, P on history and E in the drawer. Three screens over one
// database row must not be able to disagree, so they all call this now.
//
// `resolvedShift` must already be the shift the day was RECORDED under (see shiftForDay), not
// whatever the roster says today. Returns null when the day has no attendance at all, which is
// the caller's cue to fall through to weekoff / holiday / leave / absent.
function resolveDayStatus(dayLogs, resolvedShift, rules, ctx = {}) {
    const { regularization = false, earlyOutRequest = false } = ctx;

    if (!dayLogs || dayLogs.length === 0) {
        if (regularization) return 'R';
        if (earlyOutRequest) return 'E';
        return null;
    }

    const shift = resolvedShift || {};
    const firstLog = primaryDayLog(dayLogs, shift);
    const dbStatus = firstLog.status ? String(firstLog.status).toLowerCase() : '';

    const logCheckInDate = dbDateToUTC(firstLog.check_in);
    const logCheckInYMD = logCheckInDate ? logCheckInDate.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' }) : null;
    const curTodayYMD = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
    const isTodayActive = (logCheckInYMD === curTodayYMD);

    if (dbStatus === 'pending') {
        if (firstLog.check_out) return calculateSplitShiftStatus(dayLogs, shift, rules).status;
        return isTodayActive ? 'CI' : 'A';
    }

    if (!firstLog.check_out && isTodayActive &&
        firstLog.punch_source !== 'manual' &&
        firstLog.punch_source !== 'manual_override' &&
        firstLog.punch_source !== 'regularization' &&
        dbStatus !== 'regularized' && dbStatus !== 'r' && !regularization) {
        return 'CI';
    }

    if (firstLog.punch_source === 'manual' || firstLog.punch_source === 'manual_override') {
        return mapDbStatusToFrontend(dbStatus);
    }

    if (regularization || dbStatus === 'regularized' || dbStatus === 'r' || firstLog.punch_source === 'regularization') {
        return 'R';
    }

    // A settled decision an approver made. The row's own status is the answer; recomputing it
    // from the clock is how an approved late_in still drew E in the day-detail drawer.
    if (firstLog.punch_source === 'entry_request' || earlyOutRequest) {
        if (dbStatus === 'half-day' || dbStatus === 'half_day' || dbStatus === 'hd') return 'HD';
        if (dbStatus === 'late-in' || dbStatus === 'late_in' || dbStatus === 'late' || dbStatus === 'l') return 'L';
        if (dbStatus === 'present' || dbStatus === 'p') return 'P';
        if (dbStatus === 'absent' || dbStatus === 'a') return 'A';
        return 'E';
    }

    if (dbStatus === 'absent' || dbStatus === 'a') return 'A';
    if (dbStatus === 'off') return 'OFF';
    if (dbStatus === 'half-day' || dbStatus === 'half_day' || dbStatus === 'hd' || dbStatus === 'short') return 'HD';
    if (dbStatus === 'early-out' || dbStatus === 'early_out' || dbStatus === 'eo' || dbStatus === 'e') return 'E';
    if (shift.is_flexi) return 'P';

    return calculateSplitShiftStatus(dayLogs, shift, rules).status;
}

// The stats increments the muster used to copy-paste five times, each copy covering a slightly
// different subset of the statuses it could actually be handed.
function bumpDayStats(stats, status) {
    if (status === 'P' || status === 'R' || status === 'E') stats.P++;
    else if (status === 'HD') stats.P += 0.5;
    else if (status === 'L') stats.L++;
    else if (status === 'A') stats.A++;
    else if (status === 'OFF') stats.OFF++;
    else if (status === 'H') stats.H++;
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

async function isNightShiftForEmployeeDate(employeeId, dateStr, companyId) {
    const activeAssignment = await db('employee_shift_assignments as esa')
        .join('shifts as s', 'esa.shift_id', 's.id')
        .where('esa.employee_id', employeeId)
        .where('esa.from_date', '<=', dateStr)
        .andWhere(qb => {
            qb.where('esa.to_date', '>=', dateStr).orWhereNull('esa.to_date');
        })
        .select('s.*')
        .modify(byEffectiveAssignment)
        .first();
    
    const shift = activeAssignment || await db('employees as e')
        .join('shifts as s', 'e.shift_id', 's.id')
        .where('e.id', employeeId)
        .select('s.*')
        .first();
        
    return isNightShift(shift);
}

function dbDateToUTC(dateVal) {
    if (!dateVal) return null;
    if (dateVal instanceof Date) {
        const yr = dateVal.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', year: 'numeric' });
        const mo = dateVal.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', month: '2-digit' });
        const dy = dateVal.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', day: '2-digit' });
        const timeParts = dateVal.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false }).split(':');
        const hr = timeParts[0].padStart(2, '0');
        const mi = timeParts[1].padStart(2, '0');
        const sc = timeParts[2].padStart(2, '0');
        const hrClean = hr === '24' ? '00' : hr;
        return new Date(`${yr}-${mo}-${dy}T${hrClean}:${mi}:${sc}+05:30`);
    }
    const str = String(dateVal).trim();
    const parts = str.split(/[- : T]/);
    if (parts.length >= 3) {
        const yr = parts[0];
        const mo = parts[1];
        const dy = parts[2];
        const hr = parts[3] || '00';
        const mi = parts[4] || '00';
        const sc = parts[5] || '00';
        return new Date(`${yr}-${mo}-${dy}T${hr}:${mi}:${sc}+05:30`);
    }
    const d = new Date(dateVal);
    return isNaN(d.getTime()) ? null : d;
}

function toLocalYMD(dateVal) {
    if (!dateVal) return null;
    const d = dbDateToUTC(dateVal);
    if (!d || isNaN(d.getTime())) return null;
    const istDate = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
    const y = istDate.getUTCFullYear();
    const m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(istDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function toLocalYYYYMMDDHHmmss(dateVal) {
    if (!dateVal) return null;
    const d = dbDateToUTC(dateVal);
    if (!d || isNaN(d.getTime())) return null;
    const istDate = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
    const y = istDate.getUTCFullYear();
    const m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(istDate.getUTCDate()).padStart(2, '0');
    const hr = String(istDate.getUTCHours()).padStart(2, '0');
    const min = String(istDate.getUTCMinutes()).padStart(2, '0');
    const sec = String(istDate.getUTCSeconds()).padStart(2, '0');
    return `${y}-${m}-${day} ${hr}:${min}:${sec}`;
}

// Approvers type an arrival as 'HH:mm' (sometimes 'HH:mm:ss'); the UI may also post a full
// 'YYYY-MM-DD HH:mm:ss'. A bare time carries no date and belongs to the request's SHIFT day, not to
// the calendar day the ambiguous punch landed on - for a night shift those differ, and anchoring to
// the punch's own day would date a 20:10 arrival to the morning after it.
function resolveRequestPunchTime(rawTime, shiftDayStr) {
    if (!rawTime || !shiftDayStr) return null;
    const str = String(rawTime).trim();
    if (!str) return null;
    const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(str);
    if (timeOnly) {
        const hh = String(timeOnly[1]).padStart(2, '0');
        return toLocalYYYYMMDDHHmmss(`${shiftDayStr} ${hh}:${timeOnly[2]}:${timeOnly[3] || '00'}`);
    }
    return toLocalYYYYMMDDHHmmss(str);
}

function dateToISTMins(dateVal) {
    if (!dateVal) return 0;
    const d = dbDateToUTC(dateVal);
    if (!d || isNaN(d.getTime())) return 0;
    const istDate = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
    const h = istDate.getUTCHours();
    const m = istDate.getUTCMinutes();
    return h * 60 + m;
}

function safeFormatTime(dateTimeVal) {
    if (!dateTimeVal) return null;
    const d = dbDateToUTC(dateTimeVal);
    if (!d || isNaN(d.getTime())) return null;
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
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
    return 'present';
}


function calculateSplitShiftStatus(dayLogs, shift, rules) {
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
            const isToday = toLocalYMD(log.check_in) === toLocalYMD(new Date());
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

        const s1Log = s1Logs[0];
        if (s1Log) {
            const inMins = dateToMins(s1Log.check_in);
            s1Late = inMins > (s1Start + grace1In);

            if (s1Log.check_out) {
                const outMins = dateToMins(s1Log.check_out);
                s1Early = outMins < (s1End - grace1Out);
                s1Present = true;
                s1PunchText = `S1: ${s1Late ? 'Late' : 'On-Time'} (${safeFormatTime(s1Log.check_in)} - ${safeFormatTime(s1Log.check_out)})`;
            } else {
                const isS1Today = toLocalYMD(s1Log.check_in) === toLocalYMD(new Date());
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

        const s2Log = s2Logs[0];
        if (s2Log) {
            const inMins = dateToMins(s2Log.check_in);
            s2Late = inMins > (s2Start + grace2In);

            if (s2Log.check_out) {
                const outMins = dateToMins(s2Log.check_out);
                s2Early = outMins < (s2End - grace2Out);
                s2Present = true;
                s2PunchText = `S2: ${s2Late ? 'Late' : 'On-Time'} (${safeFormatTime(s2Log.check_in)} - ${safeFormatTime(s2Log.check_out)})`;
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
                    if (new Date() > terminationDate) {
                        isS2Terminated = true;
                    }
                }
                const isS2Today = toLocalYMD(s2Log.check_in) === toLocalYMD(new Date());
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
        // Standard 2-punch shift
        const log = dayLogs[0];
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
                explanation: `S1: ${isLate ? 'Late' : 'On-Time'} (${safeFormatTime(log.check_in)} - ${safeFormatTime(log.check_out)})`,
                punch_count: 2
            };
        } else {
            // Check if this punch is for today
            const checkInYMD = toLocalYMD(log.check_in);
            const todayYMD = toLocalYMD(new Date());
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
                if (new Date() > terminationDate) {
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


class AttendanceService {
    async getEmployeeId(userId, companyId, existingEmpId = null) {
        if (existingEmpId) return existingEmpId;

        const employee = await db('employees').where({ user_id: userId, company_id: companyId }).first();
        if (!employee) {
            // Fallback: search by userId only if company_id mismatch is suspected
            const fallback = await db('employees').where({ user_id: userId }).first();
            if (fallback) return fallback.id;

            throw new Error('Employee record not found for this user');
        }
        return employee.id;
    }

    async checkIn(user, companyId, location, ip) {
        const empId = await this.getEmployeeId(user.id, companyId, user.employee_id);

        // 1. Fetch Employee with Shift Info and Scheme Info
        const employee = await db('employees')
            .leftJoin('shifts', 'employees.shift_id', 'shifts.id')
            .leftJoin('attendance_schemes', 'employees.attendance_scheme_id', 'attendance_schemes.id')
            .where('employees.id', empId)
            .select(
                'employees.*',
                'shifts.start_time as shift_start',
                'shifts.end_time as shift_end',
                'shifts.grace_period as shift_grace',
                'shifts.grace_count_limit as shift_grace_count_limit',
                'shifts.is_flexi as shift_is_flexi',
                'shifts.total_punches_required as shift_total_punches',
                'shifts.session1_in_margin as shift_in_margin',
                'shifts.session1_out_margin as shift_out_margin',
                'shifts.session2_start_time',
                'shifts.session2_end_time',
                'shifts.session2_in_margin',
                'shifts.session2_out_margin',
                'shifts.session1_grace_out',
                'shifts.session2_grace_in',
                'shifts.session2_grace_out',
                'shifts.terminate_hour',
                'attendance_schemes.grace_period as scheme_grace',
                'attendance_schemes.max_late_allowed'
            )
            .first();

        // 2. Fetch Company Rules as Fallback
        const rules = await db('working_rules').where({ company_id: companyId }).first() || {
            shift_start: '09:00',
            grace_period: 15
        };

        let status = 'present';
        const now = new Date();
        const punchTimeStr = toLocalYYYYMMDDHHmmss(now);
        let dateStr = toLocalYMD(now);

        const istHourStr = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
        const hour = parseInt(istHourStr, 10);
        if (hour >= 0 && hour < 10) {
            const prevDateObj = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const prevDateStr = prevDateObj.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
            
            let prevShift = null;
            if (employee) {
                const activeAssignment = await db('employee_shift_assignments as esa')
                    .join('shifts as s', 'esa.shift_id', 's.id')
                    .where('esa.employee_id', empId)
                    .where('esa.from_date', '<=', prevDateStr)
                    .andWhere(qb => {
                        qb.where('esa.to_date', '>=', prevDateStr).orWhereNull('esa.to_date');
                    })
                    .select('s.*')
                    .modify(byEffectiveAssignment)
                    .first();
                
                if (activeAssignment) {
                    prevShift = activeAssignment;
                } else {
                    prevShift = await db('shifts').where('id', employee.shift_id).first();
                }
            }
            
            if (prevShift && isNightShift(prevShift)) {
                const prevShiftStartStr = prevShift.start_time || '09:00';
                const prevShiftEndStr = prevShift.end_time || '18:00';
                const prevTerminateHour = parseInt(prevShift.terminate_hour || 2);

                const [sHours, sMins] = prevShiftStartStr.split(':').map(Number);
                const [eHours, eMins] = prevShiftEndStr.split(':').map(Number);

                const prevShiftStartDate = new Date(`${prevDateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
                let prevShiftEndDate = new Date(`${prevDateStr} ${String(eHours).padStart(2, '0')}:${String(eMins).padStart(2, '0')}:00 +05:30`);
                if (prevShiftEndDate < prevShiftStartDate) {
                    prevShiftEndDate = new Date(prevShiftEndDate.getTime() + 24 * 60 * 60 * 1000);
                }
                const prevTerminationTime = new Date(prevShiftEndDate.getTime() + prevTerminateHour * 60 * 60 * 1000);

                if (now <= prevTerminationTime) {
                    dateStr = prevDateStr;
                }
            }
        }

        // Resolve overridden shift for check-in date
        if (employee) {
            const activeAssignment = await db('employee_shift_assignments as esa')
                .join('shifts as s', 'esa.shift_id', 's.id')
                .where('esa.employee_id', empId)
                .where('esa.from_date', '<=', dateStr)
                .andWhere(qb => {
                    qb.where('esa.to_date', '>=', dateStr).orWhereNull('esa.to_date');
                })
                .select(
                    's.is_flexi',
                    's.min_hours',
                    's.start_time',
                    's.end_time',
                    's.grace_period as shift_grace',
                    's.grace_count_limit as shift_grace_count_limit',
                    's.total_punches_required as shift_total_punches',
                    's.session1_in_margin as shift_in_margin',
                    's.session1_out_margin as shift_out_margin',
                    's.session2_start_time',
                    's.session2_end_time',
                    's.session2_in_margin',
                    's.session2_out_margin',
                    's.session1_grace_out',
                    's.session2_grace_in',
                    's.session2_grace_out',
                    's.terminate_hour'
                )
                .modify(byEffectiveAssignment)
                .first();
 
            if (activeAssignment) {
                employee.shift_is_flexi = activeAssignment.is_flexi;
                employee.min_hours = activeAssignment.min_hours;
                employee.shift_start = activeAssignment.start_time;
                employee.shift_end = activeAssignment.end_time;
                employee.shift_grace = activeAssignment.shift_grace;
                employee.shift_grace_count_limit = activeAssignment.shift_grace_count_limit;
                employee.shift_total_punches = activeAssignment.shift_total_punches;
                employee.shift_in_margin = activeAssignment.shift_in_margin;
                employee.shift_out_margin = activeAssignment.shift_out_margin;
                employee.session2_start_time = activeAssignment.session2_start_time;
                employee.session2_end_time = activeAssignment.session2_end_time;
                employee.session2_in_margin = activeAssignment.session2_in_margin;
                employee.session2_out_margin = activeAssignment.session2_out_margin;
                employee.session1_grace_out = activeAssignment.session1_grace_out;
                employee.session2_grace_in = activeAssignment.session2_grace_in;
                employee.session2_grace_out = activeAssignment.session2_grace_out;
                employee.terminate_hour = activeAssignment.terminate_hour;
            }
        }

        // Backup original shift parameters (Session 1 parameters) before any overwrite/mapping
        const origShiftStart = employee?.shift_start || '09:00';
        const origShiftEnd = employee?.shift_end || '18:00';
        const origShiftGrace = employee?.shift_grace !== undefined ? employee.shift_grace : 15;
        const origShiftInMargin = employee?.shift_in_margin !== undefined ? employee.shift_in_margin : 30;
        const origShiftOutMargin = employee?.shift_out_margin !== undefined ? employee.shift_out_margin : 0;

        // Fetch the latest attendance record today (to see if one exists, open or closed)
        const defaultShift = employee ? { start_time: employee.shift_start, end_time: employee.shift_end } : null;
        const empAssignments = await db('employee_shift_assignments as esa')
            .join('shifts as s', 'esa.shift_id', 's.id')
            .where('esa.employee_id', empId)
            .select('esa.from_date', 'esa.to_date', 's.start_time', 's.end_time')
            .modify(byEffectiveAssignment);

        const nextDate = new Date(new Date(dateStr).getTime() + 24 * 60 * 60 * 1000);
        const nextDateStr = nextDate.toISOString().split('T')[0];

        const candidateLogs = await db('attendance')
            .where({ employee_id: empId, company_id: companyId })
            .where('check_in', '>=', `${dateStr} 00:00:00`)
            .where('check_in', '<=', `${nextDateStr} 23:59:59`)
            .orderBy('check_in', 'desc');

        let latestLog = null;
        for (const log of candidateLogs) {
            const lDate = rowLogicalDate(log, empAssignments, defaultShift);
            if (lDate === dateStr) {
                latestLog = log;
                break;
            }
        }

        // Determine if the current punch belongs to Session 2 (for 4-punch shifts)
        let isSession2 = false;
        let session2CutoffMins = 0;
        const reqPunches = parseInt(employee?.shift_total_punches || 2);
        if (reqPunches === 4) {
            const punchMins = dateToISTMins(now);
            const s2StartStr = employee?.session2_start_time || '14:00';
            const [s2Hours, s2Mins] = s2StartStr.split(':').map(Number);
            const s2StartMins = s2Hours * 60 + s2Mins;
            const s2InMargin = parseInt(employee?.session2_in_margin || 30);
            session2CutoffMins = s2StartMins - s2InMargin;

            const s1EndStr = origShiftEnd;
            const [s1EndHours, s1EndMinsVal] = s1EndStr.split(':').map(Number);
            const s1EndMins = s1EndHours * 60 + s1EndMinsVal;

            if (latestLog && latestLog.check_out !== null) {
                isSession2 = true;
            } else if (punchMins >= s1EndMins) {
                isSession2 = true;
            }

            // If they already completed Session 1, prevent checking in again for Session 1
            if (latestLog && latestLog.check_out !== null && !isSession2) {
                throw new Error('PUNCH_BLOCKED: You have already checked out of Session 1 and cannot check in again until Session 2 starts.');
            }

            // Gap Check: between Session 1 end time and Session 2 in-margin start time
            if (punchMins > s1EndMins && punchMins < session2CutoffMins) {
                throw new Error('PUNCH_BLOCKED: Check-in is not allowed in the gap between Session 1 and Session 2.');
            }
        }

        // Overwrite/map shift parameters for Session 2 if active
        if (isSession2 && employee) {
            employee.shift_start = employee.session2_start_time || '14:00';
            employee.shift_end = employee.session2_end_time || '18:00';
            employee.shift_in_margin = employee.session2_in_margin !== undefined ? employee.session2_in_margin : 30;
            employee.shift_out_margin = employee.session2_out_margin !== undefined ? employee.session2_out_margin : 0;
            employee.shift_grace = employee.session2_grace_in !== undefined ? employee.session2_grace_in : 15;
        }

        // In Margin Check
        if (employee && !employee.shift_is_flexi) {
            const shiftStart = employee.shift_start || '09:00';
            const inMargin = employee.shift_in_margin !== undefined ? parseInt(employee.shift_in_margin) : 0;
            if (inMargin > 0) {
                const [sHours, sMins] = shiftStart.split(':').map(Number);
                const shiftStartDate = new Date(`${dateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
                const earliestCheckIn = new Date(shiftStartDate.getTime() - inMargin * 60 * 1000);
                if (now < earliestCheckIn) {
                    throw new Error(`PUNCH_SKIPPED: Punch ignored. You cannot check in before the allowed margin (earliest allowed: ${earliestCheckIn.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' })}).`);
                }
            }
        }

        let isCheckoutAttempt = false;
        let isAfterShiftEnd = false;
        if (employee && employee.shift_start && employee.shift_end && !employee.shift_is_flexi) {
            const shiftStart = employee.shift_start;
            const shiftEnd = employee.shift_end;
            const [sHours, sMins] = shiftStart.split(':').map(Number);
            const [eHours, eMins] = shiftEnd.split(':').map(Number);
            const shiftStartDate = new Date(`${dateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
            let shiftEndDate = new Date(`${dateStr} ${String(eHours).padStart(2, '0')}:${String(eMins).padStart(2, '0')}:00 +05:30`);
            if (shiftEndDate < shiftStartDate) {
                // Midnight crossing
                shiftEndDate = new Date(shiftEndDate.getTime() + 24 * 60 * 60 * 1000);
            }
            const shiftDurationMins = Math.round((shiftEndDate - shiftStartDate) / 60000);
            const checkoutWindowMins = Math.min(120, shiftDurationMins * 0.25);
            const thresholdDate = new Date(shiftEndDate.getTime() - checkoutWindowMins * 60 * 1000);
            
            if (now >= shiftEndDate) {
                isAfterShiftEnd = true;
            } else if (now >= thresholdDate) {
                isCheckoutAttempt = true;
            }
        }

        if (isAfterShiftEnd || isCheckoutAttempt) {
            throw new Error('PUNCH_SKIPPED: Punch ignored. Check-in is not allowed after the checkout window has started.');
        }

        // Check if there is an approved Entry/Exit Request for this date and type 'late_in'
        const approvedRequest = await db('attendance_entry_requests')
            .where({ employee_id: empId, company_id: companyId, date: dateStr, request_type: 'late_in', status: 'approved' })
            .first();

        if (!isCheckoutAttempt && !approvedRequest && !employee?.shift_is_flexi) {
            const shiftStart = employee?.shift_start || rules.shift_start || '09:00';
            const grace = employee?.scheme_grace ?? employee?.shift_grace ?? rules.grace_period ?? 15;

            const [sHours, sMins] = shiftStart.split(':').map(Number);
            const shiftStartActual = new Date(`${dateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
            const shiftStartLimit = new Date(shiftStartActual.getTime() + (parseInt(grace) || 0) * 60 * 1000);

            let isLate = now > shiftStartLimit;

            if (!isLate && now > shiftStartActual && now <= shiftStartLimit) {
                // Check if grace limit has been exceeded for the current month
                const startOfMonth = `${dateStr.slice(0, 8)}01`;
                const currentMonthLogs = await db('attendance')
                    .where({ employee_id: empId, company_id: companyId })
                    .whereRaw('DATE(check_in) >= ?', [startOfMonth])
                    .whereRaw('DATE(check_in) < ?', [dateStr])
                    .select('check_in');

                const monthAssignments = await db('employee_shift_assignments as esa')
                    .join('shifts as s', 'esa.shift_id', 's.id')
                    .where('esa.employee_id', empId)
                    .where(qb => {
                        qb.where('esa.from_date', '<=', dateStr)
                          .andWhere(qb2 => {
                              qb2.where('esa.to_date', '>=', startOfMonth).orWhereNull('esa.to_date');
                          });
                    })
                    .select('esa.from_date', 'esa.to_date', 's.start_time', 's.end_time', 's.grace_period', 's.is_night_shift')
                    // Read with .find() below, so it needs the same ordering as every other
                    // assignment lookup - it had none at all, which left the winner up to MySQL.
                    .modify(byEffectiveAssignment);

                let graceCount = 0;
                for (const log of currentMonthLogs) {
                    const logDateStr = toLocalYMD(log.check_in);
                    const ass = monthAssignments.find(a => {
                        const fromStr = toLocalYMD(a.from_date);
                        const toStr = a.to_date ? toLocalYMD(a.to_date) : null;
                        return fromStr <= logDateStr && (!toStr || toStr >= logDateStr);
                    });

                    const shiftStart = ass ? ass.start_time : (employee?.shift_start || rules.shift_start || '09:00');
                    const grace = employee?.scheme_grace ?? (ass ? ass.grace_period : (employee?.shift_grace ?? rules.grace_period ?? 15));

                    const logCheckIn = dbDateToUTC(log.check_in);
                    if (logCheckIn) {
                        const [sHours, sMins] = shiftStart.split(':').map(Number);
                        const shiftStartActual = new Date(`${logDateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
                        const shiftStartLimit = new Date(shiftStartActual.getTime() + (parseInt(grace) || 0) * 60 * 1000);

                        if (logCheckIn > shiftStartActual && logCheckIn <= shiftStartLimit) {
                            graceCount++;
                        }
                    }
                }

                const allowedGraceLimit = employee?.max_late_allowed !== undefined && employee?.max_late_allowed !== null 
                    ? parseInt(employee.max_late_allowed) 
                    : (employee?.shift_grace_count_limit !== undefined && employee?.shift_grace_count_limit !== null
                        ? parseInt(employee.shift_grace_count_limit)
                        : 3);

                if (graceCount >= allowedGraceLimit) {
                    isLate = true;
                }
            }

            if (isLate) {
                // AUTO-CREATE PENDING ENTRY/EXIT REQUEST
                const existingRequest = await db('attendance_entry_requests')
                    .where({ employee_id: empId, company_id: companyId, date: dateStr, request_type: 'late_in' })
                    .first();
                if (!existingRequest) {
                    await db('attendance_entry_requests').insert({
                        company_id: companyId,
                        employee_id: empId,
                        date: dateStr,
                        request_type: 'late_in',
                        punch_time: punchTimeStr,
                        location_data: JSON.stringify({ location, ip, source: 'web' }),
                        status: 'pending',
                        created_at: db.fn.now(),
                        updated_at: db.fn.now()
                    });

                    await this.notifyAdminsAndManager(
                        companyId,
                        empId,
                        'Late In Approval Required',
                        `${employee?.first_name || ''} ${employee?.last_name || ''} has punched in late and requires approval.`
                    );
                }
                throw new Error('LATE_IN_APPROVAL_REQUIRED: Check-in blocked. Late In request has been auto-submitted for approval.');
            }
        }

        const [id] = await attendanceRepository.punchIn(empId, companyId, status, location, ip);
        return await db('attendance').where({ id }).first();
    }

    async checkOut(user, companyId, locationData = {}) {
        const empId = await this.getEmployeeId(user.id, companyId, user.employee_id);

        // Fetch the active attendance record before punching out
        const activeEntry = await db('attendance')
            .where({ employee_id: empId, company_id: companyId, check_out: null })
            .orderBy('check_in', 'desc')
            .first();

        if (!activeEntry) {
            throw new Error('No active check-in found.');
        }

        const employee = await db('employees')
            .leftJoin('shifts', 'employees.shift_id', 'shifts.id')
            .where('employees.id', empId)
            .select(
                'shifts.is_flexi', 
                'shifts.min_hours', 
                'shifts.start_time', 
                'shifts.end_time',
                'shifts.total_punches_required as shift_total_punches',
                'shifts.session1_in_margin as shift_in_margin',
                'shifts.session1_out_margin as shift_out_margin',
                'shifts.session2_start_time',
                'shifts.session2_end_time',
                'shifts.session2_in_margin',
                'shifts.session2_out_margin',
                'shifts.session2_grace_in',
                'shifts.session2_grace_out',
                'shifts.terminate_hour'
            )
            .first();

        const now = new Date();
        const punchTimeStr = toLocalYYYYMMDDHHmmss(now);
        const dateStr = toLocalYMD(now);

        // Resolve overridden shift for this check-in date
        if (employee) {
            const checkInDateStr = toLocalYMD(activeEntry.check_in);
            const activeAssignment = await db('employee_shift_assignments as esa')
                .join('shifts as s', 'esa.shift_id', 's.id')
                .where('esa.employee_id', empId)
                .where('esa.from_date', '<=', checkInDateStr)
                .andWhere(qb => {
                    qb.where('esa.to_date', '>=', checkInDateStr).orWhereNull('esa.to_date');
                })
                .select(
                    's.is_flexi',
                    's.min_hours',
                    's.start_time',
                    's.end_time',
                    's.total_punches_required as shift_total_punches',
                    's.session1_in_margin as shift_in_margin',
                    's.session1_out_margin as shift_out_margin',
                    's.session2_start_time',
                    's.session2_end_time',
                    's.session2_in_margin',
                    's.session2_out_margin',
                    's.session2_grace_in',
                    's.session2_grace_out',
                    's.terminate_hour'
                )
                .modify(byEffectiveAssignment)
                .first();

            if (activeAssignment) {
                employee.is_flexi = activeAssignment.is_flexi;
                employee.min_hours = activeAssignment.min_hours;
                employee.start_time = activeAssignment.start_time;
                employee.end_time = activeAssignment.end_time;
                employee.shift_total_punches = activeAssignment.shift_total_punches;
                employee.shift_in_margin = activeAssignment.shift_in_margin;
                employee.shift_out_margin = activeAssignment.shift_out_margin;
                employee.session2_start_time = activeAssignment.session2_start_time;
                employee.session2_end_time = activeAssignment.session2_end_time;
                employee.session2_in_margin = activeAssignment.session2_in_margin;
                employee.session2_out_margin = activeAssignment.session2_out_margin;
                employee.session2_grace_in = activeAssignment.session2_grace_in;
                employee.session2_grace_out = activeAssignment.session2_grace_out;
                employee.terminate_hour = activeAssignment.terminate_hour;
            }
        }

        // Determine if the check-in belongs to Session 2 (for 4-punch shifts)
        let isSession2 = false;
        const reqPunches = parseInt(employee?.shift_total_punches || 2);
        if (reqPunches === 4) {
            const checkInTime = new Date(activeEntry.check_in);
            const checkInMins = dateToISTMins(checkInTime);
            
            const s1EndStr = employee?.end_time || '18:00';
            const [s1EndH, s1EndM] = s1EndStr.split(':').map(Number);
            const s1EndMins = s1EndH * 60 + s1EndM;

            if (checkInMins >= s1EndMins) {
                isSession2 = true;
            }
        }

        // Overwrite/map shift parameters for Session 2 if active
        if (isSession2 && employee) {
            employee.start_time = employee.session2_start_time || '14:00';
            employee.end_time = employee.session2_end_time || '18:00';
            employee.shift_in_margin = employee.session2_in_margin !== undefined ? employee.session2_in_margin : 30;
            employee.shift_out_margin = employee.session2_out_margin !== undefined ? employee.session2_out_margin : 0;
            employee.shift_grace = employee.session2_grace_in !== undefined ? employee.session2_grace_in : 15;
        }

        // Shift Terminate Hour check
        const isSession1Checkout = (reqPunches === 4 && !isSession2);
        if (employee && employee.terminate_hour && !isSession1Checkout) {
            const checkInDateStr = toLocalYMD(activeEntry.check_in);
            const shiftStartStr = employee.start_time || '09:00';
            const shiftEndStr = employee.end_time || '18:00';
            
            const [sHours, sMins] = shiftStartStr.split(':').map(Number);
            const [eHours, eMins] = shiftEndStr.split(':').map(Number);
            const shiftStartDate = new Date(`${checkInDateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
            let shiftEndDate = new Date(`${checkInDateStr} ${String(eHours).padStart(2, '0')}:${String(eMins).padStart(2, '0')}:00 +05:30`);
            if (shiftEndDate < shiftStartDate) {
                shiftEndDate = new Date(shiftEndDate.getTime() + 24 * 60 * 60 * 1000);
            }
            
            const terminationTime = new Date(shiftEndDate.getTime() + parseInt(employee.terminate_hour) * 60 * 60 * 1000);
            if (now > terminationTime) {
                throw new Error('PUNCH_BLOCKED: Shift has terminated. Punch out is not allowed after the shift termination limit.');
            }
        }

        // Check if there is an approved Entry/Exit Request for this date and type 'early_out'
        const approvedRequest = await db('attendance_entry_requests')
            .where({ employee_id: empId, company_id: companyId, date: dateStr, request_type: 'early_out', status: 'approved' })
            .first();

        let isEarlyCheckoutAttempt = false;
        const checkIn = new Date(activeEntry.check_in);
        const checkInMins = dateToISTMins(checkIn);
        const punchMins = dateToISTMins(now);
        let workedMins = punchMins - checkInMins;
        if (workedMins < 0) workedMins += 24 * 60; // midnight crossing
        const workedHours = workedMins / 60;

        let halfDayLimit = 4; // default
        let outMarginThreshold = null;
        let shiftEndDate = null;

        if (employee?.is_flexi) {
            const minHours = parseFloat(employee?.min_hours) || 8;
            halfDayLimit = minHours / 2;
            if (workedHours < halfDayLimit) {
                return await attendanceRepository.getCurrentStatus(empId, companyId);
            }
            if (workedHours < minHours) {
                isEarlyCheckoutAttempt = true;
            }
        } else {
            const shiftStart = employee?.start_time || '09:00';
            const shiftEnd = employee?.end_time || '18:00';
            const outMargin = employee?.shift_out_margin !== undefined ? parseInt(employee.shift_out_margin) : 0;

            const [sHours, sMins] = shiftStart.split(':').map(Number);
            const [eHours, eMins] = shiftEnd.split(':').map(Number);
            const shiftStartMins = sHours * 60 + sMins;
            let shiftEndMins = eHours * 60 + eMins;
            let shiftDurationMins = shiftEndMins - shiftStartMins;
            if (shiftDurationMins < 0) {
                shiftDurationMins += 24 * 60; // handle midnight crossing
            }
            const shiftDurationHours = shiftDurationMins / 60;

            if (reqPunches === 4) {
                halfDayLimit = shiftDurationHours / 2;
            } else {
                halfDayLimit = employee?.min_hours !== undefined && employee?.min_hours !== null
                    ? parseFloat(employee.min_hours) / 2
                    : shiftDurationHours / 2;
            }

            const checkInDateStr = toLocalYMD(dbDateToUTC(activeEntry.check_in));
            const shiftStartDate = new Date(`${checkInDateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
            shiftEndDate = new Date(`${checkInDateStr} ${String(eHours).padStart(2, '0')}:${String(eMins).padStart(2, '0')}:00 +05:30`);
            if (shiftEndDate < shiftStartDate) {
                shiftEndDate = new Date(shiftEndDate.getTime() + 24 * 60 * 60 * 1000);
            }
            outMarginThreshold = new Date(shiftEndDate.getTime() - outMargin * 60 * 1000);

            // Skip web checkout if before half day limit
            if (workedHours < halfDayLimit) {
                throw new Error(`EARLY_OUT_BLOCKED: Check-out blocked. You cannot check out before the session half-day limit (${(halfDayLimit).toFixed(2)} hours).`);
            }

            if (now < shiftEndDate) {
                isEarlyCheckoutAttempt = true;
            }
        }

        if (!approvedRequest) {
            let triggersEarlyOutRequest = false;
            if (isEarlyCheckoutAttempt) {
                if (outMarginThreshold && now < outMarginThreshold) {
                    triggersEarlyOutRequest = true;
                }
            }

            if (triggersEarlyOutRequest) {
                // AUTO-CREATE PENDING ENTRY/EXIT REQUEST
                const existingRequest = await db('attendance_entry_requests')
                    .where({ employee_id: empId, company_id: companyId, date: dateStr, request_type: 'early_out' })
                    .first();
                if (!existingRequest) {
                    await db('attendance_entry_requests').insert({
                        company_id: companyId,
                        employee_id: empId,
                        date: dateStr,
                        request_type: 'early_out',
                        punch_time: punchTimeStr,
                        location_data: JSON.stringify({ ...locationData, source: 'web' }),
                        status: 'pending',
                        created_at: db.fn.now(),
                        updated_at: db.fn.now()
                    });

                    await this.notifyAdminsAndManager(
                        companyId,
                        empId,
                        'Early Out Approval Required',
                        `${employee?.first_name || ''} ${employee?.last_name || ''} has punched out early and requires approval.`
                    );
                }
                throw new Error('EARLY_OUT_APPROVAL_REQUIRED: Check-out blocked. Early Out request has been auto-submitted for approval.');
            }
        }

        await attendanceRepository.punchOut(empId, companyId, locationData);

        // Recalculate and update status in database on checkout
        let newStatus = activeEntry.status || 'present';
        if (employee?.is_flexi) {
            const minHours = parseFloat(employee.min_hours) || 8;
            if (workedHours < halfDayLimit) {
                newStatus = 'absent';
            } else if (workedHours < minHours) {
                newStatus = 'half-day';
            } else {
                newStatus = 'present';
            }
        } else {
            if (outMarginThreshold && shiftEndDate && now >= outMarginThreshold && now < shiftEndDate) {
                newStatus = 'early_out';
            } else if (workedHours < halfDayLimit) {
                newStatus = 'absent';
            } else if (isEarlyCheckoutAttempt) {
                newStatus = 'early_out';
            } else if (newStatus !== 'pending') {
                newStatus = 'present';
            }
        }

        await db('attendance')
            .where({ id: activeEntry.id })
            .update({ status: newStatus });

        return await attendanceRepository.getCurrentStatus(empId, companyId);
    }

    async getHistory(user, companyId, month, year, extended = false) {
        const empId = await this.getEmployeeId(user.id, companyId, user.employee_id);
        const attendance = await attendanceRepository.getHistory(empId, companyId, month, year);

        if (!extended) {
            return attendance;
        }

        const leaves = await db('leaves')
            .where({ employee_id: empId, company_id: companyId })
            .whereIn('status', ['approved', 'pending'])
            .whereRaw('((MONTH(start_date) = ? AND YEAR(start_date) = ?) OR (MONTH(end_date) = ? AND YEAR(end_date) = ?))', [month, year, month, year]);

        const holidays = await db('holidays')
            .where({ company_id: companyId })
            .whereRaw('MONTH(date) = ? AND YEAR(date) = ?', [month, year]);

        const regularizations = await db('attendance_regularizations')
            .where({ employee_id: empId, company_id: companyId })
            .whereRaw('MONTH(date) = ? AND YEAR(date) = ?', [month, year]);

        const emp = await db('employees')
            .leftJoin('attendance_schemes', 'employees.attendance_scheme_id', 'attendance_schemes.id')
            .where('employees.id', empId)
            .select('attendance_schemes.weekoffs')
            .first();

        let weekoffs = ['Sunday'];
        if (emp?.weekoffs) {
            try {
                weekoffs = JSON.parse(emp.weekoffs);
            } catch (e) {
                // ignore
            }
        }

        return {
            attendance,
            leaves,
            holidays,
            regularizations,
            weekoffs
        };
    }

    async getCurrentStatus(user, companyId) {
        const empId = await this.getEmployeeId(user.id, companyId, user.employee_id);
        return await attendanceRepository.getCurrentStatus(empId, companyId);
    }

    async getMatrix(user, month, year) {
        const companyId = user.company_id;

        // 1. Fetch Company Rules
        const rules = await db('working_rules').where({ company_id: companyId }).first() || {
            shift_start: '09:00',
            grace_period: 15,
            weekoffs: JSON.stringify(['Sunday'])
        };

        const weekoffs = typeof rules.weekoffs === 'string' ? JSON.parse(rules.weekoffs) : (rules.weekoffs || []);
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        // 2. Fetch Raw Data (Employees, Attendance, Leaves, Holidays)
        const holidays = await db('holidays')
            .where({ company_id: companyId })
            .whereRaw('MONTH(date) = ? AND YEAR(date) = ?', [month, year]);

        const raw = await attendanceRepository.getCompanyMatrix(user, month, year);
        const daysInMonth = new Date(year, month, 0).getDate();

        // The shifts these rows were actually recorded under. Keyed by id, so a day is judged by
        // its own pin instead of by whatever the roster resolves to at render time.
        const pinnedShifts = await loadPinnedShifts(raw.attendance);

        const employeeIds = raw.employees.map(e => e.id);
        const shiftAssignments = employeeIds.length > 0 ? await db('employee_shift_assignments as esa')
            .join('shifts as s', 'esa.shift_id', 's.id')
            .whereIn('esa.employee_id', employeeIds)
            .where(qb => {
                qb.where('esa.from_date', '<=', `${year}-${String(month).padStart(2, '0')}-${daysInMonth}`)
                    .andWhere(qb2 => {
                        qb2.where('esa.to_date', '>=', `${year}-${String(month).padStart(2, '0')}-01`)
                            .orWhereNull('esa.to_date');
                    });
            })
            .select(
                'esa.employee_id',
                'esa.from_date',
                'esa.to_date',
                's.name',
                's.is_flexi',
                's.min_hours',
                's.start_time',
                's.end_time',
                's.grace_period',
                's.grace_count_limit',
                's.total_punches_required',
                's.session2_start_time',
                's.session2_end_time',
                's.session1_grace_out',
                's.session2_grace_in',
                's.session2_grace_out',
                's.session1_in_margin',
                's.session1_out_margin',
                's.session2_in_margin',
                's.session2_out_margin',
                's.terminate_hour',
                'esa.id'
            )
            .modify(byEffectiveAssignment) : [];

        const formatDbDate = (val) => {
            if (!val) return null;
            if (val instanceof Date) {
                return val.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
            }
            return String(val).split('T')[0];
        };

        // Pre-format shift assignments and group them by employee_id for O(1) employee shift overrides lookup
        const shiftAssignmentsByEmployee = {};
        shiftAssignments.forEach(sa => {
            const empId = sa.employee_id;
            if (!shiftAssignmentsByEmployee[empId]) {
                shiftAssignmentsByEmployee[empId] = [];
            }
            shiftAssignmentsByEmployee[empId].push({
                ...sa,
                fromStr: formatDbDate(sa.from_date),
                toStr: formatDbDate(sa.to_date)
            });
        });

        // Pre-parse and group attendance logs by employee_id and day (using logical date)
        const attendanceMap = {};
        raw.attendance.forEach(a => {
            const empId = a.employee_id;
            const employeeInfo = raw.employees.find(e => e.id === empId);
            const empAssignments = shiftAssignmentsByEmployee[empId] || [];
            const defaultShift = employeeInfo ? { start_time: employeeInfo.shift_start, end_time: employeeInfo.shift_end } : null;
            
            const logicalDate = rowLogicalDate(a, empAssignments, defaultShift);
            if (logicalDate) {
                const [lyStr, lmStr, ldStr] = logicalDate.split('-');
                const ly = parseInt(lyStr, 10);
                const lm = parseInt(lmStr, 10);
                const ld = parseInt(ldStr, 10);

                if (lm === parseInt(month, 10) && ly === parseInt(year, 10)) {
                    const day = ld;
                    const time = dbDateToUTC(a.check_in).getTime();
                    
                    if (!attendanceMap[empId]) {
                        attendanceMap[empId] = {};
                    }
                    if (!attendanceMap[empId][day]) {
                        attendanceMap[empId][day] = [];
                    }
                    attendanceMap[empId][day].push({
                        ...a,
                        day,
                        time
                    });
                }
            }
        });
        
        // Sort each array
        Object.keys(attendanceMap).forEach(empId => {
            Object.keys(attendanceMap[empId]).forEach(day => {
                attendanceMap[empId][day].sort((a, b) => a.time - b.time);
            });
        });

        // Pre-parse and group regularizations by employee_id and day
        const regularizationsMap = {};
        if (raw.regularizations) {
            raw.regularizations.forEach(r => {
                const empId = r.employee_id;
                const dayYmd = toLocalYMD(r.date);
                const day = dayYmd ? parseInt(dayYmd.split('-')[2], 10) : new Date(r.date).getDate();
                if (!regularizationsMap[empId]) {
                    regularizationsMap[empId] = {};
                }
                regularizationsMap[empId][day] = r;
            });
        }

        // Pre-parse and group entry/exit requests by employee_id and day
        const entryRequestsMap = {};
        if (raw.entryRequests) {
            raw.entryRequests.forEach(er => {
                const empId = er.employee_id;
                const dayYmd = toLocalYMD(er.date);
                const day = dayYmd ? parseInt(dayYmd.split('-')[2], 10) : new Date(er.date).getDate();
                if (!entryRequestsMap[empId]) {
                    entryRequestsMap[empId] = {};
                }
                entryRequestsMap[empId][day] = er;
            });
        }

        // Pre-parse and group leaves by employee_id with timestamp bounds
        const leavesMap = {};
        if (raw.leaves) {
            raw.leaves.forEach(l => {
                const empId = l.employee_id;
                const start = new Date(l.start_date);
                const end = new Date(l.end_date);
                start.setHours(0, 0, 0, 0);
                end.setHours(23, 59, 59, 999);
                
                if (!leavesMap[empId]) {
                    leavesMap[empId] = [];
                }
                leavesMap[empId].push({
                    ...l,
                    startTime: start.getTime(),
                    endTime: end.getTime()
                });
            });
        }

        const matrix = raw.employees.map(emp => {
            const grid = {};
            const grid_timings = {};
            const grid_meta = {};
            const stats = { P: 0, L: 0, A: 0, PL: 0, UL: 0, OFF: 0, H: 0 };

            // Resolve employee specific weekoffs from scheme if assigned
            const empWeekoffs = emp.scheme_weekoffs
                ? (typeof emp.scheme_weekoffs === 'string' ? JSON.parse(emp.scheme_weekoffs) : emp.scheme_weekoffs)
                : weekoffs;

            const empJoinStr = emp.joining_date ? toLocalYMD(emp.joining_date) : null;
            const empResignStr = emp.resignation_date ? toLocalYMD(emp.resignation_date) : null;

            const empAssignments = shiftAssignmentsByEmployee[emp.id] || [];
            const empLeaves = leavesMap[emp.id] || [];

            for (let d = 1; d <= daysInMonth; d++) {
                const date = new Date(year, month - 1, d);
                const dayName = dayNames[date.getDay()];
                const targetDateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const dateTime = date.getTime();

                // 1. Check Attendance (Includes Manual Overrides, Biometric, Regularization, Entry/Exit Requests)
                // Read BEFORE the shift is resolved: the day's own rows say which shift it was
                // recorded under, and that outranks the roster.
                const dayLogs = (attendanceMap[emp.id] && attendanceMap[emp.id][d]) || [];

                const dayRegularization = regularizationsMap[emp.id]?.[d];
                const dayEarlyOut = entryRequestsMap[emp.id]?.[d];

                // Resolve active shift for this employee on targetDateStr
                const rosterAssignment = empAssignments.find(sa =>
                    sa.fromStr <= targetDateStr && (!sa.toStr || sa.toStr >= targetDateStr)
                );
                // A settled day is judged by the shift it was worked under, not by the shift the
                // roster happens to name now. Without this, moving an employee from a 09:00-18:00
                // shift to a 4-punch split - the ordinary "enter the rotation a few days late"
                // flow - turned a finished on-time day into HD and halved that day's pay.
                const activeAssignment = shiftForDay(dayLogs, pinnedShifts, rosterAssignment);

                const resolvedShift = {
                    ...emp,
                    is_flexi: activeAssignment ? activeAssignment.is_flexi : emp.shift_is_flexi,
                    min_hours: activeAssignment ? activeAssignment.min_hours : emp.min_hours,
                    start_time: activeAssignment ? activeAssignment.start_time : emp.shift_start,
                    end_time: activeAssignment ? activeAssignment.end_time : emp.shift_end,
                    grace_period: activeAssignment ? activeAssignment.grace_period : emp.shift_grace,
                    grace_count_limit: activeAssignment ? activeAssignment.grace_count_limit : emp.shift_grace_count_limit,
                    total_punches_required: activeAssignment ? activeAssignment.total_punches_required : emp.shift_total_punches,
                    session2_start_time: activeAssignment ? activeAssignment.session2_start_time : emp.shift_session2_start,
                    session2_end_time: activeAssignment ? activeAssignment.session2_end_time : emp.shift_session2_end,
                    session1_grace_out: activeAssignment ? activeAssignment.session1_grace_out : emp.shift_session1_grace_out,
                    session2_grace_in: activeAssignment ? activeAssignment.session2_grace_in : emp.shift_session2_grace_in,
                    session2_grace_out: activeAssignment ? activeAssignment.session2_grace_out : emp.shift_session2_grace_out,
                    session1_in_margin: activeAssignment ? activeAssignment.session1_in_margin : emp.shift_session1_in_margin,
                    session1_out_margin: activeAssignment ? activeAssignment.session1_out_margin : emp.shift_session1_out_margin,
                    session2_in_margin: activeAssignment ? activeAssignment.session2_in_margin : emp.shift_session2_in_margin,
                    session2_out_margin: activeAssignment ? activeAssignment.session2_out_margin : emp.shift_session2_out_margin,
                    terminate_hour: activeAssignment ? activeAssignment.terminate_hour : emp.terminate_hour
                };

                // Check joining date constraint
                if (empJoinStr && targetDateStr < empJoinStr) {
                    grid[d] = '-';
                    continue;
                }

                // Check resignation date constraint
                if (empResignStr && targetDateStr > empResignStr) {
                    grid[d] = '-';
                    continue;
                }

                let status = '-'; // Default unknown

                if (dayLogs.length > 0 || dayRegularization || dayEarlyOut) {
                    // Shared with the history sheet and the day-detail drawer - see resolveDayStatus.
                    status = resolveDayStatus(dayLogs, resolvedShift, rules, {
                        regularization: !!dayRegularization,
                        earlyOutRequest: !!dayEarlyOut
                    });
                    bumpDayStats(stats, status);
                } else {
                    // 2. Check Week-offs
                    if (empWeekoffs.includes(dayName)) {
                        status = 'OFF';
                        stats.OFF++;
                    }
                    // 3. Check Holidays
                    else if (holidays.some(h => {
                        const dayYmd = toLocalYMD(h.date);
                        return dayYmd && parseInt(dayYmd.split('-')[2], 10) === d;
                    })) {
                        status = 'H';
                        stats.H++;
                    } else {
                        // 4. Check Leaves
                        const onLeave = empLeaves.find(l =>
                            l.startTime <= dateTime && l.endTime >= dateTime
                        );

                        if (onLeave) {
                            const isPaid = !onLeave.leave_type_name.toLowerCase().includes('unpaid') &&
                                !onLeave.leave_type_name.toLowerCase().includes('lop');
                            status = isPaid ? 'PL' : 'UL';
                            const isHalfDay = Number(onLeave.days) === 0.5 &&
                                toLocalYMD(onLeave.start_date) === toLocalYMD(onLeave.end_date);
                            const leaveIncrement = isHalfDay ? 0.5 : 1;
                            if (isPaid) stats.PL += leaveIncrement; else stats.UL += leaveIncrement;
                        } else {
                            const today = new Date();
                            today.setHours(0, 0, 0, 0);
                            if (date < today) {
                                status = 'A'; // Absent
                                stats.A++;
                            } else if (date.getTime() === today.getTime()) {
                                const now = new Date();
                                const shiftEndStr = resolvedShift.end_time || '18:00';
                                const [h, m] = shiftEndStr.split(':').map(Number);
                                const terminateHour = parseInt(resolvedShift.terminate_hour || 2);
                                
                                const targetDateStr = formatDbDate(date);
                                const shiftStartStr = resolvedShift.start_time || '09:00';
                                const [sHours, sMins] = shiftStartStr.split(':').map(Number);
                                const shiftStartDate = new Date(`${targetDateStr}T${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00+05:30`);
                                let shiftEndDate = new Date(`${targetDateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
                                if (shiftEndDate < shiftStartDate) {
                                    shiftEndDate = new Date(shiftEndDate.getTime() + 24 * 60 * 60 * 1000);
                                }
                                const terminationDate = new Date(shiftEndDate.getTime() + (terminateHour * 60 * 60 * 1000));
                                
                                if (now > terminationDate) {
                                    status = 'A'; // Absent after shift termination
                                    stats.A++;
                                }
                            }
                        }
                    }
                }
                let in1 = null, out1 = null, in2 = null, out2 = null;
                let isGrace = false;

                const timeToMinsLocal = (timeStr) => {
                    if (!timeStr) return 0;
                    const [h, m] = timeStr.split(':').map(Number);
                    return h * 60 + m;
                };
                const dateToMinsLocal = (dateVal) => {
                    return dateToISTMins(dateVal);
                };

                const reqPunches = parseInt(resolvedShift.total_punches_required || 2);
                if (dayLogs && dayLogs.length > 0) {
                    const s1Start = timeToMinsLocal(resolvedShift.start_time || '09:00');
                    const grace1In = parseInt(emp.scheme_grace ?? resolvedShift.grace_period ?? rules.grace_period ?? 15);

                    if (reqPunches === 4) {
                        const s2Start = timeToMinsLocal(resolvedShift.session2_start_time || '14:00');
                        const grace2In = parseInt(resolvedShift.session2_grace_in || 15);
                        const s2InMargin = parseInt(resolvedShift.session2_in_margin || 30);

                        const s1Logs = dayLogs.filter(log => dateToMinsLocal(log.check_in) < (s2Start - s2InMargin));
                        const s2Logs = dayLogs.filter(log => dateToMinsLocal(log.check_in) >= (s2Start - s2InMargin));

                        if (s1Logs[0]) {
                            in1 = s1Logs[0].check_in;
                            out1 = s1Logs[0].check_out;
                            const inMins1 = dateToMinsLocal(s1Logs[0].check_in);
                            if (inMins1 > s1Start && inMins1 <= (s1Start + grace1In)) {
                                isGrace = true;
                            }
                        }
                        if (s2Logs[0]) {
                            in2 = s2Logs[0].check_in;
                            out2 = s2Logs[0].check_out;
                            const inMins2 = dateToMinsLocal(s2Logs[0].check_in);
                            if (inMins2 > s2Start && inMins2 <= (s2Start + grace2In)) {
                                isGrace = true;
                            }
                        }
                    } else {
                        if (dayLogs[0]) {
                            in1 = dayLogs[0].check_in;
                            out1 = dayLogs[0].check_out;
                            const inMins = dateToMinsLocal(dayLogs[0].check_in);
                            if (inMins > s1Start && inMins <= (s1Start + grace1In)) {
                                isGrace = true;
                            }
                        }
                    }
                }
                grid[d] = status;
                grid_timings[d] = { in1, out1, in2, out2 };
                grid_meta[d] = {
                    is_override: dayLogs.some(a => a.punch_source === 'manual' || a.punch_source === 'manual_override'),
                    is_grace: isGrace && status !== 'L' && status !== 'A' && status !== '-',
                    // The row header can only carry ONE shift name (employees.shift_id, the
                    // profile default), so every day of the month is labelled with the shift the
                    // employee holds today - which is what makes a wrong-looking cell read as
                    // plausible to an admin. This is the shift the day was actually judged by.
                    shift_name: activeAssignment?.name || emp.shift_name || null
                };
            }

            return {
                id: emp.id,
                name: `${emp.first_name} ${emp.last_name}`,
                code: emp.employee_id_number,
                role: emp.designation,
                department: emp.department_name || 'General',
                location: emp.office_location || 'Unassigned',
                shift_name: emp.shift_name || null,
                shift_start: emp.shift_start || null,
                shift_end: emp.shift_end || null,
                shift_is_flexi: emp.shift_is_flexi || null,
                days: grid,
                timings: grid_timings,
                meta: grid_meta,
                stats
            };
        });

        return { matrix, days: daysInMonth };
    }
    async manualOverride(user, data) {
        // data: { employee_id, date, status, check_in, check_out }
        const { employee_id, date, status, check_in, check_out } = data;
        const companyId = user.company_id;
        const dbStatus = mapFrontendStatusToDb(status);

        const employee = await db('employees as e')
            .leftJoin('shifts as s', 'e.shift_id', 's.id')
            .where('e.id', employee_id)
            .select('e.*', 's.start_time as shift_start', 's.end_time as shift_end')
            .first();
        const defaultShift = employee ? { start_time: employee.shift_start, end_time: employee.shift_end } : null;
        const empAssignments = await db('employee_shift_assignments as esa')
            .join('shifts as s', 'esa.shift_id', 's.id')
            .where('esa.employee_id', employee_id)
            .select('esa.from_date', 'esa.to_date', 's.start_time', 's.end_time')
            .modify(byEffectiveAssignment);

        const nextDate = new Date(new Date(date).getTime() + 24 * 60 * 60 * 1000);
        const nextDateStr = nextDate.toISOString().split('T')[0];

        const candidateLogs = await db('attendance')
            .where({ employee_id, company_id: companyId })
            .where('check_in', '>=', `${date} 00:00:00`)
            .where('check_in', '<=', `${nextDateStr} 23:59:59`);

        let existing = null;
        for (const log of candidateLogs) {
            const lDate = rowLogicalDate(log, empAssignments, defaultShift);
            if (lDate === date) {
                existing = log;
                break;
            }
        }

        if (existing) {
            await db('attendance')
                .where({ id: existing.id })
                .update({
                    status: dbStatus,
                    check_in: check_in || existing.check_in,
                    check_out: check_out || existing.check_out,
                    punch_source: 'manual',
                    updated_at: db.fn.now()
                });
        } else {
            await db('attendance').insert({
                employee_id,
                company_id: companyId,
                status: dbStatus,
                check_in: check_in || `${date} 12:00:00`,
                check_out: check_out || `${date} 18:00:00`,
                punch_source: 'manual',
                created_at: db.fn.now()
            });
        }
        return { message: 'Attendance record updated successfully' };
    }
    async getWhosInStats(user, dateStr) {
        const companyId = user.company_id;

        // Robust Date Handling (Avoid UTC shifts for Local reporting)
        let dateObj;
        if (dateStr) {
            dateObj = new Date(dateStr);
            if (isNaN(dateObj.getTime())) dateObj = new Date();
        } else {
            dateObj = new Date();
        }

        const y = dateObj.getFullYear();
        const m = String(dateObj.getMonth() + 1).padStart(2, '0');
        const d = String(dateObj.getDate()).padStart(2, '0');
        const formattedDate = `${y}-${m}-${d}`;

        // 1. Fetch Company Rules (Fallback)
        const rules = await db('working_rules').where({ company_id: companyId }).first() || {
            shift_start: '09:00',
            grace_period: 15
        };

        // 2. Fetch All Employees with Shift Info and Scheme Info
        const employees = await db('employees')
            .leftJoin('shifts', 'employees.shift_id', 'shifts.id')
            .leftJoin('attendance_schemes', 'employees.attendance_scheme_id', 'attendance_schemes.id')
            .leftJoin('departments', 'employees.department_id', 'departments.id')
            .where({ 'employees.company_id': companyId, 'employees.status': 'active' })
            .select(
                'employees.id',
                'employees.first_name',
                'employees.last_name',
                'employees.employee_id_number',
                'employees.office_location',
                'employees.designation',
                'departments.name as department_name',
                'shifts.start_time as shift_start',
                'shifts.grace_period as shift_grace',
                'shifts.name as shift_name',
                'shifts.is_flexi as shift_is_flexi',
                'attendance_schemes.grace_period as scheme_grace'
            );

        // 3. Fetch Attendance for the target date
        const attendance = await db('attendance')
            .where({ company_id: companyId })
            .where('check_in', '>=', `${formattedDate} 00:00:00`)
            .where('check_in', '<=', `${formattedDate} 23:59:59`)
            .select(
                'employee_id',
                'check_in',
                'check_out',
                'status',
                'logical_date',
                'review_reason',
                'latitude',
                'longitude',
                'accuracy',
                'punch_location',
                'remarks',
                'out_latitude',
                'out_longitude',
                'out_accuracy',
                'out_punch_location',
                'out_remarks'
            );

        // 4. Fetch Leaves for the target date
        const leaves = await db('leaves')
            .where({ company_id: companyId, status: 'approved' })
            .where('start_date', '<=', formattedDate)
            .where('end_date', '>=', formattedDate)
            .select('employee_id');

        // Fetch shift assignments active on this specific date (order by ID descending to respect latest override)
        const assignments = await db('employee_shift_assignments as esa')
            .join('shifts as s', 'esa.shift_id', 's.id')
            .where('esa.company_id', companyId)
            .where('esa.from_date', '<=', formattedDate)
            .andWhere(function () {
                this.where('esa.to_date', '>=', formattedDate).orWhereNull('esa.to_date');
            })
            .select('esa.employee_id', 's.start_time', 's.grace_period', 's.name', 's.is_flexi')
            .modify(byEffectiveAssignment);

        // 5. Categorize
        const onTime = [];
        const lateArrivals = [];
        const notYetIn = [];
        const onLeave = leaves.map(l => l.employee_id);

        for (const emp of employees) {
            if (onLeave.includes(emp.id)) continue;

            const record = attendance.find(a => a.employee_id === emp.id);

            // Resolve overridden shift
            const activeAssignment = assignments.find(a => a.employee_id === emp.id);

            // Determine if this employee is on a flexi/anytime shift
            const isFlexi = activeAssignment ? !!activeAssignment.is_flexi : !!emp.shift_is_flexi;

            const shiftStart = activeAssignment ? activeAssignment.start_time : (emp.shift_start || rules.shift_start);
            const grace = activeAssignment
                ? activeAssignment.grace_period
                : (emp.scheme_grace !== undefined && emp.scheme_grace !== null
                    ? emp.scheme_grace
                    : (emp.shift_grace !== undefined && emp.shift_grace !== null ? emp.shift_grace : rules.grace_period));
            const shiftName = activeAssignment ? activeAssignment.name : (emp.shift_name || 'General');

            if (!record) {
                notYetIn.push({
                    name: `${emp.first_name} ${emp.last_name}`,
                    id: emp.employee_id_number,
                    time: isFlexi ? 'Flexi' : shiftStart,
                    shift_name: shiftName,
                    office_location: emp.office_location || 'Unassigned',
                    designation: emp.designation || 'Staff',
                    department: emp.department_name || 'General'
                });
            } else {
                const checkIn = new Date(record.check_in);
                const timeStr = checkIn.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
                const checkOutTimeStr = record.check_out ? new Date(record.check_out).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : null;

                const baseEntry = {
                    name: `${emp.first_name} ${emp.last_name}`,
                    id: emp.employee_id_number,
                    time: timeStr,
                    shift_name: shiftName,
                    latitude: record.latitude,
                    longitude: record.longitude,
                    accuracy: record.accuracy,
                    punch_location: record.punch_location,
                    remarks: record.remarks,
                    out_latitude: record.out_latitude,
                    out_longitude: record.out_longitude,
                    out_accuracy: record.out_accuracy,
                    out_punch_location: record.out_punch_location,
                    out_remarks: record.out_remarks,
                    check_out: checkOutTimeStr,
                    office_location: emp.office_location || 'Unassigned',
                    designation: emp.designation || 'Staff',
                    department: emp.department_name || 'General'
                };

                // Flexi shift employees are always "On-Time" — no late calculation
                if (isFlexi) {
                    onTime.push({ ...baseEntry, early: 'Flexi' });
                } else {
                    const [sHours, sMins] = shiftStart.split(':').map(Number);
                    const targetDateStr = dateObj.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
                    const shiftStartActual = new Date(`${targetDateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);

                    const totalMins = sMins + (parseInt(grace) || 0);
                    const allowedHours = String(sHours + Math.floor(totalMins / 60)).padStart(2, '0');
                    const allowedMins = String(totalMins % 60).padStart(2, '0');
                    const shiftStartLimit = new Date(`${targetDateStr} ${allowedHours}:${allowedMins}:00 +05:30`);

                    const isLate = checkIn > shiftStartLimit;

                    if (isLate) {
                        const diffMs = checkIn - shiftStartLimit;
                        const lateMins = Math.floor(diffMs / 60000);
                        const lateHours = Math.floor(lateMins / 60);
                        const lateStr = `${String(lateHours).padStart(2, '0')}:${String(lateMins % 60).padStart(2, '0')}`;
                        lateArrivals.push({ ...baseEntry, late: lateStr });
                    } else {
                        let earlyMins = 0;
                        if (checkIn < shiftStartActual) {
                            const diffMs = shiftStartActual - checkIn;
                            earlyMins = Math.floor(diffMs / 60000);
                        }
                        const earlyHours = Math.floor(earlyMins / 60);
                        const earlyStr = `${String(earlyHours).padStart(2, '0')}:${String(earlyMins % 60).padStart(2, '0')}`;
                        onTime.push({ ...baseEntry, early: earlyStr });
                    }
                }
            }
        }

        const total = employees.length;
        return {
            summary: [
                { label: 'Not Yet In', count: notYetIn.length, percentage: total > 0 ? Math.round((notYetIn.length / total) * 100) + '%' : '0%', color: 'text-rose-500', bg: 'bg-rose-50' },
                { label: 'Late Arrivals', count: lateArrivals.length, percentage: total > 0 ? Math.round((lateArrivals.length / total) * 100) + '%' : '0%', color: 'text-amber-500', bg: 'bg-amber-50' },
                { label: 'On-Time', count: onTime.length, percentage: total > 0 ? Math.round((onTime.length / total) * 100) + '%' : '0%', color: 'text-emerald-500', bg: 'bg-emerald-50' },
                { label: 'Out of Office', count: onLeave.length, percentage: total > 0 ? Math.round((onLeave.length / total) * 100) + '%' : '0%', color: 'text-slate-400', bg: 'bg-slate-50' }
            ],
            notYetIn,
            lateArrivals,
            onTime,
            onLeaveCount: onLeave.length
        };
    }

    async getShifts(companyId) {
        return await db('shifts').where({ company_id: companyId });
    }

    async getEmployeesByShift(companyId, shiftId, fromDate, toDate) {
        // Fetch all active employees in the company with department/designation details
        const employees = await db('employees')
            .leftJoin('departments', 'employees.department_id', 'departments.id')
            .where({ 'employees.company_id': companyId, 'employees.status': 'active' })
            .select(
                'employees.id',
                'employees.first_name',
                'employees.last_name',
                'employees.employee_id_number',
                'employees.shift_id',
                'employees.office_location',
                'employees.designation',
                'departments.name as department_name'
            );

        // Fetch all shift assignments active during the period
        const assignments = await db('employee_shift_assignments')
            .where('company_id', companyId)
            .where('from_date', '<=', toDate || fromDate)
            .andWhere(function () {
                this.where('to_date', '>=', fromDate).orWhereNull('to_date');
            })
            .select('employee_id', 'shift_id', 'id')
            .orderBy('id', 'asc');

        // Map assignments to employee ID for easy lookup
        const assignmentMap = {};
        assignments.forEach(a => {
            assignmentMap[a.employee_id] = a.shift_id;
        });

        // Filter employees based on resolved shift
        const filtered = employees.filter(emp => {
            const resolvedShiftId = assignmentMap[emp.id] !== undefined ? assignmentMap[emp.id] : emp.shift_id;

            if (shiftId === 'all' || String(shiftId).toLowerCase() === 'all') {
                return true;
            }
            return String(resolvedShiftId) === String(shiftId);
        });

        return filtered.map(emp => ({
            id: emp.id,
            first_name: emp.first_name,
            last_name: emp.last_name,
            employee_id_number: emp.employee_id_number,
            office_location: emp.office_location,
            designation: emp.designation,
            department_name: emp.department_name
        }));
    }

    async shiftOverrideLogic(user, companyId, data) {
        const { employee_ids, from_date, to_date } = data;
        const start = new Date(from_date);
        const end = new Date(to_date || from_date);

        await db.transaction(async (trx) => {
            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                const dateStr = toLocalYMD(d);

                for (const empId of employee_ids) {
                    // Check existing attendance
                    const existing = await trx('attendance')
                        .where({ employee_id: empId, company_id: companyId })
                        .whereRaw('DATE(check_in) = ?', [dateStr])
                        .first();

                    if (!existing) {
                        // Mark Absent as Present
                        const [id] = await trx('attendance').insert({
                            employee_id: empId,
                            company_id: companyId,
                            check_in: `${dateStr} 12:00:00`,
                            check_out: `${dateStr} 18:00:00`,
                            status: 'present',
                            created_at: db.fn.now()
                        });

                        await this.logOverride(trx, user, empId, companyId, dateStr, 'A', 'P', 'Shift Bulk Override');
                    }
                }
            }
        });

        return { message: 'Override applied successfully' };
    }

    async getEmployeeAttendanceHistory(companyId, employeeId, from, to) {
        // Adjust the query range slightly to capture crossover night shifts
        const nextToDate = new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
        const attendance = await db('attendance')
            .where({ employee_id: employeeId, company_id: companyId })
            .whereRaw('DATE(check_in) >= ? AND DATE(check_in) <= ?', [from, nextToDate])
            .orderBy('check_in', 'asc');

        const shifts = await db('employee_shift_assignments as esa')
            .join('shifts as s', 'esa.shift_id', 's.id')
            .where({ 'esa.employee_id': employeeId })
            .select('s.*', 'esa.from_date', 'esa.to_date')
            .modify(byEffectiveAssignment);

        const employee = await db('employees as e')
            .leftJoin('shifts as s', 'e.shift_id', 's.id')
            .where('e.id', employeeId)
            .select('s.*', 's.name as default_shift_name')
            .first();
        const defaultShiftName = employee?.default_shift_name || '---';

        const pinnedShifts = await loadPinnedShifts(attendance);
        const rules = await db('working_rules').where({ company_id: companyId }).first() || {};

        // The muster treats an approved early-out request / regularization as the day's answer even
        // when no attendance row carries it. This sheet has to see the same two facts or it will
        // still disagree with the grid on exactly those days.
        const approvedEarlyOuts = await db('attendance_entry_requests')
            .where({ employee_id: employeeId, company_id: companyId, request_type: 'early_out', status: 'approved' })
            .whereBetween('date', [from, to])
            .select('date');
        const approvedRegularizations = await db('attendance_regularizations')
            .where({ employee_id: employeeId, company_id: companyId, status: 'approved' })
            .whereBetween('date', [from, to])
            .select('date');
        const earlyOutDays = new Set(approvedEarlyOuts.map(r => toLocalYMD(r.date)));
        const regularizedDays = new Set(approvedRegularizations.map(r => toLocalYMD(r.date)));

        // Map into a daily sheet
        const start = new Date(from);
        const end = new Date(to);
        const sheet = [];

        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            const dateStr = toLocalYMD(d);
            const dayLogs = attendance.filter(a => {
                const logLogicalDate = rowLogicalDate(a, shifts, employee);
                return logLogicalDate === dateStr;
            });
            const rosterShift = shifts.find(s => {
                const fromStr = toLocalYMD(s.from_date);
                const toStr = toLocalYMD(s.to_date);
                return dateStr >= fromStr && (!toStr || dateStr <= toStr);
            });
            // The shift the day was recorded under outranks the roster - the same rule the muster
            // applies, and the reason this sheet no longer contradicts it after a rotation entry.
            const shift = shiftForDay(dayLogs, pinnedShifts, rosterShift, employee);

            const s1Ms = dayLogs[0] && dayLogs[0].check_out ? (new Date(dayLogs[0].check_out) - new Date(dayLogs[0].check_in)) : 0;
            const s2Ms = dayLogs[1] && dayLogs[1].check_out ? (new Date(dayLogs[1].check_out) - new Date(dayLogs[1].check_in)) : 0;

            // This sheet used to read attendance.status straight out of the row while the muster
            // recomputed the same day, so a day could read P here and L/HD/E on the admin grid.
            // Both now go through resolveDayStatus.
            const historyStatus = resolveDayStatus(dayLogs, shift, rules, {
                regularization: regularizedDays.has(dateStr),
                earlyOutRequest: earlyOutDays.has(dateStr)
            }) || 'A';

            sheet.push({
                date: dateStr,
                shift_code: shift?.name || defaultShiftName,
                status: historyStatus,
                first_in: dayLogs[0] ? safeFormatTime(dayLogs[0].check_in) : null,
                last_out: dayLogs[dayLogs.length - 1] ? safeFormatTime(dayLogs[dayLogs.length - 1].check_out) : null,
                session1: s1Ms > 0 ? `${(s1Ms / 3600000).toFixed(1)}h` : '0.0h',
                session2: s2Ms > 0 ? `${(s2Ms / 3600000).toFixed(1)}h` : '0.0h'
            });
        }
        return sheet;
    }

    async getDateWiseAttendance(companyId, date) {
        const employees = await db('employees')
            .leftJoin('departments', 'employees.department_id', 'departments.id')
            .where({ 'employees.company_id': companyId })
            .select(
                'employees.id',
                'employees.first_name',
                'employees.last_name',
                'employees.employee_id_number',
                'employees.shift_id',
                'employees.office_location',
                'employees.designation',
                'departments.name as department_name'
            );

        // Fetch shift assignments active on this specific date. `s.*` rather than four columns:
        // this row is handed to the shared status resolver, which needs the whole shift.
        const assignments = await db('employee_shift_assignments as esa')
            .join('shifts as s', 'esa.shift_id', 's.id')
            .where('esa.company_id', companyId)
            .where('esa.from_date', '<=', date)
            .andWhere(function () {
                this.where('esa.to_date', '>=', date).orWhereNull('esa.to_date');
            })
            .select('esa.employee_id', 's.*', 's.name as shift_name')
            .modify(byEffectiveAssignment);

        const shifts = await db('shifts').where({ company_id: companyId });

        const rules = await db('working_rules').where({ company_id: companyId }).first() || {};

        const nextDate = new Date(new Date(date).getTime() + 24 * 60 * 60 * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
        const attendance = await db('attendance')
            .where({ company_id: companyId })
            .where(qb => {
                qb.whereRaw('DATE(check_in) = ?', [date])
                  .orWhereRaw('DATE(check_in) = ?', [nextDate]);
            });

        const pinnedShifts = await loadPinnedShifts(attendance);

        return employees.map(emp => {
            const rosterAssignment = assignments.find(a => a.employee_id === emp.id);
            const defaultShift = shifts.find(s => s.id === emp.shift_id);

            const empLogs = attendance.filter(a => {
                if (a.employee_id !== emp.id) return false;
                
                const empAssignments = assignments.filter(asg => asg.employee_id === emp.id);
                const formattedAssignments = empAssignments.map(asg => ({
                    from_date: date,
                    to_date: date,
                    start_time: asg.start_time,
                    end_time: asg.end_time,
                    grace_period: asg.grace_period
                }));
                
                const logLogicalDate = rowLogicalDate(a, formattedAssignments, defaultShift);
                return logLogicalDate === date;
            });
            // The shift the day was recorded under outranks the roster, so this screen labels and
            // judges the day the same way the muster does after a rotation entry.
            const activeShift = shiftForDay(empLogs, pinnedShifts, rosterAssignment, defaultShift);
            const shiftName = activeShift?.shift_name || activeShift?.name || '---';

            const s1Ms = empLogs[0] && empLogs[0].check_out ? (new Date(empLogs[0].check_out) - new Date(empLogs[0].check_in)) : 0;
            const s2Ms = empLogs[1] && empLogs[1].check_out ? (new Date(empLogs[1].check_out) - new Date(empLogs[1].check_in)) : 0;

            return {
                id: emp.id,
                first_name: emp.first_name,
                last_name: emp.last_name,
                employee_id_number: emp.employee_id_number,
                office_location: emp.office_location,
                designation: emp.designation,
                department_name: emp.department_name,
                shift_name: shiftName,
                shift_code: shiftName,
                status: resolveDayStatus(empLogs, activeShift, rules) || 'A',
                first_in: empLogs[0] ? safeFormatTime(empLogs[0].check_in) : null,
                last_out: empLogs[empLogs.length - 1] ? safeFormatTime(empLogs[empLogs.length - 1].check_out) : null,
                session1: s1Ms > 0 ? `${(s1Ms / 3600000).toFixed(1)}h` : '0.0h',
                session2: s2Ms > 0 ? `${(s2Ms / 3600000).toFixed(1)}h` : '0.0h'
            };
        });
    }

    async manualUpdateAttendance(user, companyId, data) {
        const { employee_id, date, status, check_in, check_out } = data;
        const dbStatus = mapFrontendStatusToDb(status);

        await db.transaction(async (trx) => {
            const employee = await trx('employees as e')
                .leftJoin('shifts as s', 'e.shift_id', 's.id')
                .where('e.id', employee_id)
                .select('e.*', 's.start_time as shift_start', 's.end_time as shift_end')
                .first();
            const defaultShift = employee ? { start_time: employee.shift_start, end_time: employee.shift_end } : null;
            const empAssignments = await trx('employee_shift_assignments as esa')
                .join('shifts as s', 'esa.shift_id', 's.id')
                .where('esa.employee_id', employee_id)
                .select('esa.from_date', 'esa.to_date', 's.start_time', 's.end_time')
                .modify(byEffectiveAssignment);

            const nextDate = new Date(new Date(date).getTime() + 24 * 60 * 60 * 1000);
            const nextDateStr = nextDate.toISOString().split('T')[0];

            const candidateLogs = await trx('attendance')
                .where({ employee_id, company_id: companyId })
                .where('check_in', '>=', `${date} 00:00:00`)
                .where('check_in', '<=', `${nextDateStr} 23:59:59`);

            let existing = null;
            for (const log of candidateLogs) {
                const lDate = rowLogicalDate(log, empAssignments, defaultShift);
                if (lDate === date) {
                    existing = log;
                    break;
                }
            }

            const prevStatus = existing?.status || 'absent';

            if (existing) {
                await trx('attendance')
                    .where({ id: existing.id })
                    .update({
                        status: dbStatus,
                        // Changing the status must not rewrite the employee's real punches.
                        // Only overwrite when the caller explicitly supplies new times; a
                        // missing check_out stays missing rather than being back-filled.
                        check_in: check_in || existing.check_in,
                        check_out: check_out || existing.check_out,
                        punch_source: 'manual',
                        updated_at: db.fn.now()
                    });
            } else {
                await trx('attendance').insert({
                    employee_id,
                    company_id: companyId,
                    check_in: `${date} 12:00:00`,
                    check_out: `${date} 18:00:00`,
                    status: dbStatus,
                    punch_source: 'manual',
                    created_at: db.fn.now()
                });
            }

            await this.logOverride(trx, user, employee_id, companyId, date, mapDbStatusToFrontend(prevStatus), status, 'Manual Individual Update');
        });

        return { message: 'Attendance updated successfully' };
    }

    async logOverride(trx, user, employeeId, companyId, attendanceDate, prevStatus, newStatus, type) {
        // Ensure history table exists (Lazy check)
        const hasTable = await trx.schema.hasTable('attendance_override_history');
        if (!hasTable) {
            await trx.schema.createTable('attendance_override_history', table => {
                table.increments('id').primary();
                table.integer('company_id').notNullable();
                table.integer('employee_id').notNullable();
                table.string('attendance_date').notNullable();
                table.string('previous_status');
                table.string('updated_status');
                table.string('override_type');
                table.string('overridden_by_name');
                table.timestamp('created_at').defaultTo(db.fn.now());
            });
        }

        let operatorName = user?.full_name || 'Admin';
        if (user?.id) {
            const operatorEmployee = await trx('employees')
                .where({ user_id: user.id })
                .select('first_name', 'last_name')
                .first();
            if (operatorEmployee) {
                operatorName = `${operatorEmployee.first_name} ${operatorEmployee.last_name}`.trim();
            }
        }

        await trx('attendance_override_history').insert({
            company_id: companyId,
            employee_id: employeeId,
            attendance_date: attendanceDate,
            previous_status: prevStatus,
            updated_status: newStatus,
            override_type: type,
            overridden_by_name: operatorName
        });
    }

    async getOverrideHistory(companyId) {
        const history = await db('attendance_override_history as h')
            .join('employees as e', 'h.employee_id', 'e.id')
            .join('companies as c', 'h.company_id', 'c.id')
            .where('h.company_id', companyId)
            .select(
                'e.first_name', 'e.last_name', 'e.employee_id_number as employee_id',
                'c.name as company_name',
                'h.previous_status', 'h.updated_status', 'h.override_type',
                'h.attendance_date', 'h.overridden_by_name as overridden_by',
                'h.created_at'
            )
            .orderBy('h.created_at', 'desc');

        return history.map(h => ({
            ...h,
            employee_name: `${h.first_name} ${h.last_name}`
        }));
    }

    async getEligibleEmployees(companyId) {
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });

        // Fetch all employees with department/designation details
        const employees = await db('employees')
            .leftJoin('departments', 'employees.department_id', 'departments.id')
            .where({ 'employees.company_id': companyId })
            .select(
                'employees.id',
                'employees.first_name',
                'employees.last_name',
                'employees.employee_id_number',
                'employees.status',
                'employees.office_location',
                'employees.designation',
                'departments.name as department_name'
            );

        // Fetch all shift assignments (active or future)
        const assignments = await db('employee_shift_assignments')
            .join('shifts', 'employee_shift_assignments.shift_id', 'shifts.id')
            .where('employee_shift_assignments.company_id', companyId)
            .select(
                'employee_shift_assignments.employee_id',
                'employee_shift_assignments.from_date',
                'employee_shift_assignments.to_date',
                'shifts.name as shift_name',
                'shifts.id as shift_id'
            )
            .orderBy('employee_shift_assignments.from_date', 'asc');

        const assignmentMap = {};
        assignments.forEach(a => {
            const fromStr = toLocalYMD(a.from_date);
            const toStr = toLocalYMD(a.to_date);
            const empId = a.employee_id;

            if (!assignmentMap[empId]) {
                assignmentMap[empId] = {
                    current: null,
                    upcoming: null
                };
            }

            if (fromStr <= today && (!toStr || toStr >= today)) {
                // If multiple assignments are active (though rare), take the latest start date one
                assignmentMap[empId].current = {
                    shift_id: a.shift_id,
                    shift_name: a.shift_name,
                    from_date: fromStr,
                    to_date: toStr
                };
            } else if (fromStr > today) {
                // Take the earliest upcoming assignment
                if (!assignmentMap[empId].upcoming || fromStr < assignmentMap[empId].upcoming.from_date) {
                    assignmentMap[empId].upcoming = {
                        shift_id: a.shift_id,
                        shift_name: a.shift_name,
                        from_date: fromStr,
                        to_date: toStr
                    };
                }
            }
        });

        return employees.map(emp => {
            const mapData = assignmentMap[emp.id] || { current: null, upcoming: null };
            return {
                ...emp,
                assigned_shift: mapData.current ? mapData.current.shift_name : null,
                assigned_shift_id: mapData.current ? mapData.current.shift_id : null,
                assigned_from_date: mapData.current ? mapData.current.from_date : null,
                assigned_to_date: mapData.current ? mapData.current.to_date : null,
                upcoming_shift: mapData.upcoming ? mapData.upcoming.shift_name : null,
                upcoming_shift_id: mapData.upcoming ? mapData.upcoming.shift_id : null,
                upcoming_from_date: mapData.upcoming ? mapData.upcoming.from_date : null,
                upcoming_to_date: mapData.upcoming ? mapData.upcoming.to_date : null
            };
        });
    }
    async assignShift(user, companyId, data) {
        const { employee_ids, shift_id, from_date, to_date, allow_backdate } = data;

        if (!employee_ids || !shift_id || !from_date) {
            throw new Error('Employees, Shift, and From Date are required');
        }

        const ids = Array.isArray(employee_ids) ? employee_ids : [employee_ids];

        const fromStr = toLocalYMD(from_date) || String(from_date).split('T')[0];
        const todayStr = toLocalYMD(new Date());

        // A backdated assignment silently rewrites days that were already worked: the muster and
        // payroll for those days were computed against the shift that was in force then, and
        // re-resolving them against the new shift turns settled Present rows into Late/Absent.
        // Clients do need it for a genuinely missed rotation entry, so it stays possible - but only
        // when the caller says so explicitly.
        if (fromStr && todayStr && fromStr < todayStr && allow_backdate !== true) {
            throw new Error(`From Date ${fromStr} is in the past. Backdating a shift rewrites attendance and payroll for days already worked - resend with allow_backdate: true to confirm.`);
        }

        // Day before the new assignment starts, walked in IST rather than by string maths so the
        // month/year boundary and the server's own timezone cannot slide it.
        const prevDayStr = toLocalYMD(new Date(dbDateToUTC(`${fromStr} 12:00:00`).getTime() - 24 * 60 * 60 * 1000));

        // 1. Transactional Update
        await db.transaction(async (trx) => {
            // Only a PERMANENT assignment (no end date) supersedes what is already on the roster.
            // A temporary one - a few days' cover - must leave the standing assignment intact, or
            // the employee is left with no assignment at all the day the cover ends, silently
            // falling back to employees.shift_id. That is exactly the "no active assignment" state
            // the roster audit exists to report, and creating it here would be self-defeating.
            const isPermanent = !to_date;

            for (const empId of ids) {
                if (isPermanent) {
                    // This used to only ever append (its old comment admitted as much), which is why
                    // 164 of 231 active employees at one client carry several overlapping open-ended
                    // rows and which shift "wins" is whichever row happened to be inserted last - the
                    // root cause of per-person skipped punches. Close the running assignment first.
                    await trx('employee_shift_assignments')
                        .where({ company_id: companyId, employee_id: empId })
                        .whereNull('to_date')
                        .where('from_date', '<', fromStr)
                        .update({ to_date: prevDayStr });

                    // An open row starting on or after the new from_date covers nothing this
                    // assignment does not. End-dating it would set to_date < from_date, a row no
                    // date range can match but which every "does this employee have a shift"
                    // existence check still counts, so it is removed outright instead. Scoped to
                    // permanent assignments so a short cover cannot delete a scheduled rotation.
                    await trx('employee_shift_assignments')
                        .where({ company_id: companyId, employee_id: empId })
                        .whereNull('to_date')
                        .where('from_date', '>=', fromStr)
                        .del();
                }

                await trx('employee_shift_assignments').insert({
                    company_id: companyId,
                    employee_id: empId,
                    shift_id,
                    from_date,
                    to_date: to_date || null
                });

                // Backward compatibility: update current shift_id in employees table if this is "Permanent" or "Latest"
                if (!to_date) {
                    await trx('employees').where({ id: empId }).update({ shift_id });
                }
            }
        });

        return { message: 'Shifts assigned successfully' };
    }
    async createShift(companyId, data) {
        const {
            name, start_time, end_time, grace_period, grace_count_limit, is_night_shift, is_flexi, min_hours,
            total_punches_required, session2_start_time, session2_end_time,
            session1_grace_out, session2_grace_in, session2_grace_out,
            session1_in_margin, session1_out_margin, session2_in_margin, session2_out_margin,
            terminate_hour
        } = data;

        // For flexi shifts, start/end time are optional (informational only)
        if (!name) {
            throw new Error('Shift Name is required');
        }
        if (!is_flexi && (!start_time || !end_time)) {
            throw new Error('Name, Start Time, and End Time are required');
        }

        const [id] = await db('shifts').insert({
            company_id: companyId,
            name,
            start_time: start_time || '09:00',
            end_time: end_time || '18:00',
            grace_period: grace_period !== undefined ? grace_period : 15,
            grace_count_limit: grace_count_limit !== undefined ? grace_count_limit : 3,
            is_night_shift: !!is_night_shift,
            is_flexi: !!is_flexi,
            min_hours: min_hours !== undefined && min_hours !== null ? parseFloat(min_hours) : 8.0,
            total_punches_required: total_punches_required !== undefined ? parseInt(total_punches_required) : 2,
            session2_start_time: session2_start_time || null,
            session2_end_time: session2_end_time || null,
            session1_grace_out: session1_grace_out !== undefined ? parseInt(session1_grace_out) : 0,
            session2_grace_in: session2_grace_in !== undefined ? parseInt(session2_grace_in) : 15,
            session2_grace_out: session2_grace_out !== undefined ? parseInt(session2_grace_out) : 0,
            session1_in_margin: session1_in_margin !== undefined ? parseInt(session1_in_margin) : 0,
            session1_out_margin: session1_out_margin !== undefined ? parseInt(session1_out_margin) : 0,
            session2_in_margin: session2_in_margin !== undefined ? parseInt(session2_in_margin) : 0,
            session2_out_margin: session2_out_margin !== undefined ? parseInt(session2_out_margin) : 0,
            terminate_hour: terminate_hour !== undefined && terminate_hour !== null && terminate_hour !== '' ? parseInt(terminate_hour) : null,
            created_at: db.fn.now(),
            updated_at: db.fn.now()
        });

        return { id, message: 'Shift created successfully' };
    }

    async updateShift(companyId, id, data) {
        const {
            name, start_time, end_time, grace_period, grace_count_limit, is_night_shift, is_flexi, min_hours,
            total_punches_required, session2_start_time, session2_end_time,
            session1_grace_out, session2_grace_in, session2_grace_out,
            session1_in_margin, session1_out_margin, session2_in_margin, session2_out_margin,
            terminate_hour
        } = data;

        if (!id) {
            throw new Error('Shift ID is required');
        }

        await db('shifts')
            .where({ company_id: companyId, id })
            .update({
                name,
                start_time: start_time || '09:00',
                end_time: end_time || '18:00',
                grace_period: grace_period !== undefined ? grace_period : 15,
                grace_count_limit: grace_count_limit !== undefined ? grace_count_limit : 3,
                is_night_shift: !!is_night_shift,
                is_flexi: !!is_flexi,
                min_hours: min_hours !== undefined && min_hours !== null ? parseFloat(min_hours) : 8.0,
                total_punches_required: total_punches_required !== undefined ? parseInt(total_punches_required) : 2,
                session2_start_time: session2_start_time || null,
                session2_end_time: session2_end_time || null,
                session1_grace_out: session1_grace_out !== undefined ? parseInt(session1_grace_out) : 0,
                session2_grace_in: session2_grace_in !== undefined ? parseInt(session2_grace_in) : 15,
                session2_grace_out: session2_grace_out !== undefined ? parseInt(session2_grace_out) : 0,
                session1_in_margin: session1_in_margin !== undefined ? parseInt(session1_in_margin) : 0,
                session1_out_margin: session1_out_margin !== undefined ? parseInt(session1_out_margin) : 0,
                session2_in_margin: session2_in_margin !== undefined ? parseInt(session2_in_margin) : 0,
                session2_out_margin: session2_out_margin !== undefined ? parseInt(session2_out_margin) : 0,
                terminate_hour: terminate_hour !== undefined && terminate_hour !== null && terminate_hour !== '' ? parseInt(terminate_hour) : null,
                updated_at: db.fn.now()
            });

        return { message: 'Shift updated successfully' };
    }

    async deleteShift(companyId, id) {
        if (!id) {
            throw new Error('Shift ID is required');
        }

        // Safety: update employees referencing this shift to null
        await db('employees')
            .where({ company_id: companyId, shift_id: id })
            .update({ shift_id: null });

        // Clean up assignment periods for this shift
        await db('employee_shift_assignments')
            .where({ company_id: companyId, shift_id: id })
            .del();

        // Delete shift record
        await db('shifts')
            .where({ company_id: companyId, id })
            .del();

        return { message: 'Shift deleted successfully' };
    }

    async getShiftRoster(companyId, month, year, filters = {}) {
        const daysInMonth = new Date(year, month, 0).getDate();
        const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const toDate = `${year}-${String(month).padStart(2, '0')}-${daysInMonth}`;

        // 1. Get employees (joined with shifts, attendance_schemes and departments)
        let employeeQuery = db('employees as e')
            .leftJoin('shifts as s', 'e.shift_id', 's.id')
            .leftJoin('attendance_schemes as asch', 'e.attendance_scheme_id', 'asch.id')
            .leftJoin('departments as d', 'e.department_id', 'd.id');

        if (companyId) {
            employeeQuery = employeeQuery.where({ 'e.company_id': companyId });
        }

        if (filters.employee_id && filters.employee_id !== 'All') {
            employeeQuery = employeeQuery.where('e.id', filters.employee_id);
        }

        let employees = await employeeQuery.select(
            'e.id',
            'e.first_name',
            'e.last_name',
            'e.employee_id_number',
            'e.designation',
            'e.office_location as location',
            'e.department_id',
            's.name as default_shift_name',
            'asch.weekoffs as scheme_weekoffs',
            'asch.name as scheme_name',
            'asch.id as scheme_id',
            'd.name as department_name'
        );

        // Demo fallback for immediate visibility
        if (employees.length === 0) {
            employees = [
                { id: 101, first_name: 'Aashi', last_name: 'Chaurasia', employee_id_number: '2011341', designation: 'HR Intern', location: 'Jaipur', default_shift_name: 'General Shift', scheme_weekoffs: '["Sunday"]', scheme_id: 1, scheme_name: 'Default Attendance Cycle', department_id: 1, department_name: 'Human Resources' },
                { id: 102, first_name: 'Ayushi', last_name: 'Gupta', employee_id_number: '2011342', designation: 'HR Intern', location: 'Jaipur', default_shift_name: 'General Shift', scheme_weekoffs: '["Sunday"]', scheme_id: 1, scheme_name: 'Default Attendance Cycle', department_id: 1, department_name: 'Human Resources' },
                { id: 103, first_name: 'Komal', last_name: 'Saini', employee_id_number: '2011344', designation: 'Front Office', location: 'Jaipur', default_shift_name: 'General Shift', scheme_weekoffs: '["Sunday"]', scheme_id: 1, scheme_name: 'Default Attendance Cycle', department_id: 2, department_name: 'Front Office' },
                { id: 104, first_name: 'Kanisk', last_name: 'Kumar Singh', employee_id_number: '2011345', designation: 'HR Intern', location: 'Jaipur', default_shift_name: 'General Shift', scheme_weekoffs: '["Sunday"]', scheme_id: 1, scheme_name: 'Default Attendance Cycle', department_id: 1, department_name: 'Human Resources' },
                { id: 105, first_name: 'Sony', last_name: 'Kumari', employee_id_number: '2011346', designation: 'HR Intern', location: 'Jaipur', default_shift_name: 'General Shift', scheme_weekoffs: '["Sunday"]', scheme_id: 1, scheme_name: 'Default Attendance Cycle', department_id: 1, department_name: 'Human Resources' }
            ];
        }

        // Fetch company rules
        const rules = await db('working_rules').where({ company_id: companyId }).first() || {
            weekoffs: JSON.stringify(['Sunday'])
        };
        const companyWeekoffs = typeof rules.weekoffs === 'string' ? JSON.parse(rules.weekoffs) : (rules.weekoffs || []);

        // Fetch corporate holidays
        const holidays = await db('holidays')
            .where({ company_id: companyId })
            .whereRaw('MONTH(date) = ? AND YEAR(date) = ?', [month, year]);

        // Fetch weekend overrides
        const weekendOverrides = await db('weekend_overrides')
            .where({ company_id: companyId })
            .whereRaw('MONTH(override_date) = ? AND YEAR(override_date) = ?', [month, year]);

        // Fetch approved leaves
        const employeeIds = employees.map(emp => emp.id);
        const leaves = await db('leaves as l')
            .join('leave_types as lt', 'l.leave_type_id', 'lt.id')
            .whereIn('l.employee_id', employeeIds)
            .where({ 'l.status': 'approved' })
            .whereRaw('(MONTH(l.start_date) = ? OR MONTH(l.end_date) = ?) AND (YEAR(l.start_date) = ? OR YEAR(l.end_date) = ?)', [month, month, year, year])
            .select('l.employee_id', 'l.start_date', 'l.end_date', 'lt.name as leave_type_name');

        // Fetch manual overrides / attendance status
        const attendance = await db('attendance')
            .whereIn('employee_id', employeeIds)
            .whereRaw('MONTH(check_in) = ? AND YEAR(check_in) = ?', [month, year])
            .select('employee_id', 'check_in', 'status', 'logical_date', 'review_reason');

        // 2. Get shift assignments
        const qb = db('employee_shift_assignments as esa')
            .join('shifts as s', 'esa.shift_id', 's.id')
            .where('esa.from_date', '<=', toDate)
            .andWhere(function () {
                this.where('esa.to_date', '>=', fromDate).orWhereNull('esa.to_date');
            });

        if (companyId) {
            qb.where('esa.company_id', companyId);
        }

        const assignmentList = await qb.select('esa.id', 'esa.employee_id', 'esa.from_date', 'esa.to_date', 's.name')
            .modify(byEffectiveAssignment);


        // 3. Build Roster Matrix
        const roster = employees.map(emp => {
            const empAssignments = assignmentList.filter(a => a.employee_id === emp.id);
            const empWeekoffs = emp.scheme_weekoffs
                ? (typeof emp.scheme_weekoffs === 'string' ? JSON.parse(emp.scheme_weekoffs) : emp.scheme_weekoffs)
                : companyWeekoffs;
            const empLeaves = leaves.filter(l => l.employee_id === emp.id);
            const empAttendance = attendance.filter(a => a.employee_id === emp.id);
            const empWeekendOverrides = weekendOverrides.filter(wo => wo.employee_id === emp.id);

            const days = {};
            let wd = 0;
            let off = 0;

            for (let d = 1; d <= daysInMonth; d++) {
                const dateObj = new Date(year, month - 1, d);
                const targetDateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dateObj.getDay()];

                // A. Check Holiday
                const isHoliday = holidays.some(h => toLocalYMD(h.date) === targetDateStr);
                if (isHoliday) {
                    days[d] = 'H';
                    off++;
                    continue;
                }

                // B. Check Weekend Override
                const weekendOverride = empWeekendOverrides.find(wo => toLocalYMD(wo.override_date) === targetDateStr);
                if (weekendOverride) {
                    if (weekendOverride.override_type === 'off') {
                        days[d] = 'OFF';
                        off++;
                        continue;
                    }
                    // If weekendOverride.override_type === 'working', it skips the standard week-off check
                }

                // C. Check Standard Week-off (only if no 'working' weekend override exists)
                const isStandardWeekoff = empWeekoffs.includes(dayName);
                if (isStandardWeekoff && (!weekendOverride || weekendOverride.override_type !== 'working')) {
                    days[d] = 'OFF';
                    off++;
                    continue;
                }

                // D. Check Approved Leaves
                const onLeave = empLeaves.some(l => {
                    const fromStr = toLocalYMD(l.start_date);
                    const toStr = toLocalYMD(l.end_date);
                    return targetDateStr >= fromStr && targetDateStr <= toStr;
                });
                if (onLeave) {
                    days[d] = 'OFF';
                    off++;
                    continue;
                }

                // E. Check Manual Override / Attendance Status
                const dayAtt = empAttendance.find(a => toLocalYMD(a.check_in) === targetDateStr);
                if (dayAtt && (dayAtt.status === 'off' || dayAtt.status === 'leave')) {
                    days[d] = 'OFF';
                    off++;
                    continue;
                }

                // F. Demo shift data if no assignments exist for demo employees
                if (empAssignments.length === 0 && emp.id >= 101 && emp.id <= 105) {
                    days[d] = '10-6';
                    wd++;
                    continue;
                }

                // G. Check Shift Assignments
                const assignment = empAssignments.find(a => {
                    const fromStr = toLocalYMD(a.from_date);
                    const toStr = a.to_date ? toLocalYMD(a.to_date) : null;
                    return targetDateStr >= fromStr && (!toStr || targetDateStr <= toStr);
                });

                if (assignment) {
                    days[d] = assignment.name;
                    wd++;
                } else {
                    // Fall back to employee's default shift
                    if (emp.default_shift_name) {
                        days[d] = emp.default_shift_name;
                        wd++;
                    } else {
                        days[d] = '---';
                    }
                }
            }

            return {
                id: emp.id,
                first_name: emp.first_name,
                last_name: emp.last_name,
                employee_id_number: emp.employee_id_number,
                designation: emp.designation,
                location: emp.location,
                department_id: emp.department_id,
                department_name: emp.department_name,
                scheme_id: emp.scheme_id,
                scheme_name: emp.scheme_name,
                wd,
                off,
                days
            };
        });

        return { roster, daysInMonth };
    }

    async getDayDetail(companyId, employeeId, dateStr) {
        if (!employeeId || !dateStr) {
            throw new Error('Employee ID and date are required');
        }

        // 1. Fetch Employee
        const emp = await db('employees as e')
            .leftJoin('shifts as s', 'e.shift_id', 's.id')
            .leftJoin('attendance_schemes as asch', 'e.attendance_scheme_id', 'asch.id')
            .where({ 'e.id': employeeId, 'e.company_id': companyId })
            .select(
                'e.id', 'e.first_name', 'e.last_name', 'e.employee_id_number', 'e.designation', 'e.city as location',
                's.name as default_shift_name', 's.start_time as default_shift_start', 's.end_time as default_shift_end',
                's.total_punches_required as default_shift_total_punches',
                's.session2_start_time as default_shift_session2_start',
                's.session2_end_time as default_shift_session2_end',
                's.grace_period as default_shift_grace_period',
                's.session1_grace_out as default_shift_session1_grace_out',
                's.session2_grace_in as default_shift_session2_grace_in',
                's.session2_grace_out as default_shift_session2_grace_out',
                's.session1_in_margin as default_shift_session1_in_margin',
                's.session1_out_margin as default_shift_session1_out_margin',
                's.session2_in_margin as default_shift_session2_in_margin',
                's.session2_out_margin as default_shift_session2_out_margin',
                's.terminate_hour as default_shift_terminate_hour',
                's.is_flexi as default_shift_is_flexi',
                's.min_hours as default_shift_min_hours',
                'asch.weekoffs as scheme_weekoffs'
            )
            .first();

        if (!emp) {
            throw new Error('Employee not found');
        }

        // 2. Resolve Weekoff
        const rules = await db('working_rules').where({ company_id: companyId }).first() || {
            weekoffs: JSON.stringify(['Sunday'])
        };
        const companyWeekoffs = typeof rules.weekoffs === 'string' ? JSON.parse(rules.weekoffs) : (rules.weekoffs || []);
        const empWeekoffs = emp.scheme_weekoffs
            ? (typeof emp.scheme_weekoffs === 'string' ? JSON.parse(emp.scheme_weekoffs) : emp.scheme_weekoffs)
            : companyWeekoffs;

        const dateObj = new Date(dateStr);
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayName = dayNames[dateObj.getDay()];
        const isStandardWeekoff = empWeekoffs.includes(dayName);

        // 3. Fetch Holiday
        const holiday = await db('holidays')
            .where({ company_id: companyId, date: dateStr })
            .first();

        // 4. Fetch Weekend Override
        const weekendOverride = await db('weekend_overrides as wo')
            .leftJoin('employees as creator', 'wo.created_by', 'creator.id')
            .where({ 'wo.company_id': companyId, 'wo.employee_id': employeeId, 'wo.override_date': dateStr })
            .select(
                'wo.override_type', 'wo.reason', 'wo.created_at',
                'creator.first_name as created_by_first_name', 'creator.last_name as created_by_last_name'
            )
            .first();

        // 5. Fetch All Attendance logs
        const nextDate = new Date(new Date(dateStr).getTime() + 24 * 60 * 60 * 1000);
        const nextDateStr = nextDate.toISOString().split('T')[0];

        const defaultShift = emp ? { start_time: emp.default_shift_start, end_time: emp.default_shift_end } : null;
        const empAssignments = await db('employee_shift_assignments as esa')
            .join('shifts as s', 'esa.shift_id', 's.id')
            .where('esa.employee_id', employeeId)
            .select('esa.from_date', 'esa.to_date', 's.start_time', 's.end_time')
            .modify(byEffectiveAssignment);

        const candidateLogs = await db('attendance')
            .where({ employee_id: employeeId, company_id: companyId })
            .where('check_in', '>=', `${dateStr} 00:00:00`)
            .where('check_in', '<=', `${nextDateStr} 23:59:59`)
            .orderBy('check_in', 'asc');

        const attendanceLogs = [];
        for (const log of candidateLogs) {
            const lDate = rowLogicalDate(log, empAssignments, defaultShift);
            if (lDate === dateStr) {
                attendanceLogs.push(log);
            }
        }

        const attendance = attendanceLogs[0] || null;

        // 6. Fetch Leave
        const leave = await db('leaves as l')
            .join('leave_types as lt', 'l.leave_type_id', 'lt.id')
            .leftJoin('employees as approver', 'l.approved_by', 'approver.id')
            .where('l.employee_id', employeeId)
            .where('l.company_id', companyId)
            .where('l.status', 'approved')
            .where('l.start_date', '<=', dateStr)
            .where('l.end_date', '>=', dateStr)
            .select(
                'l.id', 'l.reason', 'l.created_at', 'l.start_date', 'l.end_date', 'l.status',
                'lt.name as leave_type_name', 'lt.color as leave_type_color',
                'approver.first_name as approved_by_first_name', 'approver.last_name as approved_by_last_name'
            )
            .first();

        // 7. Fetch Regularization
        const regularization = await db('attendance_regularizations as r')
            .leftJoin('users as u', 'r.approved_by', 'u.id')
            .leftJoin('employees as approver', 'u.id', 'approver.user_id')
            .leftJoin('roles as rlt', 'u.role_id', 'rlt.id')
            .where('r.employee_id', employeeId)
            .where('r.company_id', companyId)
            .where('r.date', dateStr)
            .select(
                'r.id', 'r.reason', 'r.status', 'r.check_in as req_check_in', 'r.check_out as req_check_out', 'r.created_at',
                'approver.first_name as approved_by_first_name', 'approver.last_name as approved_by_last_name',
                'rlt.name as approver_role', 'u.email as approver_email'
            )
            .first();

        // 7b. Fetch Entry/Exit Requests (Late In/Early Out)
        const entryRequest = await db('attendance_entry_requests as er')
            .leftJoin('users as u', 'er.approved_by', 'u.id')
            .leftJoin('employees as approver', 'u.id', 'approver.user_id')
            .leftJoin('roles as rlt', 'u.role_id', 'rlt.id')
            .where('er.employee_id', employeeId)
            .where('er.company_id', companyId)
            .where('er.date', dateStr)
            .select(
                'er.id', 'er.request_type', 'er.punch_time', 'er.status', 'er.created_at',
                'approver.first_name as approved_by_first_name', 'approver.last_name as approved_by_last_name',
                'rlt.name as approver_role', 'u.email as approver_email'
            )
            .first();

        // 8. Fetch Override History
        const overrideHistory = await db('attendance_override_history')
            .where({ employee_id: employeeId, company_id: companyId, attendance_date: dateStr })
            .orderBy('id', 'desc')
            .first();

        // 9. Fetch Active Shift for the date.
        // is_flexi and min_hours were never projected here, so a flexi shift arrived as a plain
        // 00:00-23:59 shift with grace 0 and every flexi employee's day read "Late" - on a clean
        // day, with no reassignment involved at all.
        const rosterShift = await db('employee_shift_assignments as esa')
            .join('shifts as s', 'esa.shift_id', 's.id')
            .where('esa.employee_id', employeeId)
            .where('esa.from_date', '<=', dateStr)
            .andWhere(function () {
                this.where('esa.to_date', '>=', dateStr).orWhereNull('esa.to_date');
            })
            .select(
                's.name', 's.start_time', 's.end_time', 's.total_punches_required',
                's.session2_start_time', 's.session2_end_time', 's.grace_period',
                's.session1_grace_out', 's.session2_grace_in', 's.session2_grace_out',
                's.session1_in_margin', 's.session1_out_margin', 's.session2_in_margin', 's.session2_out_margin',
                's.terminate_hour', 's.is_flexi', 's.min_hours'
            )
            .modify(byEffectiveAssignment)
            .first();

        // The day's own pinned shift outranks the roster, exactly as on the muster - otherwise the
        // drawer explains a settled day in terms of a shift the employee never worked.
        const pinnedShifts = await loadPinnedShifts(attendanceLogs);
        const assignments = shiftForDay(attendanceLogs, pinnedShifts, rosterShift);

        const activeShift = assignments || {
            name: emp.default_shift_name || 'General Shift',
            start_time: emp.default_shift_start || '09:00',
            end_time: emp.default_shift_end || '18:00',
            total_punches_required: emp.default_shift_total_punches || 2,
            session2_start_time: emp.default_shift_session2_start || null,
            session2_end_time: emp.default_shift_session2_end || null,
            grace_period: emp.default_shift_grace_period || 15,
            session1_grace_out: emp.default_shift_session1_grace_out || 0,
            session2_grace_in: emp.default_shift_session2_grace_in || 15,
            session2_grace_out: emp.default_shift_session2_grace_out || 0,
            session1_in_margin: emp.default_shift_session1_in_margin || 0,
            session1_out_margin: emp.default_shift_session1_out_margin || 0,
            session2_in_margin: emp.default_shift_session2_in_margin || 0,
            session2_out_margin: emp.default_shift_session2_out_margin || 0,
            terminate_hour: emp.default_shift_terminate_hour || null,
            is_flexi: emp.default_shift_is_flexi || 0,
            min_hours: emp.default_shift_min_hours || null
        };

        let attendanceCheckOutText = null;
        if (attendance && attendance.check_in && !attendance.check_out && activeShift.terminate_hour) {
            const reqPunches = parseInt(activeShift.total_punches_required || 2);
            const finalEndStr = (reqPunches === 4) 
                ? (activeShift.session2_end_time || activeShift.end_time || '18:00') 
                : (activeShift.end_time || '18:00');
            const [eHours, eMins] = finalEndStr.split(':').map(Number);
            const checkInDateStr = toLocalYMD(attendance.check_in);
            const [sHours, sMins] = (activeShift.start_time || '09:00').split(':').map(Number);
            
            const shiftStartDate = new Date(`${checkInDateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
            let shiftEndDate = new Date(`${checkInDateStr} ${String(eHours).padStart(2, '0')}:${String(eMins).padStart(2, '0')}:00 +05:30`);
            if (shiftEndDate < shiftStartDate) {
                shiftEndDate = new Date(shiftEndDate.getTime() + 24 * 60 * 60 * 1000);
            }
            const terminationDate = new Date(shiftEndDate.getTime() + parseInt(activeShift.terminate_hour) * 60 * 60 * 1000);
            if (new Date() > terminationDate) {
                attendanceCheckOutText = 'Shift Terminated - No Punch Out Done';
            }
        }

        const formattedLogs = attendanceLogs.map((log, idx) => {
            let logCheckOutText = null;
            if (log.check_in && !log.check_out && activeShift.terminate_hour) {
                const reqPunches = parseInt(activeShift.total_punches_required || 2);
                let sessionEndTimeStr = activeShift.end_time || '18:00';
                if (reqPunches === 4) {
                    const checkInTime = new Date(log.check_in);
                    const checkInMins = dateToISTMins(checkInTime);
                    const s2StartStr = activeShift.session2_start_time || '14:00';
                    const [s2Hours, s2Mins] = s2StartStr.split(':').map(Number);
                    const s2StartMins = s2Hours * 60 + s2Mins;
                    const s2InMargin = parseInt(activeShift.session2_in_margin || 30);
                    const session2CutoffMins = s2StartMins - s2InMargin;
                    
                    if (checkInMins >= session2CutoffMins) {
                        sessionEndTimeStr = activeShift.session2_end_time || '18:00';
                    }
                }
                
                const [eHours, eMins] = sessionEndTimeStr.split(':').map(Number);
                const checkInDateStr = toLocalYMD(log.check_in);
                const shiftStartStr = activeShift.start_time || '09:00';
                const [sHours, sMins] = shiftStartStr.split(':').map(Number);
                const shiftStartDate = new Date(`${checkInDateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
                let shiftEndDate = new Date(`${checkInDateStr} ${String(eHours).padStart(2, '0')}:${String(eMins).padStart(2, '0')}:00 +05:30`);
                if (shiftEndDate < shiftStartDate) {
                    shiftEndDate = new Date(shiftEndDate.getTime() + 24 * 60 * 60 * 1000);
                }
                const terminationDate = new Date(shiftEndDate.getTime() + parseInt(activeShift.terminate_hour) * 60 * 60 * 1000);
                if (new Date() > terminationDate) {
                    logCheckOutText = 'Shift Terminated - No Punch Out Done';
                }
            }
            return {
                id: log.id,
                check_in: log.check_in,
                check_out: log.check_out,
                check_out_text: logCheckOutText,
                status: log.status,
                punch_source: log.punch_source,
                device_id: log.device_id,
                latitude: log.latitude,
                longitude: log.longitude,
                punch_location: log.punch_location,
                remarks: log.remarks,
                out_latitude: log.out_latitude,
                out_longitude: log.out_longitude,
                out_punch_location: log.out_punch_location,
                out_remarks: log.out_remarks
            };
        });

        // The per-session breakdown this drawer exists to show. Its `status` is overwritten below,
        // once the approved requests are known, so that the drawer cannot disagree with the grid.
        let splitShiftDetails = null;
        if (attendanceLogs.length > 0) {
            splitShiftDetails = calculateSplitShiftStatus(attendanceLogs, activeShift, rules);
        }

        // 9b. Fetch all raw biometric logs
        const biometricMapping = await db('employee_biometric_mapping')
            .where({ employee_id: employeeId, company_id: companyId })
            .select('biometric_enroll_id');
        const enrollIds = biometricMapping.map(m => m.biometric_enroll_id);
        enrollIds.push(emp.employee_id_number);
        if (emp.employee_id_number && emp.employee_id_number.startsWith('0')) {
            enrollIds.push(emp.employee_id_number.replace(/^0+/, ''));
        }

        const rawBiometricLogs = await db('biometric_raw_logs')
            .where({ company_id: companyId })
            .whereIn('employee_code', enrollIds)
            .whereRaw('DATE(punch_time) = ?', [dateStr])
            .orderBy('punch_time', 'asc');

        // 9c. Fetch all entry requests
        const entryRequests = await db('attendance_entry_requests as er')
            .leftJoin('users as u', 'er.approved_by', 'u.id')
            .leftJoin('employees as approver', 'u.id', 'approver.user_id')
            .where('er.employee_id', employeeId)
            .where('er.company_id', companyId)
            .where('er.date', dateStr)
            .select(
                'er.id', 'er.request_type', 'er.punch_time', 'er.status', 'er.created_at',
                'approver.first_name as approved_by_first_name', 'approver.last_name as approved_by_last_name'
            )
            .orderBy('er.created_at', 'asc');

        // 9d. Fetch all regularization requests
        const regularizations = await db('attendance_regularizations as r')
            .leftJoin('users as u', 'r.approved_by', 'u.id')
            .leftJoin('employees as approver', 'u.id', 'approver.user_id')
            .where('r.employee_id', employeeId)
            .where('r.company_id', companyId)
            .where('r.date', dateStr)
            .select(
                'r.id', 'r.reason', 'r.status', 'r.check_in as req_check_in', 'r.check_out as req_check_out', 'r.created_at',
                'approver.first_name as approved_by_first_name', 'approver.last_name as approved_by_last_name'
            )
            .orderBy('r.created_at', 'asc');

        // The drawer used to recompute this cell from the clock and honour the stored status only
        // for 'manual'/'manual_override' rows. So an approver could approve a late_in or an
        // early_out, watch the muster settle on L or P, and still find E in the drawer for the same
        // row. The grid, the history sheet and this drawer all read resolveDayStatus now.
        if (splitShiftDetails) {
            splitShiftDetails.status = resolveDayStatus(attendanceLogs, activeShift, rules, {
                regularization: regularizations.some(r => r.status === 'approved'),
                earlyOutRequest: entryRequests.some(er => er.request_type === 'early_out' && er.status === 'approved')
            }) || splitShiftDetails.status;
        }

        return {
            employee: {
                id: emp.id,
                name: `${emp.first_name} ${emp.last_name}`,
                code: emp.employee_id_number,
                designation: emp.designation,
                location: emp.location
            },
            date: dateStr,
            day_name: dayName,
            is_weekoff: isStandardWeekoff,
            active_shift: activeShift,
            split_shift_details: splitShiftDetails,
            attendance_logs: formattedLogs,
            raw_biometric_logs: rawBiometricLogs.map(log => ({
                id: log.id,
                device_serial: log.device_serial,
                employee_code: log.employee_code,
                punch_time: log.punch_time,
                status: log.status,
                error_details: log.error_details
            })),
            entry_requests: entryRequests.map(er => ({
                id: er.id,
                request_type: er.request_type,
                punch_time: er.punch_time,
                status: er.status,
                created_at: er.created_at,
                approved_by: er.approved_by_first_name ? `${er.approved_by_first_name} ${er.approved_by_last_name}` : 'Pending'
            })),
            regularizations: regularizations.map(r => ({
                id: r.id,
                reason: r.reason,
                status: r.status,
                req_check_in: r.req_check_in,
                req_check_out: r.req_check_out,
                created_at: r.created_at,
                approved_by: r.approved_by_first_name ? `${r.approved_by_first_name} ${r.approved_by_last_name}` : 'Pending'
            })),
            attendance: attendance ? {
                id: attendance.id,
                check_in: attendance.check_in,
                check_out: attendance.check_out,
                check_out_text: attendanceCheckOutText,
                status: splitShiftDetails ? splitShiftDetails.status : attendance.status,
                punch_source: attendance.punch_source,
                device_id: attendance.device_id,
                latitude: attendance.latitude,
                longitude: attendance.longitude,
                punch_location: attendance.punch_location,
                remarks: attendance.remarks,
                out_latitude: attendance.out_latitude,
                out_longitude: attendance.out_longitude,
                out_punch_location: attendance.out_punch_location,
                out_remarks: attendance.out_remarks
            } : null,
            leave: leave ? {
                id: leave.id,
                leave_type_name: leave.leave_type_name,
                leave_type_color: leave.leave_type_color,
                reason: leave.reason,
                status: leave.status,
                created_at: leave.created_at,
                start_date: leave.start_date,
                end_date: leave.end_date,
                approved_by: leave.approved_by_first_name ? `${leave.approved_by_first_name} ${leave.approved_by_last_name}` : 'System'
            } : null,
            holiday: holiday ? {
                id: holiday.id,
                name: holiday.name,
                type: holiday.type
            } : null,
            weekend_override: weekendOverride ? {
                override_type: weekendOverride.override_type,
                reason: weekendOverride.reason,
                created_at: weekendOverride.created_at,
                created_by: weekendOverride.created_by_first_name ? `${weekendOverride.created_by_first_name} ${weekendOverride.created_by_last_name}` : 'Admin'
            } : null,
            regularization: regularization ? {
                id: regularization.id,
                reason: regularization.reason,
                status: regularization.status,
                req_check_in: regularization.req_check_in,
                req_check_out: regularization.req_check_out,
                created_at: regularization.created_at,
                approved_by: regularization.approved_by_first_name ? `${regularization.approved_by_first_name} ${regularization.approved_by_last_name}` : (regularization.approver_email || 'Admin')
            } : null,
            entry_request: entryRequest ? {
                id: entryRequest.id,
                request_type: entryRequest.request_type,
                punch_time: entryRequest.punch_time,
                status: entryRequest.status,
                created_at: entryRequest.created_at,
                approved_by: entryRequest.approved_by_first_name
                    ? `${entryRequest.approved_by_first_name} ${entryRequest.approved_by_last_name}`
                    : (entryRequest.approver_email || 'Admin'),
                approver_role: entryRequest.approver_role
            } : null,
            override_history: overrideHistory ? {
                previous_status: overrideHistory.previous_status,
                updated_status: overrideHistory.updated_status,
                override_type: overrideHistory.override_type,
                overridden_by_name: overrideHistory.overridden_by_name,
                created_at: overrideHistory.created_at
            } : null
        };
    }

    async processMachineLog(payload) {
        console.log('>>> [BIOMETRIC]: Processing push logs:', JSON.stringify(payload));

        let logs = [];
        if (Array.isArray(payload)) {
            logs = payload;
        } else if (payload && typeof payload === 'object') {
            if (Array.isArray(payload.logs)) {
                logs = payload.logs;
            } else if (Array.isArray(payload.data)) {
                logs = payload.data;
            } else {
                logs = [payload];
            }
        }

        const results = {
            total: logs.length,
            successCount: 0,
            skippedCount: 0,
            failedCount: 0,
            details: []
        };

        for (const log of logs) {
            try {
                const empCode = log.employee_code || log.employee_id || log.EnrollNumber || log.UserId || log.badgenumber || log.emp_code || log.CardNo;
                const rawTime = log.timestamp || log.log_time || log.datetime || log.PunchTime || log.time;
                const deviceId = log.device_id || log.device_serial || log.serial_number || log.device || 'BIOMETRIC_DEV';

                if (!empCode || !rawTime) {
                    results.failedCount++;
                    results.details.push({ log, status: 'error', reason: 'Missing employee code or timestamp' });
                    continue;
                }

                const employee = await db('employees').where({ employee_id_number: empCode }).first();
                if (!employee) {
                    results.skippedCount++;
                    results.details.push({ empCode, time: rawTime, status: 'skipped', reason: `Employee code ${empCode} not found in database` });
                    continue;
                }

                const empId = employee.id;
                const companyId = employee.company_id;
                const rawTimeStr = typeof rawTime === 'string' ? rawTime : String(rawTime);
                const punchTime = new Date(rawTimeStr.includes('+') ? rawTimeStr : `${rawTimeStr} +05:30`);

                if (isNaN(punchTime.getTime())) {
                    results.failedCount++;
                    results.details.push({ empCode, time: rawTime, status: 'error', reason: 'Invalid timestamp format' });
                    continue;
                }

                const logDate = toLocalYMD(punchTime);

                const existing = await db('attendance')
                    .where({ employee_id: empId, company_id: companyId })
                    .whereRaw('DATE(check_in) = ?', [logDate])
                    .first();

                if (!existing) {
                    const employeeWithShift = await db('employees')
                        .leftJoin('shifts', 'employees.shift_id', 'shifts.id')
                        .leftJoin('attendance_schemes', 'employees.attendance_scheme_id', 'attendance_schemes.id')
                        .where('employees.id', empId)
                        .select(
                            'employees.*',
                            'shifts.start_time as shift_start',
                            'shifts.grace_period as shift_grace',
                            'attendance_schemes.grace_period as scheme_grace'
                        )
                        .first();

                    const rules = await db('working_rules').where({ company_id: companyId }).first() || {
                        shift_start: '09:00',
                        grace_period: 15
                    };

                    const shiftStart = employeeWithShift?.shift_start || rules.shift_start;
                    const grace = employeeWithShift?.scheme_grace ?? employeeWithShift?.shift_grace ?? rules.grace_period;

                    const [sHours, sMins] = shiftStart.split(':').map(Number);
                    const totalMins = sMins + (parseInt(grace) || 0);
                    const allowedHours = String(sHours + Math.floor(totalMins / 60)).padStart(2, '0');
                    const allowedMins = String(totalMins % 60).padStart(2, '0');
                    const shiftAllowed = new Date(`${logDate} ${allowedHours}:${allowedMins}:00 +05:30`);

                    const status = punchTime > shiftAllowed ? 'late' : 'present';

                    await db('attendance').insert({
                        employee_id: empId,
                        company_id: companyId,
                        check_in: punchTime,
                        check_out: null,
                        status: status,
                        punch_source: 'biometric',
                        device_id: deviceId,
                        created_at: db.fn.now()
                    });

                    results.successCount++;
                    results.details.push({ empCode, time: rawTime, action: 'check-in', status });
                } else {
                    const currentCheckIn = new Date(existing.check_in);

                    if (punchTime > currentCheckIn) {
                        if (!existing.check_out || punchTime > new Date(existing.check_out)) {
                            await db('attendance')
                                .where({ id: existing.id })
                                .update({
                                    check_out: punchTime,
                                    punch_source: 'biometric',
                                    device_id: deviceId
                                });

                            results.successCount++;
                            results.details.push({ empCode, time: rawTime, action: 'check-out' });
                        } else {
                            results.skippedCount++;
                            results.details.push({ empCode, time: rawTime, action: 'none', reason: 'Punch time is older than current check-out' });
                        }
                    } else {
                        results.skippedCount++;
                        results.details.push({ empCode, time: rawTime, action: 'none', reason: 'Punch time is older than current check-in' });
                    }
                }
            } catch (err) {
                console.error('>>> [BIOMETRIC]: Error processing log row:', err);
                results.failedCount++;
                results.details.push({ log, status: 'error', reason: err.message });
            }
        }

        console.log(`>>> [BIOMETRIC]: Processing completed. Success: ${results.successCount}, Skipped: ${results.skippedCount}, Failed: ${results.failedCount}`);
        return results;
    }

    async getWeekendOverrides(companyId, month, year) {
        const weekendOverrideRepository = require('../repositories/weekendOverrideRepository');
        return await weekendOverrideRepository.getAll(companyId, month, year);
    }

    async createWeekendOverride(user, companyId, data) {
        const weekendOverrideRepository = require('../repositories/weekendOverrideRepository');
        // data should have: employee_ids (array), override_date, override_type, reason
        const results = [];
        for (const empId of data.employee_ids) {
            const result = await weekendOverrideRepository.create(companyId, {
                employee_id: empId,
                override_date: data.override_date,
                override_type: data.override_type || 'working',
                reason: data.reason || null,
                created_by: user.id
            });
            results.push(result);
        }
        return { message: `Weekend override applied to ${results.length} employee(s)`, count: results.length };
    }

    async deleteWeekendOverride(companyId, id) {
        const weekendOverrideRepository = require('../repositories/weekendOverrideRepository');
        await weekendOverrideRepository.delete(id, companyId);
        return { message: 'Override removed' };
    }

    async getEmployeesForWeekendOverride(companyId) {
        const employees = await db('employees as e')
            .leftJoin('departments as d', 'e.department_id', 'd.id')
            .where('e.company_id', companyId)
            .select('e.id', 'e.first_name', 'e.last_name', 'e.employee_id_number', 'e.department_id', 'e.designation', 'e.office_location', 'd.name as department_name');
        return employees;
    }

    async getSchemes(companyId) {
        return await db('attendance_schemes').where({ company_id: companyId });
    }

    async createScheme(companyId, data) {
        const {
            name, shift_id, weekoffs, grace_period, max_late_allowed,
            late_deduction_type, half_day_hours, late_marks_for_half_day,
            ot_enabled, ot_min_minutes, ot_rate_multiplier, max_missed_punches
        } = data;

        if (!name) {
            throw new Error('Scheme name is required');
        }

        const [id] = await db('attendance_schemes').insert({
            company_id: companyId,
            name,
            shift_id: shift_id || null,
            weekoffs: Array.isArray(weekoffs) ? JSON.stringify(weekoffs) : (weekoffs || '[]'),
            grace_period: grace_period !== undefined && grace_period !== null ? parseInt(grace_period) : 15,
            max_late_allowed: max_late_allowed !== undefined && max_late_allowed !== null ? parseInt(max_late_allowed) : 3,
            late_deduction_type: late_deduction_type || 'none',
            half_day_hours: half_day_hours !== undefined && half_day_hours !== null ? parseFloat(half_day_hours) : 4.0,
            late_marks_for_half_day: late_marks_for_half_day !== undefined && late_marks_for_half_day !== null ? parseInt(late_marks_for_half_day) : 3,
            ot_enabled: !!ot_enabled,
            ot_min_minutes: ot_min_minutes !== undefined && ot_min_minutes !== null ? parseInt(ot_min_minutes) : 60,
            ot_rate_multiplier: ot_rate_multiplier !== undefined && ot_rate_multiplier !== null ? parseFloat(ot_rate_multiplier) : 1.5,
            max_missed_punches: max_missed_punches !== undefined && max_missed_punches !== null ? parseInt(max_missed_punches) : 2,
            created_at: db.fn.now(),
            updated_at: db.fn.now()
        });

        return { id, message: 'Attendance scheme created successfully' };
    }

    async updateScheme(companyId, id, data) {
        const {
            name, shift_id, weekoffs, grace_period, max_late_allowed,
            late_deduction_type, half_day_hours, late_marks_for_half_day,
            ot_enabled, ot_min_minutes, ot_rate_multiplier, max_missed_punches
        } = data;

        if (!id) {
            throw new Error('Scheme ID is required');
        }

        await db('attendance_schemes')
            .where({ company_id: companyId, id })
            .update({
                name,
                shift_id: shift_id || null,
                weekoffs: Array.isArray(weekoffs) ? JSON.stringify(weekoffs) : (weekoffs || '[]'),
                grace_period: grace_period !== undefined && grace_period !== null ? parseInt(grace_period) : 15,
                max_late_allowed: max_late_allowed !== undefined && max_late_allowed !== null ? parseInt(max_late_allowed) : 3,
                late_deduction_type: late_deduction_type || 'none',
                half_day_hours: half_day_hours !== undefined && half_day_hours !== null ? parseFloat(half_day_hours) : 4.0,
                late_marks_for_half_day: late_marks_for_half_day !== undefined && late_marks_for_half_day !== null ? parseInt(late_marks_for_half_day) : 3,
                ot_enabled: !!ot_enabled,
                ot_min_minutes: ot_min_minutes !== undefined && ot_min_minutes !== null ? parseInt(ot_min_minutes) : 60,
                ot_rate_multiplier: ot_rate_multiplier !== undefined && ot_rate_multiplier !== null ? parseFloat(ot_rate_multiplier) : 1.5,
                max_missed_punches: max_missed_punches !== undefined && max_missed_punches !== null ? parseInt(max_missed_punches) : 2,
                updated_at: db.fn.now()
            });

        return { message: 'Attendance scheme updated successfully' };
    }

    async deleteScheme(companyId, id) {
        if (!id) {
            throw new Error('Scheme ID is required');
        }

        await db.transaction(async (trx) => {
            // Nullify employee references
            await trx('employees')
                .where({ company_id: companyId, attendance_scheme_id: id })
                .update({ attendance_scheme_id: null });

            // Delete the scheme
            await trx('attendance_schemes')
                .where({ company_id: companyId, id })
                .del();
        });

        return { message: 'Attendance scheme deleted successfully' };
    }

    async getSchemeAssignments(companyId) {
        const employees = await db('employees as e')
            .leftJoin('departments as d', 'e.department_id', 'd.id')
            .leftJoin('shifts as s', 'e.shift_id', 's.id')
            .leftJoin('attendance_schemes as asch', 'e.attendance_scheme_id', 'asch.id')
            .where('e.company_id', companyId)
            .select(
                'e.id',
                'e.first_name',
                'e.last_name',
                'e.employee_id_number',
                'e.designation',
                'e.status',
                'e.office_location',
                'd.name as department_name',
                's.id as shift_id',
                's.name as shift_name',
                'asch.id as attendance_scheme_id',
                'asch.name as attendance_scheme_name'
            );

        const seenIds = new Set();
        return employees.filter(emp => {
            if (seenIds.has(emp.id)) {
                return false;
            }
            seenIds.add(emp.id);
            return true;
        });
    }

    async assignScheme(user, companyId, employeeIds, schemeId) {
        if (!employeeIds || !Array.isArray(employeeIds) || employeeIds.length === 0) {
            throw new Error('Employee list is required');
        }

        await db.transaction(async (trx) => {
            let shiftId = null;

            if (schemeId) {
                // Get shift_id from scheme to sync it
                const scheme = await trx('attendance_schemes')
                    .where({ company_id: companyId, id: schemeId })
                    .first();
                if (!scheme) {
                    throw new Error('Attendance scheme not found');
                }
                shiftId = scheme.shift_id;
            }

            for (const empId of employeeIds) {
                const updates = { attendance_scheme_id: schemeId || null };

                // For backward compatibility and UI consistency, also sync shift_id if scheme has a shift
                if (shiftId) {
                    updates.shift_id = shiftId;
                }

                await trx('employees')
                    .where({ company_id: companyId, id: empId })
                    .update(updates);
            }
        });

        return { message: `Scheme assigned to ${employeeIds.length} employee(s) successfully` };
    }

    async getTodayNotCheckedIn(companyId, user) {
        const today = toLocalYMD(new Date());
        const isAdmin = ['company_admin', 'super_admin'].includes(user.role_name);

        let empQuery = db('employees as e')
            .leftJoin('shifts as s', 'e.shift_id', 's.id')
            .leftJoin('departments as d', 'e.department_id', 'd.id')
            .where({ 'e.company_id': companyId, 'e.status': 'active' });

        if (!isAdmin) {
            // Manager role: get subordinates
            const manager = await db('employees').where({ user_id: user.id }).first();
            if (!manager) return [];
            empQuery = empQuery.where('e.manager_id', manager.id);
        }

        const employees = await empQuery.select(
            'e.id',
            'e.first_name',
            'e.last_name',
            'e.employee_id_number',
            'e.office_location',
            'e.designation',
            'd.name as department_name',
            's.name as shift_name',
            's.start_time as shift_start',
            's.end_time as shift_end'
        );

        // Fetch check-in logs for today
        const checkedInIds = await db('attendance')
            .where({ company_id: companyId })
            .whereRaw('DATE(check_in) = ?', [today])
            .pluck('employee_id');

        // Fetch pre-approved/pending requests for today
        const requests = await db('attendance_entry_requests')
            .where({ company_id: companyId, date: today });

        const results = employees.map(emp => {
            const isCheckedIn = checkedInIds.includes(emp.id);
            const lateInRequest = requests.find(r => r.employee_id === emp.id && r.request_type === 'late_in');
            const earlyOutRequest = requests.find(r => r.employee_id === emp.id && r.request_type === 'early_out');

            return {
                id: emp.id,
                first_name: emp.first_name,
                last_name: emp.last_name,
                employee_id_number: emp.employee_id_number,
                office_location: emp.office_location,
                designation: emp.designation,
                department_name: emp.department_name,
                shift_name: emp.shift_name,
                shift_start: emp.shift_start,
                shift_end: emp.shift_end,
                is_checked_in: isCheckedIn,
                late_in_status: lateInRequest ? lateInRequest.status : null,
                early_out_status: earlyOutRequest ? earlyOutRequest.status : null
            };
        });

        // Filter: only show employees who are not checked in AND do NOT have an approved late-in request today
        return results.filter(r => !r.is_checked_in && r.late_in_status !== 'approved');
    }

    async preApproveException(companyId, user, employeeId, type, date) {
        if (!['late_in', 'early_out'].includes(type)) {
            throw new Error('Invalid request type');
        }

        const targetDate = date || toLocalYMD(new Date());

        const existing = await db('attendance_entry_requests')
            .where({ employee_id: employeeId, company_id: companyId, date: targetDate, request_type: type })
            .first();

        if (existing) {
            await db('attendance_entry_requests')
                .where({ id: existing.id })
                .update({
                    status: 'approved',
                    approved_by: user.id,
                    updated_at: db.fn.now()
                });
        } else {
            const nowStr = toLocalYYYYMMDDHHmmss(new Date());
            await db('attendance_entry_requests').insert({
                company_id: companyId,
                employee_id: employeeId,
                date: targetDate,
                request_type: type,
                punch_time: nowStr,
                location_data: JSON.stringify({ source: 'pre-approve', operator: user.id }),
                status: 'approved',
                approved_by: user.id,
                created_at: db.fn.now(),
                updated_at: db.fn.now()
            });
        }

        return { message: `${type === 'late_in' ? 'Late In' : 'Early Out'} pre-approved successfully.` };
    }

    async getEntryExitRequests(companyId, user, statusFilter) {
        const isAdmin = ['company_admin', 'super_admin'].includes(user.role_name);
        const employee = await db('employees').where({ user_id: user.id }).first();

        let query = db('attendance_entry_requests as r')
            .join('employees as e', 'r.employee_id', 'e.id')
            .leftJoin('departments as d', 'e.department_id', 'd.id')
            .where('r.company_id', companyId);

        if (statusFilter === 'history') {
            query = query.whereIn('r.status', ['approved', 'rejected']);
        } else if (statusFilter === 'pending') {
            query = query.where('r.status', 'pending');
        } else {
            // Default to pending if not specified
            query = query.where('r.status', 'pending');
        }

        if (!isAdmin) {
            if (!employee) return [];
            query = query.where('e.manager_id', employee.id);
        }

        return await query.select(
            'r.*',
            'e.first_name',
            'e.last_name',
            'e.employee_id_number',
            'e.employee_id_number as employee_code',
            'e.office_location',
            'e.designation',
            'd.name as department_name'
        ).orderBy('r.created_at', 'desc');
    }

    async approveRejectEntryExitRequest(companyId, user, requestId, status, attendanceStatus = 'present', resolvedTime = null) {
        if (!['approved', 'rejected'].includes(status)) {
            throw new Error('Invalid status value');
        }

        const request = await db('attendance_entry_requests').where({ id: requestId, company_id: companyId }).first();
        if (!request) throw new Error('Request not found');

        const dateStr = toLocalYMD(request.date) || request.date;
        const punchTimeStr = request.punch_time;

        // A 'missing_in' punch landed inside the shift's checkout window with no attendance row for
        // the day, so the engine could not tell a very late arrival from a lone check-OUT and parked
        // the punch in check_in. Only the approver knows the real arrival. Validate it BEFORE the
        // request row is flipped: a throw after that update would leave the request 'approved' with
        // nothing written to attendance and no way to raise it again.
        let resolvedPunch = null;
        if (request.request_type === 'missing_in' && status === 'approved') {
            resolvedPunch = resolveRequestPunchTime(resolvedTime, dateStr);
            if (!resolvedPunch) {
                throw new Error('Actual arrival time is required to approve a missing check-in request - supplying it is the whole purpose of this request type.');
            }
            const punchAt = punchTimeStr ? dbDateToUTC(punchTimeStr) : null;
            const resolvedAt = dbDateToUTC(resolvedPunch);
            if (punchAt && resolvedAt && resolvedAt.getTime() > punchAt.getTime()) {
                // The recorded punch becomes this row's check_out, so an arrival later than it would
                // store check_out < check_in - a corruption already seen in production.
                throw new Error(`Arrival time ${resolvedPunch} is after the recorded punch ${toLocalYYYYMMDDHHmmss(punchTimeStr)}; the arrival must be the same time or earlier.`);
            }
        }

        // Update request status
        await db('attendance_entry_requests')
            .where({ id: requestId })
            .update({
                status,
                approved_by: user.id,
                updated_at: db.fn.now()
            });

        // Rejecting a 'missing_in' still has to reach attendance, to clear the review flag, so the
        // row lookup below runs for that type in both directions.
        const touchesAttendance = status === 'approved' || request.request_type === 'missing_in';

        if (touchesAttendance) {
            let dbStatus = 'present';
            if (attendanceStatus === 'late_in' || attendanceStatus === 'late') {
                dbStatus = 'late';
            } else if (attendanceStatus === 'half_day' || attendanceStatus === 'half-day') {
                dbStatus = 'half-day';
            } else if (attendanceStatus === 'early_out' || attendanceStatus === 'early-out') {
                dbStatus = 'early_out';
            } else if (attendanceStatus === 'present' || attendanceStatus === 'p') {
                dbStatus = 'present';
            } else if (attendanceStatus === 'absent' || attendanceStatus === 'a') {
                dbStatus = 'absent';
            }

            const employee = await db('employees as e')
                .leftJoin('shifts as s', 'e.shift_id', 's.id')
                .where('e.id', request.employee_id)
                .select('e.*', 's.start_time as shift_start', 's.end_time as shift_end')
                .first();
            const defaultShift = employee ? { start_time: employee.shift_start, end_time: employee.shift_end } : null;
            const empAssignments = await db('employee_shift_assignments as esa')
                .join('shifts as s', 'esa.shift_id', 's.id')
                .where('esa.employee_id', request.employee_id)
                .select('esa.from_date', 'esa.to_date', 's.start_time', 's.end_time')
                .modify(byEffectiveAssignment);

            const nextDate = new Date(new Date(dateStr).getTime() + 24 * 60 * 60 * 1000);
            const nextDateStr = nextDate.toISOString().split('T')[0];

            const candidateLogs = await db('attendance')
                .where({ employee_id: request.employee_id, company_id: companyId })
                .where('check_in', '>=', `${dateStr} 00:00:00`)
                .where('check_in', '<=', `${nextDateStr} 23:59:59`);

            // Prefer the row this request was raised FROM: the biometric engine writes the
            // same punchTimeStr to attendance.check_in (late_in, missing_in) / check_out (early_out)
            // and to the request's punch_time, so an exact match is authoritative. The logical-date
            // fallback below can pick a different row on the same calendar date - e.g. a
            // rescued 00:08 night-shift check-in whose request was dated by calendar day, where
            // the fallback landed on the employee's real 15:45 row and stamped it late.
            let existingAtt = null;
            const wantedPunch = toLocalYYYYMMDDHHmmss(punchTimeStr);
            if (wantedPunch) {
                const punchCol = request.request_type === 'early_out' ? 'check_out' : 'check_in';
                const dayBefore = toLocalYMD(new Date(dbDateToUTC(punchTimeStr).getTime() - 24 * 60 * 60 * 1000));
                const dayAfter = toLocalYMD(new Date(dbDateToUTC(punchTimeStr).getTime() + 24 * 60 * 60 * 1000));
                const nearRows = await db('attendance')
                    .where({ employee_id: request.employee_id, company_id: companyId })
                    .where(punchCol, '>=', `${dayBefore} 00:00:00`)
                    .where(punchCol, '<=', `${dayAfter} 23:59:59`);
                existingAtt = nearRows.find(r => r[punchCol] && toLocalYYYYMMDDHHmmss(r[punchCol]) === wantedPunch) || null;
            }

            if (!existingAtt) {
                for (const log of candidateLogs) {
                    const lDate = rowLogicalDate(log, empAssignments, defaultShift);
                    if (lDate === dateStr) {
                        existingAtt = log;
                        break;
                    }
                }
            }

            if (status === 'rejected') {
                // Only 'missing_in' gets here. Rejecting says "this is not a missing check-in"; the
                // device's times stay exactly as recorded. The flag must still be cleared - leaving
                // review_reason set would keep the row flagged for review forever with no path out,
                // the same dead end the 'pending' status hit before 04a64cd.
                if (existingAtt) {
                    const rejectUpdates = {
                        review_reason: null,
                        updated_at: db.fn.now()
                    };
                    // The row was stamped 'pending' by the engine solely to hold it for this
                    // decision. With the request rejected and the flag cleared, nothing is left
                    // that could ever move it off 'pending' - the muster would render it Absent
                    // forever and only a manual override could rescue it. Settle it instead:
                    // present when the day has a pair, absent when the punch still stands alone,
                    // which is what a rejected "the check-in is missing" claim actually means.
                    if ((existingAtt.status || '').toLowerCase() === 'pending') {
                        rejectUpdates.status = existingAtt.check_out ? 'present' : 'absent';
                    }
                    await db('attendance')
                        .where({ id: existingAtt.id })
                        .update(rejectUpdates);
                }
            } else if (request.request_type === 'late_in') {
                if (!existingAtt) {
                    await db('attendance').insert({
                        employee_id: request.employee_id,
                        company_id: companyId,
                        check_in: punchTimeStr,
                        check_out: null,
                        status: dbStatus,
                        punch_source: 'entry_request',
                        // The request is already dated by SHIFT day, so stamp it rather than
                        // leaving readers to re-derive the day from check_in - a night-shift
                        // late-in is exactly the row that derivation places wrongly.
                        logical_date: dateStr,
                        created_at: db.fn.now()
                    });
                } else {
                    await db('attendance')
                        .where({ id: existingAtt.id })
                        .update({
                            status: dbStatus,
                            punch_source: 'entry_request',
                            updated_at: db.fn.now()
                        });
                }
            } else if (request.request_type === 'early_out') {
                if (existingAtt) {
                    const updates = {
                        status: dbStatus,
                        punch_source: 'entry_request',
                        updated_at: db.fn.now()
                    };
                    if (!existingAtt.check_out && punchTimeStr) {
                        updates.check_out = punchTimeStr;
                    }
                    await db('attendance')
                        .where({ id: existingAtt.id })
                        .update(updates);
                } else {
                    await db('attendance').insert({
                        employee_id: request.employee_id,
                        company_id: companyId,
                        check_in: punchTimeStr || `${dateStr} 12:00:00`,
                        check_out: punchTimeStr || `${dateStr} 18:00:00`,
                        status: dbStatus,
                        punch_source: 'entry_request',
                        logical_date: dateStr,
                        created_at: db.fn.now()
                    });
                }
            } else if (request.request_type === 'missing_in') {
                if (existingAtt) {
                    const updates = {
                        check_in: resolvedPunch,
                        status: dbStatus,
                        punch_source: 'entry_request',
                        review_reason: null,
                        updated_at: db.fn.now()
                    };
                    // The ambiguous punch was parked in check_in only so a later punch could still
                    // close the row. Now that the real arrival is known, that punch is the day's
                    // check-OUT - unless a later punch already closed the row, which is then the
                    // truer departure and must not be overwritten.
                    if (!existingAtt.check_out && wantedPunch) {
                        updates.check_out = wantedPunch;
                    }
                    await db('attendance')
                        .where({ id: existingAtt.id })
                        .update(updates);
                } else {
                    await db('attendance').insert({
                        employee_id: request.employee_id,
                        company_id: companyId,
                        check_in: resolvedPunch,
                        check_out: wantedPunch || punchTimeStr || null,
                        logical_date: dateStr,
                        status: dbStatus,
                        punch_source: 'entry_request',
                        created_at: db.fn.now()
                    });
                }
            }
        }

        return { message: `Request ${status} successfully.` };
    }

    async notifyAdminsAndManager(companyId, employeeId, title, message) {
        try {
            const employee = await db('employees').where({ id: employeeId }).first();
            if (!employee) return;

            let targetUserIds = [];
            if (employee.manager_id) {
                const manager = await db('employees').where({ id: employee.manager_id }).first();
                if (manager && manager.user_id) {
                    targetUserIds.push(manager.user_id);
                }
            }

            const admins = await db('users')
                .where({ company_id: companyId, role_name: 'company_admin' })
                .select('id');

            admins.forEach(admin => {
                if (!targetUserIds.includes(admin.id)) {
                    targetUserIds.push(admin.id);
                }
            });

            for (const userId of targetUserIds) {
                await notificationService.createNotification(
                    userId,
                    companyId,
                    title,
                    message,
                    'warning'
                );
            }
        } catch (err) {
            console.error('Failed to send entry/exit notifications', err);
        }
    }
}

const serviceInstance = new AttendanceService();
serviceInstance.dbDateToUTC = dbDateToUTC;
serviceInstance.getLogicalDateStr = getLogicalDateStr;
serviceInstance.checkIfLogUsedGrace = checkIfLogUsedGrace;

module.exports = serviceInstance;
