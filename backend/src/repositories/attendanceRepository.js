const db = require('../config/db');

function toLocalYYYYMMDDHHmmss(dateVal) {
    if (!dateVal) return null;
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' }) + ' ' + d.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Kolkata', hour12: false });
}

function getISTHour(dateVal) {
    const d = new Date(dateVal);
    const istStr = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
    return parseInt(istStr, 10);
}

function getISTDate(dateVal) {
    const d = new Date(dateVal);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
}

class AttendanceRepository {
    async punchIn(employeeId, companyId, status = 'present', location = {}, ip = '') {
        // Prevent multiple punch-ins on the same day if one is already open
        const now = new Date();
        const hour = getISTHour(now);
        let logicalDateStr, nextLogicalDateStr;
        if (hour < 10) {
            const prev = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            logicalDateStr = getISTDate(prev);
            nextLogicalDateStr = getISTDate(now);
        } else {
            logicalDateStr = getISTDate(now);
            const next = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            nextLogicalDateStr = getISTDate(next);
        }

        let cutoffHour = 10;
        const activeAssignment = await db('employee_shift_assignments as esa')
            .join('shifts as s', 'esa.shift_id', 's.id')
            .where('esa.employee_id', employeeId)
            .where('esa.from_date', '<=', logicalDateStr)
            .andWhere(qb => {
                qb.where('esa.to_date', '>=', logicalDateStr).orWhereNull('esa.to_date');
            })
            .select('s.start_time', 's.session1_in_margin')
            // from_date desc, then id desc - ATTENDANCE_TROUBLESHOOTING.md's documented ordering.
            // id alone picks the most recently created row, not the one that covers this date.
            .orderBy('esa.from_date', 'desc')
            .orderBy('esa.id', 'desc')
            .first();
        
        const shift = activeAssignment || await db('employees as e')
            .leftJoin('shifts as s', 'e.shift_id', 's.id')
            .where('e.id', employeeId)
            .select('s.start_time', 's.session1_in_margin')
            .first();
        
        if (shift && shift.start_time) {
            const [sHours, sMins] = shift.start_time.split(':').map(Number);
            const shiftStartMins = sHours * 60 + sMins;
            const inMargin = shift.session1_in_margin !== undefined ? parseInt(shift.session1_in_margin) : 30;
            const earliestCheckInMins = shiftStartMins - inMargin;
            if (earliestCheckInMins < 600) { // 600 mins = 10:00 AM
                cutoffHour = Math.floor(Math.max(0, earliestCheckInMins) / 60);
            }
        }

        const existing = await db('attendance')
            .where({
                employee_id: employeeId,
                company_id: companyId,
                check_out: null
            })
            .andWhere(qb => {
                qb.where(qb1 => {
                    qb1.whereRaw('DATE(check_in) = ?', [logicalDateStr]).whereRaw('HOUR(check_in) >= ?', [cutoffHour]);
                }).orWhere(qb2 => {
                    qb2.whereRaw('DATE(check_in) = ?', [nextLogicalDateStr]).whereRaw('HOUR(check_in) < ?', [cutoffHour]);
                });
            })
            .first();

        if (existing) throw new Error('Already punched in today');

        const localNowStr = toLocalYYYYMMDDHHmmss(new Date());

        return await db('attendance').insert({
            employee_id: employeeId,
            company_id: companyId,
            check_in: localNowStr,
            status: status,
            latitude: location.latitude || null,
            longitude: location.longitude || null,
            accuracy: location.accuracy || null,
            punch_location: location.location || null,
            remarks: location.remarks || null
        });
    }

    async punchOut(employeeId, companyId, location = {}) {
        console.log('>>> DEBUG: punchOut called for emp:', employeeId);
        const entry = await db('attendance')
            .where({
                employee_id: employeeId,
                company_id: companyId,
                check_out: null
            })
            .orderBy('check_in', 'desc')
            .first();

        if (!entry) throw new Error('No active check-in found');

        const now = new Date();
        const checkIn = new Date(entry.check_in);
        const diffMs = now - checkIn;
        const workHours = (diffMs / (1000 * 60 * 60)).toFixed(2);

        const localNowStr = toLocalYYYYMMDDHHmmss(new Date());

        return await db('attendance')
            .where({ id: entry.id })
            .update({
                check_out: localNowStr,
                out_latitude: location.latitude || null,
                out_longitude: location.longitude || null,
                out_accuracy: location.accuracy || null,
                out_punch_location: location.location || null,
                out_remarks: location.remarks || null
            });
    }

    async getHistory(employeeId, companyId, month, year) {
        return await db('attendance')
            .where({ employee_id: employeeId, company_id: companyId })
            .whereRaw('MONTH(check_in) = ?', [month])
            .whereRaw('YEAR(check_in) = ?', [year])
            .orderBy('check_in', 'desc');
    }

    async getCurrentStatus(employeeId, companyId) {
        const active = await db('attendance')
            .where({ employee_id: employeeId, company_id: companyId, check_out: null })
            .whereRaw('DATE(check_in) = CURRENT_DATE')
            .first();

        const completed = await db('attendance')
            .where({ employee_id: employeeId, company_id: companyId })
            .whereNotNull('check_out')
            .whereRaw('DATE(check_in) = CURRENT_DATE');

        let accrued_ms = 0;
        completed.forEach(record => {
            if (record.check_in && record.check_out) {
                const inTime = new Date(record.check_in);
                const outTime = new Date(record.check_out);
                accrued_ms += (outTime - inTime);
            }
        });

        return {
            check_in: active ? active.check_in : null,
            id: active ? active.id : null,
            accrued_ms
        };
    }

    async getCompanyMatrix(user, month, year) {
        let employeeQuery = db('employees').where({ 'employees.company_id': user.company_id });

        if (user.role_name === 'manager') {
            employeeQuery = employeeQuery.where({ 'employees.manager_id': user.employee_id });
        } else if (user.role_name === 'employee') {
            employeeQuery = employeeQuery.where({ 'employees.id': user.employee_id });
        }

        const employees = await employeeQuery
            .leftJoin('shifts', 'employees.shift_id', 'shifts.id')
            .leftJoin('attendance_schemes', 'employees.attendance_scheme_id', 'attendance_schemes.id')
            .leftJoin('departments', 'employees.department_id', 'departments.id')
            .select(
                'employees.id',
                'employees.first_name',
                'employees.last_name',
                'employees.designation',
                'employees.employee_id_number',
                'employees.office_location',
                'departments.name as department_name',
                'shifts.name as shift_name',
                'shifts.start_time as shift_start',
                'shifts.end_time as shift_end',
                'shifts.grace_period as shift_grace',
                'shifts.is_flexi as shift_is_flexi',
                'shifts.total_punches_required as shift_total_punches',
                'shifts.session2_start_time as shift_session2_start',
                'shifts.session2_end_time as shift_session2_end',
                'shifts.session1_grace_out as shift_session1_grace_out',
                'shifts.session2_grace_in as shift_session2_grace_in',
                'shifts.session2_grace_out as shift_session2_grace_out',
                'shifts.session1_in_margin as shift_session1_in_margin',
                'shifts.session1_out_margin as shift_session1_out_margin',
                'shifts.session2_in_margin as shift_session2_in_margin',
                'shifts.session2_out_margin as shift_session2_out_margin',
                'attendance_schemes.grace_period as scheme_grace',
                'attendance_schemes.weekoffs as scheme_weekoffs',
                'shifts.terminate_hour as terminate_hour',
                'employees.joining_date',
                'employees.resignation_date'
            );
        const employeeIds = employees.map(e => e.id);

        // 2. Get attendance for these employees (include crossover logs from the 1st of next month)
        const attendance = await db('attendance')
            .whereIn('employee_id', employeeIds)
            .where(qb => {
                qb.whereRaw('MONTH(check_in) = ? AND YEAR(check_in) = ?', [month, year])
                  .orWhere(qb2 => {
                      const nextM = month === 12 ? 1 : month + 1;
                      const nextY = month === 12 ? year + 1 : year;
                      qb2.whereRaw('MONTH(check_in) = ? AND YEAR(check_in) = ? AND DAY(check_in) = 1 AND HOUR(check_in) < 10', [nextM, nextY]);
                  });
            })
            // logical_date, review_reason and shift_id are load-bearing for the muster, not
            // extras: getMatrix prefers the row's persisted logical_date over re-deriving the day
            // from check_in and judges the day by the row's pinned shift_id rather than by
            // whatever the roster says today, and it silently falls back to the old derivation
            // when a column is not projected here - so omitting one leaves the fix inert with no
            // error. This select list has already made one fix inert that way; do not trim it.
            .select('id', 'employee_id', 'check_in', 'check_out', 'status', 'punch_source', 'logical_date', 'review_reason', 'shift_id');

        // 3. Get leaves for these employees
        const leaves = await db('leaves as l')
            .join('leave_types as lt', 'l.leave_type_id', 'lt.id')
            .whereIn('l.employee_id', employeeIds)
            .where({ 'l.status': 'approved' })
            .whereRaw('(MONTH(l.start_date) = ? OR MONTH(l.end_date) = ?) AND (YEAR(l.start_date) = ? OR YEAR(l.end_date) = ?)', [month, month, year, year])
            .select('l.employee_id', 'l.start_date', 'l.end_date', 'l.days', 'l.leave_type_id', 'lt.name as leave_type_name');

        // 4. Get approved entry/exit requests for these employees (specifically early_out)
        const entryRequests = await db('attendance_entry_requests')
            .whereIn('employee_id', employeeIds)
            .where({ request_type: 'early_out', status: 'approved' })
            .whereRaw('MONTH(date) = ? AND YEAR(date) = ?', [month, year])
            .select('employee_id', 'date', 'request_type', 'status');

        // 5. Get approved regularizations for these employees
        const regularizations = await db('attendance_regularizations')
            .whereIn('employee_id', employeeIds)
            .where({ status: 'approved' })
            .whereRaw('MONTH(date) = ? AND YEAR(date) = ?', [month, year])
            .select('employee_id', 'date', 'status');

        return { employees, attendance, leaves, entryRequests, regularizations };
    }
}

module.exports = new AttendanceRepository();
