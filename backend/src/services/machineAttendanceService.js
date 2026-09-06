// The connection pool. Deliberately NOT named `db`: the punch body below runs inside a
// transaction that binds the name `db` to it, so leaving `db` free at module scope means an
// accidental use of the pool from inside the lock has to be spelled `pool` and is visible on
// sight - instead of silently escaping the transaction.
const pool = require('../config/db');
const crypto = require('crypto');

function isNightShift(shift) {
    if (!shift || !shift.start_time || !shift.end_time) return false;
    const [sH, sM] = shift.start_time.split(':').map(Number);
    const [eH, eM] = shift.end_time.split(':').map(Number);
    const sMins = sH * 60 + sM;
    const eMins = eH * 60 + eM;
    return eMins < sMins;
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

/**
 * Normalizes a database datetime (which Knex/MySQL parses as local time)
 * into a UTC Date object matching the string time.
 */
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

function dateToISTMins(dateVal) {
    if (!dateVal) return 0;
    const d = dbDateToUTC(dateVal);
    if (!d || isNaN(d.getTime())) return 0;
    const istDate = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
    const h = istDate.getUTCHours();
    const m = istDate.getUTCMinutes();
    return h * 60 + m;
}

function dateToISTDateString(dateVal) {
    if (!dateVal) return null;
    const d = dbDateToUTC(dateVal);
    if (!d || isNaN(d.getTime())) return null;
    const istDate = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
    const y = istDate.getUTCFullYear();
    const m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(istDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// The longest span we are willing to read as "one worked shift". Two decisions depend on it:
// whether a punch arriving after the shift's terminate_hour is this row's late check-OUT or
// an unrelated new arrival, and how far either rescue guard looks for a neighbouring row
// before concluding a logical day is empty. Both derive from the constant below so the engine
// holds ONE notion of "close enough to be the same shift".
//
// The separate `diffHours < 20` bound on the previous-day open-row lookup is deliberately NOT
// folded in here: it is a night-shift checkout window, and tightening it to 16h would strand
// long night shifts whose exit legitimately lands further from the check-in.
const MAX_PLAUSIBLE_WORKED_HOURS = 16;
const NEAR_ROW_WINDOW_MS = MAX_PLAUSIBLE_WORKED_HOURS * 60 * 60 * 1000;

// Why a row needs a human to confirm it. Persisted on attendance.review_reason so the muster
// can stop presenting a rescued or ambiguous punch as established fact, and so a rescued row
// has an audit trail beyond the biometric_raw_logs note.
const REVIEW_REASONS = {
    // The punch landed inside the shift's checkout window and no attendance row existed for
    // that logical day. Its DIRECTION is genuinely unknowable: it is either a very late
    // arrival, or a lone check-OUT whose morning check-in never reached the server. The
    // engine records it in check_in so a later punch can still close the row, and flags it.
    CHECKOUT_WINDOW_UNPAIRED: 'checkout_window_unpaired',
    // Punch arrived before the allowed in-margin but within the rescue floor, and was
    // recorded as a check-in rather than discarded.
    EARLY_BEFORE_IN_MARGIN: 'early_before_in_margin',
    // An open row was closed by a punch that arrived after the shift's terminate_hour.
    // Almost always means the assigned shift does not match the hours actually worked.
    CLOSED_AFTER_TERMINATION: 'closed_after_termination',
    // The mirror image of the above: an open row was closed by a punch that lands BEFORE the
    // start time of the shift the row is being judged against. That is only possible when the
    // shift the row is judged against is not the shift the employee worked - either the row
    // pre-dates attendance.shift_id and its session shift had to be re-resolved by date, or
    // the roster was edited between the two punches. The punch is recorded rather than
    // discarded, and flagged so the day is reviewable.
    CLOSED_BEFORE_SHIFT_START: 'closed_before_shift_start',
    // A punch that would have rewritten this row's already-settled check_out was refused,
    // because the shift the row was RECORDED under says it arrived after that shift
    // terminated - while the roster, edited since, would have accepted it. The row is right
    // as it stands; the flag exists because a punch a roster edit would have used to destroy
    // a finished day is worth a human's attention rather than a line in biometric_raw_logs.
    STRAY_AFTER_SETTLED_DAY: 'stray_after_settled_day',
    // The only candidate exit an open row had could not be placed anywhere: it sits further
    // from the check-in than any one shift a human could have worked, AND it is not a
    // credible arrival on its own day either. It closes the row rather than being discarded,
    // because the alternative is the punch surviving only in biometric_raw_logs while the
    // row stays open, 'present' and invisible to every review queue - both lost and silent.
    OPEN_ROW_PUNCH_UNPLACEABLE: 'open_row_punch_unplaceable',
    // A punch landing before the ROSTER shift's in-margin, on a logical day with no row at
    // all, that is nevertheless a credible arrival for the shift this employee's last
    // recorded day actually ran under. The roster has moved them onto a shift that does not
    // describe the day they are working; the punch is recorded so the day survives and
    // flagged so the roster gets fixed.
    ARRIVAL_OUTSIDE_ROSTER_SHIFT: 'arrival_outside_roster_shift'
};

// Every place that resolves an employee_shift_assignments row onto `employeeWithShift` selects
// exactly these columns under exactly these aliases. It was written out three times, and a
// column added to one copy but not the others is silently a different shift. `assigned_shift_id`
// is deliberately NOT aliased to `shift_id`: that name already belongs to employees.shift_id on
// the same object (the profile default), which the termination path still reads as a fallback.
const ASSIGNED_SHIFT_COLUMNS = [
    's.id as assigned_shift_id',
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
    's.terminate_hour as shift_terminate_hour'
];

/** Projects a shift row selected with ASSIGNED_SHIFT_COLUMNS over the employee's own shift. */
function applyResolvedShift(employeeWithShift, shift) {
    if (!employeeWithShift || !shift) return;
    employeeWithShift.shift_is_flexi = shift.is_flexi;
    employeeWithShift.min_hours = shift.min_hours;
    employeeWithShift.shift_start = shift.start_time;
    employeeWithShift.shift_end = shift.end_time;
    employeeWithShift.shift_grace = shift.shift_grace;
    employeeWithShift.shift_grace_count_limit = shift.shift_grace_count_limit;
    employeeWithShift.shift_total_punches = shift.shift_total_punches;
    employeeWithShift.shift_in_margin = shift.shift_in_margin;
    employeeWithShift.shift_out_margin = shift.shift_out_margin;
    employeeWithShift.session2_start_time = shift.session2_start_time;
    employeeWithShift.session2_end_time = shift.session2_end_time;
    employeeWithShift.session2_in_margin = shift.session2_in_margin;
    employeeWithShift.session2_out_margin = shift.session2_out_margin;
    employeeWithShift.session1_grace_out = shift.session1_grace_out;
    employeeWithShift.session2_grace_in = shift.session2_grace_in;
    employeeWithShift.session2_grace_out = shift.session2_grace_out;
    employeeWithShift.shift_terminate_hour = shift.shift_terminate_hour;
}

/**
 * The shift in force for this employee on `targetDate`, or null when none covers it.
 *
 * Ordered from_date DESC then id DESC, which is the rule ATTENDANCE_TROUBLESHOOTING.md records
 * as the fix for the "Shift Assignment Priority Bug" and which attendanceService and
 * looksLikeArrivalOnPunchDay below already follow. The three copies this helper replaces
 * ordered by id alone, so whenever an employee carries several overlapping open-ended
 * assignments - measured 2026-09-05 as 164 of 231 active employees at one client - the shift
 * that won was whichever row happened to be inserted last, not the one whose rotation started
 * most recently. Ingestion and the muster could therefore judge the same day by different
 * shifts, which is the whole class of bug this branch exists to close.
 */
function assignedShiftForDate(db, employeeId, targetDate) {
    return db('employee_shift_assignments as esa')
        .join('shifts as s', 'esa.shift_id', 's.id')
        .where('esa.employee_id', employeeId)
        .where('esa.from_date', '<=', targetDate)
        .andWhere(qb => {
            qb.where('esa.to_date', '>=', targetDate).orWhereNull('esa.to_date');
        })
        .select(ASSIGNED_SHIFT_COLUMNS)
        .orderBy('esa.from_date', 'desc')
        .orderBy('esa.id', 'desc')
        .first();
}

/** One shift by id, in the same shape assignedShiftForDate returns. */
function shiftById(db, shiftId) {
    if (!shiftId) return Promise.resolve(null);
    return db('shifts as s').where('s.id', shiftId).select(ASSIGNED_SHIFT_COLUMNS).first();
}

/**
 * The row that already governs `logicalDate` for this employee, if the day has one.
 *
 * Only rows carrying attendance.shift_id qualify: that column is stamped once, at the moment
 * the session opens, so the row it sits on is a record of what the employee was ACTUALLY
 * working that day - which the roster, editable at any time and retroactively, is not.
 * Rows written before the column existed have it NULL and are ignored, leaving the
 * roster-based resolution they have always had.
 */
function pinnedRowForDay(db, employeeId, companyId, logicalDate) {
    return db('attendance')
        .where({ employee_id: employeeId, company_id: companyId })
        .whereNotNull('shift_id')
        .where('logical_date', logicalDate)
        .orderBy('check_in', 'desc')
        .first();
}

/**
 * The shift the PREVIOUS logical day actually ran under, for the night-shift lookback.
 *
 * The lookback decides whether a punch in the small hours belongs to yesterday's shift, and
 * it used to answer that from employee_shift_assignments alone. So an admin entering a night
 * rotation over a day that was already worked and settled retroactively made that settled day
 * a night shift: the next morning's ordinary arrival then fell inside yesterday's checkout
 * window, adopted yesterday's closed row and overwrote its check_out - destroying the settled
 * day AND swallowing the new one, which got no row at all.
 *
 * Yesterday's own row knows better than today's roster does, so ask it first. When the day
 * produced no pinned row - no punches, or a row that pre-dates attendance.shift_id - this
 * falls back to exactly the resolution it always used.
 */
async function prevDayShift(db, employeeId, companyId, prevDateStr, fallbackShiftId) {
    const prevRow = await pinnedRowForDay(db, employeeId, companyId, prevDateStr);
    if (prevRow) {
        const pinned = await db('shifts').where('id', prevRow.shift_id).first();
        if (pinned) return pinned;
    }

    const assigned = await db('employee_shift_assignments as esa')
        .join('shifts as s', 'esa.shift_id', 's.id')
        .where('esa.employee_id', employeeId)
        .where('esa.from_date', '<=', prevDateStr)
        .andWhere(qb => {
            qb.where('esa.to_date', '>=', prevDateStr).orWhereNull('esa.to_date');
        })
        .select('s.*')
        .orderBy('esa.from_date', 'desc')
        .orderBy('esa.id', 'desc')
        .first();

    if (assigned) return assigned;
    return fallbackShiftId ? await db('shifts').where('id', fallbackShiftId).first() : null;
}

/**
 * Decides what a punch arriving after an open row's shift has terminated actually is.
 *
 * Termination is measured against the ASSIGNED shift, so whenever that assignment is wrong
 * for the person their real exit lands past it every single day. The engine used to re-read
 * such a punch as a fresh check-in, which the in-margin guard then discarded: the row stayed
 * open forever and the punch survived only in biometric_raw_logs. Measured at Hotel Highway
 * King on 2026-09-05: 5-16 skipped punches a day had an open row 4-16h old that they would
 * have closed, and employee 10290 (works 16:00-02:00 on a fallback 06:00-16:00 assignment)
 * lost his exit that way every night.
 *
 * Span, not shift arithmetic, is the honest test: if the gap since check-in is a shift a
 * human could have worked, it is a checkout. A genuinely unrelated next-day arrival is more
 * than MAX_PLAUSIBLE_WORKED_HOURS away and still terminates the stale row.
 *
 * Takes the shift window as explicit strings rather than reading employeeWithShift, because
 * the two call sites resolve it differently - one picks the session-2 times by hand, the
 * other relies on those values having been written over shift_start/shift_end earlier. They
 * agree today; passing them in keeps a future divergence from being silent.
 */
function assessPunchAfterTermination(punchTime, checkInVal, shiftStartStr, shiftEndStr, terminateHour) {
    const checkInDateStr = dateToISTDateString(dbDateToUTC(checkInVal));
    const [sHours, sMins] = shiftStartStr.split(':').map(Number);
    const [eHours, eMins] = shiftEndStr.split(':').map(Number);

    const shiftStartDate = new Date(`${checkInDateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
    let shiftEndDate = new Date(`${checkInDateStr} ${String(eHours).padStart(2, '0')}:${String(eMins).padStart(2, '0')}:00 +05:30`);
    if (shiftEndDate < shiftStartDate) {
        // Midnight crossing
        shiftEndDate = new Date(shiftEndDate.getTime() + 24 * 60 * 60 * 1000);
    }

    const terminationTime = new Date(shiftEndDate.getTime() + parseInt(terminateHour) * 60 * 60 * 1000);
    const hoursSinceCheckIn = (punchTime.getTime() - dbDateToUTC(checkInVal).getTime()) / (1000 * 60 * 60);
    const isPastTermination = punchTime > terminationTime;
    const isPlausibleLateCheckout = hoursSinceCheckIn > 0 && hoursSinceCheckIn <= MAX_PLAUSIBLE_WORKED_HOURS;
    const terminationTimeStr = terminationTime.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });

    return {
        terminationTimeStr,
        isPastTermination,
        // True only when the row should be closed rather than abandoned.
        closesOpenRow: isPastTermination && isPlausibleLateCheckout,
        note: `Closed after shift termination (terminated ${terminationTimeStr}): punch is ${hoursSinceCheckIn.toFixed(2)}h after check-in, which is within a plausible worked shift. The assigned shift likely does not match the hours actually worked.`
    };
}

/**
 * Would this punch pass for the employee's ARRIVAL on its own calendar day?
 *
 * Needed to stop the late-checkout rescue overreaching. The rescue asks only "is the gap since
 * check-in a span a human could have worked", which is true of a 12h gap - but a 20:00 check-in
 * that was never closed followed by an 08:00 punch the next morning is two different days when
 * the employee has rotated onto a morning shift. Closing the old row at 08:00 both inflates the
 * old day to 12 hours and swallows the new day's arrival.
 *
 * Resolved against the shift in force on the PUNCH's day, which is not the shift the rest of
 * the caller is working with (that one belongs to the open row's day).
 */
async function looksLikeArrivalOnPunchDay(db, employeeId, punchTime, punchDateStr, fallbackShiftId) {
    const assigned = await db('employee_shift_assignments as esa')
        .join('shifts as s', 'esa.shift_id', 's.id')
        .where('esa.employee_id', employeeId)
        .where('esa.from_date', '<=', punchDateStr)
        .andWhere(qb => qb.where('esa.to_date', '>=', punchDateStr).orWhereNull('esa.to_date'))
        .select('s.start_time', 's.session1_in_margin', 's.is_flexi')
        .orderBy('esa.from_date', 'desc')
        .orderBy('esa.id', 'desc')
        .first();

    const shift = assigned || (fallbackShiftId ? await db('shifts').where('id', fallbackShiftId).first() : null);
    return looksLikeArrivalForShift(shift, punchTime, punchDateStr);
}

/**
 * The window test behind looksLikeArrivalOnPunchDay, against a shift handed in rather than
 * resolved from the roster - so the same question can be put to the shift a row was PINNED
 * to. The roster is editable and retroactive; the pin is what the employee actually worked,
 * and when the two disagree it is the pin that knows which punches are this person's arrival.
 *
 * Accepts a `shifts` row under either of the two column shapes in this file: raw
 * (session1_in_margin, as prevDayShift and the fallback lookup return) or projected through
 * ASSIGNED_SHIFT_COLUMNS (shift_in_margin, as shiftById returns). Reading only one of them
 * would silently fall back to the 30-minute default for the other.
 */
function looksLikeArrivalForShift(shift, punchTime, punchDateStr) {
    if (!shift || shift.is_flexi || !shift.start_time) return false;

    const [sHours, sMins] = String(shift.start_time).split(':').map(Number);
    const startDate = new Date(`${punchDateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
    const rawMargin = shift.session1_in_margin !== undefined && shift.session1_in_margin !== null
        ? shift.session1_in_margin
        : shift.shift_in_margin;
    const inMargin = rawMargin !== undefined && rawMargin !== null ? parseInt(rawMargin) : 30;

    // From the earliest the shift will accept a check-in, to two hours after it starts - the
    // same 2h allowance the in-margin rescue uses for "still arriving for this shift".
    const earliest = new Date(startDate.getTime() - inMargin * 60 * 1000);
    const latest = new Date(startDate.getTime() + 120 * 60 * 1000);
    return punchTime >= earliest && punchTime <= latest;
}

/**
 * The most recent day this employee has a RECORDED shift for, before `beforeDate`.
 *
 * The roster says what an admin has typed; a pinned row says what the employee was actually
 * working. When a rotation is entered that does not describe their days, this is the only
 * surviving evidence of the shift they were really on - and it is what the in-margin guard
 * asks before throwing an ordinary arrival away.
 */
function lastPinnedRowBefore(db, employeeId, companyId, beforeDate) {
    return db('attendance')
        .where({ employee_id: employeeId, company_id: companyId })
        .whereNotNull('shift_id')
        .whereNotNull('logical_date')
        .where('logical_date', '<', beforeDate)
        .orderBy('logical_date', 'desc')
        .orderBy('check_in', 'desc')
        .first();
}

/**
 * Closes an open row with a punch that has nowhere else to go, and flags the day.
 *
 * Reached only when a punch walked away from an open row (past that row's termination and
 * further from its check-in than one plausible worked shift) and was then refused as a
 * check-in on its own day too. Discarding it there left the punch in biometric_raw_logs only
 * AND the row open, 'present' and absent from every review queue. The status is deliberately
 * 'pending': the span is not one this engine is willing to call a worked day, so the day is
 * handed to a human rather than asserted as fact.
 */
async function closeAbandonedRowWithPunch(db, row, punchTimeStr, deviceSerial) {
    await db('attendance')
        .where({ id: row.id })
        .update({
            check_out: punchTimeStr,
            status: 'pending',
            punch_source: 'biometric',
            device_id: deviceIdString(deviceSerial),
            review_reason: REVIEW_REASONS.OPEN_ROW_PUNCH_UNPLACEABLE,
            updated_at: db.fn.now()
        });
}

/**
 * Resolves a biometric enroll code to an employees.id, trying the explicit mapping table
 * first and then three progressively looser matches on employee_id_number. Extracted from
 * processPunch so the punch can be attributed BEFORE the per-employee lock is taken -
 * there is nothing to lock until we know whose punch this is.
 */
async function resolveEmployeeId(companyId, cleanCode) {
    const mapper = await pool('employee_biometric_mapping')
        .where({ company_id: companyId, biometric_enroll_id: cleanCode })
        .first();

    if (mapper) return mapper.employee_id;

    // Fallback: try matching employees.employee_id_number as string
    let employee = await pool('employees')
        .where({ company_id: companyId, employee_id_number: cleanCode })
        .first();

    // If not found, try without leading zeros (e.g. machine sends "09910" but stored as "9910")
    if (!employee && cleanCode.startsWith('0')) {
        const strippedCode = cleanCode.replace(/^0+/, '');
        employee = await pool('employees')
            .where({ company_id: companyId, employee_id_number: strippedCode })
            .first();
    }

    // If still not found, try numeric comparison (employee_id_number stored as number)
    if (!employee) {
        const numericCode = parseInt(cleanCode, 10);
        if (!isNaN(numericCode)) {
            employee = await pool('employees')
                .where({ company_id: companyId })
                .whereRaw('CAST(employee_id_number AS CHAR) = ?', [String(numericCode)])
                .first();
        }
    }

    return employee ? employee.id : null;
}

class MachineAttendanceService {
    /**
     * Registers a biometric device and generates a secure API key.
     */
    async registerDevice(companyId, data) {
        const { device_name, device_serial, ip_address, port } = data;

        if (!device_serial || !device_name) {
            throw new Error('Device serial and name are required.');
        }

        // Check if device with the same serial already exists
        const existing = await pool('biometric_devices')
            .where({ device_serial })
            .first();

        if (existing) {
            if (existing.company_id !== companyId) {
                throw new Error(`Device serial ${device_serial} is already registered under another company.`);
            }
            return {
                message: 'Device already registered.',
                device: {
                    id: existing.id,
                    company_id: existing.company_id,
                    device_name: existing.device_name,
                    device_serial: existing.device_serial,
                    ip_address: existing.ip_address,
                    port: existing.port,
                    status: existing.status,
                    api_key: existing.api_key,
                    created_at: existing.created_at
                }
            };
        }

        // Generate a cryptographically secure random API key prefixed with mfhr_device_live_
        const apiKey = `mfhr_device_live_${crypto.randomBytes(32).toString('hex')}`;

        const payload = {
            company_id: companyId,
            device_name,
            device_serial,
            ip_address,
            port: parseInt(port) || 5005,
            status: 'online',
            api_key: apiKey,
            last_ping_at: pool.fn.now()
        };

        const [id] = await pool('biometric_devices').insert(payload);
        const registered = await pool('biometric_devices').where({ id }).first();

        return {
            message: 'Device registered successfully.',
            device: registered
        };
    }

    /**
     * Maps an employee biometric enrollment ID to a platform employee ID.
     */
    async mapEmployee(companyId, data) {
        const { employee_id, biometric_enroll_id } = data;

        if (!employee_id || !biometric_enroll_id) {
            throw new Error('Employee ID and Biometric Enrollment ID are required.');
        }

        // Verify employee belongs to company
        const employee = await pool('employees')
            .where({ id: employee_id, company_id: companyId })
            .first();

        if (!employee) {
            throw new Error('Employee not found in this company.');
        }

        // Check existing mapping
        const existing = await pool('employee_biometric_mapping')
            .where({ company_id: companyId, biometric_enroll_id })
            .first();

        if (existing) {
            if (existing.employee_id === parseInt(employee_id)) {
                return { message: 'Mapping already exists.', mapping: existing };
            }
            // Update mapping if enroll ID is assigned to a different employee
            await pool('employee_biometric_mapping')
                .where({ id: existing.id })
                .update({ employee_id, created_at: pool.fn.now() });

            return { message: 'Mapping updated successfully.', mapping: { ...existing, employee_id } };
        }

        const payload = {
            company_id: companyId,
            employee_id: parseInt(employee_id),
            biometric_enroll_id
        };

        const [id] = await pool('employee_biometric_mapping').insert(payload);

        return {
            message: 'Employee biometric mapping created.',
            mapping: { id, ...payload }
        };
    }

    /**
     * Processes a single machine log entry.
     */
    async processPunch(companyId, deviceSerial, punch, bypassDuplicateCheck = false) {
        const { employee_code, timestamp } = punch;

        if (!employee_code || !timestamp) {
            return { status: 'failed', reason: 'Missing employee_code or timestamp' };
        }

        // Parse the incoming timestamp in Indian Standard Time (IST) timezone
        const rawTimeStr = typeof timestamp === 'string' ? timestamp : String(timestamp);
        const punchTime = new Date(rawTimeStr.includes('+') ? rawTimeStr : `${rawTimeStr} +05:30`);
        if (isNaN(punchTime.getTime())) {
            return { status: 'failed', reason: 'Invalid timestamp format' };
        }

        const punchTimeStr = toLocalYYYYMMDDHHmmss(punchTime);
        const cleanCode = employeeCodeClean(employee_code);

        // Resolve the employee before locking - there is nothing to serialize on until we
        // know whose punch this is, and an unmapped code never reaches the attendance table.
        let employeeId = null;
        try {
            employeeId = await resolveEmployeeId(companyId, cleanCode);
        } catch (error) {
            console.error('[BIOMETRIC-SYNC-ERROR]:', error);
            return { status: 'failed', reason: error.message };
        }

        if (!employeeId) {
            // Log unmapped punch
            await pool('biometric_raw_logs').insert({
                company_id: companyId,
                device_serial: deviceSerial,
                employee_code,
                punch_time: punchTimeStr,
                status: 'invalid_user',
                error_details: `Unmapped biometric enroll ID: '${cleanCode}'. No employee found with this code.`
            });
            return { status: 'skipped', reason: `Employee mapping not found for code: ${cleanCode}` };
        }

        try {
            // Serialize every punch for one employee behind a row lock on that employee.
            // The whole body below is read-then-write (is there a raw log for this exact
            // timestamp? is there an open row? is this within 2 minutes of the check-in?),
            // and a device that re-sends a punch a few seconds later opens a SECOND HTTP
            // request that reads the same pre-insert state and writes a second attendance
            // row. Measured at Hotel Highway King 2026-09-05: employee 10234 got five check-in rows for
            // 06:04:29-06:04:51 on 2026-09-05; 1-11 duplicate rows a day across the client.
            // The muster then renders the earliest of those rows, which is the one nobody
            // closed - the "checked in but shows no checkout" complaint.
            // An in-process mutex cannot fix this: PM2 runs the app in cluster mode
            // (ecosystem.config.js instances: 'max'), so the two requests routinely land in
            // different Node processes with independent connection pools. MySQL is the only
            // shared point of coordination. This mirrors the one existing precedent in the
            // codebase, leaveService.applyLeave.
            return await pool.transaction(async (trx) => {
                await trx('employees').where({ id: employeeId }).forUpdate();
                return await this._processPunchSerialized(trx, {
                    companyId,
                    deviceSerial,
                    employee_code,
                    employeeId,
                    punchTime,
                    punchTimeStr,
                    bypassDuplicateCheck
                });
            });
        } catch (error) {
            console.error('[BIOMETRIC-SYNC-ERROR]:', error);
            // Deliberately on the outer connection, not the transaction: the transaction has
            // already rolled back, so an audit row written inside it would vanish with it.
            await pool('biometric_raw_logs').insert({
                company_id: companyId,
                device_serial: deviceSerial,
                employee_code,
                punch_time: punchTimeStr,
                status: 'failed',
                error_details: error.message
            });
            return { status: 'failed', reason: error.message };
        }
    }

    /**
     * The body of processPunch, running with a row lock held on the employee.
     *
     * The first parameter is named `pool` so it shadows the module-level knex instance: every
     * query in here therefore runs inside the caller's transaction and under its lock. Do
     * not reintroduce a reference to the module-level `pool` in this method.
     */
    async _processPunchSerialized(db, ctx) {
        const {
            companyId,
            deviceSerial,
            employee_code,
            employeeId,
            punchTime,
            punchTimeStr,
            bypassDuplicateCheck
        } = ctx;

        // 1. Duplicate Transmission Prevention (Check if raw log already exists in audit
        // table). Inside the lock: a device retrying the same punch concurrently would
        // otherwise have both copies read "no raw log yet" and both proceed.
        const duplicateRaw = await db('biometric_raw_logs')
            .where({
                company_id: companyId,
                device_serial: deviceSerial,
                employee_code,
                punch_time: punchTimeStr
            })
            // A 'failed' audit row records that processing threw, not that the punch was
            // handled. Counting it as a duplicate poisons that timestamp forever: every
            // resend by the device is dismissed and the punch is lost for good. Transient
            // failures are exactly what a device retry exists for - and the new per-employee
            // lock makes a lock-wait rollback a real, if rare, way to get one.
            .whereNot('status', 'failed')
            .first();

        if (!bypassDuplicateCheck && duplicateRaw) {
            return { status: 'skipped', reason: 'Duplicate log transmission' };
        }

        // 3. Process Check-In / Check-Out Business Logic
        const dateStr = dateToISTDateString(punchTime);

        // 3a. Check for night shift: look back on the previous date for an open check-in (< 16 hours old)
        const prevDateObj = new Date(punchTime.getTime() - 24 * 60 * 60 * 1000);
        const prevDateStr = dateToISTDateString(prevDateObj);

        let activeLog = null;
        // Set when an open row is closed by a punch arriving after the shift's
        // terminate_hour; recorded on the row and in the audit log so the day is
        // reviewable rather than silently lost.
        let lateTerminationNote = null;
        // An OPEN row this punch was released from because its shift had terminated and the
        // span was too long to read as one worked day. Only set on that path, and only ever
        // consumed by the check-in guards below when they would otherwise discard the punch -
        // leaving the row orphaned open and the punch nowhere. See REVIEW_REASONS.
        let abandonedOpenRow = null;

        // First check if there is an active check-in on the previous day with NO check-out
        const openPrevDayLog = await db('attendance')
            .where({ employee_id: employeeId, company_id: companyId })
            .whereRaw('DATE(check_in) = ?', [prevDateStr])
            .whereNull('check_out')
            .first();

        if (openPrevDayLog) {
            const checkInTime = dbDateToUTC(openPrevDayLog.check_in);
            const diffHours = Math.abs(punchTime.getTime() - checkInTime.getTime()) / (1000 * 60 * 60);
            if (diffHours < 20) {
                activeLog = openPrevDayLog; // night shift checkout!
            }
        }

        // Fetch Employee with Shift Info and Scheme Info
        const employeeWithShift = await db('employees')
            .leftJoin('shifts', 'employees.shift_id', 'shifts.id')
            .leftJoin('attendance_schemes', 'employees.attendance_scheme_id', 'attendance_schemes.id')
            .where('employees.id', employeeId)
            .select(
                'employees.*',
                'shifts.start_time as shift_start',
                'shifts.end_time as shift_end',
                'shifts.grace_period as shift_grace',
                'shifts.grace_count_limit as shift_grace_count_limit',
                'shifts.is_flexi as shift_is_flexi',
                // Only ever reached this object via an employee_shift_assignments row, so a
                // flexi employee with no assignment fell back to a hardcoded 8h in the
                // checkout routine. Harmless while that branch was dead code; not any more.
                'shifts.min_hours',
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
                'shifts.terminate_hour as shift_terminate_hour',
                'attendance_schemes.grace_period as scheme_grace',
                'attendance_schemes.max_late_allowed',
                'attendance_schemes.half_day_hours as scheme_half_day_hours'
            )
            .first();

        // Resolve overridden shift for this date
        const istHourStr = punchTime.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
        const hour = parseInt(istHourStr, 10);
        let targetShiftDate = dateStr;
        if (!activeLog && hour >= 0 && hour < 10) {
            const prevDateObj = new Date(punchTime.getTime() - 24 * 60 * 60 * 1000);
            const prevDateStr = dateToISTDateString(prevDateObj);

            let prevShift = null;
            if (employeeWithShift) {
                prevShift = await prevDayShift(db, employeeId, companyId, prevDateStr, employeeWithShift.shift_id);
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

                // Being inside yesterday's checkout window is not on its own a reason to file
                // a punch under yesterday. The lookback never asked whether the punch was
                // plausibly this person's arrival TODAY, so a night-to-day rotation lost two
                // days at once: the 09:00 arrival on the first day shift sits exactly inside a
                // 20:00-05:00 shift's window, so it was filed under the (unworked) previous
                // day and pinned to the night shift, while the day actually worked read Absent.
                //
                // looksLikeArrivalOnPunchDay resolves against the roster in force on the
                // PUNCH's own day, which is the day the rotation applies to - so it says yes
                // exactly when the employee has been moved onto a shift this punch starts.
                if (punchTime <= prevTerminationTime
                    && !(await looksLikeArrivalOnPunchDay(db, employeeId, punchTime, dateStr, employeeWithShift.shift_id))) {
                    targetShiftDate = prevDateStr;
                }
            }
        } else if (activeLog) {
            targetShiftDate = dateToISTDateString(dbDateToUTC(activeLog.check_in));
        }

        // The shift this punch is judged against, and the id stamped on any row it opens.
        // Starts as the employee's profile default and is overwritten below by whichever
        // shift actually wins.
        let resolvedShiftId = employeeWithShift?.shift_id || null;

        // THE SHIFT IS PINNED TO THE SESSION, NOT RE-RESOLVED PER PUNCH.
        //
        // Re-resolving from employee_shift_assignments on every punch means an admin who
        // reassigns an employee effective TODAY moves the goalposts under a session that is
        // already open: the check-in was accepted under the old shift, the checkout is then
        // measured against the new one. Reproduced 2026-09-22, employee QA023 - in at 09:00 on
        // a 09:00-18:00 shift, reassigned mid-session to a 22:00-06:00 night shift effective
        // the same day, out at 18:00 -> 'Punch out prior to shift start', the punch discarded
        // and the row orphaned open forever. Mid-day rotation entry is routine admin work, so
        // this fires for a real share of the daily issue count, not a corner case.
        //
        // attendance.shift_id records what the session was actually opened under, so a later
        // punch on that row can ask the row instead of the roster. Every row written before
        // that column existed has it NULL and still falls back to the date-based resolution
        // below - that fallback is exactly today's behaviour, which is what keeps this change
        // backward compatible on production data.
        let pinnedShift = null;
        if (employeeWithShift) {
            // activeLog here is only ever the previous-day open row; the same-day open row is
            // not picked up until latestLog below, so look for it directly. Bounded by
            // NEAR_ROW_WINDOW_MS for the same reason the rescue guards are: beyond one
            // plausible worked shift an open row is stale, not this punch's session.
            const openSessionRow = activeLog || await db('attendance')
                .where({ employee_id: employeeId, company_id: companyId })
                .whereNull('check_out')
                .where('check_in', '<=', punchTimeStr)
                .where('check_in', '>=', toLocalYYYYMMDDHHmmss(new Date(punchTime.getTime() - NEAR_ROW_WINDOW_MS)))
                .orderBy('check_in', 'desc')
                .first();

            if (openSessionRow && openSessionRow.shift_id) {
                pinnedShift = await shiftById(db, openSessionRow.shift_id);
            }

            const activeAssignment = pinnedShift || await assignedShiftForDate(db, employeeId, targetShiftDate);

            if (activeAssignment) {
                applyResolvedShift(employeeWithShift, activeAssignment);
                resolvedShiftId = activeAssignment.assigned_shift_id;
            }
        }

        // HOW MANY PUNCHES A LOGICAL DAY IS SHAPED BY IS SETTLED BY THE DAY, NOT BY THE ROSTER.
        //
        // The pin above only speaks for an OPEN row, so the moment a session closes the engine
        // went back to asking the roster - which can have been edited since. A 4-punch split
        // day whose employee is reassigned to a 2-punch shift the same day then reads
        // total_punches_required=2 while session 1 sits closed on the table, so session 2's
        // arrival takes the 2-punch fallback below and lands on session 1's SETTLED row: a
        // 4h+4h day collapses into one 09:00-21:05 row and session 2 never gets a row at all.
        //
        // A day that already produced a pinned row has already declared its shape. When that
        // shape AGREES with the roster's - the ordinary case, a split-to-split rotation
        // included - nothing changes here and session 2 is still judged by the new shift's own
        // session-2 window. Only when the two disagree can the roster's shift not describe
        // this day (a 2-punch shift has no session 2 to route into), and then the shift the
        // day was actually recorded under has to govern the rest of this punch.
        //
        // Deliberately above the session-1 backup below: origShiftEnd is what the 4-punch
        // router uses to place a punch between the sessions, so it has to be the adopted
        // shift's, not the one the roster has since moved to.
        if (!pinnedShift && employeeWithShift) {
            const dayRow = await pinnedRowForDay(db, employeeId, companyId, targetShiftDate);
            const dayShift = dayRow ? await shiftById(db, dayRow.shift_id) : null;

            if (dayShift
                && parseInt(dayShift.shift_total_punches || 2) !== parseInt(employeeWithShift.shift_total_punches || 2)) {
                applyResolvedShift(employeeWithShift, dayShift);
                resolvedShiftId = dayShift.assigned_shift_id;
            }
        }

        // Backup original shift parameters (Session 1 parameters) before any overwrite/mapping
        const origShiftStart = employeeWithShift?.shift_start || '09:00';
        const origShiftEnd = employeeWithShift?.shift_end || '18:00';
        const origShiftGrace = employeeWithShift?.shift_grace !== undefined ? employeeWithShift.shift_grace : 15;
        const origShiftInMargin = employeeWithShift?.shift_in_margin !== undefined ? employeeWithShift.shift_in_margin : 30;
        const origShiftOutMargin = employeeWithShift?.shift_out_margin !== undefined ? employeeWithShift.shift_out_margin : 0;

        const reqPunches = parseInt(employeeWithShift?.shift_total_punches || 2);

        // Fetch the latest attendance record (to see if one exists, open or closed for targetShiftDate)
        const nextShiftDateObj = new Date(new Date(targetShiftDate).getTime() + 24 * 60 * 60 * 1000);
        const nextShiftDateStr = dateToISTDateString(nextShiftDateObj);

        let cutoffHour = 6;
        if (employeeWithShift && employeeWithShift.shift_start) {
            const [sHours, sMins] = employeeWithShift.shift_start.split(':').map(Number);
            const shiftStartMins = sHours * 60 + sMins;
            const inMargin = employeeWithShift.shift_in_margin !== undefined ? parseInt(employeeWithShift.shift_in_margin) : 30;
            const earliestCheckInMins = shiftStartMins - inMargin;
            if (earliestCheckInMins < 360) { // 360 mins = 6:00 AM
                cutoffHour = Math.floor(Math.max(0, earliestCheckInMins) / 60);
            }
        }

        const latestLog = await db('attendance')
            .where({ employee_id: employeeId, company_id: companyId })
            .andWhere(qb => {
                qb.where(qb1 => {
                    qb1.whereRaw('DATE(check_in) = ?', [targetShiftDate]).whereRaw('HOUR(check_in) >= ?', [cutoffHour]);
                }).orWhere(qb2 => {
                    qb2.whereRaw('DATE(check_in) = ?', [nextShiftDateStr]).whereRaw('HOUR(check_in) < ?', [cutoffHour]);
                });
            })
            .orderBy('check_in', 'desc')
            .first();

        if (!activeLog && latestLog && latestLog.check_out === null) {
            activeLog = latestLog;
        }

        // Fallback for 2-punch shifts (preserve original logic where activeLog can be a closed log)
        if (!activeLog && reqPunches !== 4) {
            activeLog = latestLog;
        }

        // Determine if the current punch belongs to Session 2 (for 4-punch shifts)
        let isSession2 = false;
        let session2CutoffMins = 0;
        if (reqPunches === 4) {
            const s2StartStr = employeeWithShift?.session2_start_time || '14:00';
            const [s2Hours, s2Mins] = s2StartStr.split(':').map(Number);
            const s2StartMins = s2Hours * 60 + s2Mins;
            const s2InMargin = parseInt(employeeWithShift?.session2_in_margin || 30);
            session2CutoffMins = s2StartMins - s2InMargin;

            const s1EndStr = origShiftEnd;
            const [s1EndHours, s1EndMinsVal] = s1EndStr.split(':').map(Number);
            const s1EndMins = s1EndHours * 60 + s1EndMinsVal;

            if (activeLog) {
                // Checkout attempt: evaluate based on check-in time of the open log
                const checkInDate = dbDateToUTC(activeLog.check_in);
                const checkInMins = dateToISTMins(checkInDate);
                if (checkInMins >= session2CutoffMins) {
                    isSession2 = true;
                }
            } else {
                // Check-in attempt: evaluate based on current punch time
                const punchMins = dateToISTMins(punchTime);
                if (latestLog && latestLog.check_out !== null) {
                    isSession2 = true;
                } else if (punchMins >= session2CutoffMins) {
                    isSession2 = true;
                }

                // If they already completed Session 1, prevent checking in again for Session 1
                if (latestLog && latestLog.check_out !== null && !isSession2) {
                    await db('biometric_raw_logs').insert({
                        company_id: companyId,
                        device_serial: deviceSerial,
                        employee_code,
                        punch_time: punchTimeStr,
                        status: 'skipped',
                        error_details: 'Punch ignored: already checked out of Session 1 and before Session 2 cutoff'
                    });
                    return { status: 'skipped', reason: 'Punch ignored: Session 1 completed' };
                }

                // Gap Check: between Session 1 end time and Session 2 in-margin start time
                if (punchMins > s1EndMins && punchMins < session2CutoffMins) {
                    await db('biometric_raw_logs').insert({
                        company_id: companyId,
                        device_serial: deviceSerial,
                        employee_code,
                        punch_time: punchTimeStr,
                        status: 'skipped',
                        error_details: `Punch ignored: between Session 1 end (${s1EndStr}) and Session 2 in-margin start`
                    });
                    return { status: 'skipped', reason: 'Punch ignored: between Session 1 and Session 2' };
                }
            }
        }

        // If activeLog exists and is open (check_out is null), check if its shift has terminated.
        // If it has terminated, we treat this punch as a new check-in attempt for today instead of a check-out.
        const isSession1Checkout = (reqPunches === 4 && !isSession2);
        if (activeLog && activeLog.check_out === null && employeeWithShift && employeeWithShift.shift_terminate_hour && !isSession1Checkout) {
            const termination = assessPunchAfterTermination(
                punchTime,
                activeLog.check_in,
                isSession2 ? (employeeWithShift.session2_start_time || '14:00') : (employeeWithShift.shift_start || '09:00'),
                isSession2 ? (employeeWithShift.session2_end_time || '18:00') : (employeeWithShift.shift_end || '18:00'),
                employeeWithShift.shift_terminate_hour
            );

            // A punch that is itself a credible arrival for its own day is an arrival, not a
            // late checkout - otherwise a rotation swallows two days at once: the stale row is
            // inflated to the moment of the new arrival, and the new day loses its check-in.
            const arrivesToday = termination.closesOpenRow
                && dateToISTDateString(activeLog.check_in) !== dateStr
                && await looksLikeArrivalOnPunchDay(db, employeeId, punchTime, dateStr, employeeWithShift.shift_id);

            if (termination.closesOpenRow && !arrivesToday) {
                lateTerminationNote = termination.note;
            } else if (termination.isPastTermination) {
                // Remember what we are walking away from. This punch is about to be judged as
                // a fresh arrival, which is right when it IS one - but when the check-in
                // guards below then refuse it, the punch is lost and this row is left open,
                // 'present' and unflagged, which no review queue can see. That is how a
                // 17-hour post-rotation exit disappeared completely: too long to be one
                // worked shift, so released here, and nowhere near the new roster shift's
                // start, so discarded there. The guards below close this row instead.
                abandonedOpenRow = activeLog;
                // Shift has terminated! Reset activeLog to null so it forces a check-in today
                activeLog = null;

                // Recalculate targetShiftDate and reload shift details for today's date
                const istHourStr = punchTime.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
                const hour = parseInt(istHourStr, 10);
                targetShiftDate = dateStr;
                if (hour >= 0 && hour < 10) {
                    const prevDateObj = new Date(punchTime.getTime() - 24 * 60 * 60 * 1000);
                    const prevDateStr = dateToISTDateString(prevDateObj);

                    const prevShift = await prevDayShift(db, employeeId, companyId, prevDateStr, employeeWithShift.shift_id);

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

                        // Same guard as the copy above, for the same reason: this punch has
                        // just been ruled a fresh arrival rather than the abandoned row's
                        // checkout, so the one thing it must not then do is get filed under
                        // yesterday. The two copies must agree or a punch's logical day
                        // depends on which of them ran.
                        if (punchTime <= prevTerminationTime
                            && !(await looksLikeArrivalOnPunchDay(db, employeeId, punchTime, dateStr, employeeWithShift.shift_id))) {
                            targetShiftDate = prevDateStr;
                        }
                    }
                }

                // Reload the active shift assignment for the new targetShiftDate.
                //
                // The pin belonged to the row we just abandoned. This punch is being treated
                // as a fresh arrival on its own day, so it must be judged - and stamped - by
                // the roster in force on THAT day, not by the shift of a session it is no
                // longer part of. When no assignment covers the day we fall back to the
                // employee's profile shift explicitly rather than leaving whatever was
                // resolved earlier in place; with no pin that is the same object the initial
                // join produced, so this is a no-op on the pre-existing path.
                pinnedShift = null;
                const reloadedShift = await assignedShiftForDate(db, employeeId, targetShiftDate)
                    || await shiftById(db, employeeWithShift.shift_id);

                if (reloadedShift) {
                    applyResolvedShift(employeeWithShift, reloadedShift);
                    resolvedShiftId = reloadedShift.assigned_shift_id;
                }
            }
        }

        // A SETTLED ROW IS NOT UP FOR GRABS.
        //
        // activeLog on the 2-punch path is routinely a CLOSED row - the fallback above hands
        // one over whenever the day has any row at all - and the checkout routine then writes
        // check_out onto it unconditionally. The only thing standing between that and a
        // destroyed day was the post-termination skip further down, which fires only when the
        // punch is PAST the row's termination hour. A punch that is merely before it falls
        // through every guard and rewrites a finished day's exit.
        //
        // That is not hypothetical: enter a night rotation over an already-settled day and the
        // next morning's ordinary arrival is pulled back into that day, adopts its closed row,
        // rewrites 09:00-18:00 into 09:00 -> next-day 09:00 and marks it absent - while the day
        // that arrival actually belongs to gets no row at all.
        //
        // Two things disqualify a punch from being a settled row's checkout, and both are the
        // engine's existing tests rather than new heuristics: it reads as this person's
        // ARRIVAL on its own calendar day (looksLikeArrivalOnPunchDay, the same test the
        // late-checkout rescue uses to avoid swallowing two days), or it sits further from the
        // check-in than any one shift a human could have worked. Either way it is a different
        // session, so the row is released and the punch opens its own - the punch is never
        // discarded, and the settled row is never touched.
        //
        // What is deliberately still allowed: a later punch on the same day, within one
        // plausible worked span, correcting a checkout that was already recorded. That is the
        // self-healing from ec630fd - a sub-half-day tap settles the row, the real exit
        // arrives hours later and moves check_out to the truth.
        if (activeLog && activeLog.check_out !== null && employeeWithShift) {
            const settledCheckIn = dbDateToUTC(activeLog.check_in);
            const gapHours = (punchTime.getTime() - settledCheckIn.getTime()) / (1000 * 60 * 60);
            const belongsToAnotherDay = dateToISTDateString(settledCheckIn) !== dateStr
                && await looksLikeArrivalOnPunchDay(db, employeeId, punchTime, dateStr, employeeWithShift.shift_id);

            if (belongsToAnotherDay || gapHours > MAX_PLAUSIBLE_WORKED_HOURS) {
                activeLog = null;
                pinnedShift = null;
                targetShiftDate = dateStr;

                const ownDayShift = await assignedShiftForDate(db, employeeId, targetShiftDate)
                    || await shiftById(db, employeeWithShift.shift_id);
                if (ownDayShift) {
                    applyResolvedShift(employeeWithShift, ownDayShift);
                    resolvedShiftId = ownDayShift.assigned_shift_id;
                }
            }
        }

        // A pin describes the session an OPEN row started under. If this punch turns out not
        // to be acting on that row - it is a fresh arrival, or the row it would have closed
        // was abandoned above - the pin no longer applies and the punch must be judged, and
        // stamped, by the roster in force on its own day. Reverting here rather than never
        // pinning at all is deliberate: it keeps every decision above (session routing, the
        // checkout window, the termination rules) running on one consistent shift instead of
        // half on the session's and half on the roster's.
        if (!activeLog && pinnedShift && employeeWithShift) {
            pinnedShift = null;
            const dateResolvedShift = await assignedShiftForDate(db, employeeId, targetShiftDate)
                || await shiftById(db, employeeWithShift.shift_id);
            if (dateResolvedShift) {
                applyResolvedShift(employeeWithShift, dateResolvedShift);
                resolvedShiftId = dateResolvedShift.assigned_shift_id;
            }
        }

        // Overwrite/map shift parameters for Session 2 if active
        if (isSession2 && employeeWithShift) {
            employeeWithShift.shift_start = employeeWithShift.session2_start_time || '14:00';
            employeeWithShift.shift_end = employeeWithShift.session2_end_time || '18:00';
            employeeWithShift.shift_in_margin = employeeWithShift.session2_in_margin !== undefined ? employeeWithShift.session2_in_margin : 30;
            employeeWithShift.shift_out_margin = employeeWithShift.session2_out_margin !== undefined ? employeeWithShift.session2_out_margin : 0;
            employeeWithShift.shift_grace = employeeWithShift.session2_grace_in !== undefined ? employeeWithShift.session2_grace_in : 15;
        }

        if (!activeLog) {
            // --- CHECK-IN ROUTINE ---

            // IN MARGIN CHECK
            // Set when the rescue below records an early punch anyway; appended to the
            // biometric_raw_logs audit row.
            let inMarginNote = null;
            // Which flag the rescued row carries. Defaults to the plain early-punch reason;
            // the roster-mismatch rescue below sets its own, because the two say different
            // things to whoever reads the review queue ("was this really their arrival?"
            // versus "this employee is not on the shift the roster claims").
            let inMarginReviewReason = REVIEW_REASONS.EARLY_BEFORE_IN_MARGIN;
            if (employeeWithShift && !employeeWithShift.shift_is_flexi) {
                const shiftStart = employeeWithShift.shift_start || '09:00';
                const inMargin = employeeWithShift.shift_in_margin !== undefined ? parseInt(employeeWithShift.shift_in_margin) : 0;
                if (inMargin > 0) {
                    const [sHours, sMins] = shiftStart.split(':').map(Number);
                    // Use targetShiftDate (not dateStr) so night shifts anchor correctly to their start date
                    const shiftStartDate = new Date(`${targetShiftDate} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
                    const earliestCheckIn = new Date(shiftStartDate.getTime() - inMargin * 60 * 1000);
                    if (punchTime < earliestCheckIn) {
                        // Same rationale as the checkout-window rescue below: when the logical
                        // day has no attendance row, discarding the punch destroys the
                        // employee's only punch and the day reads Absent — and the next-day
                        // checkout, finding nothing to close, then spawns an orphan open row
                        // (Highway King, Aug 30: 11 night-shift staff arrived ~75min early on
                        // a Sunday and lost the whole worked shift this way). Rescue only
                        // punches within 2h of shift start: anything earlier is more likely a
                        // misattributed checkout or a wrongly assigned shift, where writing a
                        // check-in would corrupt the muster cell instead of saving it.
                        const rescueFloor = new Date(shiftStartDate.getTime() - Math.max(inMargin, 120) * 60 * 1000);
                        let nearbyEarlyRow = null;
                        if (punchTime >= rescueFloor && !latestLog) {
                            nearbyEarlyRow = await db('attendance')
                                .where({ employee_id: employeeId, company_id: companyId })
                                .where('check_in', '>=', toLocalYYYYMMDDHHmmss(new Date(punchTime.getTime() - NEAR_ROW_WINDOW_MS)))
                                .where('check_in', '<=', toLocalYYYYMMDDHHmmss(new Date(punchTime.getTime() + NEAR_ROW_WINDOW_MS)))
                                .first();
                        }

                        if (punchTime < rescueFloor || latestLog || nearbyEarlyRow) {
                            // Before throwing the punch away, ask the pin what shift this
                            // employee is actually working.
                            //
                            // The 2h rescue floor above assumes the roster describes their
                            // day, so a punch far outside it is junk. It does not when a
                            // rotation has been entered that the employee is not on: enter an
                            // open-ended night shift over a settled day-shift week and every
                            // subsequent ordinary 06:00 arrival lands fourteen hours before a
                            // 20:00 start, misses the floor, and is discarded - the day reads
                            // Absent and the punch exists only in biometric_raw_logs. 97e7527
                            // saved the settled day from exactly this roster edit by asking
                            // what the day was RECORDED under; the day AFTER it was still lost.
                            //
                            // attendance.shift_id on the employee's last recorded day is that
                            // same evidence, and the roster cannot rewrite it. If the punch is
                            // a credible arrival for that shift and this logical day has no
                            // row to be confused with, record it and flag it - discarding it
                            // does not make the roster any less wrong, it just also costs the
                            // employee the day.
                            let rosterMismatchNote = null;
                            if (!latestLog && !nearbyEarlyRow) {
                                const lastPinned = await lastPinnedRowBefore(db, employeeId, companyId, targetShiftDate);
                                const workedShift = lastPinned ? await shiftById(db, lastPinned.shift_id) : null;
                                if (workedShift
                                    && Number(lastPinned.shift_id) !== Number(resolvedShiftId)
                                    && looksLikeArrivalForShift(workedShift, punchTime, targetShiftDate)) {
                                    rosterMismatchNote = `Recorded as check-in against a roster that does not describe this day: punch is before the assigned shift's in-margin (earliest allowed ${earliestCheckIn.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' })}) but is a normal arrival for ${workedShift.start_time}-${workedShift.end_time}, the shift this employee's last recorded day actually ran under.`;
                                }
                            }

                            if (!rosterMismatchNote) {
                                // The punch cannot open a day of its own. If it walked away
                                // from an open row on the way here, it is that row's only
                                // candidate exit and closing it beats losing both.
                                if (abandonedOpenRow) {
                                    await closeAbandonedRowWithPunch(db, abandonedOpenRow, punchTimeStr, deviceSerial);
                                    await db('biometric_raw_logs').insert({
                                        company_id: companyId,
                                        device_serial: deviceSerial,
                                        employee_code,
                                        punch_time: punchTimeStr,
                                        status: 'synced',
                                        error_details: `Closed an abandoned open row: punch is neither a plausible span for that row's shift nor a credible arrival on its own day (earliest allowed ${earliestCheckIn.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' })}). Flagged for review.`
                                    });
                                    return { status: 'check-out', record_status: 'pending' };
                                }

                                await db('biometric_raw_logs').insert({
                                    company_id: companyId,
                                    device_serial: deviceSerial,
                                    employee_code,
                                    punch_time: punchTimeStr,
                                    status: 'skipped',
                                    error_details: `Punch in before allowed margin (earliest allowed: ${earliestCheckIn.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' })})`
                                });
                                return { status: 'skipped', reason: 'Punch in before allowed margin' };
                            }

                            inMarginNote = rosterMismatchNote;
                            inMarginReviewReason = REVIEW_REASONS.ARRIVAL_OUTSIDE_ROSTER_SHIFT;
                        } else {
                            inMarginNote = `Recorded as early check-in: punch before the in-margin window (earliest allowed ${earliestCheckIn.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' })}) with no attendance row for ${targetShiftDate}`;
                        }
                    }
                }
            }

            const rules = await db('working_rules').where({ company_id: companyId }).first() || {
                shift_start: '09:00',
                grace_period: 15
            };

            let status = 'present';
            // Set when the checkout-window guard below decides to record the punch
            // anyway (see that block); appended to the biometric_raw_logs audit row.
            let checkoutWindowNote = null;

            if (employeeWithShift && employeeWithShift.shift_start && employeeWithShift.shift_end && !employeeWithShift.shift_is_flexi) {
                const shiftStart = employeeWithShift.shift_start;
                const shiftEnd = employeeWithShift.shift_end;
                const [sHours, sMins] = shiftStart.split(':').map(Number);
                const [eHours, eMins] = shiftEnd.split(':').map(Number);
                const shiftStartDate = new Date(`${targetShiftDate} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
                let shiftEndDate = new Date(`${targetShiftDate} ${String(eHours).padStart(2, '0')}:${String(eMins).padStart(2, '0')}:00 +05:30`);
                if (shiftEndDate < shiftStartDate) {
                    // Midnight crossing
                    shiftEndDate = new Date(shiftEndDate.getTime() + 24 * 60 * 60 * 1000);
                }
                const shiftDurationMins = Math.round((shiftEndDate - shiftStartDate) / 60000);
                const checkoutWindowMins = Math.min(120, shiftDurationMins * 0.25);
                const thresholdDate = new Date(shiftEndDate.getTime() - checkoutWindowMins * 60 * 1000);
                if (punchTime >= thresholdDate) {
                    const thresholdStr = thresholdDate.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' });

                    // A punch this late in the shift is normally a check-OUT, so it must not
                    // become a check-in that shadows a real one. But when no attendance row
                    // exists for this logical day at all, discarding it destroys the employee's
                    // ONLY punch: the day then reads as Absent and the punch survives only in
                    // biometric_raw_logs. Per the master prompt ("NEVER block a biometric
                    // punch - always log it, even if late or early"), record it instead and let
                    // the late-in path below flag it for manager review.
                    // `latestLog` alone is not enough to prove the logical day is empty. Its
                    // window uses a per-shift cutoff hour, while the muster grid's
                    // getLogicalDateStr() (attendanceService.js) uses a fixed 10-hour rule and
                    // pulls a 00:00-09:59 punch back to the previous date whenever THAT date
                    // held a night shift - and which shift "that date" resolves to is itself
                    // order-dependent when an employee has overlapping open-ended rows in
                    // employee_shift_assignments (the norm in this data). Rather than depend on
                    // that resolution, refuse to write whenever ANY row sits close enough to
                    // possibly share the cell. A day that already has a row is not a day whose
                    // attendance was destroyed, so declining there costs nothing: the punch this
                    // fallback exists to save is by definition the only one of its day.
                    const nearbyRow = await db('attendance')
                        .where({ employee_id: employeeId, company_id: companyId })
                        .where('check_in', '>=', toLocalYYYYMMDDHHmmss(new Date(punchTime.getTime() - NEAR_ROW_WINDOW_MS)))
                        .where('check_in', '<=', toLocalYYYYMMDDHHmmss(new Date(punchTime.getTime() + NEAR_ROW_WINDOW_MS)))
                        .first();

                    if (latestLog || nearbyRow) {
                        // As in the in-margin guard: a punch refused here that also walked
                        // away from an open row would leave BOTH lost - the punch in
                        // biometric_raw_logs only, the row open and unflagged. It closes the
                        // row it came from instead.
                        if (abandonedOpenRow) {
                            await closeAbandonedRowWithPunch(db, abandonedOpenRow, punchTimeStr, deviceSerial);
                            await db('biometric_raw_logs').insert({
                                company_id: companyId,
                                device_serial: deviceSerial,
                                employee_code,
                                punch_time: punchTimeStr,
                                status: 'synced',
                                error_details: `Closed an abandoned open row: punch is neither a plausible span for that row's shift nor a check-in its own day will accept (checkout window started ${thresholdStr}). Flagged for review.`
                            });
                            return { status: 'check-out', record_status: 'pending' };
                        }

                        await db('biometric_raw_logs').insert({
                            company_id: companyId,
                            device_serial: deviceSerial,
                            employee_code,
                            punch_time: punchTimeStr,
                            status: 'skipped',
                            error_details: `Punch in ignored: checkout window has started (earliest allowed: ${thresholdStr})`
                        });
                        return { status: 'skipped', reason: 'Check-in after checkout window started' };
                    }

                    checkoutWindowNote = `Recorded as review-pending check-in: punch landed in the checkout window (started ${thresholdStr}) with no attendance row for ${targetShiftDate}`;
                }
            }

            const approvedRequest = await db('attendance_entry_requests')
                .where({ employee_id: employeeId, company_id: companyId, date: targetShiftDate, request_type: 'late_in', status: 'approved' })
                .first();

            // A punch inside the shift's checkout window with no attendance row for the
            // logical day is DIRECTION-ambiguous, and the engine must not pretend
            // otherwise. It is either a very late arrival, or a lone check-OUT whose
            // morning check-in never reached the server. Banti (10105), 2026-09-05:
            // single punch at 17:00 on a 07:00-17:00 shift, no 07:00 punch anywhere in
            // biometric_raw_logs though the device delivered other people's punches that
            // hour. It was recorded as a check-in, a late_in request was raised, a
            // manager approved it, and the day-detail panel then asserted "PUNCH IN
            // 05:00 pm" - which the client escalated as "punch out taken as punch in".
            // The punch still goes in check_in so a later punch can close the row (that
            // self-healing is what rescues employees whose assigned shift is simply
            // wrong), but it is flagged for review and raises missing_in rather than
            // late_in, so approval asks the manager for the real arrival time instead of
            // blessing the recorded time as the arrival.
            const isUnpairedCheckoutWindowPunch = !!checkoutWindowNote;

            if (isUnpairedCheckoutWindowPunch) {
                status = 'pending';
                const existingRequest = await db('attendance_entry_requests')
                    .where({ employee_id: employeeId, company_id: companyId, date: targetShiftDate, request_type: 'missing_in' })
                    .first();
                if (!existingRequest) {
                    await db('attendance_entry_requests').insert({
                        company_id: companyId,
                        employee_id: employeeId,
                        date: targetShiftDate,
                        request_type: 'missing_in',
                        punch_time: punchTimeStr,
                        location_data: JSON.stringify({ source: 'biometric', device_serial: deviceSerial }),
                        status: 'pending',
                        created_at: db.fn.now(),
                        updated_at: db.fn.now()
                    });
                }
            }

            if (!approvedRequest && !employeeWithShift?.shift_is_flexi && !isUnpairedCheckoutWindowPunch) {
                const shiftStart = employeeWithShift?.shift_start || rules.shift_start || '09:00';
                const grace = employeeWithShift?.scheme_grace ?? employeeWithShift?.shift_grace ?? rules.grace_period ?? 15;

                const [sHours, sMins] = shiftStart.split(':').map(Number);
                const shiftStartActual = new Date(`${targetShiftDate} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
                const shiftStartLimit = new Date(shiftStartActual.getTime() + (parseInt(grace) || 0) * 60 * 1000);

                let isLate = punchTime > shiftStartLimit;

                if (!isLate && punchTime > shiftStartActual && punchTime <= shiftStartLimit) {
                    // Check if grace limit has been exceeded for the current month
                    const startOfMonth = `${targetShiftDate.slice(0, 8)}01`;
                    const currentMonthLogs = await db('attendance')
                        .where({ employee_id: employeeId, company_id: companyId })
                        .whereRaw('DATE(check_in) >= ?', [startOfMonth])
                        .whereRaw('DATE(check_in) < ?', [targetShiftDate])
                        .select('check_in');

                    const monthAssignments = await db('employee_shift_assignments as esa')
                        .join('shifts as s', 'esa.shift_id', 's.id')
                        .where('esa.employee_id', employeeId)
                        .where(qb => {
                            qb.where('esa.from_date', '<=', targetShiftDate)
                                .andWhere(qb2 => {
                                    qb2.where('esa.to_date', '>=', startOfMonth).orWhereNull('esa.to_date');
                                });
                        })
                        .select('esa.from_date', 'esa.to_date', 's.start_time', 's.end_time', 's.grace_period', 's.is_night_shift');

                    let graceCount = 0;
                    for (const log of currentMonthLogs) {
                        const logDateStr = dateToISTDateString(log.check_in);
                        const ass = monthAssignments.find(a => {
                            const fromStr = dateToISTDateString(a.from_date);
                            const toStr = a.to_date ? dateToISTDateString(a.to_date) : null;
                            return fromStr <= logDateStr && (!toStr || toStr >= logDateStr);
                        });

                        const shiftStart = ass ? ass.start_time : (employeeWithShift?.shift_start || rules.shift_start || '09:00');
                        const grace = employeeWithShift?.scheme_grace ?? (ass ? ass.grace_period : (employeeWithShift?.shift_grace ?? rules.grace_period ?? 15));

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

                    const allowedGraceLimit = employeeWithShift?.max_late_allowed !== undefined && employeeWithShift?.max_late_allowed !== null
                        ? parseInt(employeeWithShift.max_late_allowed)
                        : (employeeWithShift?.shift_grace_count_limit !== undefined && employeeWithShift?.shift_grace_count_limit !== null
                            ? parseInt(employeeWithShift.shift_grace_count_limit)
                            : 3);

                    if (graceCount >= allowedGraceLimit) {
                        isLate = true;
                    }
                }

                if (isLate) {
                    // Biometric machine punch - log attendance as 'late' instead of blocking
                    // Auto-create regularization request for manager review
                    status = 'pending';
                    const existingRequest = await db('attendance_entry_requests')
                        .where({ employee_id: employeeId, company_id: companyId, date: targetShiftDate, request_type: 'late_in' })
                        .first();
                    if (!existingRequest) {
                        await db('attendance_entry_requests').insert({
                            company_id: companyId,
                            employee_id: employeeId,
                            // Shift date, not calendar date: a rescued 00:0x check-in on a night
                            // shift belongs to the previous day. Dating it by calendar day made
                            // approval attach to the employee's real evening row on that date
                            // and stamp it late (Highway King 10304/10305, Sep 1 2026).
                            date: targetShiftDate,
                            request_type: 'late_in',
                            punch_time: punchTimeStr,
                            location_data: JSON.stringify({ source: 'biometric', device_serial: deviceSerial }),
                            status: 'pending',
                            created_at: db.fn.now(),
                            updated_at: db.fn.now()
                        });
                    }
                }
            }

            await db('attendance').insert({
                employee_id: employeeId,
                company_id: companyId,
                check_in: punchTimeStr,
                check_out: null,
                status: status,
                punch_source: 'biometric',
                device_id: deviceSerial,
                // The shift day this row belongs to, decided here where the shift, the
                // night-shift lookback and the termination rules have all already been
                // resolved. Readers previously re-derived it from check_in alone, which
                // is order-dependent when an employee has overlapping open-ended shift
                // assignments - the norm in this data.
                logical_date: targetShiftDate,
                // The shift this session was opened under, pinned so that every later punch
                // on this row is judged by it even if the roster is edited in between. This
                // is the only place it is written: a row's shift is decided once, at the
                // moment the session starts. NULL only for rows that pre-date the column.
                shift_id: resolvedShiftId,
                review_reason: checkoutWindowNote
                    ? REVIEW_REASONS.CHECKOUT_WINDOW_UNPAIRED
                    : (inMarginNote ? inMarginReviewReason : null),
                created_at: db.fn.now()
            });

            // Record audit log
            await db('biometric_raw_logs').insert({
                company_id: companyId,
                device_serial: deviceSerial,
                employee_code,
                punch_time: punchTimeStr,
                status: 'synced',
                error_details: checkoutWindowNote || inMarginNote
            });

            return { status: 'check-in', record_status: status };
        } else {
            // --- CHECK-OUT ROUTINE / RE-PUNCH DEDUPLICATION ---

            // If 4-punch and already checked out of Session 1, and not yet in Session 2, ignore punch
            if (reqPunches === 4 && activeLog.check_out && !isSession2) {
                await db('biometric_raw_logs').insert({
                    company_id: companyId,
                    device_serial: deviceSerial,
                    employee_code,
                    punch_time: punchTimeStr,
                    status: 'skipped',
                    error_details: 'Punch ignored: already checked out of Session 1 and before Session 2 margin'
                });
                return { status: 'skipped', reason: 'Punch ignored: between Session 1 and Session 2' };
            }

            // Shift Terminate Hour check
            const isSession1Checkout = (reqPunches === 4 && !isSession2);
            if (employeeWithShift && employeeWithShift.shift_terminate_hour && !isSession1Checkout) {
                // The check-in-side branch above keeps activeLog when the punch is still a
                // plausible checkout, so this one has to agree or the punch arrives here
                // only to be discarded and the row stays open anyway. Both now ask the
                // same function rather than repeating the arithmetic.
                const rosterTermination = assessPunchAfterTermination(
                    punchTime,
                    activeLog.check_in,
                    employeeWithShift.shift_start || '09:00',
                    employeeWithShift.shift_end || '18:00',
                    employeeWithShift.shift_terminate_hour
                );

                // A SETTLED row is judged by the shift it was RECORDED under, never by the
                // roster's current one.
                //
                // While a row is OPEN the pin already governs employeeWithShift, so this
                // agrees with itself. Once the row closes, the pin is dropped and this test
                // fell back to the roster - which is editable, and retroactively. Rotate a
                // 06:00-16:00 day (terminating 18:00) onto a 12:00-21:00 shift (terminating
                // 23:00) effective the SAME day and a 19:00 stray tap stopped being past
                // termination: it walked through this guard and rewrote a finished day's
                // check_out to 19:00, flipped it to 'pending' and raised an early-out request
                // nobody needed. Without the rotation the identical punch is refused, which
                // is the whole proof that the roster edit was doing the damage.
                //
                // shift_id NULL means the row pre-dates the pin, not that it has no shift, so
                // those rows keep the date-based resolution they have always had.
                let termination = rosterTermination;
                let refusedByPinOnly = false;
                if (activeLog.check_out !== null && activeLog.shift_id
                    && Number(activeLog.shift_id) !== Number(resolvedShiftId)) {
                    const rowShift = await shiftById(db, activeLog.shift_id);
                    if (rowShift && rowShift.shift_terminate_hour !== null && rowShift.shift_terminate_hour !== undefined) {
                        // Session-2 rows are judged by the session-2 window, exactly as the
                        // check-in-side call site does it by hand.
                        termination = assessPunchAfterTermination(
                            punchTime,
                            activeLog.check_in,
                            isSession2 ? (rowShift.session2_start_time || '14:00') : (rowShift.start_time || '09:00'),
                            isSession2 ? (rowShift.session2_end_time || '18:00') : (rowShift.end_time || '18:00'),
                            rowShift.shift_terminate_hour
                        );
                        refusedByPinOnly = termination.isPastTermination && !rosterTermination.isPastTermination;
                    }
                }

                // closesOpenRow is not sufficient on its own here: unlike the check-in-side
                // branch, activeLog on this path is routinely a CLOSED row (the 2-punch
                // fallback above assigns latestLog whether or not it has a check_out). A stray
                // evening punch would then rewrite an already-settled check_out and turn a
                // normal day into a 13-hour one. Only an open row can be closed late.
                if (termination.closesOpenRow && activeLog.check_out === null) {
                    lateTerminationNote = lateTerminationNote || termination.note;
                } else if (termination.isPastTermination) {
                    // A punch only the pin refused is a punch the roster edit would have used
                    // to destroy this day. Blocking it silently leaves that near-miss visible
                    // nowhere but biometric_raw_logs, so the settled row carries the flag -
                    // the row is right as it stands, but the day is worth a human's eye. The
                    // ordinary case (no rotation, both windows agree) flags nothing.
                    if (refusedByPinOnly && !activeLog.review_reason) {
                        await db('attendance')
                            .where({ id: activeLog.id })
                            .update({ review_reason: REVIEW_REASONS.STRAY_AFTER_SETTLED_DAY, updated_at: db.fn.now() });
                    }
                    await db('biometric_raw_logs').insert({
                        company_id: companyId,
                        device_serial: deviceSerial,
                        employee_code,
                        punch_time: punchTimeStr,
                        status: 'skipped',
                        error_details: `Punch ignored: shift terminated at ${termination.terminationTimeStr}`
                            + (refusedByPinOnly ? ' (measured against the shift the settled row was recorded under, not the roster\'s current one)' : '')
                    });
                    return { status: 'skipped', reason: 'Shift terminated' };
                }
            }

            const currentCheckIn = dbDateToUTC(activeLog.check_in);
            const diffMinutesFromCheckIn = Math.abs(punchTime.getTime() - currentCheckIn.getTime()) / 60000;

            // Deduplicate consecutive double punches (within 2 minutes of check-in)
            if (diffMinutesFromCheckIn < 2) {
                await db('biometric_raw_logs').insert({
                    company_id: companyId,
                    device_serial: deviceSerial,
                    employee_code,
                    punch_time: punchTimeStr,
                    status: 'duplicate',
                    error_details: 'Punch is within 2 minutes of check-in'
                });
                return { status: 'skipped', reason: 'Deduplicated: within 2 minutes of check-in' };
            }

            if (activeLog.check_out) {
                const currentCheckOut = dbDateToUTC(activeLog.check_out);
                const diffMinutesFromCheckOut = Math.abs(punchTime.getTime() - currentCheckOut.getTime()) / 60000;

                // Deduplicate consecutive double punches (within 2 minutes of last checkout)
                if (diffMinutesFromCheckOut < 2) {
                    await db('biometric_raw_logs').insert({
                        company_id: companyId,
                        device_serial: deviceSerial,
                        employee_code,
                        punch_time: punchTimeStr,
                        status: 'duplicate',
                        error_details: 'Punch is within 2 minutes of check-out'
                    });
                    return { status: 'skipped', reason: 'Deduplicated: within 2 minutes of check-out' };
                }
            }

            // If punchTime is actually before check_in, ignore it (should not happen chronologically)
            if (punchTime < currentCheckIn) {
                await db('biometric_raw_logs').insert({
                    company_id: companyId,
                    device_serial: deviceSerial,
                    employee_code,
                    punch_time: punchTimeStr,
                    status: 'failed',
                    error_details: 'Punch timestamp is prior to recorded check-in time'
                });
                return { status: 'skipped', reason: 'Punch time prior to check-in' };
            }

            const employee = employeeWithShift;
            // The flexi flag is `shift_is_flexi` on this object - it is selected as
            // `shifts.is_flexi as shift_is_flexi` and re-assigned under that name when an
            // assignment overrides the shift. `employee.is_flexi` (which this whole
            // checkout routine used to test) is ALWAYS undefined: employees has no such
            // column. So every flexi employee has been silently evaluated by the
            // fixed-hours path, judged against the shift's clock times instead of
            // min_hours - which for the usual 00:00-23:59 "Anytime" flexi shift means any
            // checkout before 23:59 read as leaving early. The check-in routine had it
            // right all along (see the shift_is_flexi tests above); only this branch drifted.
            const isFlexi = !!employee?.shift_is_flexi;
            const rules = await db('working_rules').where({ company_id: companyId }).first() || {};

            const checkIn = dbDateToUTC(activeLog.check_in);
            const checkInMins = dateToISTMins(checkIn);
            const punchMins = dateToISTMins(punchTime);
            let workedMins = punchMins - checkInMins;
            if (workedMins < 0) workedMins += 24 * 60;
            const workedHours = workedMins / 60;

            let isEarly = false;
            let halfDayLimit = 4; // default
            let shiftEndDate = null;
            let outMarginThreshold = null;
            // Set when the before-shift-start guard below closes an open row instead of
            // discarding the punch; recorded on the row and in the audit log.
            let beforeShiftStartNote = null;

            if (isFlexi) {
                const minHours = parseFloat(employee?.min_hours) || 8;
                halfDayLimit = minHours / 2;
                if (workedHours < minHours) {
                    isEarly = true;
                }
            } else {
                const shiftStart = employee?.shift_start || '09:00';
                const shiftEnd = employee?.shift_end || '18:00';
                const outMargin = employee?.shift_out_margin !== undefined ? parseInt(employee.shift_out_margin) : 0;

                const checkInDateStr = dateToISTDateString(checkIn);
                const [sHours, sMins] = shiftStart.split(':').map(Number);
                const [eHours, eMins] = shiftEnd.split(':').map(Number);
                const shiftStartDate = new Date(`${checkInDateStr} ${String(sHours).padStart(2, '0')}:${String(sMins).padStart(2, '0')}:00 +05:30`);
                shiftEndDate = new Date(`${checkInDateStr} ${String(eHours).padStart(2, '0')}:${String(eMins).padStart(2, '0')}:00 +05:30`);
                if (shiftEndDate < shiftStartDate) {
                    // Midnight crossing
                    shiftEndDate = new Date(shiftEndDate.getTime() + 24 * 60 * 60 * 1000);
                }

                // 1. PUNCH OUT BEFORE SHIFT START
                //
                // The guard exists for a punch that really does land before the shift began
                // with nothing to close - a stray tap that must not be written anywhere. But
                // it used to fire on an OPEN row too, and then it destroyed the exit that
                // would have closed it: the row stayed check_in-only forever and the punch
                // survived only in biometric_raw_logs. That happens whenever the shift this
                // row is being judged against is not the shift the employee worked - a row
                // written before attendance.shift_id existed (so its session shift had to be
                // re-resolved by date), or a roster edited between the two punches. QA023,
                // 2026-09-22: in 09:00, reassigned mid-session to a 22:00 shift, out 18:00 -
                // 18:00 is "before shift start" and the day was lost.
                //
                // Span is the honest test here, the same one assessPunchAfterTermination
                // uses: if the gap since check-in is a shift a human could have worked, this
                // punch closes the row. It is recorded and flagged rather than discarded,
                // because a real punch must never be silently lost. A closed activeLog (the
                // 2-punch fallback hands one over routinely) has nothing to close, so it
                // still takes the original skip.
                if (punchTime < shiftStartDate) {
                    const gapHours = (punchTime.getTime() - checkIn.getTime()) / (1000 * 60 * 60);
                    const closesOpenRow = activeLog.check_out === null
                        && gapHours > 0
                        && gapHours <= MAX_PLAUSIBLE_WORKED_HOURS;

                    if (!closesOpenRow) {
                        await db('biometric_raw_logs').insert({
                            company_id: companyId,
                            device_serial: deviceSerial,
                            employee_code,
                            punch_time: punchTimeStr,
                            status: 'skipped',
                            error_details: 'Punch out prior to shift start time'
                        });
                        return { status: 'skipped', reason: 'Punch out prior to shift start' };
                    }

                    beforeShiftStartNote = `Closed before the assigned shift start (${shiftStart}): punch is ${gapHours.toFixed(2)}h after check-in, which is within a plausible worked shift. The shift this row is judged against is not the one that was worked - most often the roster was changed after the session opened.`;
                }

                // Determine half day hours limit
                if (reqPunches === 4) {
                    let diffMins = (eHours * 60 + eMins) - (sHours * 60 + sMins);
                    if (diffMins < 0) diffMins += 24 * 60;
                    halfDayLimit = (diffMins / 60) / 2;
                } else {
                    halfDayLimit = employee?.min_hours !== undefined && employee?.min_hours !== null
                        ? parseFloat(employee.min_hours) / 2
                        : (employee?.scheme_half_day_hours !== undefined && employee?.scheme_half_day_hours !== null
                            ? parseFloat(employee.scheme_half_day_hours)
                            : parseFloat(rules.half_day_hours || 4));
                }

                outMarginThreshold = new Date(shiftEndDate.getTime() - outMargin * 60 * 1000);

                // Early means before the shift's allowed out-margin, NOT merely before the
                // shift end. session1_out_margin exists precisely to say "leaving this
                // many minutes early is fine"; treating anything before shift end as early
                // made the margin meaningless. Measured 2026-09-05: every early_out row at Hotel Highway King
                // Sep 1-5 2026 was 1-4 minutes early against a 5-minute margin - 17 of
                // them on Sep 4 alone - i.e. all of them were people leaving on time.
                // The early-out REQUEST trigger below already used outMarginThreshold, so
                // only the status disagreed with the request; they now share one rule.
                if (punchTime < outMarginThreshold) {
                    isEarly = true;
                }
            }
            // Half-day limit: only 4-punch shifts still skip here — closing Session 1
            // prematurely would misroute the employee's remaining punches into Session 2.
            // For 2-punch and flexi shifts, dropping the punch strands the row open forever
            // (the real damage: an unclosed cell and lost worked hours), while recording it
            // is self-healing — any later punch overwrites check_out below, and if none
            // comes, "left before half-day" is the truth and the status logic marks it.
            if (workedHours < halfDayLimit && reqPunches === 4) {
                await db('biometric_raw_logs').insert({
                    company_id: companyId,
                    device_serial: deviceSerial,
                    employee_code,
                    punch_time: punchTimeStr,
                    status: 'skipped',
                    error_details: `Punch ignored: worked hours (${workedHours.toFixed(2)}) is less than the half-day threshold (${halfDayLimit.toFixed(2)} hours).`
                });
                return { status: 'skipped', reason: 'Punch ignored: before half-day limit' };
            }

            // 2. Determine if we should generate an early out regularization request
            let triggersEarlyOutRequest = false;

            // The half-day floor is load-bearing: without it a stray tap minutes after
            // check-in (past the 2-minute dedup) raises an early-out request and stamps the
            // row 'pending', and the status recompute below refuses to clear 'pending' - so
            // the real full-day checkout that follows can never restore it to Present.
            // Sub-half-day checkouts are still recorded; they just settle as 'absent' and
            // self-heal when the genuine checkout reopens the row.
            // isEarly now already means "before the out-margin window" for non-flexi
            // shifts, so the redundant second threshold test that used to sit here is
            // gone. Flexi shifts set isEarly from min_hours and have no out-margin, so
            // they are excluded explicitly rather than by outMarginThreshold being null.
            if (isEarly && workedHours >= halfDayLimit && !isFlexi) {
                triggersEarlyOutRequest = true;
            }

            // This checkout settles the question that flagged the row on the way in. The
            // punch was ambiguous only because it stood alone; now that a genuine exit
            // has paired with it, it was a check-in after all - the employee simply works
            // hours the roster does not describe. So the row must not stay 'pending' and
            // the manager must not keep staring at a missing_in request for a day that is
            // now complete. Leaving either in place is the dead end fixed in 04a64cd: a
            // row nothing can move off 'pending' and a request with no correct answer.
            //
            // Resolved here, above the early-out branch, because that branch returns: run
            // it later and an early checkout would clear the flag and strand the request.
            const wasUnpaired = activeLog.review_reason === REVIEW_REASONS.CHECKOUT_WINDOW_UNPAIRED;
            if (wasUnpaired) {
                // Withdrawn rather than deleted: the request is how we know the engine
                // was unsure, and 'withdrawn' is absent from both the pending queue and
                // the approved/rejected history, so it leaves the reviewer's screens
                // without erasing the trail.
                await db('attendance_entry_requests')
                    .where({
                        employee_id: employeeId,
                        company_id: companyId,
                        date: targetShiftDate,
                        request_type: 'missing_in',
                        status: 'pending'
                    })
                    .update({ status: 'withdrawn', updated_at: db.fn.now() });
            }

            // A checkout answers exactly one question: whether the check-in stood alone.
            // It says nothing about whether an EARLY check-in was really this person's
            // arrival, so early_before_in_margin has to survive - clearing it would retire
            // the flag before any human saw it, since a rescued early row nearly always
            // gets closed later that day.
            const resolvedReviewReason = lateTerminationNote
                ? REVIEW_REASONS.CLOSED_AFTER_TERMINATION
                : (beforeShiftStartNote
                    ? REVIEW_REASONS.CLOSED_BEFORE_SHIFT_START
                    : (wasUnpaired ? null : (activeLog.review_reason || null)));

            // Both close-anyway rescues write a note; only one can be set on a given punch.
            const checkoutAuditNote = lateTerminationNote || beforeShiftStartNote;

            // Check if there is an approved Entry/Exit Request for this date and type 'early_out'
            const approvedRequest = await db('attendance_entry_requests')
                .where({ employee_id: employeeId, company_id: companyId, date: targetShiftDate, request_type: 'early_out', status: 'approved' })
                .first();

            if (!approvedRequest && triggersEarlyOutRequest) {
                // Biometric machine punch - log checkout anyway, just create a regularization request
                const existingRequest = await db('attendance_entry_requests')
                    .where({ employee_id: employeeId, company_id: companyId, date: targetShiftDate, request_type: 'early_out' })
                    .first();
                if (!existingRequest) {
                    await db('attendance_entry_requests').insert({
                        company_id: companyId,
                        employee_id: employeeId,
                        // Shift date of the open row (targetShiftDate = check-in's date here).
                        date: targetShiftDate,
                        request_type: 'early_out',
                        punch_time: punchTimeStr,
                        location_data: JSON.stringify({ source: 'biometric', device_serial: deviceSerial }),
                        status: 'pending',
                        created_at: db.fn.now(),
                        updated_at: db.fn.now()
                    });
                }
                // Update check_out and set status to 'pending' because it requires approval
                await db('attendance')
                    .where({ id: activeLog.id })
                    .update({
                        check_out: punchTimeStr,
                        status: 'pending',
                        punch_source: 'biometric',
                        device_id: deviceIdString(deviceSerial),
                        review_reason: resolvedReviewReason,
                        updated_at: db.fn.now()
                    });

                // Record audit log
                await db('biometric_raw_logs').insert({
                    company_id: companyId,
                    device_serial: deviceSerial,
                    employee_code,
                    punch_time: punchTimeStr,
                    status: 'synced',
                    error_details: checkoutAuditNote
                });

                return { status: 'check-out', record_status: 'pending' };
            }

            // Normal/non-blocked checkout: Update check_out
            await db('attendance')
                .where({ id: activeLog.id })
                .update({
                    check_out: punchTimeStr,
                    punch_source: 'biometric',
                    device_id: deviceIdString(deviceSerial),
                    review_reason: resolvedReviewReason,
                    updated_at: db.fn.now()
                });

            // Calculate and update status in database on checkout
            let newStatus = activeLog.status || 'present';
            if (isFlexi) {
                const minHours = parseFloat(employee.min_hours) || 8;
                if (workedHours < halfDayLimit) {
                    newStatus = 'absent';
                } else if (workedHours < minHours) {
                    newStatus = 'half-day';
                } else {
                    newStatus = 'present';
                }
            } else {
                // The branch that used to lead here stamped 'early_out' for a checkout
                // between (shift end - out margin) and shift end - that is the INSIDE of
                // the allowed margin, i.e. exactly the people who left on time. Removed;
                // isEarly is now the single rule and it already excludes the margin.
                if (workedHours < halfDayLimit) {
                    newStatus = 'absent';
                } else if (isEarly) {
                    newStatus = 'early_out';
                } else if (newStatus !== 'pending' || wasUnpaired) {
                    // The 'pending' guard protects a row awaiting early-out approval from
                    // being quietly marked present. A row pending only because its lone
                    // punch was ambiguous has no such decision outstanding once it pairs,
                    // so it is excluded - otherwise every employee whose roster is wrong
                    // ends each completed day stuck awaiting a manager.
                    newStatus = 'present';
                }
            }

            await db('attendance')
                .where({ id: activeLog.id })
                .update({ status: newStatus });

            // Record audit log
            await db('biometric_raw_logs').insert({
                company_id: companyId,
                device_serial: deviceSerial,
                employee_code,
                punch_time: punchTimeStr,
                status: 'synced',
                error_details: checkoutAuditNote
            });

            return { status: 'check-out' };
        }
    }

    /**
     * Gets all biometric devices for a company.
     */
    async getDevices(companyId) {
        return await pool('biometric_devices')
            .where({ company_id: companyId })
            .select('id', 'company_id', 'device_name', 'device_serial', 'ip_address', 'port', 'status', 'api_key', 'last_ping_at', 'created_at');
    }

    /**
     * Deletes a biometric device.
     */
    async deleteDevice(companyId, deviceId) {
        const deleted = await pool('biometric_devices')
            .where({ id: deviceId, company_id: companyId })
            .del();
        if (!deleted) {
            throw new Error('Device not found or not authorized.');
        }
        return { message: 'Device deleted successfully.' };
    }
}

// Helper to sanitize enroll IDs (remove leading zeros or whitespace)
function employeeCodeClean(code) {
    if (typeof code !== 'string') return String(code);
    return code.trim();
}

// Helper to sanitize device serial string
function deviceIdString(serial) {
    if (typeof serial !== 'string') return 'BIOMETRIC_DEV';
    return serial.substring(0, 100);
}

module.exports = new MachineAttendanceService();
