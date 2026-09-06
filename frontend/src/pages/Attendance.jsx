import React, { useState, useEffect } from 'react';
import AttendanceAdmin from '../components/attendance/AttendanceAdmin';
import { LogIn, LogOut, Clock, Calendar, CheckCircle, AlertCircle, MapPin, ChevronLeft, ChevronRight, Activity, Users as UsersIcon, ArrowRight } from 'lucide-react';
import api from '../utils/api';
import { exportToCSV } from '../utils/exportUtils';

const StatCard = ({ label, value, icon: Icon, color, bg }) => (
    <div className="bg-white p-5 md:p-6 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-4 transition-all hover:shadow-md">
        <div className={`p-3 rounded-xl ${color} ${bg}`}>
            <Icon size={18} md:size={20} />
        </div>
        <div>
            <p className="text-[9px] md:text-[10px] font-bold text-slate-400 uppercase tracking-widest leading-none mb-1">{label}</p>
            <p className="text-lg md:text-xl font-black text-slate-800 tracking-tight">{value}</p>
        </div>
    </div>
);

// /attendance/history returns the same resolved status LETTER the admin muster renders, decided
// once in the backend by services/attendance/dayResolver.js. It used to return attendance.status
// straight out of the database and this table printed the raw word, so an employee read `pending`
// or `late` as their own attendance while their manager's grid said E or L for the same day.
// Nothing here re-derives a status; this map is presentation only.
const STATUS_META = {
    P:   { label: 'Present',     badge: 'bg-emerald-50 text-emerald-600 border-emerald-100' },
    R:   { label: 'Regularized', badge: 'bg-emerald-50 text-emerald-600 border-emerald-100' },
    L:   { label: 'Late In',     badge: 'bg-amber-50 text-amber-600 border-amber-100' },
    E:   { label: 'Early Out',   badge: 'bg-amber-50 text-amber-600 border-amber-100' },
    HD:  { label: 'Half Day',    badge: 'bg-orange-50 text-orange-600 border-orange-100' },
    CI:  { label: 'Checked In',  badge: 'bg-indigo-50 text-indigo-600 border-indigo-100' },
    A:   { label: 'Absent',      badge: 'bg-rose-50 text-rose-600 border-rose-100' },
    OFF: { label: 'Week Off',    badge: 'bg-slate-50 text-slate-500 border-slate-200' },
    H:   { label: 'Holiday',     badge: 'bg-sky-50 text-sky-600 border-sky-100' },
    PL:  { label: 'Paid Leave',  badge: 'bg-violet-50 text-violet-600 border-violet-100' },
    UL:  { label: 'Unpaid Leave',badge: 'bg-violet-50 text-violet-600 border-violet-100' },
    // '-' is the backend saying "nothing to judge yet": a date that has not happened, or today
    // before its shift has run far enough past its end for a no-show to be settled. It must read
    // as blank, never as Absent.
    '-': { label: '\u2014',       badge: 'bg-slate-50 text-slate-300 border-slate-100' }
};
const statusMeta = (code) => STATUS_META[code] || { label: code || '\u2014', badge: 'bg-slate-50 text-slate-400 border-slate-100' };

// 'YYYY-MM-DD' rendered without going through Date(), which would shift the day in a browser
// west of UTC and print the wrong date against the right status.
const formatDayMonth = (dateStr) => {
    if (!dateStr) return '';
    const [y, m, d] = String(dateStr).split('-').map(Number);
    if (!y || !m || !d) return dateStr;
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, {
        day: '2-digit', month: 'short', timeZone: 'UTC'
    });
};

// The four counters above the table. Every one of them is a plain fact about the payload the
// backend already resolved - a letter count or a punch count - so nothing here can disagree with
// the muster or invent a payroll weight. They were hardcoded to 22 / 18 / 2 / 8.4h before, shown
// identically to every employee in the company.
const summarise = (days) => {
    const rows = Array.isArray(days) ? days : [];
    const worked = rows.filter(r => r.work_hours != null).map(r => parseFloat(r.work_hours));
    const totalHours = worked.reduce((a, b) => a + b, 0);
    return {
        workingDays: rows.filter(r => !['OFF', 'H', '-'].includes(r.status)).length,
        attended: rows.filter(r => r.check_in).length,
        late: rows.filter(r => r.status === 'L').length,
        avgHours: worked.length ? `${(totalHours / worked.length).toFixed(1)}h` : '—'
    };
};



const Attendance = () => {
    const [viewMode, setViewMode] = useState('self'); // 'self' or 'team'
    const [role] = useState(localStorage.getItem('user_role') || 'employee');
    const [status, setStatus] = useState({ check_in: null });
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(true);
    const [timer, setTimer] = useState("00:00:00");

    const [currentMonth, setCurrentMonth] = useState(new Date().getMonth()); // 0-11
    const [currentYear, setCurrentYear] = useState(new Date().getFullYear());

    const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    const summary = summarise(history);

    useEffect(() => {
        fetchInitialData(currentMonth, currentYear);
    }, [currentMonth, currentYear]);

    const fetchInitialData = async (m = currentMonth, y = currentYear) => {
        setLoading(true);
        try {
            const [statusRes, historyRes] = await Promise.all([
                api.get('/attendance/status'),
                api.get(`/attendance/history?month=${m + 1}&year=${y}`)
            ]);
            setStatus(statusRes || { check_in: null });
            setHistory(historyRes || []);
        } catch (err) {
            console.error('Failed to load attendance data', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        let interval;
        const accrued = status.accrued_ms || 0;
        
        const formatTime = (ms) => {
            const hrs = String(Math.floor(ms / 3600000)).padStart(2, '0');
            const mins = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
            const secs = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
            return `${hrs}:${mins}:${secs}`;
        };

        if (status.check_in) {
            interval = setInterval(() => {
                const start = new Date(status.check_in);
                const now = new Date();
                const diff = (now - start) + accrued;
                setTimer(formatTime(diff));
            }, 1000);
        } else {
            setTimer(formatTime(accrued));
        }
        return () => clearInterval(interval);
    }, [status.check_in, status.accrued_ms]);

    const handleAction = async () => {
        setLoading(true);
        try {
            if (!status.check_in) {
                const res = await api.post('/attendance/check-in');
                setStatus(res.record);
            } else {
                await api.post('/attendance/check-out');
                setStatus({ check_in: null });
                fetchInitialData(currentMonth, currentYear);
            }
        } catch (err) {
            alert(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handlePrevMonth = () => {
        setCurrentMonth(prev => {
            if (prev === 0) {
                setCurrentYear(y => y - 1);
                return 11;
            }
            return prev - 1;
        });
    };

    const handleNextMonth = () => {
        setCurrentMonth(prev => {
            if (prev === 11) {
                setCurrentYear(y => y + 1);
                return 0;
            }
            return prev + 1;
        });
    };

    const handleExport = () => {
        if (!history || history.length === 0) {
            alert('No data available to export.');
            return;
        }
        // Every day of the month is a row now, including the ones with no punch, so nothing here
        // may assume item.check_in exists.
        const dataToExport = history.map((item, index) => ({
            "S.No.": index + 1,
            "Date": item.date,
            "Day": item.day_name || '',
            "Status": statusMeta(item.status).label,
            "Shift": item.shift_code || '',
            "Check-In": item.in_time || '',
            "Check-Out": item.out_time || '',
            "Work Hours": item.work_hours ? `${item.work_hours} hrs` : ''
        }));
        exportToCSV(dataToExport, `Attendance_Report_${monthNames[currentMonth]}_${currentYear}.csv`);
    };

    return (
        <div className="p-4 md:p-8 space-y-6 md:space-y-8 animate-in fade-in duration-700 font-outfit">
            <header className="flex flex-col md:flex-row justify-between items-center md:items-center gap-6 text-center md:text-left">
                <div>
                    <h1 className="text-2xl md:text-3xl font-black text-slate-800 tracking-tight">Attendance Tracking</h1>
                    <p className="text-slate-500 text-xs md:text-sm mt-1">Manage your daily presence and work hours.</p>
                </div>

                <div className="flex flex-col sm:flex-row items-center gap-4 w-full md:w-auto">
                    <div className="bg-slate-100 p-1 rounded-full flex items-center shadow-inner w-full sm:w-auto">
                        <button
                            onClick={() => setViewMode('self')}
                            className={`flex-1 sm:flex-none px-4 md:px-6 py-1.5 rounded-full text-[10px] md:text-xs font-bold transition-all flex items-center justify-center gap-2 ${viewMode === 'self' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'
                                }`}
                        >
                            <Clock size={12} /> My Days
                        </button>
                        {(role === 'company_admin' || role === 'manager' || role === 'super_admin') && (
                            <button
                                onClick={() => setViewMode('team')}
                                className={`flex-1 sm:flex-none px-4 md:px-6 py-1.5 rounded-full text-[10px] md:text-xs font-bold transition-all flex items-center justify-center gap-2 ${viewMode === 'team' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'
                                    }`}
                            >
                                <UsersIcon size={12} /> Team Attendance
                            </button>
                        )}
                    </div>

                    <div className="flex items-center gap-2 bg-white p-1.5 rounded-2xl border border-slate-100 shadow-sm w-full sm:w-auto justify-between">
                        <button onClick={handlePrevMonth} className="p-1.5 hover:bg-slate-50 rounded-xl transition-colors"><ChevronLeft size={16} /></button>
                        <span className="text-xs md:text-sm font-bold text-slate-700 px-2 md:px-4 uppercase tracking-widest italic">{monthNames[currentMonth]} {currentYear}</span>
                        <button onClick={handleNextMonth} className="p-1.5 hover:bg-slate-50 rounded-xl transition-colors"><ChevronRight size={16} /></button>
                    </div>
                </div>
            </header>

            {viewMode === 'self' ? (
                <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
                        <StatCard label="Working Days" value={summary.workingDays} icon={Calendar} color="text-indigo-600" bg="bg-indigo-50" />
                        <StatCard label="Days Attended" value={summary.attended} icon={CheckCircle} color="text-emerald-600" bg="bg-emerald-50" />
                        <StatCard label="Late Entries" value={summary.late} icon={Clock} color="text-orange-600" bg="bg-orange-50" />
                        <StatCard label="Work Hours Avg" value={summary.avgHours} icon={Activity} color="text-rose-600" bg="bg-rose-50" />
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 md:gap-8">
                        {/* Punch Card Section */}
                        <div className="lg:col-span-4 space-y-6">
                            <div className="bg-white rounded-[32px] md:rounded-3xl border border-slate-100 shadow-lg p-6 md:p-8 text-center relative overflow-hidden group">
                                <div className="absolute top-0 left-0 w-full h-1.5 bg-indigo-600" />

                                <div className={`mx-auto w-16 h-16 md:w-20 md:h-20 rounded-full flex items-center justify-center mb-6 transition-all duration-500 ${status.check_in ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                                    {status.check_in ? <Activity size={28} className="animate-pulse" /> : <Clock size={28} />}
                                </div>

                                <h2 className="text-3xl md:text-4xl font-black text-slate-800 tracking-tighter mb-2">{timer}</h2>
                                <p className="text-[10px] md:text-xs font-bold text-slate-400 uppercase tracking-widest mb-8">
                                    {status.check_in ? `Working since ${new Date(status.check_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Ready to start your day?'}
                                </p>

                                {role !== 'employee' ? (
                                    <button
                                        onClick={handleAction}
                                        disabled={loading}
                                        className={`w-full py-3.5 md:py-4 rounded-2xl font-black text-xs md:text-sm uppercase tracking-widest transition-all shadow-md active:scale-95 flex items-center justify-center gap-3 ${status.check_in
                                                ? 'bg-rose-500 hover:bg-rose-600 text-white shadow-rose-200'
                                                : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-200'
                                            }`}
                                    >
                                        {loading ? (
                                            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                        ) : (
                                            status.check_in ? <><LogOut size={16} /> Check Out</> : <><LogIn size={16} /> Check In</>
                                        )}
                                    </button>
                                ) : (
                                    <div className="bg-slate-50 border border-slate-200/50 rounded-2xl py-3 px-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">
                                        Check-in managed via Biometric/Auto System
                                    </div>
                                )}

                                <div className="mt-8 pt-8 border-t border-slate-50 flex flex-wrap items-center justify-center gap-4 text-slate-400">
                                    <div className="flex items-center gap-1.5">
                                        <MapPin size={12} />
                                        <span className="text-[9px] font-bold">Office HQ</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <Activity size={12} />
                                        <span className="text-[9px] font-bold">Secured</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* History Section */}
                        <div className="lg:col-span-8 space-y-6">
                            <div className="bg-white rounded-[32px] border border-slate-100 shadow-sm overflow-hidden">
                                <div className="p-5 md:p-6 border-b border-slate-50 flex items-center justify-between bg-slate-50/20">
                                    <h3 className="text-xs md:text-sm font-black text-slate-800 flex items-center gap-2 uppercase tracking-wide">
                                        <Calendar size={16} className="text-indigo-600" />
                                        {monthNames[currentMonth]} Log Records
                                    </h3>
                                    <button onClick={handleExport} className="text-[9px] font-black text-indigo-600 uppercase tracking-widest hover:text-indigo-800 bg-indigo-50 px-3 py-1.5 rounded-lg border border-indigo-100">Export</button>
                                </div>

                                <div className="overflow-x-auto">
                                    <table className="w-full text-left">
                                        <thead className="bg-slate-50/50">
                                            <tr>
                                                <th className="px-5 md:px-6 py-4 text-[9px] font-black text-slate-400 uppercase tracking-widest italic">Date</th>
                                                <th className="px-5 md:px-6 py-4 text-[9px] font-black text-slate-400 uppercase tracking-widest italic">Status</th>
                                                <th className="px-5 md:px-6 py-4 text-[9px] font-black text-slate-400 uppercase tracking-widest italic">Time Log</th>
                                                <th className="px-5 md:px-6 py-4 text-[9px] font-black text-slate-400 uppercase tracking-widest italic text-right">Hrs</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-50">
                                            {history.map(item => {
                                                const meta = statusMeta(item.status);
                                                const isBlank = item.status === '-';
                                                return (
                                                    <tr key={item.date} className={`group hover:bg-slate-50 transition-colors ${isBlank ? 'opacity-50' : ''}`}>
                                                        <td className="px-5 md:px-6 py-4">
                                                            <p className="text-xs font-bold text-slate-700 leading-none mb-1">{formatDayMonth(item.date)}</p>
                                                            <p className="text-[9px] text-slate-400 font-bold uppercase tracking-tighter opacity-70">{item.day_name}</p>
                                                        </td>
                                                        <td className="px-5 md:px-6 py-4">
                                                            <span className={`px-2.5 py-1 rounded-full text-[8px] font-black uppercase tracking-widest border transition-colors ${meta.badge}`}>
                                                                {meta.label}
                                                            </span>
                                                        </td>
                                                        <td className="px-5 md:px-6 py-4 text-[10px] md:text-xs font-bold text-slate-600">
                                                            {item.in_time ? (
                                                                <>
                                                                    <span className="text-indigo-500">{item.in_time}</span>
                                                                    <span className="mx-1 text-slate-300">→</span>
                                                                    <span className="text-slate-500">{item.out_time || '--:--'}</span>
                                                                </>
                                                            ) : (
                                                                <span className="text-slate-300">—</span>
                                                            )}
                                                        </td>
                                                        <td className="px-5 md:px-6 py-4 text-xs font-black text-slate-800 text-right italic">
                                                            {item.work_hours ? `${item.work_hours}H` : <span className="text-slate-300">—</span>}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </>
            ) : (
                <AttendanceAdmin />
            )}
        </div>
    );
};

export default Attendance;
