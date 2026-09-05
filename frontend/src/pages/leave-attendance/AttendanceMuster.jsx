import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { 
    Calendar, Users, Clock, Search, Filter, Download, 
    ArrowRight, UserCheck, AlertCircle, ChevronDown, 
    ChevronLeft, ChevronRight, FileText, CheckCircle, 
    XCircle, HelpCircle, Star, MapPin, Info, RefreshCw
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../../utils/api';
import { exportToCSV } from '../../utils/exportUtils';

const formatPunchTime = (punchTimeVal) => {
    if (!punchTimeVal) return '';
    try {
        let dateObj;
        if (punchTimeVal instanceof Date) {
            dateObj = punchTimeVal;
        } else {
            let str = String(punchTimeVal).trim();
            if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(str)) {
                str = str.replace(' ', 'T');
            }
            dateObj = new Date(str);
        }

        if (isNaN(dateObj.getTime())) return punchTimeVal;

        return dateObj.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        }).replace(/\s+/g, '');
    } catch (e) {
        return punchTimeVal;
    }
};

const formatTimeAMPM = (timeStr) => {
    if (!timeStr) return '';
    if (timeStr.toLowerCase().includes('am') || timeStr.toLowerCase().includes('pm')) return timeStr;
    const parts = timeStr.split(':');
    if (parts.length < 2) return timeStr;
    let hours = parseInt(parts[0], 10);
    const minutes = parts[1];
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    const strHours = hours < 10 ? `0${hours}` : hours;
    return `${strHours}:${minutes} ${ampm}`;
};

// Entry/Exit exception request types. Keep this the single source of truth so a new
// request_type degrades to a readable fallback instead of silently reading "Early Out".
const REQUEST_TYPE_META = {
    late_in: { label: 'Late In', title: 'Late In Request', pill: 'bg-rose-50 text-rose-600' },
    early_out: { label: 'Early Out', title: 'Early Out Request', pill: 'bg-amber-50 text-amber-600' },
    missing_in: { label: 'Missing Check-In', title: 'Missing Check-In Request', pill: 'bg-indigo-50 text-indigo-600' }
};

const getRequestTypeMeta = (type) => {
    if (type && REQUEST_TYPE_META[type]) return REQUEST_TYPE_META[type];
    const fallback = String(type || 'exception').replace(/_/g, ' ');
    return { label: fallback, title: `${fallback} Request`, pill: 'bg-slate-100 text-slate-600' };
};

// Why a recorded punch pair still needs a human look before it is treated as fact.
const REVIEW_REASON_META = {
    checkout_window_unpaired: {
        caption: 'Check-in missing - punch direction not confirmed',
        message: 'Only one punch reached us for this day, and it landed in the check-out window. It could be a late arrival, or it could be the punch out with the check-in never delivered. Confirm the real arrival time before treating this as the check-in.'
    },
    early_before_in_margin: {
        caption: 'Punched before the allowed check-in window',
        message: 'This punch arrived earlier than the shift allows for a check-in. It has been recorded as-is, so check it against the roster before treating it as the arrival time.'
    },
    closed_after_termination: {
        caption: 'Day closed by a late-arriving punch',
        message: 'This day was closed by a punch that came in after the shift cut-off hour. The check-out time shown may not be when the employee actually left.'
    }
};

const getReviewReasonMeta = (reason) => REVIEW_REASON_META[reason] || {
    caption: 'Flagged for review',
    message: 'This punch pair was flagged for review. Confirm the times before treating them as final.'
};

// A lone punch in the check-out window: the shown time may be the punch OUT, not the arrival.
// Keyed off REVIEW_REASON_META so the reason string is written once on this side of the wire.
const UNPAIRED_PUNCH_REASON = 'checkout_window_unpaired';
const isUnpairedPunch = (row) => row?.review_reason === UNPAIRED_PUNCH_REASON;

// Shown next to the punch time itself, where the caption alone is too far away to stop
// someone reading "Punch In 05:00 pm" as established fact. Both punch cards use it; their
// surrounding chrome differs enough (sizes, the Info button) that sharing a component would
// cost more than it saves, but this sentence must not be allowed to drift between them.
const UNPAIRED_PUNCH_HINT = 'Not confirmed as the arrival - this may be the punch out.';

const ReviewReasonNotice = ({ reason }) => {
    if (!reason) return null;
    const meta = getReviewReasonMeta(reason);
    return (
        <div className="bg-amber-50/30 border border-amber-100 p-3 rounded-xl flex gap-2 items-start">
            <AlertCircle size={12} className="text-amber-500 mt-0.5 shrink-0" />
            <div className="leading-relaxed">
                <span className="text-[8px] font-black text-amber-600 uppercase tracking-widest block">{meta.caption}</span>
                <p className="text-[9.5px] font-bold text-slate-600 mt-1">{meta.message}</p>
            </div>
        </div>
    );
};

// Normalizes a shift start time ("09:00:00", "9:00 AM") into an <input type="time"> value.
const toTimeInputValue = (timeVal) => {
    if (!timeVal) return '';
    const str = String(timeVal).trim();
    const match = str.match(/(\d{1,2}):(\d{2})/);
    if (!match) return '';
    let hours = parseInt(match[1], 10);
    if (isNaN(hours)) return '';
    if (/pm/i.test(str) && hours < 12) hours += 12;
    if (/am/i.test(str) && hours === 12) hours = 0;
    if (hours > 23) return '';
    return `${String(hours).padStart(2, '0')}:${match[2]}`;
};

const AttendanceMuster = () => {
    const [searchParams] = useSearchParams();
    const initialTab = searchParams.get('tab') === 'entry_requests' ? 'entry_requests' : 'muster';
    const [activeTab, setActiveTab] = useState(initialTab); // 'muster' or 'entry_requests'
    const [showRules, setShowRules] = useState(false);

    // Also sync the tab if searchParams change while component is mounted
    useEffect(() => {
        const tab = searchParams.get('tab');
        if (tab === 'entry_requests') {
            setActiveTab('entry_requests');
        } else if (tab === 'muster') {
            setActiveTab('muster');
        }
    }, [searchParams]);
    const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth() + 1); // 1-12
    const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedOutlet, setSelectedOutlet] = useState('all');
    const [selectedDept, setSelectedDept] = useState('all');
    const [selectedDesignation, setSelectedDesignation] = useState('all');
    const [selectedShift, setSelectedShift] = useState('all');
    const [matrix, setMatrix] = useState([]);
    const [totalDays, setTotalDays] = useState(30);
    const [loading, setLoading] = useState(true);
    const [selectedEmployee, setSelectedEmployee] = useState(null);
    const [selectedCell, setSelectedCell] = useState(null);
    const [modalData, setModalData] = useState(null);

    // Derived once: the markup below tests it four times across two punch cards.
    const attendanceUnpaired = isUnpairedPunch(modalData?.attendance);
    const [punchHistoryOpen, setPunchHistoryOpen] = useState(false);
    const [modalLoading, setModalLoading] = useState(false);
    const [modalError, setModalError] = useState(null);

    // Entry/Exit Exception Requests States
    const [entryRequests, setEntryRequests] = useState([]);
    const [entryHistory, setEntryHistory] = useState([]);
    const [requestsTab, setRequestsTab] = useState('pending'); // 'pending' or 'history'
    const [notCheckedIn, setNotCheckedIn] = useState([]);
    const [requestsLoading, setRequestsLoading] = useState(false);
    const [approvingId, setApprovingId] = useState(null);
    const [preApprovingId, setPreApprovingId] = useState(null);
    const [approvalModalRequest, setApprovalModalRequest] = useState(null);
    const [arrivalTime, setArrivalTime] = useState('');
    const [approvalError, setApprovalError] = useState(null);

    // Reset (and pre-fill) the approval modal inputs whenever a different request is opened
    useEffect(() => {
        setApprovalError(null);
        if (!approvalModalRequest || approvalModalRequest.request_type !== 'missing_in') {
            setArrivalTime('');
            return;
        }
        setArrivalTime(toTimeInputValue(
            approvalModalRequest.shift_start_time || approvalModalRequest.shift_start || approvalModalRequest.start_time
        ));
    }, [approvalModalRequest]);

    const handleCellClick = async (emp, day) => {
        const formattedDate = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        setSelectedCell({
            employee: emp,
            date: formattedDate,
            day,
            status: emp.days[day] || '-'
        });
        setModalLoading(true);
        setModalError(null);
        setModalData(null);
        try {
            const data = await api.get(`/attendance/day-detail?employee_id=${emp.id}&date=${formattedDate}`);
            setModalData(data);
        } catch (err) {
            console.error('Failed to load cell details:', err);
            setModalError(err.message || 'Failed to fetch details');
        } finally {
            setModalLoading(false);
        }
    };

    const months = [
        { name: 'January', val: 1 }, { name: 'February', val: 2 }, { name: 'March', val: 3 },
        { name: 'April', val: 4 }, { name: 'May', val: 5 }, { name: 'June', val: 6 },
        { name: 'July', val: 7 }, { name: 'August', val: 8 }, { name: 'September', val: 9 },
        { name: 'October', val: 10 }, { name: 'November', val: 11 }, { name: 'December', val: 12 }
    ];

    const currentYear = new Date().getFullYear();
    const years = Array.from({ length: 11 }, (_, i) => currentYear - 5 + i);

    useEffect(() => {
        fetchMatrix();
    }, [selectedMonth, selectedYear]);

    const fetchMatrix = async () => {
        try {
            setLoading(true);
            const res = await api.get(`/attendance/matrix?month=${selectedMonth}&year=${selectedYear}`);
            setMatrix(res.matrix || []);
            setTotalDays(res.days || 30);
        } catch (err) {
            console.error('Failed to load attendance muster matrix:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (activeTab === 'entry_requests') {
            fetchEntryRequests();
        }
    }, [activeTab]);

    const fetchEntryRequests = async () => {
        try {
            setRequestsLoading(true);
            const [reqs, hist, notChecked] = await Promise.all([
                api.get('/attendance/entry-requests?status=pending'),
                api.get('/attendance/entry-requests?status=history'),
                api.get('/attendance/entry-requests/not-checked-in')
            ]);
            setEntryRequests(reqs || []);
            setEntryHistory(hist || []);
            setNotCheckedIn(notChecked || []);
        } catch (err) {
            console.error('Failed to fetch entry/exit requests', err);
        } finally {
            setRequestsLoading(false);
        }
    };

    const handleRequestAction = async (id, status, attendanceStatus = 'present', arrivalTimeValue = null) => {
        try {
            setApprovingId(id);
            setApprovalError(null);
            const payload = { status, attendance_status: attendanceStatus };
            // Only sent for missing_in approvals - late_in / early_out post exactly as before
            if (arrivalTimeValue) payload.arrival_time = arrivalTimeValue;
            await api.post(`/attendance/entry-requests/${id}/status`, payload);
            await fetchEntryRequests();
            setApprovalModalRequest(null);
        } catch (err) {
            const message = err.response?.data?.message || err.message || 'Could not update this request.';
            if (approvalModalRequest && approvalModalRequest.id === id) {
                setApprovalError(message);
            } else {
                alert(message);
            }
        } finally {
            setApprovingId(null);
        }
    };

    const handlePreApprove = async (employeeId, type) => {
        try {
            setPreApprovingId(employeeId);
            const today = new Date().toISOString().split('T')[0];
            await api.post('/attendance/entry-requests/pre-approve', {
                employee_id: employeeId,
                type,
                date: today
            });
            await fetchEntryRequests();
            alert(`Pre-approved ${getRequestTypeMeta(type).label} for today!`);
        } catch (err) {
            alert(err.response?.data?.message || err.message);
        } finally {
            setPreApprovingId(null);
        }
    };

    const handleExport = () => {
        if (!filteredEmployees || filteredEmployees.length === 0) {
            alert('No Attendance Muster data to export.');
            return;
        }

        const dataToExport = filteredEmployees.map(emp => {
            const row = {
                employee_code: emp.code,
                name: emp.name,
                role: emp.role,
                location: emp.location
            };
            for (let d = 1; d <= totalDays; d++) {
                const dayStatus = emp.days[d] || '-';
                const dayTimings = emp.timings?.[d] || {};
                
                const formatCSVTime = (dateTimeStr) => {
                    if (!dateTimeStr) return '';
                    try {
                        const dateObj = new Date(dateTimeStr);
                        if (isNaN(dateObj.getTime())) return '';
                        return dateObj.toLocaleTimeString('en-US', {
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: true
                        }).replace(/\s+/g, '');
                    } catch (e) {
                        return '';
                    }
                };

                row[`day_${d}_status`] = dayStatus;
                row[`day_${d}_in1`] = formatCSVTime(dayTimings.in1);
                row[`day_${d}_out1`] = formatCSVTime(dayTimings.out1);
                row[`day_${d}_in2`] = formatCSVTime(dayTimings.in2);
                row[`day_${d}_out2`] = formatCSVTime(dayTimings.out2);
            }
            row.total_present = emp.stats?.P || 0;
            row.total_late = emp.stats?.L || 0;
            row.total_absent = emp.stats?.A || 0;
            row.total_off = emp.stats?.OFF || 0;
            return row;
        });

        const headers = {
            employee_code: 'Employee ID',
            name: 'Name',
            role: 'Role',
            location: 'Location'
        };
        for (let d = 1; d <= totalDays; d++) {
            headers[`day_${d}_status`] = `Day ${d} Status`;
            headers[`day_${d}_in1`] = `Day ${d} In 1`;
            headers[`day_${d}_out1`] = `Day ${d} Out 1`;
            headers[`day_${d}_in2`] = `Day ${d} In 2`;
            headers[`day_${d}_out2`] = `Day ${d} Out 2`;
        }
        headers.total_present = 'Total Present (P)';
        headers.total_late = 'Total Late (L)';
        headers.total_absent = 'Total Absent (A)';
        headers.total_off = 'Total Off (OFF)';

        exportToCSV(dataToExport, `Attendance_Muster_${selectedMonth}_${selectedYear}.csv`, headers);
    };

    const getDayInitial = (day) => {
        const date = new Date(selectedYear, selectedMonth - 1, day);
        return date.toLocaleDateString('en-US', { weekday: 'short' })[0];
    };

    const getDayName = (day) => {
        const date = new Date(selectedYear, selectedMonth - 1, day);
        return date.toLocaleDateString('en-US', { weekday: 'short' });
    };

    const isDayWeekend = (day) => {
        const date = new Date(selectedYear, selectedMonth - 1, day);
        const dayOfWeek = date.getDay();
        return dayOfWeek === 0 || dayOfWeek === 6; // Sunday or Saturday
    };

    // Helper to perform normalized alphanumeric comparisons for search filters (handles spacing like "F & B" vs "F&B", "Floor   Manager" vs "Floor Manager")
    const matchText = (val, filterVal) => {
        if (!filterVal || filterVal.toLowerCase() === 'all') return true;
        if (!val) return false;
        const clean = (str) => String(str).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        return clean(val) === clean(filterVal);
    };

    // Helper to format string to Title Case/capitalize
    const formatLabel = (str) => {
        if (!str) return '';
        const trimmed = str.trim();
        if (!trimmed) return '';
        return trimmed.split(' ').map(word => {
            if (!word) return '';
            if (word.includes('/')) {
                return word.split('/').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('/');
            }
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        }).join(' ');
    };

    // Unique outlets, departments, designations list
    const uniqueOutlets = React.useMemo(() => {
        const map = new Map();
        matrix.forEach(emp => {
            const val = emp.location;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        entryRequests.forEach(req => {
            const val = req.office_location;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        entryHistory.forEach(req => {
            const val = req.office_location;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        notCheckedIn.forEach(emp => {
            const val = emp.office_location;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [matrix, entryRequests, entryHistory, notCheckedIn]);

    const uniqueDepts = React.useMemo(() => {
        const map = new Map();
        matrix.forEach(emp => {
            const val = emp.department_name || emp.department;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        entryRequests.forEach(req => {
            const val = req.department_name || req.department;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        entryHistory.forEach(req => {
            const val = req.department_name || req.department;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        notCheckedIn.forEach(emp => {
            const val = emp.department_name || emp.department;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [matrix, entryRequests, entryHistory, notCheckedIn]);

    const uniqueDesignations = React.useMemo(() => {
        const map = new Map();
        matrix.forEach(emp => {
            const val = emp.role || emp.designation;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        entryRequests.forEach(req => {
            const val = req.designation || req.role;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        entryHistory.forEach(req => {
            const val = req.designation || req.role;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        notCheckedIn.forEach(emp => {
            const val = emp.designation || emp.role;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [matrix, entryRequests, entryHistory, notCheckedIn]);

    const uniqueShifts = React.useMemo(() => {
        const map = new Map();
        matrix.forEach(emp => {
            const val = emp.shift_name;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        notCheckedIn.forEach(emp => {
            const val = emp.shift_name;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [matrix, notCheckedIn]);

    // Filter employees
    const filteredEmployees = React.useMemo(() => {
        return matrix.filter(emp => {
            const matchesQuery = (emp.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                                 (emp.code && emp.code.toLowerCase().includes(searchQuery.toLowerCase()));
            const matchesOutlet = matchText(emp.location, selectedOutlet);
            const matchesDept = matchText(emp.department_name || emp.department, selectedDept);
            const matchesDesignation = matchText(emp.role || emp.designation, selectedDesignation);
            const matchesShift = matchText(emp.shift_name, selectedShift);
            return matchesQuery && matchesOutlet && matchesDept && matchesDesignation && matchesShift;
        });
    }, [matrix, searchQuery, selectedOutlet, selectedDept, selectedDesignation, selectedShift]);

    // Filter entry requests, history, and not checked-in today lists
    const filteredEntryRequests = React.useMemo(() => {
        return entryRequests.filter(req => {
            const name = `${req.first_name || ''} ${req.last_name || ''}`;
            const matchesQuery = name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                                 (req.employee_id_number && String(req.employee_id_number).toLowerCase().includes(searchQuery.toLowerCase())) ||
                                 (req.employee_code && String(req.employee_code).toLowerCase().includes(searchQuery.toLowerCase()));
            const matchesOutlet = matchText(req.office_location, selectedOutlet);
            const matchesDept = matchText(req.department_name || req.department, selectedDept);
            const matchesDesignation = matchText(req.designation || req.role, selectedDesignation);
            const matchesShift = !req.shift_name || matchText(req.shift_name, selectedShift);
            return matchesQuery && matchesOutlet && matchesDept && matchesDesignation && matchesShift;
        });
    }, [entryRequests, searchQuery, selectedOutlet, selectedDept, selectedDesignation, selectedShift]);

    const filteredEntryHistory = React.useMemo(() => {
        return entryHistory.filter(req => {
            const name = `${req.first_name || ''} ${req.last_name || ''}`;
            const matchesQuery = name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                                 (req.employee_id_number && String(req.employee_id_number).toLowerCase().includes(searchQuery.toLowerCase())) ||
                                 (req.employee_code && String(req.employee_code).toLowerCase().includes(searchQuery.toLowerCase()));
            const matchesOutlet = matchText(req.office_location, selectedOutlet);
            const matchesDept = matchText(req.department_name || req.department, selectedDept);
            const matchesDesignation = matchText(req.designation || req.role, selectedDesignation);
            const matchesShift = !req.shift_name || matchText(req.shift_name, selectedShift);
            return matchesQuery && matchesOutlet && matchesDept && matchesDesignation && matchesShift;
        });
    }, [entryHistory, searchQuery, selectedOutlet, selectedDept, selectedDesignation, selectedShift]);

    const filteredNotCheckedIn = React.useMemo(() => {
        return notCheckedIn.filter(emp => {
            const name = `${emp.first_name || ''} ${emp.last_name || ''}`;
            const matchesQuery = name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                                 (emp.employee_id_number && String(emp.employee_id_number).toLowerCase().includes(searchQuery.toLowerCase()));
            const matchesOutlet = matchText(emp.office_location, selectedOutlet);
            const matchesDept = matchText(emp.department_name || emp.department, selectedDept);
            const matchesDesignation = matchText(emp.designation || emp.role, selectedDesignation);
            const matchesShift = matchText(emp.shift_name, selectedShift);
            return matchesQuery && matchesOutlet && matchesDept && matchesDesignation && matchesShift;
        });
    }, [notCheckedIn, searchQuery, selectedOutlet, selectedDept, selectedDesignation, selectedShift]);

    // Grid Cell Styling configuration
    const getStatusStyle = (status) => {
        switch (status) {
            case 'P':
                return 'bg-emerald-50 text-emerald-600 border border-emerald-200/60 font-black';
            case 'L':
                return 'bg-amber-50 text-amber-600 border border-amber-200/60 font-black';
            case 'A':
                return 'bg-rose-50 text-rose-600 border border-rose-200/60 font-black';
            case 'OFF':
                return 'bg-slate-100 text-slate-400 border border-slate-200/50 font-normal';
            case 'H':
                return 'bg-sky-50 text-sky-600 border border-sky-200/60 font-black';
            case 'PL':
                return 'bg-violet-50 text-violet-600 border border-violet-200/60 font-bold';
            case 'UL':
                return 'bg-fuchsia-50 text-fuchsia-600 border border-fuchsia-200/60 font-bold';
            case 'E':
                return 'bg-orange-50 text-orange-600 border border-orange-200/60 font-black';
            case 'R':
                return 'bg-teal-50 text-teal-600 border border-teal-200/60 font-black';
            case 'HD':
                return 'bg-cyan-50 text-cyan-600 border border-cyan-200/60 font-black';
            case 'NC':
                return 'bg-rose-100 text-rose-700 border border-rose-300 font-extrabold shadow-sm animate-pulse';
            case 'CI':
                return 'bg-blue-50 text-blue-600 border border-blue-200/60 font-black animate-pulse';
            default:
                return 'bg-transparent text-slate-300 font-normal border border-transparent';
        }
    };

    const getFullStatusName = (status) => {
        switch (status) {
            case 'P': return 'Present';
            case 'L': return 'Late Check-In';
            case 'A': return 'Absent';
            case 'OFF': return 'Weekly Off';
            case 'H': return 'Gazetted Holiday';
            case 'PL': return 'Paid Leave';
            case 'UL': return 'Unpaid Leave';
            case 'E': return 'Early Out';
            case 'R': return 'Regularized';
            case 'HD': return 'Half Day';
            case 'NC': return 'Checkout Attempt (Zero Check-In)';
            case 'CI': return 'Checked In (Active)';
            default: return 'No Data';
        }
    };

    // Summary stats for filtered group
    const totalHeadcount = matrix.length;
    const avgPresentRate = totalHeadcount > 0 
        ? (matrix.reduce((acc, emp) => acc + (emp.stats.P || 0) + (emp.stats.L || 0), 0) / (totalHeadcount * totalDays) * 100).toFixed(1)
        : '0.0';

    const avgLateCount = totalHeadcount > 0
        ? (matrix.reduce((acc, emp) => acc + (emp.stats.L || 0), 0) / totalHeadcount).toFixed(1)
        : '0.0';

    // A missing_in approval cannot be posted until the manager states the real arrival time
    const isMissingInApproval = approvalModalRequest?.request_type === 'missing_in';
    const approvalActionsBlocked = isMissingInApproval && !arrivalTime;

    return (
        <div className="space-y-6 max-w-[1700px] mx-auto animate-in fade-in duration-500 pb-10 px-2">
            {/* --- HEADER BANNER --- */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white border border-slate-200/40 p-5 rounded-2xl shadow-sm">
                <div className="space-y-1.5 max-w-xl">
                    <h1 className="text-xl md:text-2xl font-black text-slate-900 tracking-tight flex items-center gap-2">
                        Attendance Muster
                        <span className="text-[9px] font-black tracking-widest text-emerald-600 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-100 uppercase">Live</span>
                        <button 
                            onClick={() => setShowRules(!showRules)}
                            className={`p-1.5 rounded-lg border transition-all ${
                                showRules 
                                    ? 'bg-[#4361ee] border-[#4361ee] text-white shadow-md shadow-indigo-100 scale-105' 
                                    : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600 hover:border-slate-300'
                            }`}
                            title="Show Rules"
                        >
                            <HelpCircle size={14} className={showRules ? 'animate-pulse' : ''} />
                        </button>
                    </h1>
                    <p className="text-slate-500 text-xs mt-0.5">High-density visual grid listing day-by-day attendance, status checks, and monthly stats.</p>
                </div>

                {/* Tab Switcher */}
                <div className="flex bg-slate-100 p-1 rounded-xl shadow-inner border border-slate-200/40 shrink-0">
                    <button
                        onClick={() => setActiveTab('muster')}
                        className={`px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${
                            activeTab === 'muster'
                                ? 'bg-white text-[#4361ee] shadow-sm'
                                : 'text-slate-550 hover:text-slate-800'
                        }`}
                    >
                        Muster Grid
                    </button>
                    <button
                        onClick={() => setActiveTab('entry_requests')}
                        className={`px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${
                            activeTab === 'entry_requests'
                                ? 'bg-white text-[#4361ee] shadow-sm'
                                : 'text-slate-550 hover:text-slate-800'
                        }`}
                    >
                        Entry/Exit Approvals
                    </button>
                </div>
            </div>

            {/* --- FILTERS ROW --- */}
            {activeTab === 'muster' && (
                <div className="bg-white border border-slate-200/40 p-4 rounded-2xl shadow-sm flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-3">
                        {/* Month selector */}
                        <div className="relative">
                            <select 
                                value={selectedMonth} 
                                onChange={(e) => setSelectedMonth(Number(e.target.value))}
                                className="appearance-none bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-xl px-4 py-2 text-xs font-black text-slate-700 outline-none pr-10 shadow-inner cursor-pointer"
                            >
                                {months.map(m => (
                                    <option key={m.val} value={m.val}>{m.name}</option>
                                ))}
                            </select>
                            <ChevronDown size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        </div>

                        {/* Year Selector */}
                        <div className="relative">
                            <select 
                                value={selectedYear} 
                                onChange={(e) => setSelectedYear(Number(e.target.value))}
                                className="appearance-none bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-xl px-4 py-2 text-xs font-black text-slate-700 outline-none pr-10 shadow-inner cursor-pointer"
                            >
                                {years.map(y => (
                                    <option key={y} value={y}>{y}</option>
                                ))}
                            </select>
                            <ChevronDown size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        </div>

                        {/* Outlet Selector */}
                        <div className="relative">
                            <select 
                                value={selectedOutlet} 
                                onChange={(e) => setSelectedOutlet(e.target.value)}
                                className="appearance-none bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-xl px-4 py-2 text-xs font-black text-slate-700 outline-none pr-10 shadow-inner cursor-pointer"
                            >
                                <option value="all">All Outlets</option>
                                {uniqueOutlets.filter(o => o !== 'all').map(o => (
                                    <option key={o} value={o}>{o}</option>
                                ))}
                            </select>
                            <ChevronDown size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        </div>

                        {/* Department Selector */}
                        <div className="relative">
                            <select 
                                value={selectedDept} 
                                onChange={(e) => setSelectedDept(e.target.value)}
                                className="appearance-none bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-xl px-4 py-2 text-xs font-black text-slate-700 outline-none pr-10 shadow-inner cursor-pointer"
                            >
                                <option value="all">All Departments</option>
                                {uniqueDepts.filter(d => d !== 'all').map(d => (
                                    <option key={d} value={d}>{d}</option>
                                ))}
                            </select>
                            <ChevronDown size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        </div>

                        {/* Designation Selector */}
                        <div className="relative">
                            <select 
                                value={selectedDesignation} 
                                onChange={(e) => setSelectedDesignation(e.target.value)}
                                className="appearance-none bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-xl px-4 py-2 text-xs font-black text-slate-700 outline-none pr-10 shadow-inner cursor-pointer"
                            >
                                <option value="all">All Designations</option>
                                {uniqueDesignations.filter(d => d !== 'all').map(d => (
                                    <option key={d} value={d}>{d}</option>
                                ))}
                            </select>
                            <ChevronDown size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        </div>

                        {/* Shift Selector */}
                        <div className="relative">
                            <select 
                                value={selectedShift} 
                                onChange={(e) => setSelectedShift(e.target.value)}
                                className="appearance-none bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-xl px-4 py-2 text-xs font-black text-slate-700 outline-none pr-10 shadow-inner cursor-pointer"
                            >
                                <option value="all">All Shifts</option>
                                {uniqueShifts.filter(s => s !== 'all').map(s => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </select>
                            <ChevronDown size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <button 
                            onClick={fetchMatrix}
                            title="Refresh muster data"
                            className="flex items-center gap-2 bg-slate-50 hover:bg-slate-100 text-slate-600 border border-slate-200 rounded-xl px-3 py-2 text-xs font-black transition-all active:scale-95 shadow-sm"
                        >
                            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                            <span>Refresh</span>
                        </button>
                        <button 
                            onClick={handleExport}
                            className="flex items-center gap-2 bg-indigo-50 hover:bg-indigo-100/80 text-[#4361ee] border border-indigo-100 rounded-xl px-4 py-2 text-xs font-black transition-all active:scale-95 shadow-sm"
                        >
                            <Download size={14} />
                            <span>Export Grid</span>
                        </button>
                    </div>
                </div>
            )}

            {activeTab === 'muster' && (
                <>
                    {/* --- QUICK ANALYTICS ROW --- */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        <div className="bg-white border border-slate-200/50 p-4.5 rounded-2xl shadow-sm flex items-center gap-4">
                            <div className="w-11 h-11 rounded-xl bg-indigo-50 flex items-center justify-center text-[#4361ee]">
                                <Users size={18} strokeWidth={2.5} />
                            </div>
                            <div>
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Total Headcount</span>
                                <h4 className="text-lg font-black text-slate-800 mt-0.5">{totalHeadcount} Enrolled</h4>
                            </div>
                        </div>

                        <div className="bg-white border border-slate-200/50 p-4.5 rounded-2xl shadow-sm flex items-center gap-4">
                            <div className="w-11 h-11 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600">
                                <UserCheck size={18} strokeWidth={2.5} />
                            </div>
                            <div>
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Avg Present Rate</span>
                                <h4 className="text-lg font-black text-slate-800 mt-0.5">{avgPresentRate}%</h4>
                            </div>
                        </div>

                        <div className="bg-white border border-slate-200/50 p-4.5 rounded-2xl shadow-sm flex items-center gap-4">
                            <div className="w-11 h-11 rounded-xl bg-amber-50 flex items-center justify-center text-amber-600">
                                <Clock size={18} strokeWidth={2.5} />
                            </div>
                            <div>
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Avg Late arrivals</span>
                                <h4 className="text-lg font-black text-slate-800 mt-0.5">{avgLateCount} times/emp</h4>
                            </div>
                        </div>

                        <div className="bg-white border border-slate-200/50 p-4.5 rounded-2xl shadow-sm flex items-center gap-4">
                            <div className="w-11 h-11 rounded-xl bg-sky-50 flex items-center justify-center text-sky-600">
                                <Calendar size={18} strokeWidth={2.5} />
                            </div>
                            <div>
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Period Range</span>
                                <h4 className="text-md font-black text-slate-800 mt-0.5">{months[selectedMonth - 1].name} {selectedYear}</h4>
                            </div>
                        </div>
                    </div>

                    {/* --- SEARCH BAR AND STATUS LEGEND --- */}
                    <div className="bg-white border border-slate-200/40 p-4 rounded-2xl shadow-sm space-y-4">
                        <div className="flex flex-col xl:flex-row gap-4 items-center justify-between">
                            {/* Search field */}
                            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 w-full xl:w-56 shrink-0 shadow-inner">
                                <Search size={13} className="text-slate-400" />
                                <input 
                                    type="text" 
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder="Search name or ID..."
                                    className="bg-transparent border-none text-[11px] font-bold text-slate-700 outline-none w-full"
                                />
                            </div>

                            {/* Status Color Legend */}
                            <div className="flex flex-wrap gap-1.5 items-center justify-center xl:justify-end w-full">
                                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest mr-1">Legend:</span>
                                {[
                                    { label: 'P (Present)', style: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
                                    { label: 'L (Late)', style: 'bg-amber-50 text-amber-600 border-amber-200' },
                                    { label: 'E (Early Out)', style: 'bg-orange-50 text-orange-600 border-orange-200' },
                                    { label: 'R (Regularized)', style: 'bg-teal-50 text-teal-600 border-teal-200' },
                                    { label: 'HD (Half Day)', style: 'bg-cyan-50 text-cyan-600 border-cyan-200' },
                                    { label: 'CI (Checked In)', style: 'bg-blue-50 text-blue-600 border-blue-200 animate-pulse' },
                                    { label: 'A (Absent)', style: 'bg-rose-50 text-rose-600 border-rose-200' },
                                    { label: 'OFF (Weekly Off)', style: 'bg-slate-100 text-slate-400 border-slate-200' },
                                    { label: 'H (Holiday)', style: 'bg-sky-50 text-sky-600 border-sky-200' },
                                    { label: 'PL (Paid Leave)', style: 'bg-violet-50 text-violet-600 border-violet-200' },
                                    { label: 'UL (Unpaid Leave)', style: 'bg-fuchsia-50 text-fuchsia-600 border-fuchsia-200' },
                                ].map((item, i) => (
                                    <div key={i} className={`px-2 py-0.5 rounded-lg border text-[8.5px] font-extrabold tracking-tight ${item.style}`}>
                                        {item.label}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Rules Notes Card */}
                        <AnimatePresence>
                            {showRules && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0, y: -10 }}
                                    animate={{ opacity: 1, height: 'auto', y: 0 }}
                                    exit={{ opacity: 0, height: 0, y: -10 }}
                                    transition={{ duration: 0.2 }}
                                    className="overflow-hidden"
                                >
                                    <div className="bg-indigo-50/30 border border-indigo-100 rounded-xl p-4 flex flex-col md:flex-row gap-4 items-start justify-between text-xs text-slate-600">
                                        <div className="space-y-1.5">
                                            <div className="flex items-center gap-1.5 text-indigo-700 font-extrabold uppercase tracking-wide text-[10px]">
                                                <HelpCircle size={14} className="text-indigo-600" />
                                                Muster Calculations & Attendance Flow
                                            </div>
                                            <ul className="list-disc pl-4 space-y-1 text-slate-500 font-bold text-[11px] leading-relaxed">
                                                <li><strong className="text-slate-700">P (Present):</strong> Working hours meet/exceed full shift hours.</li>
                                                <li><strong className="text-slate-700">HD (Half Day):</strong> Working hours equal to or more than Half Day config, but less than Full Day.</li>
                                                <li><strong className="text-slate-700">A (Absent):</strong> Working hours are below the Half Day limit. Early checkouts prior to completing half-day hours do not generate early-out requests.</li>
                                                <li><strong className="text-slate-700">Direct vs Request:</strong> Punching on-time directly marks present. Late punch-ins or early departures (after half-day hours) will show status <strong className="text-[#4361ee] bg-indigo-50 px-1 rounded">L</strong> / <strong className="text-orange-600 bg-orange-50 px-1 rounded">E</strong> and generate regularization requests in "Entry/Exit Approvals".</li>
                                                <li><strong className="text-slate-700">Special Indicators:</strong> Cells with a <strong className="text-[#4361ee]">Blue Folded Corner</strong> represent manual overrides. Cells with an <strong className="text-amber-500">Amber Dot</strong> represent grace periods applied.</li>
                                            </ul>
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    {/* --- MAIN MATRIX GRID SHEET --- */}
                    <div className="bg-white border border-slate-200/50 rounded-2xl shadow-sm overflow-hidden relative">
                        
                        {loading ? (
                            <div className="flex flex-col items-center justify-center min-h-[350px] p-8">
                                <div className="w-12 h-12 bg-indigo-50 rounded-2xl flex items-center justify-center text-[#4361ee] mb-4">
                                    <Clock size={24} className="animate-spin" />
                                </div>
                                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">Loading attendance sheet...</p>
                            </div>
                        ) : filteredEmployees.length === 0 ? (
                            <div className="flex flex-col items-center justify-center min-h-[350px] p-8 text-center">
                                <div className="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-400 mb-4 border border-slate-100">
                                    <AlertCircle size={22} />
                                </div>
                                <h4 className="text-sm font-black text-slate-800 uppercase tracking-tight">No Employees Found</h4>
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mt-1">Try relaxing your search query rules or selecting another month.</p>
                            </div>
                        ) : (
                            <div className="overflow-x-auto custom-scrollbar select-none">
                                <table className="w-full border-collapse text-left table-fixed">
                                    
                                    {/* Header grid */}
                                    <thead>
                                        <tr className="bg-slate-50/50 border-b border-slate-200/80">
                                            {/* Sticky employee header */}
                                            <th className="sticky left-0 bg-slate-50 border-r border-slate-200/80 p-3 text-[9px] font-black text-slate-400 uppercase tracking-widest shadow-[4px_0_8px_-4px_rgba(0,0,0,0.05)] z-20 w-[240px] min-w-[240px]">
                                                Employee Details
                                            </th>
                                            
                                            {/* Days Headers */}
                                            {Array.from({ length: totalDays }).map((_, i) => {
                                                const day = i + 1;
                                                const isWeekend = isDayWeekend(day);
                                                return (
                                                    <th 
                                                        key={day} 
                                                        className={`border-r border-slate-200/60 p-1.5 text-center w-9 min-w-9 select-none ${
                                                            isWeekend ? 'bg-slate-100/50' : 'bg-transparent'
                                                        }`}
                                                    >
                                                        <div className={`text-[7.5px] font-black uppercase tracking-tighter leading-none ${isWeekend ? 'text-rose-500' : 'text-slate-400'}`}>
                                                            {getDayInitial(day)}
                                                        </div>
                                                        <div className={`text-[10px] font-black mt-1 leading-none ${isWeekend ? 'text-rose-600' : 'text-slate-700'}`}>
                                                            {day < 10 ? `0${day}` : day}
                                                        </div>
                                                    </th>
                                                );
                                            })}

                                            {/* Aggregation Summary Headers */}
                                            <th className="border-r border-slate-200 p-2 text-center w-10 text-[9px] font-black text-emerald-600 uppercase tracking-tight">P</th>
                                            <th className="border-r border-slate-200 p-2 text-center w-10 text-[9px] font-black text-amber-600 uppercase tracking-tight">L</th>
                                            <th className="border-r border-slate-200 p-2 text-center w-10 text-[9px] font-black text-rose-600 uppercase tracking-tight">A</th>
                                            <th className="p-2 text-center w-10 text-[9px] font-black text-indigo-600 uppercase tracking-tight">OFF</th>
                                        </tr>
                                    </thead>

                                    {/* Body matrix rows */}
                                    <tbody className="divide-y divide-slate-200/70">
                                        {filteredEmployees.map((emp) => (
                                            <tr 
                                                key={emp.id} 
                                                onClick={() => setSelectedEmployee(emp)}
                                                className="hover:bg-slate-50/40 transition-colors cursor-pointer group"
                                            >
                                                
                                                {/* Sticky details cell */}
                                                <td className="sticky left-0 bg-white group-hover:bg-slate-50/90 border-r border-slate-200/80 p-3 flex items-center gap-3 shadow-[4px_0_8px_-4px_rgba(0,0,0,0.05)] z-10 w-[240px] min-w-[240px]">
                                                    <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200/60 flex items-center justify-center text-[10px] font-black text-slate-600 uppercase">
                                                        {emp.name.split(' ').map(n => n[0]).join('')}
                                                    </div>
                                                    <div className="overflow-hidden leading-tight">
                                                        <h5 className="text-[10.5px] font-black text-slate-800 group-hover:text-indigo-600 transition-colors truncate">
                                                            {emp.name}
                                                        </h5>
                                                        <p className="text-[8px] font-bold text-slate-400 mt-0.5 flex items-center gap-1.5 truncate">
                                                            <span>{emp.code || 'EMP-TEMP'}</span>
                                                            <span className="w-1 h-1 bg-slate-200 rounded-full" />
                                                            <span>{emp.role || 'Designation'}</span>
                                                        </p>
                                                    </div>
                                                </td>

                                                {/* Attendance Status Cells */}
                                                {Array.from({ length: totalDays }).map((_, i) => {
                                                    const day = i + 1;
                                                    const status = emp.days[day] || '-';
                                                    const isWeekend = isDayWeekend(day);
                                                    return (
                                                        <td 
                                                            key={day}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleCellClick(emp, day);
                                                            }}
                                                            className={`border-r border-slate-200/50 p-0.5 text-center align-middle w-9 min-w-9 cursor-pointer hover:bg-slate-50 transition-colors relative ${
                                                                isWeekend ? 'bg-slate-50/20' : 'bg-transparent'
                                                            }`}
                                                        >
                                                            <div className={`w-6.5 h-6.5 mx-auto rounded-full flex items-center justify-center text-[9px] transition-all hover:scale-110 border shadow-sm ${getStatusStyle(status)}`}>
                                                                {status}
                                                            </div>
                                                            {emp.meta?.[day]?.is_override && (
                                                                <div 
                                                                    className="absolute top-0 right-0 w-0 h-0 border-t-[6px] border-t-indigo-600 border-l-[6px] border-l-transparent" 
                                                                    title="Manual Override"
                                                                />
                                                            )}
                                                            {emp.meta?.[day]?.is_grace && (
                                                                <div 
                                                                    className="absolute bottom-0.5 right-0.5 w-1.5 h-1.5 bg-amber-500 rounded-full" 
                                                                    title="Grace Period Applied"
                                                                />
                                                            )}
                                                        </td>
                                                    );
                                                })}

                                                {/* Counters side logs */}
                                                <td className="border-r border-slate-200/60 p-1.5 text-center font-black text-[10px] text-emerald-600 w-10 bg-emerald-50/5">
                                                    {emp.stats.P || 0}
                                                </td>
                                                <td className="border-r border-slate-200/60 p-1.5 text-center font-black text-[10px] text-amber-600 w-10 bg-amber-50/5">
                                                    {emp.stats.L || 0}
                                                </td>
                                                <td className="border-r border-slate-200/60 p-1.5 text-center font-black text-[10px] text-rose-600 w-10 bg-rose-50/5">
                                                    {emp.stats.A || 0}
                                                </td>
                                                <td className="p-1.5 text-center font-black text-[10px] text-slate-500 w-10 bg-slate-50/20">
                                                    {emp.stats.OFF || 0}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>

                                </table>
                            </div>
                        )}
                    </div>
                </>
            )}

            {activeTab === 'entry_requests' && (
                <div className="space-y-6">
                    {/* --- FILTERS ROW FOR ENTRY REQUESTS --- */}
                    <div className="bg-white border border-slate-200/40 p-4 rounded-2xl shadow-sm flex flex-wrap items-center justify-between gap-4">
                        <div className="flex flex-wrap items-center gap-3">
                            {/* Search field */}
                            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 w-full xl:w-56 shrink-0 shadow-inner">
                                <Search size={13} className="text-slate-400" />
                                <input 
                                    type="text" 
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder="Search name or ID..."
                                    className="bg-transparent border-none text-[11px] font-bold text-slate-700 outline-none w-full"
                                />
                            </div>

                            {/* Outlet Selector */}
                            <div className="relative">
                                <select 
                                    value={selectedOutlet} 
                                    onChange={(e) => setSelectedOutlet(e.target.value)}
                                    className="appearance-none bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-xl px-4 py-2 text-xs font-black text-slate-700 outline-none pr-10 shadow-inner cursor-pointer"
                                >
                                    <option value="all">All Outlets</option>
                                    {uniqueOutlets.filter(o => o !== 'all').map(o => (
                                        <option key={o} value={o}>{o}</option>
                                    ))}
                                </select>
                                <ChevronDown size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                            </div>

                            {/* Department Selector */}
                            <div className="relative">
                                <select 
                                    value={selectedDept} 
                                    onChange={(e) => setSelectedDept(e.target.value)}
                                    className="appearance-none bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-xl px-4 py-2 text-xs font-black text-slate-700 outline-none pr-10 shadow-inner cursor-pointer"
                                >
                                    <option value="all">All Departments</option>
                                    {uniqueDepts.filter(d => d !== 'all').map(d => (
                                        <option key={d} value={d}>{d}</option>
                                    ))}
                                </select>
                                <ChevronDown size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                            </div>

                            {/* Designation Selector */}
                            <div className="relative">
                                <select 
                                    value={selectedDesignation} 
                                    onChange={(e) => setSelectedDesignation(e.target.value)}
                                    className="appearance-none bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-xl px-4 py-2 text-xs font-black text-slate-700 outline-none pr-10 shadow-inner cursor-pointer"
                                >
                                    <option value="all">All Designations</option>
                                    {uniqueDesignations.filter(d => d !== 'all').map(d => (
                                        <option key={d} value={d}>{d}</option>
                                    ))}
                                </select>
                                <ChevronDown size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                            </div>

                            {/* Shift Selector */}
                            <div className="relative">
                                <select 
                                    value={selectedShift} 
                                    onChange={(e) => setSelectedShift(e.target.value)}
                                    className="appearance-none bg-slate-50 border border-slate-200 hover:border-slate-300 rounded-xl px-4 py-2 text-xs font-black text-slate-700 outline-none pr-10 shadow-inner cursor-pointer"
                                >
                                    <option value="all">All Shifts</option>
                                    {uniqueShifts.filter(s => s !== 'all').map(s => (
                                        <option key={s} value={s}>{s}</option>
                                    ))}
                                </select>
                                <ChevronDown size={14} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                            </div>
                        </div>
                    </div>

                    {/* Entry/Exit Exception Requests & Pre-approvals Columns Grid */}
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start animate-in slide-in-from-bottom-4 duration-500">
                        {/* Pending Requests Column */}
                        <div className="lg:col-span-7">
                            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm flex flex-col h-[600px] overflow-hidden">
                                <div className="p-2 border-b border-slate-50 flex items-center justify-between bg-slate-50/50">
                                    <div className="flex gap-1">
                                        <button
                                            onClick={() => setRequestsTab('pending')}
                                            className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all cursor-pointer ${
                                                requestsTab === 'pending'
                                                    ? 'bg-white text-slate-900 shadow-sm border border-slate-100'
                                                    : 'text-slate-400 hover:text-slate-600'
                                            }`}
                                        >
                                            Pending ({filteredEntryRequests.length})
                                        </button>
                                        <button
                                            onClick={() => setRequestsTab('history')}
                                            className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all cursor-pointer ${
                                                requestsTab === 'history'
                                                    ? 'bg-white text-slate-900 shadow-sm border border-slate-100'
                                                    : 'text-slate-400 hover:text-slate-600'
                                            }`}
                                        >
                                            History ({filteredEntryHistory.length})
                                        </button>
                                    </div>
                                </div>
                                <div className="flex-1 overflow-y-auto custom-scrollbar">
                                    {requestsLoading ? (
                                        <div className="flex flex-col items-center justify-center h-full gap-2">
                                            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Loading Requests...</p>
                                        </div>
                                    ) : requestsTab === 'pending' ? (
                                        filteredEntryRequests.length === 0 ? (
                                            <div className="flex flex-col items-center justify-center h-full opacity-40 p-6 text-center">
                                                <CheckCircle size={32} className="text-emerald-500 mb-2" />
                                                <p className="text-[10px] font-black uppercase tracking-widest">All Clear</p>
                                                <p className="text-[9px] font-bold text-slate-400 mt-1">No pending attendance exceptions found.</p>
                                            </div>
                                        ) : (
                                            <div className="divide-y divide-slate-50">
                                                {filteredEntryRequests.map((req) => (
                                                    <div key={req.id} className="p-4 flex justify-between items-start hover:bg-slate-50/50 transition-all animate-in fade-in duration-300">
                                                        <div className="space-y-1">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-[10px] font-black text-slate-700 uppercase">{req.first_name} {req.last_name}</span>
                                                            </div>
                                                            <div className="text-[8px] font-bold text-slate-450 uppercase flex items-center gap-1.5 flex-wrap">
                                                                <span>#{req.employee_id_number || req.employee_code || 'N/A'}</span>
                                                                {req.office_location && (
                                                                    <>
                                                                        <span className="w-1 h-1 bg-slate-300 rounded-full" />
                                                                        <span>{req.office_location}</span>
                                                                    </>
                                                                )}
                                                                {req.department_name && (
                                                                    <>
                                                                        <span className="w-1 h-1 bg-slate-300 rounded-full" />
                                                                        <span>{req.department_name}</span>
                                                                    </>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-1.5 flex-wrap pt-1">
                                                                <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-tighter ${getRequestTypeMeta(req.request_type).pill}`}>
                                                                    {getRequestTypeMeta(req.request_type).label}
                                                                </span>
                                                                <span className="text-[9px] font-bold text-slate-400 uppercase">
                                                                    Date: {req.date ? new Date(req.date).toLocaleDateString() : 'N/A'}
                                                                </span>
                                                                {req.punch_time && (
                                                                    <span className="text-[9px] font-bold text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">
                                                                        Time: {formatPunchTime(req.punch_time)}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-2">
                                                            <button
                                                                onClick={() => { setApprovalError(null); setApprovalModalRequest(req); }}
                                                                disabled={approvingId === req.id}
                                                                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[9px] font-black uppercase tracking-widest transition-all shadow-sm shadow-emerald-100 disabled:opacity-50 cursor-pointer animate-in fade-in duration-150"
                                                            >
                                                                Approve
                                                            </button>
                                                            <button
                                                                onClick={() => handleRequestAction(req.id, 'rejected')}
                                                                disabled={approvingId === req.id}
                                                                className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[9px] font-black uppercase tracking-widest transition-all shadow-sm shadow-rose-100 disabled:opacity-50 cursor-pointer animate-in fade-in duration-150"
                                                            >
                                                                Reject
                                                            </button>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )
                                    ) : (
                                        filteredEntryHistory.length === 0 ? (
                                            <div className="flex flex-col items-center justify-center h-full opacity-40 p-6 text-center">
                                                <Clock size={32} className="text-slate-400 mb-2" />
                                                <p className="text-[10px] font-black uppercase tracking-widest">No History</p>
                                                <p className="text-[9px] font-bold text-slate-400 mt-1">No processed exception requests found.</p>
                                            </div>
                                        ) : (
                                            <div className="divide-y divide-slate-50">
                                                {filteredEntryHistory.map((req) => (
                                                    <div key={req.id} className="p-4 flex justify-between items-start hover:bg-slate-50/50 transition-all animate-in fade-in duration-300">
                                                        <div className="space-y-1">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-[10px] font-black text-slate-700 uppercase">{req.first_name} {req.last_name}</span>
                                                            </div>
                                                            <div className="text-[8px] font-bold text-slate-450 uppercase flex items-center gap-1.5 flex-wrap">
                                                                <span>#{req.employee_id_number || req.employee_code || 'N/A'}</span>
                                                                {req.office_location && (
                                                                    <>
                                                                        <span className="w-1 h-1 bg-slate-300 rounded-full" />
                                                                        <span>{req.office_location}</span>
                                                                    </>
                                                                )}
                                                                {req.department_name && (
                                                                    <>
                                                                        <span className="w-1 h-1 bg-slate-300 rounded-full" />
                                                                        <span>{req.department_name}</span>
                                                                    </>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-1.5 flex-wrap pt-1">
                                                                <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-tighter ${getRequestTypeMeta(req.request_type).pill}`}>
                                                                    {getRequestTypeMeta(req.request_type).label}
                                                                </span>
                                                                <span className="text-[9px] font-bold text-slate-400 uppercase">
                                                                    Date: {req.date ? new Date(req.date).toLocaleDateString() : 'N/A'}
                                                                </span>
                                                            </div>
                                                        </div>
                                                        <div>
                                                            <span className={`inline-flex px-3 py-1 rounded-full text-[8px] font-black uppercase tracking-widest ${
                                                                req.status === 'approved'
                                                                    ? 'bg-emerald-50 text-emerald-600 border border-emerald-100'
                                                                    : 'bg-rose-50 text-rose-600 border border-rose-100'
                                                            }`}>
                                                                {req.status}
                                                            </span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Today's Not Checked-In Column */}
                        <div className="lg:col-span-5">
                            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm flex flex-col h-[600px] overflow-hidden">
                                <div className="p-4 border-b border-slate-50 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <Clock size={14} className="text-slate-700" />
                                        <h3 className="text-[10px] font-black text-slate-800 uppercase tracking-widest">Not Checked-In Today</h3>
                                    </div>
                                    <span className="inline-flex px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-tighter bg-slate-100 text-slate-500">
                                        {filteredNotCheckedIn.length} Left
                                    </span>
                                </div>
                                <div className="flex-1 overflow-y-auto custom-scrollbar">
                                    {requestsLoading ? (
                                        <div className="flex flex-col items-center justify-center h-full gap-2">
                                            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                                            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Loading List...</p>
                                        </div>
                                    ) : filteredNotCheckedIn.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center h-full opacity-40 p-6 text-center">
                                            <Users size={32} className="text-slate-400 mb-2" />
                                            <p className="text-[10px] font-black uppercase tracking-widest">No Employees Left</p>
                                            <p className="text-[9px] font-bold text-slate-400 mt-1">Everyone has checked in or has a pre-approval.</p>
                                        </div>
                                    ) : (
                                        <div className="divide-y divide-slate-50">
                                            {filteredNotCheckedIn.map((emp) => (
                                                <div key={emp.id} className="p-3.5 flex justify-between items-center hover:bg-slate-50/50 transition-all">
                                                    <div>
                                                        <p className="text-[10px] font-black text-slate-700 uppercase">{emp.first_name} {emp.last_name}</p>
                                                        <p className="text-[8px] font-bold text-slate-400 uppercase flex items-center gap-1.5 flex-wrap mt-0.5">
                                                            <span>#{emp.employee_id_number || emp.employee_code || 'N/A'}</span>
                                                            {emp.office_location && (
                                                                <>
                                                                    <span className="w-1 h-1 bg-slate-300 rounded-full" />
                                                                    <span>{emp.office_location}</span>
                                                                </>
                                                            )}
                                                            {emp.shift_name && (
                                                                <>
                                                                    <span className="w-1 h-1 bg-slate-300 rounded-full" />
                                                                    <span>{emp.shift_name}</span>
                                                                </>
                                                            )}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-1.5">
                                                        <button
                                                            onClick={() => handlePreApprove(emp.id, 'late_in')}
                                                            disabled={preApprovingId === emp.id}
                                                            className="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-[8px] font-black uppercase tracking-wider transition-all disabled:opacity-50 cursor-pointer"
                                                            title="Pre-approve late punch-in for today"
                                                        >
                                                            Pre-Approve Late
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* --- DAILY CELL DETAIL MODAL --- */}
            <AnimatePresence>
                {selectedCell && (
                    <div className="fixed inset-0 z-50 overflow-hidden flex items-center justify-center p-4">
                        {/* Background Overlay */}
                        <motion.div 
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 0.4 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setSelectedCell(null)}
                            className="absolute inset-0 bg-slate-950/80 backdrop-blur-xs"
                        />

                        {/* Modal Box */}
                        <motion.div 
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            transition={{ type: 'spring', damping: 25, stiffness: 220 }}
                            className="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-slate-100/80 z-10 flex flex-col overflow-hidden max-h-[85vh]"
                        >
                            {/* Modal Header */}
                            <div className="p-6 border-b border-slate-50 flex justify-between items-start bg-slate-50/20">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-2xl bg-indigo-50 border border-indigo-100/50 flex items-center justify-center text-xs font-black text-[#4361ee] uppercase">
                                        {selectedCell.employee.name.split(' ').map(n => n[0]).join('')}
                                    </div>
                                    <div>
                                        <h3 className="text-xs font-black text-slate-800 uppercase tracking-wide leading-tight">{selectedCell.employee.name}</h3>
                                        <p className="text-[9px] font-bold text-slate-400 uppercase mt-0.5">{selectedCell.employee.code} • {selectedCell.employee.role}</p>
                                    </div>
                                </div>
                                <button 
                                    onClick={() => setSelectedCell(null)}
                                    className="p-1.5 hover:bg-slate-100 rounded-xl text-slate-400 transition-colors"
                                >
                                    ✕
                                </button>
                            </div>

                            {/* Modal Content Body */}
                            <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
                                {/* Date and Status Badge */}
                                <div className="flex items-center justify-between bg-slate-50/60 p-4 rounded-2xl border border-slate-100">
                                    <div className="leading-tight">
                                        <span className="text-[10px] font-black text-slate-400 block uppercase tracking-widest">Date Selected</span>
                                        <span className="text-xs font-black text-slate-800 uppercase tracking-tight mt-1 block">
                                            {new Date(selectedCell.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                                        </span>
                                    </div>
                                    <span className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wider border shadow-xs ${getStatusStyle(selectedCell.status)}`}>
                                        {getFullStatusName(selectedCell.status)}
                                    </span>
                                </div>

                                {modalLoading ? (
                                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                                        <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Retrieving diagnostics...</p>
                                    </div>
                                ) : modalError ? (
                                    <div className="p-4 bg-rose-50 border border-rose-100 rounded-2xl flex items-center gap-3 text-rose-700">
                                        <AlertCircle size={18} />
                                        <span className="text-xs font-bold">{modalError}</span>
                                    </div>
                                ) : modalData ? (
                                    <div className="space-y-6">
                                        
                                        {/* 1. Target Shift Details */}
                                        <div className="space-y-2">
                                            <h4 className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Scheduled Protocol</h4>
                                            <div className="border border-slate-150 p-4 rounded-2xl bg-white flex justify-between items-center shadow-xs">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-8 h-8 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-500">
                                                        <Clock size={15} />
                                                    </div>
                                                    <div>
                                                        <span className="text-[10px] font-black text-slate-700 uppercase">{modalData.active_shift?.name || 'General Shift'}</span>
                                                        <p className="text-[9.5px] font-bold text-slate-400 uppercase mt-0.5">Start: {modalData.active_shift?.start_time || '09:00'} • End: {modalData.active_shift?.end_time || '18:00'}</p>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        {/* 2. Check-In & Check-Out Timings */}
                                        {modalData.attendance_logs && modalData.attendance_logs.length > 0 && modalData.active_shift?.total_punches_required === 4 ? (
                                            <div className="space-y-4">
                                                {/* Split Shift Status Overview */}
                                                <div className="bg-indigo-50/20 border border-indigo-100 p-4 rounded-2xl space-y-3">
                                                    <h5 className="text-[10px] font-black text-indigo-600 uppercase tracking-widest">Split Shift Session Details</h5>
                                                    <div className="grid grid-cols-2 gap-3">
                                                        {/* Session 1 */}
                                                        <div className="bg-white border border-slate-150 p-3 rounded-xl space-y-1">
                                                             <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Session 1</span>
                                                             <div className="text-[11px] font-black text-slate-800">
                                                                 {modalData.active_shift.start_time} - {modalData.active_shift.end_time}
                                                             </div>
                                                             <div className="text-[9px] font-bold text-slate-505">
                                                                 Grace: In +{modalData.active_shift.grace_period}m / Out -{modalData.active_shift.session1_grace_out}m
                                                             </div>
                                                             <div className={`text-[10px] font-black uppercase tracking-wider mt-1.5 ${
                                                                 modalData.split_shift_details?.session1_status === 'Present' ? 'text-emerald-600' :
                                                                 modalData.split_shift_details?.session1_status === 'Late' ? 'text-amber-500' : 'text-rose-500'
                                                             }`}>
                                                                 Status: {modalData.split_shift_details?.session1_status || 'Absent'}
                                                             </div>
                                                        </div>

                                                        {/* Session 2 */}
                                                        <div className="bg-white border border-slate-150 p-3 rounded-xl space-y-1">
                                                             <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Session 2</span>
                                                             <div className="text-[11px] font-black text-slate-800">
                                                                 {modalData.active_shift.session2_start_time || 'N/A'} - {modalData.active_shift.session2_end_time || 'N/A'}
                                                             </div>
                                                             <div className="text-[9px] font-bold text-slate-505">
                                                                 Grace: In +{modalData.active_shift.session2_grace_in}m / Out -{modalData.active_shift.session2_grace_out}m
                                                             </div>
                                                             <div className={`text-[10px] font-black uppercase tracking-wider mt-1.5 ${
                                                                 modalData.split_shift_details?.session2_status === 'Present' ? 'text-emerald-600' :
                                                                 modalData.split_shift_details?.session2_status === 'Late' ? 'text-amber-500' : 'text-rose-500'
                                                             }`}>
                                                                 Status: {modalData.split_shift_details?.session2_status || 'Absent'}
                                                             </div>
                                                        </div>
                                                    </div>
                                                    {modalData.split_shift_details?.explanation && (
                                                        <div className="text-[9.5px] font-bold text-slate-650 border-t border-indigo-50/80 pt-2 flex items-center gap-1.5">
                                                            <span>📝 Details:</span>
                                                            <span>{modalData.split_shift_details.explanation}</span>
                                                        </div>
                                                    )}
                                                </div>
                                                
                                                {/* Render all check-in/check-out logs */}
                                                <h4 className="text-[9.5px] font-black text-slate-400 uppercase tracking-widest mt-4">Punches Record ({modalData.attendance_logs.length} Session Logs)</h4>
                                                <div className="space-y-3">
                                                    {modalData.attendance_logs.map((log, idx) => {
                                                      const logUnpaired = isUnpairedPunch(log);
                                                      return (
                                                        <div key={log.id || idx} className="border border-slate-150 p-4 rounded-2xl bg-white space-y-3 shadow-xs">
                                                            <div className="flex justify-between items-center border-b border-slate-100 pb-2">
                                                                <span className="text-[9px] font-black text-slate-450 uppercase tracking-widest">Punch Entry #{idx + 1}</span>
                                                                <span className="text-[9px] font-bold text-[#4361ee] bg-indigo-50 px-2 py-0.5 rounded uppercase">
                                                                    Status: {log.status || 'Present'}
                                                                </span>
                                                            </div>
                                                            <div className="grid grid-cols-2 gap-4">
                                                                <div className={`p-3 rounded-xl space-y-1 border ${logUnpaired ? 'bg-amber-50/25 border-amber-100' : 'bg-emerald-50/20 border-emerald-100'}`}>
                                                                    <span className={`text-[8px] font-black uppercase tracking-widest ${logUnpaired ? 'text-amber-600' : 'text-emerald-600'}`}>
                                                                        {logUnpaired ? 'Punch Recorded' : 'Check In'}
                                                                    </span>
                                                                    <h4 className="text-xs font-black text-slate-800">
                                                                        {log.check_in ? new Date(log.check_in).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true }) : '--:--'}
                                                                    </h4>
                                                                    <p className="text-[8px] font-bold text-slate-400 leading-none mt-1">Source: {log.punch_source || 'device'}</p>
                                                                    {logUnpaired && (
                                                                        <p className="text-[8px] font-bold text-amber-600 leading-snug mt-1">{UNPAIRED_PUNCH_HINT}</p>
                                                                    )}
                                                                </div>
                                                                <div className="bg-slate-50/50 border border-slate-200/60 p-3 rounded-xl space-y-1">
                                                                    <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Check Out</span>
                                                                    <h4 className="text-xs font-black text-slate-800">
                                                                        {log.check_out_text 
                                                                            ? log.check_out_text 
                                                                            : (log.check_out 
                                                                                ? new Date(log.check_out).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true }) 
                                                                                : '--:--')}
                                                                    </h4>
                                                                    <p className="text-[8px] font-bold text-slate-400 leading-none mt-1">Device: {log.device_id || 'N/A'}</p>
                                                                </div>
                                                            </div>
                                                            {log.review_reason && (
                                                                <ReviewReasonNotice reason={log.review_reason} />
                                                            )}
                                                            {(log.punch_location || log.remarks || log.out_punch_location || log.out_remarks) && (
                                                                <div className="bg-slate-50/30 border border-slate-100 p-3 rounded-xl space-y-2 text-[9px] font-bold text-slate-700">
                                                                    {log.punch_location && (
                                                                        <div><span className="text-slate-400 mr-1.5 uppercase text-[8px] font-black">In Location:</span>{log.punch_location}</div>
                                                                    )}
                                                                    {log.remarks && (
                                                                        <div><span className="text-slate-400 mr-1.5 uppercase text-[8px] font-black">In Remarks:</span>"{log.remarks}"</div>
                                                                    )}
                                                                    {log.out_punch_location && (
                                                                        <div><span className="text-slate-400 mr-1.5 uppercase text-[8px] font-black">Out Location:</span>{log.out_punch_location}</div>
                                                                    )}
                                                                    {log.out_remarks && (
                                                                        <div><span className="text-slate-400 mr-1.5 uppercase text-[8px] font-black">Out Remarks:</span>"{log.out_remarks}"</div>
                                                                    )}
                                                                </div>
                                                            )}
                                                            {log.latitude && log.longitude && (
                                                                <div className="flex items-center justify-between flex-wrap gap-2 pt-2 border-t border-slate-100">
                                                                    <div className="flex items-center gap-1.5 text-[8.5px] font-black text-slate-400">
                                                                        <MapPin size={10} className="text-indigo-500" />
                                                                        <span>Coordinates: {log.latitude}, {log.longitude}</span>
                                                                    </div>
                                                                    <a 
                                                                        href={`https://www.google.com/maps/search/?api=1&query=${log.latitude},${log.longitude}`}
                                                                        target="_blank"
                                                                        rel="noreferrer"
                                                                        className="text-[8.5px] font-black text-[#4361ee] uppercase tracking-wider hover:underline cursor-pointer"
                                                                    >
                                                                        View check-in map ↗
                                                                    </a>
                                                                </div>
                                                            )}
                                                        </div>
                                                      );
                                                    })}
                                                </div>
                                            </div>
                                        ) : modalData.attendance ? (
                                            <div className="space-y-4.5">
                                                <h4 className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Biometric / Web Attendance Records</h4>
                                                
                                                <div className="grid grid-cols-2 gap-4">
                                                    {/* In Record */}
                                                    <div className={`p-4 rounded-2xl space-y-2 border ${attendanceUnpaired ? 'bg-amber-50/25 border-amber-100' : 'bg-emerald-50/20 border-emerald-100'}`}>
                                                        <div className="flex justify-between items-center">
                                                            <span className={`text-[8px] font-black uppercase tracking-widest ${attendanceUnpaired ? 'text-amber-600' : 'text-emerald-600'}`}>
                                                                {attendanceUnpaired ? 'Punch Recorded' : 'Punch In'}
                                                            </span>
                                                            <button 
                                                                onClick={(e) => { e.stopPropagation(); setPunchHistoryOpen(true); }}
                                                                className="text-slate-400 hover:text-indigo-600 transition-colors p-0.5 cursor-pointer flex items-center justify-center rounded hover:bg-slate-100"
                                                                title="View Details"
                                                            >
                                                                <Info size={11} />
                                                            </button>
                                                        </div>
                                                        <h4 className="text-lg font-black text-slate-800 leading-tight">
                                                            {modalData.attendance.check_in ? new Date(modalData.attendance.check_in).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true }) : '--:--'}
                                                        </h4>
                                                        <p className="text-[9px] font-bold text-slate-400 leading-none">Source: {modalData.attendance.punch_source || 'device'}</p>
                                                        {attendanceUnpaired && (
                                                            <p className="text-[8.5px] font-bold text-amber-600 leading-snug">{UNPAIRED_PUNCH_HINT}</p>
                                                        )}
                                                    </div>

                                                    {/* Out Record */}
                                                    <div className="bg-slate-50/50 border border-slate-200/60 p-4 rounded-2xl space-y-2">
                                                        <div className="flex justify-between items-center">
                                                            <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Punch Out</span>
                                                            <button 
                                                                onClick={(e) => { e.stopPropagation(); setPunchHistoryOpen(true); }}
                                                                className="text-slate-400 hover:text-indigo-600 transition-colors p-0.5 cursor-pointer flex items-center justify-center rounded hover:bg-slate-100"
                                                                title="View Details"
                                                            >
                                                                <Info size={11} />
                                                            </button>
                                                        </div>
                                                        <h4 className="text-lg font-black text-slate-800 leading-tight">
                                                            {modalData.attendance.check_out_text 
                                                                ? modalData.attendance.check_out_text 
                                                                : (modalData.attendance.check_out 
                                                                    ? new Date(modalData.attendance.check_out).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true }) 
                                                                    : '--:--')}
                                                        </h4>
                                                        <p className="text-[9px] font-bold text-slate-400 leading-none">Device: {modalData.attendance.device_id || 'N/A'}</p>
                                                    </div>
                                                </div>

                                                {modalData.attendance.review_reason && (
                                                    <ReviewReasonNotice reason={modalData.attendance.review_reason} />
                                                )}

                                                {/* Coordinates and Location Mapping */}
                                                {(modalData.attendance.latitude || modalData.attendance.longitude || modalData.attendance.punch_location || modalData.attendance.remarks) && (
                                                    <div className="border border-slate-100 p-4 rounded-2xl bg-slate-50/30 space-y-3">
                                                        <h5 className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Location Details</h5>
                                                        
                                                        {modalData.attendance.punch_location && (
                                                            <div className="text-[10px] font-bold text-slate-700">
                                                                <span className="text-slate-400 mr-1.5 uppercase text-[8px] font-black">Check-In Hub:</span>
                                                                {modalData.attendance.punch_location}
                                                            </div>
                                                        )}

                                                        {modalData.attendance.remarks && (
                                                            <div className="text-[10px] font-bold text-slate-700">
                                                                <span className="text-slate-400 mr-1.5 uppercase text-[8px] font-black">Check-In Remarks:</span>
                                                                "{modalData.attendance.remarks}"
                                                            </div>
                                                        )}

                                                        {modalData.attendance.out_punch_location && (
                                                            <div className="text-[10px] font-bold text-slate-700">
                                                                <span className="text-slate-400 mr-1.5 uppercase text-[8px] font-black">Check-Out Hub:</span>
                                                                {modalData.attendance.out_punch_location}
                                                            </div>
                                                        )}

                                                        {modalData.attendance.out_remarks && (
                                                            <div className="text-[10px] font-bold text-slate-700">
                                                                <span className="text-slate-400 mr-1.5 uppercase text-[8px] font-black">Check-Out Remarks:</span>
                                                                "{modalData.attendance.out_remarks}"
                                                            </div>
                                                        )}

                                                        {modalData.attendance.latitude && modalData.attendance.longitude && (
                                                            <div className="flex items-center justify-between flex-wrap gap-2 pt-2 border-t border-slate-100">
                                                                <div className="flex items-center gap-1.5 text-[9px] font-black text-slate-400">
                                                                    <MapPin size={12} className="text-indigo-500" />
                                                                    <span>Coordinates: {modalData.attendance.latitude}, {modalData.attendance.longitude}</span>
                                                                </div>
                                                                <a 
                                                                    href={`https://www.google.com/maps/search/?api=1&query=${modalData.attendance.latitude},${modalData.attendance.longitude}`}
                                                                    target="_blank"
                                                                    rel="noreferrer"
                                                                    className="text-[9px] font-black text-[#4361ee] uppercase tracking-wider hover:underline cursor-pointer"
                                                                >
                                                                    View check-in map ↗
                                                                </a>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ) : null}

                                        {modalData.leave && (
                                            <div className="space-y-3">
                                                <h4 className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Leave Log Summary</h4>
                                                <div className="border border-indigo-50 bg-indigo-50/15 p-4 rounded-2xl space-y-3.5 shadow-sm">
                                                    <div className="flex justify-between items-start">
                                                        <div>
                                                            <span className="text-[9px] font-black text-indigo-600 uppercase tracking-widest">Approved Leave</span>
                                                            <h4 className="text-xs font-black text-slate-800 mt-1 uppercase">{modalData.leave.leave_type_name}</h4>
                                                        </div>
                                                        <span className="text-[8px] font-black text-emerald-600 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full uppercase">Approved</span>
                                                    </div>

                                                    <div className="text-[10px] text-slate-600 leading-relaxed font-bold">
                                                        <span className="text-slate-400 block text-[8px] font-black uppercase mb-1">Reason for leave:</span>
                                                        "{modalData.leave.reason || 'Not specified'}"
                                                    </div>

                                                    <div className="grid grid-cols-2 gap-3 pt-2.5 border-t border-slate-200/50 text-[9.5px] font-bold text-slate-500">
                                                        <div>
                                                            <span className="text-slate-400 block text-[8px] font-black uppercase mb-0.5">Duration</span>
                                                            {new Date(modalData.leave.start_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - {new Date(modalData.leave.end_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                                                        </div>
                                                        <div>
                                                            <span className="text-slate-400 block text-[8px] font-black uppercase mb-0.5">Approved By</span>
                                                            {modalData.leave.approved_by || 'System / Admin'}
                                                        </div>
                                                    </div>

                                                    {(modalData.leave.leave_type_name.toLowerCase().includes('unpaid') || modalData.leave.leave_type_name.toLowerCase().includes('lop')) ? (
                                                        <div className="bg-rose-50 border border-rose-100 text-rose-700 p-2.5 rounded-xl text-[9.5px] font-bold">
                                                            ⚠️ This is an unpaid leave (Loss of Pay) resulting in salary deductions for this day.
                                                        </div>
                                                    ) : null}
                                                </div>
                                            </div>
                                        )}

                                        {/* 4. Regularization Details */}
                                        {modalData.regularization && (
                                            <div className="space-y-3">
                                                <h4 className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Regularization Log</h4>
                                                <div className="border border-indigo-100 bg-indigo-50/10 p-4 rounded-2xl space-y-3 shadow-xs">
                                                    <div className="flex justify-between items-center">
                                                        <span className="text-[9px] font-black text-indigo-500 uppercase tracking-widest">Regularization Request</span>
                                                        <span className={`px-2 py-0.5 rounded-full text-[8.5px] font-black uppercase border ${
                                                            modalData.regularization.status === 'approved' ? 'bg-emerald-50 border-emerald-100 text-emerald-600' :
                                                            modalData.regularization.status === 'rejected' ? 'bg-rose-50 border-rose-100 text-rose-600' :
                                                            'bg-amber-50 border-amber-100 text-amber-600'
                                                        }`}>
                                                            {modalData.regularization.status}
                                                        </span>
                                                    </div>

                                                    <div className="grid grid-cols-2 gap-2 text-[10px] font-bold text-slate-700">
                                                        <div>
                                                            <span className="text-slate-400 text-[8px] font-black uppercase block mb-0.5">Req. Check-In</span>
                                                            {modalData.regularization.req_check_in || 'N/A'}
                                                        </div>
                                                        <div>
                                                            <span className="text-slate-400 text-[8px] font-black uppercase block mb-0.5">Req. Check-Out</span>
                                                            {modalData.regularization.req_check_out || 'N/A'}
                                                        </div>
                                                    </div>

                                                    <div className="text-[10px] text-slate-600 font-bold leading-normal pt-2 border-t border-slate-100">
                                                        <span className="text-slate-400 block text-[8px] font-black uppercase mb-0.5">Reason:</span>
                                                        "{modalData.regularization.reason}"
                                                    </div>

                                                    <div className="flex justify-between items-center text-[9px] text-slate-400 font-bold pt-2 border-t border-slate-100">
                                                        <span>Submitted: {new Date(modalData.regularization.created_at).toLocaleDateString('en-GB')}</span>
                                                        {modalData.regularization.approved_by && (
                                                            <span>Approver: {modalData.regularization.approved_by}</span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* 4.5. Entry/Exit Request Details */}
                                        {modalData.entry_request && (
                                            <div className="space-y-3">
                                                <h4 className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Entry/Exit Request Log</h4>
                                                <div className="border border-orange-100 bg-orange-50/10 p-4 rounded-2xl space-y-3 shadow-xs">
                                                    <div className="flex justify-between items-center">
                                                        <span className="text-[9px] font-black text-orange-500 uppercase tracking-widest">
                                                            {getRequestTypeMeta(modalData.entry_request.request_type).title}
                                                        </span>
                                                        <span className={`px-2 py-0.5 rounded-full text-[8.5px] font-black uppercase border ${
                                                            modalData.entry_request.status === 'approved' ? 'bg-emerald-50 border-emerald-100 text-emerald-600' :
                                                            modalData.entry_request.status === 'rejected' ? 'bg-rose-50 border-rose-100 text-rose-600' :
                                                            'bg-amber-50 border-amber-100 text-amber-600'
                                                        }`}>
                                                            {modalData.entry_request.status}
                                                        </span>
                                                    </div>

                                                    <div className="grid grid-cols-2 gap-2 text-[10px] font-bold text-slate-700">
                                                        <div>
                                                            <span className="text-slate-400 text-[8px] font-black uppercase block mb-0.5">Punch Attempt Time</span>
                                                            {modalData.entry_request.punch_time ? formatPunchTime(modalData.entry_request.punch_time) : 'N/A'}
                                                        </div>
                                                        <div>
                                                            <span className="text-slate-400 text-[8px] font-black uppercase block mb-0.5">Request Type</span>
                                                            <span className="capitalize">{getRequestTypeMeta(modalData.entry_request.request_type).label}</span>
                                                        </div>
                                                    </div>

                                                    <div className="flex justify-between items-center text-[9px] text-slate-400 font-bold pt-2 border-t border-slate-100">
                                                        <span>Submitted: {new Date(modalData.entry_request.created_at).toLocaleDateString('en-GB')}</span>
                                                        {modalData.entry_request.approved_by && (
                                                            <span>Approver: {modalData.entry_request.approved_by} {modalData.entry_request.approver_role ? `(${modalData.entry_request.approver_role})` : ''}</span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* 5. Holiday Details */}
                                        {modalData.holiday && (
                                            <div className="bg-sky-50/40 border border-sky-100 p-4 rounded-2xl space-y-2">
                                                <span className="text-[8px] font-black text-sky-600 uppercase tracking-widest">Declared Holiday</span>
                                                <h4 className="text-xs font-black text-slate-800 uppercase tracking-tight">{modalData.holiday.name}</h4>
                                                <p className="text-[9.5px] font-bold text-slate-400">Type: {modalData.holiday.type || 'fixed'} Gazetted Holiday. Operations closed.</p>
                                            </div>
                                        )}

                                        {/* 6. Off Day / Weekoff Details */}
                                        {selectedCell.status === 'OFF' && (
                                            <div className="bg-slate-50 border border-slate-200/50 p-4 rounded-2xl space-y-2">
                                                <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Weekly Rest Day</span>
                                                <p className="text-[10.5px] font-bold text-slate-600 leading-normal">
                                                    {modalData.weekend_override ? (
                                                        <span>Weekend Override was configured for this date. Reason: "{modalData.weekend_override.reason || 'N/A'}" (applied by {modalData.weekend_override.created_by}).</span>
                                                    ) : (
                                                        <span>This day is a standard weekly rest off-day according to the corporate schedule policies.</span>
                                                    )}
                                                </p>
                                            </div>
                                        )}

                                        {/* 7. Manual Override Info */}
                                        {modalData.override_history && (
                                            <div className="bg-amber-50/20 border border-amber-100 p-3 rounded-xl flex gap-2 text-[10px] text-amber-800 font-bold">
                                                <span>ℹ️</span>
                                                <div>
                                                    <span className="uppercase text-[8px] font-black block">Manual Intervention Log</span>
                                                    Manual override applied ({modalData.override_history.override_type}). Status changed from "{modalData.override_history.previous_status || 'absent'}" to "{modalData.override_history.updated_status}" by admin ({modalData.override_history.overridden_by_name || 'System'}).
                                                </div>
                                            </div>
                                        )}

                                        {/* 8. Absent fallback when no log exists */}
                                        {!modalData.attendance && !modalData.leave && !modalData.holiday && selectedCell.status === 'A' && (
                                            <div className="bg-rose-50/25 border border-rose-100 p-4.5 rounded-2xl space-y-2">
                                                <span className="text-[8px] font-black text-rose-600 uppercase tracking-widest block">Missed Logs / Absent</span>
                                                <p className="text-[10.5px] font-bold text-slate-500 leading-normal">
                                                    No biometric punch-in or check-in request was registered on this day. The employee has been marked as absent.
                                                </p>
                                                {!modalData.regularization && (
                                                    <div className="text-[9.5px] font-extrabold text-slate-400 mt-2">
                                                        Regularization has not been submitted.
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                    </div>
                                ) : (
                                    <div className="py-8 text-center text-[10px] font-bold text-slate-400 uppercase">
                                        No diagnostics available for this day.
                                    </div>
                                )}
                            </div>

                            {/* Modal Footer */}
                            <div className="p-5 border-t border-slate-100 flex items-center justify-end bg-slate-50/30">
                                <button 
                                    onClick={() => setSelectedCell(null)}
                                    className="px-6 py-2 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-800 transition-all cursor-pointer active:scale-95 shadow-md"
                                >
                                    Close Details
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            {/* Punch History Info Overlay Modal */}
            <AnimatePresence>
                {punchHistoryOpen && modalData && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                        {/* Background Overlay */}
                        <motion.div 
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 0.6 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setPunchHistoryOpen(false)}
                            className="absolute inset-0 bg-slate-950/40 backdrop-blur-xs"
                        />

                        {/* Modal Box */}
                        <motion.div 
                            initial={{ opacity: 0, scale: 0.95, y: 10 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 10 }}
                            className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-100 z-10 flex flex-col overflow-hidden max-h-[75vh]"
                        >
                            {/* Header */}
                            <div className="p-5 border-b border-slate-50 flex justify-between items-center bg-slate-50/20">
                                <div>
                                    <h3 className="text-xs font-black text-slate-800 uppercase tracking-wide">Punch & Request Log</h3>
                                    <p className="text-[9px] font-bold text-slate-400 uppercase mt-0.5">
                                        {new Date(selectedCell.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                                    </p>
                                </div>
                                <button 
                                    onClick={() => setPunchHistoryOpen(false)}
                                    className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 transition-colors text-xs font-bold"
                                >
                                    ✕
                                </button>
                            </div>

                            {/* Content body */}
                            <div className="p-5 overflow-y-auto space-y-5 custom-scrollbar flex-1 text-left">
                                {/* Section 1: Raw Biometric Logs */}
                                <div className="space-y-2">
                                    <h4 className="text-[9px] font-black text-indigo-650 uppercase tracking-widest">Raw Biometric Machine Logs</h4>
                                    {modalData.raw_biometric_logs && modalData.raw_biometric_logs.length > 0 ? (
                                        <div className="divide-y divide-slate-50 border border-slate-100 rounded-2xl overflow-hidden bg-slate-50/30">
                                            {modalData.raw_biometric_logs.map((log) => (
                                                <div key={log.id} className="p-3 text-[10px] font-bold text-slate-700 space-y-1">
                                                    <div className="flex justify-between items-center">
                                                        <span>Time: {formatPunchTime(log.punch_time)}</span>
                                                        <span className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase ${
                                                            log.status === 'synced' ? 'bg-emerald-50 text-emerald-600' :
                                                            log.status === 'skipped' ? 'bg-amber-50 text-amber-600 border border-amber-100' :
                                                            'bg-rose-50 text-rose-600'
                                                        }`}>
                                                            {log.status}
                                                        </span>
                                                    </div>
                                                    <div className="text-[8.5px] text-slate-400 font-bold">
                                                        Device SN: {log.device_serial || 'N/A'} {log.error_details ? `• Reason: ${log.error_details}` : ''}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-[9.5px] font-bold text-slate-450 italic p-3 border border-slate-100 rounded-2xl text-center bg-slate-50/10">
                                            No raw machine logs recorded for this day.
                                        </div>
                                    )}
                                </div>

                                {/* Section 2: Late In / Early Out Requests */}
                                <div className="space-y-2">
                                    <h4 className="text-[9px] font-black text-orange-500 uppercase tracking-widest">Entry / Exit Requests</h4>
                                    {modalData.entry_requests && modalData.entry_requests.length > 0 ? (
                                        <div className="divide-y divide-slate-50 border border-slate-100 rounded-2xl overflow-hidden bg-slate-50/30">
                                            {modalData.entry_requests.map((er) => (
                                                <div key={er.id} className="p-3 text-[10px] font-bold text-slate-700 space-y-1">
                                                    <div className="flex justify-between items-center">
                                                        <span className="uppercase text-[8.5px] font-black text-slate-600">{getRequestTypeMeta(er.request_type).label}</span>
                                                        <span className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase ${
                                                            er.status === 'approved' ? 'bg-emerald-50 text-emerald-600' :
                                                            er.status === 'rejected' ? 'bg-rose-50 text-rose-600' :
                                                            'bg-amber-50 text-amber-600'
                                                        }`}>
                                                            {er.status}
                                                        </span>
                                                    </div>
                                                    <div className="text-[8.5px] text-slate-455 font-bold flex justify-between">
                                                        <span>Time: {formatPunchTime(er.punch_time)}</span>
                                                        <span>Approver: {er.approved_by || 'Pending'}</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-[9.5px] font-bold text-slate-455 italic p-3 border border-slate-100 rounded-2xl text-center bg-slate-50/10">
                                            No entry/exit requests submitted.
                                        </div>
                                    )}
                                </div>

                                {/* Section 3: Regularization Requests */}
                                <div className="space-y-2">
                                    <h4 className="text-[9px] font-black text-[#4361ee] uppercase tracking-widest">Regularization Requests</h4>
                                    {modalData.regularizations && modalData.regularizations.length > 0 ? (
                                        <div className="divide-y divide-slate-50 border border-slate-100 rounded-2xl overflow-hidden bg-slate-50/30">
                                            {modalData.regularizations.map((r) => (
                                                <div key={r.id} className="p-3 text-[10px] font-bold text-slate-700 space-y-1">
                                                    <div className="flex justify-between items-center">
                                                        <span>In: {r.req_check_in || 'N/A'} • Out: {r.req_check_out || 'N/A'}</span>
                                                        <span className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase ${
                                                            r.status === 'approved' ? 'bg-emerald-50 text-emerald-600' :
                                                            r.status === 'rejected' ? 'bg-rose-50 text-rose-600' :
                                                            'bg-amber-50 text-amber-600'
                                                        }`}>
                                                            {r.status}
                                                        </span>
                                                    </div>
                                                    <div className="text-[8.5px] text-slate-500 font-bold">
                                                        Reason: "{r.reason || 'N/A'}"
                                                    </div>
                                                    <div className="text-[8px] text-slate-400 font-bold flex justify-between pt-1 border-t border-slate-100/50">
                                                        <span>Submitted: {new Date(r.created_at).toLocaleDateString('en-GB')}</span>
                                                        <span>Approver: {r.approved_by || 'Pending'}</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-[9.5px] font-bold text-slate-455 italic p-3 border border-slate-100 rounded-2xl text-center bg-slate-50/10">
                                            No regularization requests submitted.
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Footer */}
                            <div className="p-4 border-t border-slate-100 flex justify-end bg-slate-50/20">
                                <button 
                                    onClick={() => setPunchHistoryOpen(false)}
                                    className="px-5 py-1.5 bg-slate-900 text-white rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-slate-800 transition-colors active:scale-95 shadow-md cursor-pointer"
                                >
                                    Close History
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            {/* --- SLIDE-OVER DETAIL EMPLOYEE SIDE DRAWER --- */}
            <AnimatePresence>
                {selectedEmployee && (
                    <div className="fixed inset-0 z-50 overflow-hidden flex justify-end">
                        {/* Background Overlay */}
                        <motion.div 
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 0.4 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setSelectedEmployee(null)}
                            className="absolute inset-0 bg-slate-950/80 backdrop-blur-xs"
                        />

                        {/* Drawer content */}
                        <motion.div 
                            initial={{ translateX: '100%' }}
                            animate={{ translateX: 0 }}
                            exit={{ translateX: '100%' }}
                            transition={{ type: 'spring', damping: 25, stiffness: 220 }}
                            className="relative w-full max-w-md bg-white h-full shadow-2xl z-10 flex flex-col p-6 overflow-y-auto"
                        >
                            {/* Drawer Header */}
                            <div className="flex justify-between items-start border-b border-slate-100 pb-4">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center text-xs font-black text-[#4361ee] uppercase border border-indigo-100">
                                        {selectedEmployee.name.split(' ').map(n => n[0]).join('')}
                                    </div>
                                    <div>
                                        <h3 className="text-xs font-black text-slate-800">{selectedEmployee.name}</h3>
                                        <p className="text-[9px] font-bold text-slate-400">{selectedEmployee.code} | {selectedEmployee.role}</p>
                                    </div>
                                </div>
                                <button 
                                    onClick={() => setSelectedEmployee(null)}
                                    className="p-1.5 hover:bg-slate-100 rounded-xl text-slate-400 transition-colors"
                                >
                                    ✕
                                </button>
                            </div>

                            {/* Details body */}
                            <div className="flex-1 space-y-6 mt-6">
                                {/* Monthly stats block */}
                                <div className="bg-slate-50 rounded-2xl p-4.5 border border-slate-200/50">
                                    <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3.5">
                                        Attendance Summary ({months[selectedMonth - 1].name})
                                    </h4>
                                    
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="bg-white border border-slate-100 rounded-xl p-3 text-center">
                                            <span className="text-[9px] font-black text-slate-400 block uppercase">Present Days</span>
                                            <span className="text-lg font-black text-emerald-600 mt-1 block">{selectedEmployee.stats.P || 0}</span>
                                        </div>
                                        <div className="bg-white border border-slate-100 rounded-xl p-3 text-center">
                                            <span className="text-[9px] font-black text-slate-400 block uppercase">Late Marks</span>
                                            <span className="text-lg font-black text-amber-500 mt-1 block">{selectedEmployee.stats.L || 0}</span>
                                        </div>
                                        <div className="bg-white border border-slate-100 rounded-xl p-3 text-center">
                                            <span className="text-[9px] font-black text-slate-400 block uppercase">Absent Days</span>
                                            <span className="text-lg font-black text-rose-500 mt-1 block">{selectedEmployee.stats.A || 0}</span>
                                        </div>
                                        <div className="bg-white border border-slate-100 rounded-xl p-3 text-center">
                                            <span className="text-[9px] font-black text-slate-400 block uppercase">Weekly Offs</span>
                                            <span className="text-lg font-black text-slate-500 mt-1 block">{selectedEmployee.stats.OFF || 0}</span>
                                        </div>
                                    </div>
                                </div>

                                {/* Shift info block */}
                                <div className="space-y-3.5">
                                    <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                                        Working Shift Guidelines
                                    </h4>
                                    <div className="bg-white border border-slate-200 rounded-2xl p-4 flex justify-between items-center shadow-sm">
                                        <div className="flex items-center gap-3">
                                            <div className="w-9 h-9 bg-indigo-50 rounded-xl flex items-center justify-center text-[#4361ee]">
                                                <Clock size={16} />
                                            </div>
                                            <div className="leading-tight">
                                                <span className="text-[10px] font-bold text-slate-800">
                                                    {selectedEmployee.shift_name || 'General Morning Shift'}
                                                </span>
                                                <p className="text-[8px] font-black text-[#4361ee] uppercase tracking-widest mt-0.5">
                                                    {selectedEmployee.shift_name ? (
                                                        selectedEmployee.shift_is_flexi 
                                                            ? 'Flexi Shift' 
                                                            : `${formatTimeAMPM(selectedEmployee.shift_start)} - ${formatTimeAMPM(selectedEmployee.shift_end)}`
                                                    ) : (
                                                        '09:00 AM - 06:00 PM'
                                                    )}
                                                </p>
                                            </div>
                                        </div>
                                        <span className="text-[8px] font-black text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-100 uppercase">
                                            {selectedEmployee.shift_name ? 'Active' : 'Default'}
                                        </span>
                                    </div>
                                </div>

                                {/* Location info block */}
                                <div className="space-y-3.5">
                                    <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                                        Punch Settings
                                    </h4>
                                    <div className="bg-white border border-slate-200 rounded-2xl p-4 flex justify-between items-center shadow-sm">
                                        <div className="flex items-center gap-3">
                                            <div className="w-9 h-9 bg-slate-50 rounded-xl flex items-center justify-center text-slate-500 border border-slate-100">
                                                <MapPin size={16} />
                                            </div>
                                            <div className="leading-tight">
                                                <span className="text-[10px] font-bold text-slate-800">Assigned Hub Location</span>
                                                <p className="text-[8px] font-bold text-slate-400 mt-0.5">{selectedEmployee.location || 'Noida Head Office (HQ)'}</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Footer links */}
                            <div className="border-t border-slate-100 pt-4 mt-6">
                                <button 
                                    onClick={() => setSelectedEmployee(null)}
                                    className="w-full bg-[#4361ee] hover:bg-[#344ed1] text-white text-xs font-black py-2.5 rounded-xl transition-all shadow-md active:scale-98"
                                >
                                    Okay, Close Panel
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            {/* --- ENTRY/EXIT REQUEST APPROVAL OPTIONS MODAL --- */}
            <AnimatePresence>
                {approvalModalRequest && (
                    <div className="fixed inset-0 z-[100] overflow-hidden flex items-center justify-center p-4">
                        {/* Background Overlay */}
                        <motion.div 
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 0.4 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setApprovalModalRequest(null)}
                            className="absolute inset-0 bg-slate-950/80 backdrop-blur-xs"
                        />

                        {/* Modal Box */}
                        <motion.div 
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            className="relative w-full max-w-md bg-white rounded-3xl shadow-2xl border border-slate-100 z-10 p-6 space-y-6"
                        >
                            <div className="flex justify-between items-start">
                                <div>
                                    <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider">Approve Request</h3>
                                    <p className="text-[10px] font-bold text-slate-400 mt-1 uppercase">
                                        For {approvalModalRequest.first_name} {approvalModalRequest.last_name} (#{approvalModalRequest.employee_id_number})
                                    </p>
                                </div>
                                <button 
                                    onClick={() => setApprovalModalRequest(null)}
                                    className="text-slate-400 hover:text-slate-600 font-bold"
                                >
                                    ✕
                                </button>
                            </div>

                            <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 space-y-1">
                                <p className="text-[10px] font-bold text-slate-500 uppercase">Request Details</p>
                                <div className="flex justify-between text-xs font-bold text-slate-700">
                                    <span>Type: <span className="text-indigo-600 capitalize">{getRequestTypeMeta(approvalModalRequest.request_type).label}</span></span>
                                    <span>Date: {approvalModalRequest.date ? new Date(approvalModalRequest.date).toLocaleDateString() : 'N/A'}</span>
                                </div>
                                {approvalModalRequest.punch_time && (
                                    <p className="text-xs font-bold text-slate-750">Punch Attempt: <span className="text-indigo-600 font-black">{formatPunchTime(approvalModalRequest.punch_time)}</span></p>
                                )}
                            </div>

                            {isMissingInApproval && (
                                <div className="space-y-2.5">
                                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Actual Arrival Time</p>
                                    <div className="bg-amber-50/30 border border-amber-100 p-3.5 rounded-2xl space-y-2.5">
                                        <div className="flex gap-2 items-start">
                                            <AlertCircle size={12} className="text-amber-500 mt-0.5 shrink-0" />
                                            <p className="text-[9.5px] font-bold text-slate-600 leading-relaxed">
                                                Only one punch reached us for this day and the check-in is missing. Enter the time the employee actually arrived: it is saved as the check-in, and the recorded punch{approvalModalRequest.punch_time ? ` (${formatPunchTime(approvalModalRequest.punch_time)})` : ''} becomes the check-out.
                                            </p>
                                        </div>
                                        <input
                                            type="time"
                                            value={arrivalTime}
                                            onChange={(e) => { setArrivalTime(e.target.value); setApprovalError(null); }}
                                            className="w-full bg-white border border-slate-200 hover:border-slate-300 rounded-xl px-3 py-2 text-xs font-black text-slate-700 outline-none shadow-inner"
                                        />
                                        {approvalActionsBlocked && (
                                            <p className="text-[9px] font-black text-amber-600 uppercase tracking-wider">Enter the arrival time to enable approval.</p>
                                        )}
                                    </div>
                                </div>
                            )}

                            {approvalError && (
                                <div className="p-3.5 bg-rose-50 border border-rose-100 rounded-2xl flex items-start gap-2.5 text-rose-700">
                                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                                    <span className="text-[10px] font-bold leading-relaxed">{approvalError}</span>
                                </div>
                            )}

                            <div className="space-y-3">
                                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Select Mark Option</p>
                                <div className="grid grid-cols-1 gap-2.5">
                                    <button
                                        onClick={() => handleRequestAction(approvalModalRequest.id, 'approved', 'present', isMissingInApproval ? arrivalTime : null)}
                                        disabled={approvingId === approvalModalRequest.id || approvalActionsBlocked}
                                        className="w-full py-3 bg-emerald-50 hover:bg-emerald-100/75 text-emerald-700 border border-emerald-200 rounded-2xl text-[10px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        Mark Full Day (Present)
                                    </button>
                                    <button
                                        onClick={() => handleRequestAction(approvalModalRequest.id, 'approved', 'late_in', isMissingInApproval ? arrivalTime : null)}
                                        disabled={approvingId === approvalModalRequest.id || approvalActionsBlocked}
                                        className="w-full py-3 bg-amber-50 hover:bg-amber-100/75 text-amber-700 border border-amber-200 rounded-2xl text-[10px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        Mark Late In
                                    </button>
                                    <button
                                        onClick={() => handleRequestAction(approvalModalRequest.id, 'approved', 'half_day', isMissingInApproval ? arrivalTime : null)}
                                        disabled={approvingId === approvalModalRequest.id || approvalActionsBlocked}
                                        className="w-full py-3 bg-cyan-50 hover:bg-cyan-100/75 text-cyan-700 border border-cyan-200 rounded-2xl text-[10px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        Mark Half Day
                                    </button>
                                    <button
                                        onClick={() => handleRequestAction(approvalModalRequest.id, 'approved', 'early_out', isMissingInApproval ? arrivalTime : null)}
                                        disabled={approvingId === approvalModalRequest.id || approvalActionsBlocked}
                                        className="w-full py-3 bg-orange-50 hover:bg-orange-100/75 text-orange-700 border border-orange-200 rounded-2xl text-[10px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        Mark Early Out
                                    </button>
                                </div>
                            </div>

                            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                                <button
                                    onClick={() => setApprovalModalRequest(null)}
                                    className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all"
                                >
                                    Cancel
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

        </div>
    );
};

export default AttendanceMuster;
