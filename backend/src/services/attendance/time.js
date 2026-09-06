/**
 * The datetime primitives the attendance path is written against. Pure: no database, no
 * knex, no clock. Every function here is a total function of its arguments.
 *
 * These lived in attendanceService.js. They moved out with dayResolver.js rather than being
 * duplicated, because two copies of dbDateToUTC() drifting apart is exactly the failure mode
 * this whole subsystem keeps producing. attendanceService.js imports them back under their
 * original names, so its ~100 existing call sites are unchanged.
 *
 * Why they exist at all: DB timestamps and the server timezone are not guaranteed to agree
 * with the logical (Asia/Kolkata) day boundaries every attendance rule is written against.
 * Production runs UTC. Raw `Date` arithmetic in this path is a bug.
 */

// Interpret a DB value as an instant, reading it as Asia/Kolkata wall-clock time.
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

// The IST calendar day an instant falls on. attendanceService calls this once per read request
// on a real `new Date()` and hands the result down - the service owns the clock read, this stays
// a function of its argument so the resolver can be driven from a fixed instant in a test.
function istDateStr(dateObj) {
    if (!dateObj) return null;
    return dateObj.toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
}

module.exports = {
    dbDateToUTC,
    toLocalYMD,
    toLocalYYYYMMDDHHmmss,
    resolveRequestPunchTime,
    dateToISTMins,
    safeFormatTime,
    istDateStr
};
