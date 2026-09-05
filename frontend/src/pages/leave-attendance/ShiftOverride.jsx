import React, { useState, useEffect } from 'react';
import {
    Clock, Users, CheckCircle, Search, Save, Shield,
    Plus, X, Info, UserCheck, Trash2, Calendar, Layout, Zap, Download, Edit2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../../utils/api';
import { exportToCSV } from '../../utils/exportUtils';
import DeleteSecurityModal from '../../components/common/DeleteSecurityModal';

const ShiftManagement = () => {
    const [employees, setEmployees] = useState([]);
    const [shifts, setShifts] = useState([]);
    const [showRules, setShowRules] = useState(false);
    const [loading, setLoading] = useState(false);
    const [fetching, setFetching] = useState(true);
    const [success, setSuccess] = useState(false);
    const [viewMode, setViewMode] = useState('list'); // 'list', 'assign', 'override', 'entry_requests'
    const [editingShiftId, setEditingShiftId] = useState(null);
    const [assignMode, setAssignMode] = useState('single'); // 'single', 'multiple'
    const [selectedShiftId, setSelectedShiftId] = useState('');

    const decimalToTime = (decimal) => {
        if (decimal === undefined || decimal === null || isNaN(decimal)) return '00:00';
        const hrs = Math.floor(decimal);
        const mins = Math.round((decimal - hrs) * 60);
        return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    };

    const getDurationFromTimes = (start, end, s2Start, s2End, punches) => {
        const timeToMins = (t) => {
            if (!t) return 0;
            const [h, m] = t.split(':').map(Number);
            return h * 60 + m;
        };
        let totalMins = 0;
        if (parseInt(punches) === 4) {
            const s1Start = timeToMins(start || '09:00');
            const s1End = timeToMins(end || '13:00');
            const s2S = timeToMins(s2Start || '14:00');
            const s2E = timeToMins(s2End || '18:00');
            let s1 = s1End - s1Start;
            if (s1 < 0) s1 += 24 * 60;
            let s2 = s2E - s2S;
            if (s2 < 0) s2 += 24 * 60;
            totalMins = s1 + s2;
        } else {
            const s1Start = timeToMins(start || '09:00');
            const s1End = timeToMins(end || '18:00');
            let s1 = s1End - s1Start;
            if (s1 < 0) s1 += 24 * 60;
            totalMins = s1;
        }
        return parseFloat((totalMins / 60).toFixed(2)) || 8.0;
    };

    const timeToDecimal = (timeString) => {
        if (!timeString) return 0;
        const [hrs, mins] = timeString.split(':').map(Number);
        if (isNaN(hrs) || isNaN(mins)) return 0;
        return hrs + (mins / 60);
    };

    // Custom Alert & Confirm States
    const [alertConfig, setAlertConfig] = useState({ show: false, message: '', type: 'info' });
    const [confirmConfig, setConfirmConfig] = useState({ show: false, message: '', onConfirm: null, onCancel: null });

    const showAlert = (message, type = 'info') => {
        setAlertConfig({ show: true, message, type });
    };

    const triggerConfirm = (message, onConfirm) => {
        setConfirmConfig({ show: true, message, onConfirm });
    };

    // Delete Protection States
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [deleteTargetId, setDeleteTargetId] = useState(null);
    const [selectedAssignmentStatus, setSelectedAssignmentStatus] = useState('all');
    const [overrideConfig, setOverrideConfig] = useState({
        from_date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' }),
        to_date: ''
    });

    const [selectedEmployees, setSelectedEmployees] = useState([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedOutlet, setSelectedOutlet] = useState('all');
    const [selectedDept, setSelectedDept] = useState('all');
    const [selectedDesignation, setSelectedDesignation] = useState('all');

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

    const uniqueLocations = React.useMemo(() => {
        const map = new Map();
        employees.forEach(e => {
            const val = e.office_location;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [employees]);

    const uniqueDepts = React.useMemo(() => {
        const map = new Map();
        employees.forEach(e => {
            const val = e.department_name || e.department;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [employees]);

    const uniqueDesignations = React.useMemo(() => {
        const map = new Map();
        employees.forEach(e => {
            const val = e.designation;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [employees]);
    const [shiftConfig, setShiftConfig] = useState({
        name: '',
        start_time: '',
        end_time: '',
        grace_period: '',
        grace_count_limit: '',
        from_date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' }),
        to_date: '',
        is_night_shift: false,
        is_flexi: false,
        min_hours: '',
        min_hours_half: '',
        total_punches_required: 2,
        session2_start_time: '',
        session2_end_time: '',
        session1_grace_out: '',
        session2_grace_in: '',
        session2_grace_out: '',
        session1_in_margin: '',
        session1_out_margin: '',
        session2_in_margin: '',
        session2_out_margin: '',
        terminate_hour: ''
    });

    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        try {
            setFetching(true);
            const [empRes, shiftRes] = await Promise.all([
                api.get('/attendance/eligible-employees'),
                api.get('/attendance/shift-list')
            ]);
            setEmployees(empRes || []);
            setShifts(shiftRes || []);
        } catch (err) {
            console.error('Failed to fetch data', err);
        } finally {
            setFetching(false);
        }
    };

    const handleEmployeeToggle = (emp) => {
        // In override mode, we can pick any employee. In assign mode, only unassigned.
        if (viewMode === 'assign' && emp.assigned_shift) {
            showAlert(`${emp.first_name} already has a shift assigned. Use "Override Shift" mode to change existing assignments.`, 'info');
            return;
        }

        if (selectedEmployees.some(item => item.id === emp.id)) {
            setSelectedEmployees(prev => prev.filter(item => item.id !== emp.id));
        } else {
            setSelectedEmployees(prev => [...prev, emp]);
        }
    };

    // The backend refuses a backdated assignment unless the caller confirms it, because
    // re-resolving days that were already worked rewrites their muster status and the payroll
    // computed from it. Clients genuinely need it - rotations here are often keyed in hours or
    // days after the punches - so ask rather than block, and send the confirmation the API
    // expects. Without this the API's own error message asks for a flag the UI cannot set.
    const confirmBackdate = (fromDate) => {
        const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
        if (!fromDate || fromDate >= todayStr) return Promise.resolve(true);
        return new Promise((resolve) => {
            setConfirmConfig({
                show: true,
                message: `From Date ${fromDate} is in the past. Attendance already recorded from that date will be re-evaluated against this shift, which can change days that are already settled. Apply anyway?`,
                onConfirm: () => resolve(true),
                onCancel: () => resolve(false)
            });
        });
    };

    const handleOverrideExecute = async () => {
        if (!selectedShiftId) return showAlert('Select a shift protocol', 'error');
        if (selectedEmployees.length === 0) return showAlert('Select personnel', 'error');

        const allowBackdate = await confirmBackdate(overrideConfig.from_date);
        if (!allowBackdate) return;

        try {
            setLoading(true);
            await api.post('/attendance/shift-override', {
                employee_ids: selectedEmployees.map(e => e.id),
                shift_id: selectedShiftId,
                from_date: overrideConfig.from_date,
                to_date: overrideConfig.to_date || null,
                allow_backdate: true
            });

            setSuccess(true);
            setTimeout(() => setSuccess(false), 3000);
            setSelectedEmployees([]);
            setSelectedShiftId('');
            setViewMode('list');
            fetchData();
        } catch (err) {
            showAlert(err.message, 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleEditShift = (shift, e) => {
        if (e) e.stopPropagation();
        setEditingShiftId(shift.id);
        setShiftConfig({
            name: shift.name || '',
            start_time: shift.start_time || '09:00',
            end_time: shift.end_time || '18:00',
            grace_period: shift.grace_period !== undefined ? shift.grace_period : 15,
            grace_count_limit: shift.grace_count_limit !== undefined ? shift.grace_count_limit : 3,
            from_date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' }),
            to_date: '',
            is_night_shift: !!shift.is_night_shift,
            is_flexi: !!shift.is_flexi,
            min_hours: shift.min_hours !== undefined && shift.min_hours !== null ? String(shift.min_hours) : '8.0',
            min_hours_half: shift.min_hours !== undefined && shift.min_hours !== null ? String(shift.min_hours / 2) : '4.0',
            total_punches_required: shift.total_punches_required !== undefined ? shift.total_punches_required : 2,
            session2_start_time: shift.session2_start_time || '14:00',
            session2_end_time: shift.session2_end_time || '18:00',
            session1_grace_out: shift.session1_grace_out !== undefined ? shift.session1_grace_out : 0,
            session2_grace_in: shift.session2_grace_in !== undefined ? shift.session2_grace_in : 15,
            session2_grace_out: shift.session2_grace_out !== undefined ? shift.session2_grace_out : 0,
            session1_in_margin: shift.session1_in_margin !== undefined ? shift.session1_in_margin : 0,
            session1_out_margin: shift.session1_out_margin !== undefined ? shift.session1_out_margin : 0,
            session2_in_margin: shift.session2_in_margin !== undefined ? shift.session2_in_margin : 0,
            session2_out_margin: shift.session2_out_margin !== undefined ? shift.session2_out_margin : 0,
            terminate_hour: shift.terminate_hour !== undefined && shift.terminate_hour !== null ? shift.terminate_hour : ''
        });
        setViewMode('assign');
    };

    const handleSave = async (e) => {
        if (e) e.preventDefault();
        if (!shiftConfig.name) return showAlert('Shift Name is required', 'error');

        // Saving a shift also assigns it when personnel are selected, so the same backdate
        // confirmation applies here as on the override screen.
        if (selectedEmployees.length > 0 && !(await confirmBackdate(shiftConfig.from_date))) return;

        try {
            setLoading(true);
            const postData = {
                name: shiftConfig.name,
                start_time: shiftConfig.is_flexi ? '00:00' : shiftConfig.start_time,
                end_time: shiftConfig.is_flexi ? '23:59' : shiftConfig.end_time,
                grace_period: shiftConfig.is_flexi ? 0 : shiftConfig.grace_period,
                grace_count_limit: shiftConfig.is_flexi ? 0 : shiftConfig.grace_count_limit,
                is_night_shift: shiftConfig.is_flexi ? false : shiftConfig.is_night_shift,
                is_flexi: shiftConfig.is_flexi,
                min_hours: parseFloat(shiftConfig.min_hours) || 8.0,
                total_punches_required: parseInt(shiftConfig.total_punches_required) || 2,
                session2_start_time: shiftConfig.total_punches_required === 4 ? shiftConfig.session2_start_time : null,
                session2_end_time: shiftConfig.total_punches_required === 4 ? shiftConfig.session2_end_time : null,
                session1_grace_out: parseInt(shiftConfig.session1_grace_out) || 0,
                session2_grace_in: parseInt(shiftConfig.session2_grace_in) || 15,
                session2_grace_out: parseInt(shiftConfig.session2_grace_out) || 0,
                session1_in_margin: parseInt(shiftConfig.session1_in_margin) || 0,
                session1_out_margin: parseInt(shiftConfig.session1_out_margin) || 0,
                session2_in_margin: parseInt(shiftConfig.session2_in_margin) || 0,
                session2_out_margin: parseInt(shiftConfig.session2_out_margin) || 0,
                terminate_hour: shiftConfig.terminate_hour !== '' && shiftConfig.terminate_hour !== undefined && shiftConfig.terminate_hour !== null ? parseInt(shiftConfig.terminate_hour) : null
            };

            if (editingShiftId) {
                // Update existing shift parameters
                await api.put(`/attendance/shift-list/${editingShiftId}`, postData);

                // Assign to employees if any are selected during edit
                if (selectedEmployees.length > 0) {
                    await api.post('/attendance/shift-override', {
                        employee_ids: selectedEmployees.map(e => e.id),
                        shift_id: editingShiftId,
                        from_date: shiftConfig.from_date,
                        to_date: shiftConfig.to_date || null,
                        allow_backdate: true
                    });
                }

                showAlert('Shift updated successfully!', 'success');
            } else {
                // Create new shift protocol
                const shiftRes = await api.post('/attendance/shift-list', postData);

                if (selectedEmployees.length > 0) {
                    await api.post('/attendance/shift-override', {
                        employee_ids: selectedEmployees.map(e => e.id),
                        shift_id: shiftRes.id,
                        from_date: shiftConfig.from_date,
                        to_date: shiftConfig.to_date || null,
                        allow_backdate: true
                    });
                }
                showAlert('Shift created successfully!', 'success');
            }

            setSuccess(true);
            setTimeout(() => setSuccess(false), 3000);
            setSelectedEmployees([]);
            setEditingShiftId(null);
            setShiftConfig({
                name: '',
                start_time: '',
                end_time: '',
                grace_period: '',
                grace_count_limit: '',
                from_date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' }),
                to_date: '',
                is_night_shift: false,
                is_flexi: false,
                min_hours: '',
                min_hours_half: '',
                total_punches_required: 2,
                session2_start_time: '',
                session2_end_time: '',
                session1_grace_out: '',
                session2_grace_in: '',
                session2_grace_out: '',
                session1_in_margin: '',
                session1_out_margin: '',
                session2_in_margin: '',
                session2_out_margin: '',
                terminate_hour: ''
            });
            setViewMode('list');
            fetchData();
        } catch (err) {
            showAlert(err.message, 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteShift = async (id, e) => {
        if (e) e.stopPropagation();
        if (id === 1 || String(id) === '1') {
            showAlert('Cannot delete the primary General Shift.', 'error');
            return;
        }
        triggerConfirm(
            'Are you sure you want to delete this shift? Active employees will default back to General Shift timings.',
            async () => {
                try {
                    setLoading(true);
                    await api.delete(`/attendance/shift-list/${id}`);
                    fetchData();
                    showAlert('Shift deleted successfully!', 'success');
                } catch (err) {
                    showAlert(err.response?.data?.message || 'Failed to delete shift', 'error');
                } finally {
                    setLoading(false);
                }
            }
        );
    };

    const filteredEmployees = React.useMemo(() => {
        return employees.filter(emp => {
            const fullName = `${emp.first_name || ''} ${emp.last_name || ''}`.toLowerCase();
            const search = searchQuery.toLowerCase();
            const empId = (emp.employee_id_number || '').toLowerCase();
            const matchesSearch = fullName.includes(search) || empId.includes(search);
            const matchesOutlet = matchText(emp.office_location, selectedOutlet);
            const matchesDept = matchText(emp.department_name || emp.department, selectedDept);
            const matchesDesignation = matchText(emp.designation, selectedDesignation);
            const matchesAssignment = selectedAssignmentStatus === 'all'
                ? true
                : selectedAssignmentStatus === 'assigned'
                    ? !!emp.assigned_shift
                    : !emp.assigned_shift;
            return matchesSearch && matchesOutlet && matchesDept && matchesDesignation && matchesAssignment;
        });
    }, [employees, searchQuery, selectedOutlet, selectedDept, selectedDesignation, selectedAssignmentStatus]);

    const handleExport = () => {
        if (!filteredEmployees || filteredEmployees.length === 0) {
            alert("No data available to export.");
            return;
        }
        const dataToExport = filteredEmployees.map(emp => ({
            "Employee Code": emp.employee_id_number,
            "Employee Name": `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
            "Assigned Shift": emp.assigned_shift || 'Unassigned',
            "Status": emp.assigned_shift ? 'Active' : 'Inactive'
        }));
        exportToCSV(dataToExport, "Personnel_Shift_Assignments.csv");
    };

    if (fetching) return (
        <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
            <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Loading shifts...</p>
        </div>
    );

    return (
        <div className="max-w-[1200px] mx-auto p-4 space-y-6 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex justify-between items-center bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white">
                        <Clock size={16} />
                    </div>
                    <div>
                        <h1 className="text-lg font-black text-slate-800 tracking-tight flex items-center gap-2">
                            Shift Management
                        </h1>
                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">Shift Guidelines & Assignments</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {viewMode === 'list' ? (
                        <>
                            <button
                                onClick={() => setViewMode('override')}
                                className="flex items-center gap-2 px-6 py-2 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg"
                            >
                                <Zap size={14} />
                                Override Shift
                            </button>
                            <button
                                onClick={() => {
                                    setEditingShiftId(null);
                                    setShiftConfig({
                                        name: '',
                                        start_time: '',
                                        end_time: '',
                                        grace_period: '',
                                        grace_count_limit: '',
                                        from_date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' }),
                                        to_date: '',
                                        is_night_shift: false,
                                        is_flexi: false,
                                        min_hours: '',
                                        min_hours_half: '',
                                        total_punches_required: 2,
                                        session2_start_time: '',
                                        session2_end_time: '',
                                        session1_grace_out: '',
                                        session2_grace_in: '',
                                        session2_grace_out: '',
                                        session1_in_margin: '',
                                        session1_out_margin: '',
                                        session2_in_margin: '',
                                        session2_out_margin: '',
                                        terminate_hour: ''
                                    });
                                    setViewMode('assign');
                                }}
                                className="flex items-center gap-2 px-6 py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100"
                            >
                                <Plus size={14} />
                                Add New Shift
                            </button>
                        </>
                    ) : (
                        <button
                            onClick={() => {
                                setViewMode('list');
                                setSelectedEmployees([]);
                                setSelectedShiftId('');
                                setEditingShiftId(null);
                            }}
                            className="flex items-center gap-2 px-6 py-2 bg-slate-100 text-slate-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-all"
                        >
                            <X size={14} />
                            Back to Overview
                        </button>
                    )}
                </div>
            </div>

            {viewMode === 'list' ? (
                <div className="space-y-6">
                    {/* Stats */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {[
                            { label: 'Total Staff', value: filteredEmployees.length, icon: Users, color: 'text-indigo-600', bg: 'bg-indigo-50' },
                            { 
                                label: 'Active Shifts', 
                                value: (selectedOutlet !== 'all' || selectedDept !== 'all' || selectedDesignation !== 'all' || selectedAssignmentStatus !== 'all' || searchQuery.trim() !== '') 
                                    ? new Set(filteredEmployees.map(e => e.assigned_shift).filter(Boolean)).size 
                                    : shifts.length, 
                                icon: Clock, 
                                color: 'text-emerald-600', 
                                bg: 'bg-emerald-50' 
                            },
                            { label: 'Assigned', value: filteredEmployees.filter(e => e.assigned_shift).length, icon: UserCheck, color: 'text-amber-600', bg: 'bg-amber-50' },
                            { label: 'Unassigned', value: filteredEmployees.filter(e => !e.assigned_shift).length, icon: Info, color: 'text-rose-600', bg: 'bg-rose-50' }
                        ].map((stat, i) => (
                            <div key={i} className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-3">
                                <div className={`w-8 h-8 rounded-lg ${stat.bg} ${stat.color} flex items-center justify-center`}>
                                    <stat.icon size={16} />
                                </div>
                                <div>
                                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">{stat.label}</p>
                                    <p className="text-lg font-black text-slate-800 leading-none">{stat.value}</p>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Shift Protocol Guidelines */}
                    <AnimatePresence>
                        {showRules && (
                            <motion.div
                                initial={{ opacity: 0, height: 0, y: -10 }}
                                animate={{ opacity: 1, height: 'auto', y: 0 }}
                                exit={{ opacity: 0, height: 0, y: -10 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                            >
                                <div className="bg-gradient-to-r from-purple-500/10 via-indigo-500/5 to-transparent border border-indigo-100 rounded-3xl p-5 shadow-sm">
                                    <div className="flex items-center gap-2 text-indigo-700 font-black text-xs uppercase tracking-wider mb-2">
                                        <Clock size={16} className="text-indigo-600" />
                                        Shift rules & calculation logic
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-xs text-slate-600 mt-2">
                                        <div>
                                            <h4 className="font-extrabold text-slate-700 uppercase tracking-wider text-[10px] mb-1">
                                                ⏱️ Punch Timing & Grace Rules
                                            </h4>
                                            <p className="text-slate-500 leading-relaxed font-bold">
                                                Employees checking in inside the <span className="text-slate-700 font-extrabold">Grace Period</span> (e.g. 15 mins) are marked Present directly. Punching after the grace limit triggers a <span className="text-indigo-600 bg-indigo-50 px-1 rounded font-extrabold">Late Mark</span> which requires manager regularization.
                                            </p>
                                        </div>
                                        <div>
                                            <h4 className="font-extrabold text-slate-700 uppercase tracking-wider text-[10px] mb-1">
                                                ⚙️ Worked Hours Calculations & Early Out
                                            </h4>
                                            <p className="text-slate-500 leading-relaxed font-bold">
                                                Calculated automatically: Under <span className="text-rose-600 bg-rose-50 px-1 rounded font-extrabold">Half Day Minimum Hours</span> = Absent (checkouts before this do not trigger early-out approval requests). Early-out requests are only generated if punching out after completing half-day hours but before full shift.
                                            </p>
                                        </div>
                                        <div>
                                            <h4 className="font-extrabold text-slate-700 uppercase tracking-wider text-[10px] mb-1">
                                                🚨 Zero Check-In Checkout Attempt
                                            </h4>
                                            <p className="text-slate-500 leading-relaxed font-bold">
                                                If an employee punches for the first time within 2 hours of shift end or later, it is marked as <span className="text-rose-600 bg-rose-50 px-1 rounded font-extrabold">NC (Checkout Attempt - Zero Check-In)</span> instead of a late check-in.
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                        {/* Defined Shifts Panel */}
                        <div className="lg:col-span-4 space-y-4">
                            <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm h-full">
                                <h3 className="text-[10px] font-black text-slate-800 uppercase tracking-widest mb-4 flex items-center gap-2">
                                    <Layout size={14} className="text-indigo-600" />
                                    Active Protocols
                                </h3>
                                <div className="space-y-3">
                                    {shifts.length === 0 ? (
                                        <div className="py-10 text-center opacity-40">
                                            <Clock size={24} className="mx-auto mb-2" />
                                            <p className="text-[9px] font-black uppercase tracking-widest">No Shifts Found</p>
                                        </div>
                                    ) : (
                                        shifts.map(shift => (
                                            <div key={shift.id} className="p-3 rounded-xl border border-slate-50 bg-slate-50/50 group hover:border-indigo-100 transition-all">
                                                <div className="flex justify-between items-center mb-1">
                                                    <span className="text-[10px] font-black text-slate-700 uppercase">{shift.name}</span>
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="text-[8px] font-bold text-indigo-600 bg-white px-1.5 py-0.5 rounded border border-indigo-50">
                                                            {shift.is_flexi ? 'Flexi' : (shift.total_punches_required === 4 ? `Split (${shift.start_time}-${shift.end_time} & ${shift.session2_start_time || '14:00'}-${shift.session2_end_time || '18:00'})` : `${shift.start_time}-${shift.end_time}`)}
                                                        </span>
                                                        <button
                                                            onClick={(e) => handleEditShift(shift, e)}
                                                            className="text-slate-350 hover:text-indigo-600 transition-colors p-0.5 rounded hover:bg-slate-100"
                                                            title="Edit Shift"
                                                        >
                                                            <Edit2 size={12} />
                                                        </button>
                                                        {shift.id !== 1 && shift.id !== '1' && (
                                                            <button
                                                                onClick={(e) => handleDeleteShift(shift.id, e)}
                                                                className="text-slate-350 hover:text-rose-600 transition-colors p-0.5 rounded hover:bg-slate-100"
                                                                title="Delete Shift"
                                                            >
                                                                <Trash2 size={12} />
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="flex flex-col gap-1 text-[8px] font-bold text-slate-400 uppercase tracking-tighter mt-1">
                                                    <div>Punches Required: {shift.total_punches_required || 2}</div>
                                                    {shift.is_flexi ? (
                                                        <div className="mt-1">Min Hours: {shift.min_hours}h</div>
                                                    ) : (
                                                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-1.5 border-t border-slate-100 pt-1.5">
                                                            <div>
                                                                <p className="text-slate-500 font-extrabold text-[8px] mb-0.5">Session 1</p>
                                                                <div className="text-[7.5px] leading-relaxed text-slate-400 normal-case font-medium">
                                                                    Grace: <span className="font-bold">{shift.grace_period || 15}m</span> / <span className="font-bold">{shift.session1_grace_out || 0}m</span><br />
                                                                    Margin: <span className="font-bold">{shift.session1_in_margin || 0}m</span> / <span className="font-bold">{shift.session1_out_margin || 0}m</span>
                                                                </div>
                                                            </div>
                                                            {shift.total_punches_required === 4 && (
                                                                <div>
                                                                    <p className="text-slate-500 font-extrabold text-[8px] mb-0.5">Session 2</p>
                                                                    <div className="text-[7.5px] leading-relaxed text-slate-400 normal-case font-medium">
                                                                        Grace: <span className="font-bold">{shift.session2_grace_in || 15}m</span> / <span className="font-bold">{shift.session2_grace_out || 0}m</span><br />
                                                                        Margin: <span className="font-bold">{shift.session2_in_margin || 0}m</span> / <span className="font-bold">{shift.session2_out_margin || 0}m</span>
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Personnel Status Matrix */}
                        <div className="lg:col-span-8">
                            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                                <div className="p-4 border-b border-slate-50 flex items-center justify-between flex-wrap gap-2">
                                    <div className="flex items-center gap-3 flex-wrap">
                                        <h3 className="text-[10px] font-black text-slate-800 uppercase tracking-widest">Personnel Status</h3>
                                        <div className="relative">
                                            <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                            <input
                                                type="text"
                                                placeholder="Quick filter..."
                                                value={searchQuery}
                                                onChange={(e) => setSearchQuery(e.target.value)}
                                                className="bg-slate-50 border border-slate-100 rounded-lg pl-8 pr-3 py-1.5 text-[10px] font-bold outline-none focus:border-indigo-300 w-48"
                                            />
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3 flex-wrap">
                                        <button
                                            type="button"
                                            onClick={handleExport}
                                            className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all shadow-sm cursor-pointer active:scale-95"
                                        >
                                            <Download size={11} /> Export CSV
                                        </button>
                                        <select
                                            value={selectedOutlet}
                                            onChange={(e) => setSelectedOutlet(e.target.value)}
                                            className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-[10px] font-bold outline-none focus:border-indigo-300"
                                        >
                                            {uniqueLocations.map(loc => (
                                                <option key={loc} value={loc}>
                                                    {loc === 'all' ? 'All Outlets' : loc}
                                                </option>
                                            ))}
                                        </select>
                                        <select
                                            value={selectedDept}
                                            onChange={(e) => setSelectedDept(e.target.value)}
                                            className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-[10px] font-bold outline-none focus:border-indigo-300"
                                        >
                                            {uniqueDepts.map(dept => (
                                                <option key={dept} value={dept}>
                                                    {dept === 'all' ? 'All Departments' : dept}
                                                </option>
                                            ))}
                                        </select>
                                        <select
                                            value={selectedDesignation}
                                            onChange={(e) => setSelectedDesignation(e.target.value)}
                                            className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-[10px] font-bold outline-none focus:border-indigo-300"
                                        >
                                            {uniqueDesignations.map(desg => (
                                                <option key={desg} value={desg}>
                                                    {desg === 'all' ? 'All Designations' : desg}
                                                </option>
                                            ))}
                                        </select>
                                        <select
                                            value={selectedAssignmentStatus}
                                            onChange={(e) => setSelectedAssignmentStatus(e.target.value)}
                                            className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-[10px] font-bold outline-none focus:border-indigo-300"
                                        >
                                            <option value="all">All Status</option>
                                            <option value="assigned">Assigned</option>
                                            <option value="unassigned">Unassigned</option>
                                        </select>
                                    </div>
                                </div>
                                <div className="max-h-[500px] overflow-y-auto custom-scrollbar">
                                    <table className="w-full text-left">
                                        <thead className="sticky top-0 bg-slate-50 z-10">
                                            <tr>
                                                <th className="px-5 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest">Employee</th>
                                                <th className="px-5 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest">Assigned Shift</th>
                                                <th className="px-5 py-3 text-[9px] font-black text-slate-400 uppercase tracking-widest text-right">Status</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-50">
                                            {filteredEmployees.map(emp => (
                                                <tr key={emp.id} className="hover:bg-slate-50/50 transition-all">
                                                    <td className="px-5 py-3">
                                                        <div className="flex items-center gap-3">
                                                            <div className="w-7 h-7 rounded-lg bg-slate-100 text-slate-400 flex items-center justify-center text-[9px] font-black uppercase">
                                                                {(emp.first_name?.[0] || '')}{(emp.last_name?.[0] || '')}
                                                            </div>
                                                            <div>
                                                                <p className="text-[11px] font-black text-slate-700 uppercase leading-none">{emp.first_name} {emp.last_name}</p>
                                                                <p className="text-[8px] font-bold text-slate-400 uppercase tracking-tighter">#{emp.employee_id_number}</p>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="px-5 py-3">
                                                         {emp.assigned_shift ? (
                                                             <div className="flex flex-col gap-0.5">
                                                                 <span className="text-[10px] font-black text-slate-600 uppercase leading-none">{emp.assigned_shift}</span>
                                                                 <span className="text-[8px] font-bold text-slate-400 normal-case">
                                                                     {emp.assigned_from_date ? `Valid: ${emp.assigned_from_date}` : ''}
                                                                     {emp.assigned_to_date ? ` to ${emp.assigned_to_date}` : ' onwards'}
                                                                 </span>
                                                             </div>
                                                         ) : (
                                                             <span className="text-[9px] font-bold text-slate-300 uppercase italic">Unassigned</span>
                                                         )}
                                                         {emp.upcoming_shift && (
                                                             <div className="flex flex-col gap-0.5 mt-1 border-t border-slate-100 pt-1">
                                                                 <span className="text-[8px] font-black text-indigo-650 text-indigo-600 uppercase leading-none">Upcoming: {emp.upcoming_shift}</span>
                                                                 <span className="text-[7.5px] font-bold text-indigo-400 normal-case">
                                                                     Starts: {emp.upcoming_from_date}
                                                                     {emp.upcoming_to_date ? ` to ${emp.upcoming_to_date}` : ''}
                                                                 </span>
                                                             </div>
                                                         )}
                                                     </td>
                                                     <td className="px-5 py-3 text-right">
                                                         <span className={`inline-flex px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-tighter ${
                                                             emp.assigned_shift ? 'bg-emerald-50 text-emerald-600' :
                                                             emp.upcoming_shift ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-50 text-slate-400'
                                                         }`}>
                                                             {emp.assigned_shift ? 'Active' : emp.upcoming_shift ? 'Upcoming' : 'Inactive'}
                                                         </span>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            ) : viewMode === 'assign' ? (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start animate-in slide-in-from-bottom-4 duration-500 pb-20">
                    {/* Assignment Form */}
                    <div className="lg:col-span-12 space-y-4">
                        <div className="bg-white rounded-[32px] border border-slate-100 shadow-xl p-8 space-y-8">
                            <div className="flex items-center justify-between pb-4 border-b border-slate-50">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-2xl bg-indigo-50 flex items-center justify-center text-indigo-600">
                                        <Plus size={20} />
                                    </div>
                                    <div>
                                        <h3 className="text-sm font-black text-slate-800 uppercase tracking-widest leading-none">
                                            {editingShiftId ? 'Edit Shift Protocol' : 'Add New Shift'}
                                        </h3>
                                        <p className="text-[10px] font-bold text-slate-400 mt-1 uppercase">
                                            {editingShiftId ? 'Update timing details and rules for this shift' : 'Define timing protocols and session margins'}
                                        </p>
                                    </div>
                                </div>
                                <button
                                    onClick={handleSave}
                                    disabled={loading}
                                    className="px-8 py-3 bg-indigo-600 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 flex items-center gap-2"
                                >
                                    {loading ? 'Processing...' : <><Save size={14} /> Save Shift Protocol</>}
                                </button>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Shift Name</label>
                                    <input
                                        type="text"
                                        placeholder="e.g. Standard General"
                                        value={shiftConfig.name}
                                        onChange={(e) => setShiftConfig({ ...shiftConfig, name: e.target.value })}
                                        className="w-full h-12 bg-slate-50 border border-slate-200 rounded-2xl px-5 text-xs font-bold text-slate-700 outline-none focus:bg-white focus:border-indigo-500 transition-all"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Shift Code</label>
                                    <input
                                        type="text"
                                        placeholder="e.g. SG-01"
                                        className="w-full h-12 bg-slate-50 border border-slate-200 rounded-2xl px-5 text-xs font-bold text-slate-700 outline-none focus:bg-white focus:border-indigo-500 transition-all"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Time Zone</label>
                                    <select 
                                        defaultValue="(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi"
                                        className="w-full h-12 bg-slate-50 border border-slate-200 rounded-2xl px-5 text-xs font-bold text-slate-700 outline-none focus:bg-white focus:border-indigo-500 transition-all appearance-none"
                                    >
                                        <option value="">Select Time Zone</option>
                                        <option value="(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi">(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi</option>
                                    </select>
                                </div>
                            </div>

                            <div className="bg-slate-50/50 p-6 rounded-[24px] border border-slate-100 space-y-4">
                                <p className="text-[10px] font-black text-slate-800 uppercase tracking-widest flex items-center gap-1.5">
                                    Required Punches per Day
                                    <span className="cursor-help text-slate-400 hover:text-indigo-600 relative group">
                                        <Info size={12} />
                                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-slate-900 text-white text-[9px] rounded shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity font-bold uppercase leading-tight z-50">
                                            2 Punches: One In, One Out. 4 Punches: Session 1 In/Out & Session 2 In/Out (requires break punches).
                                        </span>
                                    </span>
                                </p>
                                <div className="flex gap-8">
                                    <label className="flex items-center gap-2 cursor-pointer group">
                                        <input
                                            type="radio"
                                            name="total_punches_required"
                                            checked={parseInt(shiftConfig.total_punches_required) === 2}
                                            onChange={() => {
                                                const newMinHours = getDurationFromTimes(shiftConfig.start_time, shiftConfig.end_time, shiftConfig.session2_start_time, shiftConfig.session2_end_time, 2);
                                                setShiftConfig({ ...shiftConfig, total_punches_required: 2, min_hours: String(newMinHours), min_hours_half: String(newMinHours / 2) });
                                            }}
                                            className="accent-indigo-600"
                                        />
                                        <span className="text-xs font-bold text-slate-600 group-hover:text-slate-800 transition-colors">2 Punches (Single Session)</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer group">
                                        <input
                                            type="radio"
                                            name="total_punches_required"
                                            checked={parseInt(shiftConfig.total_punches_required) === 4}
                                            onChange={() => {
                                                const newMinHours = getDurationFromTimes(shiftConfig.start_time, shiftConfig.end_time, shiftConfig.session2_start_time, shiftConfig.session2_end_time, 4);
                                                setShiftConfig({ ...shiftConfig, total_punches_required: 4, min_hours: String(newMinHours), min_hours_half: String(newMinHours / 2) });
                                            }}
                                            className="accent-indigo-600"
                                        />
                                        <span className="text-xs font-bold text-slate-600 group-hover:text-slate-800 transition-colors">4 Punches (Double Session / Split Shift)</span>
                                    </label>
                                </div>
                            </div>

                            <div className="overflow-visible rounded-2xl border border-slate-100">
                                <table className="w-full text-left border-collapse">
                                    <thead>
                                        <tr className="bg-slate-50 text-slate-500 uppercase">
                                            <th className="px-6 py-4 text-[10px] font-black tracking-widest">Session</th>
                                            <th className="px-4 py-4 text-[10px] font-black tracking-widest">
                                                <div className="flex items-center gap-1">
                                                    In Time
                                                    <span className="cursor-help text-slate-400 hover:text-indigo-600 relative group normal-case">
                                                        <Info size={11} />
                                                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2.5 bg-slate-900 text-white text-[9px] rounded-lg shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity font-medium normal-case leading-normal z-50">
                                                            Official start time of the session (e.g. 09:00 AM). Check-ins after this time will be compared against the Grace In limit.
                                                        </span>
                                                    </span>
                                                </div>
                                            </th>
                                            <th className="px-4 py-4 text-[10px] font-black tracking-widest">
                                                <div className="flex items-center gap-1">
                                                    Out Time
                                                    <span className="cursor-help text-slate-400 hover:text-indigo-600 relative group normal-case">
                                                        <Info size={11} />
                                                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2.5 bg-slate-900 text-white text-[9px] rounded-lg shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity font-medium normal-case leading-normal z-50">
                                                            Official end time of the session (e.g. 06:00 PM). Check-outs before this time will be verified against Grace Out/Out Margin to trigger early checkout request.
                                                        </span>
                                                    </span>
                                                </div>
                                            </th>
                                            <th className="px-4 py-4 text-[10px] font-black tracking-widest">
                                                <div className="flex items-center gap-1">
                                                    Grace In (Mins)
                                                    <span className="cursor-help text-slate-400 hover:text-indigo-600 relative group normal-case">
                                                        <Info size={11} />
                                                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2.5 bg-slate-900 text-white text-[9px] rounded-lg shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity font-medium normal-case leading-normal z-50">
                                                            Allowed delay after In Time (e.g. 30 mins for 09:00 AM start means up to 09:30 AM is marked Present). Exceeding this or monthly Grace Cap triggers Late In request.
                                                        </span>
                                                    </span>
                                                </div>
                                            </th>
                                            <th className="px-4 py-4 text-[10px] font-black tracking-widest">
                                                <div className="flex items-center gap-1">
                                                    Grace Out (Mins)
                                                    <span className="cursor-help text-slate-400 hover:text-indigo-600 relative group normal-case">
                                                        <Info size={11} />
                                                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2.5 bg-slate-900 text-white text-[9px] rounded-lg shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity font-medium normal-case leading-normal z-50">
                                                            Allowed early check-out buffer before Out Time without request (e.g. if 15 mins for 06:00 PM shift, checking out after 05:45 PM is allowed without request).
                                                        </span>
                                                    </span>
                                                </div>
                                            </th>
                                            <th className="px-4 py-4 text-[10px] font-black tracking-widest">
                                                <div className="flex items-center gap-1">
                                                    In Margin (Mins)
                                                    <span className="cursor-help text-slate-400 hover:text-indigo-600 relative group normal-case">
                                                        <Info size={11} />
                                                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2.5 bg-slate-900 text-white text-[9px] rounded-lg shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity font-medium normal-case leading-normal z-50">
                                                            Allowed early check-in window before In Time (e.g. if 30 mins for 09:00 AM start, earliest check-in is 08:30 AM). Punches before this window are blocked.
                                                        </span>
                                                    </span>
                                                </div>
                                            </th>
                                            <th className="px-4 py-4 text-[10px] font-black tracking-widest">
                                                <div className="flex items-center gap-1">
                                                    Out Margin (Mins)
                                                    <span className="cursor-help text-slate-400 hover:text-indigo-600 relative group normal-case">
                                                        <Info size={11} />
                                                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2.5 bg-slate-900 text-white text-[9px] rounded-lg shadow-lg opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity font-medium normal-case leading-normal z-50">
                                                            Allowed checkout window before Out Time (e.g. if 60 mins for 06:00 PM shift, checks out after 05:00 PM are allowed, but checks out before 05:00 PM are blocked).
                                                        </span>
                                                    </span>
                                                </div>
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-50">
                                        <tr>
                                            <td className="px-6 py-4 text-xs font-bold text-slate-600">Session 1</td>
                                            <td className="px-2 py-4">
                                                <input
                                                    type="time"
                                                    value={shiftConfig.is_flexi ? '00:00' : shiftConfig.start_time}
                                                    disabled={shiftConfig.is_flexi}
                                                    onChange={(e) => {
                                                        const val = e.target.value;
                                                        const d = getDurationFromTimes(val, shiftConfig.end_time, shiftConfig.session2_start_time, shiftConfig.session2_end_time, shiftConfig.total_punches_required);
                                                        setShiftConfig({ ...shiftConfig, start_time: val, min_hours: String(d), min_hours_half: String(d / 2) });
                                                    }}
                                                    className="h-10 bg-white border border-slate-200 rounded-lg px-2 text-xs font-bold outline-none focus:border-indigo-500 disabled:opacity-50"
                                                />
                                            </td>
                                            <td className="px-2 py-4">
                                                <input
                                                    type="time"
                                                    value={shiftConfig.is_flexi ? '23:59' : shiftConfig.end_time}
                                                    disabled={shiftConfig.is_flexi}
                                                    onChange={(e) => {
                                                        const val = e.target.value;
                                                        const d = getDurationFromTimes(shiftConfig.start_time, val, shiftConfig.session2_start_time, shiftConfig.session2_end_time, shiftConfig.total_punches_required);
                                                        setShiftConfig({ ...shiftConfig, end_time: val, min_hours: String(d), min_hours_half: String(d / 2) });
                                                    }}
                                                    className="h-10 bg-white border border-slate-200 rounded-lg px-2 text-xs font-bold outline-none focus:border-indigo-500 disabled:opacity-50"
                                                />
                                            </td>
                                            <td className="px-2 py-4">
                                                <input
                                                    type="number"
                                                    placeholder="15"
                                                    value={shiftConfig.is_flexi ? 0 : shiftConfig.grace_period}
                                                    disabled={shiftConfig.is_flexi}
                                                    onChange={(e) => setShiftConfig({ ...shiftConfig, grace_period: e.target.value === '' ? '' : parseInt(e.target.value) || 0 })}
                                                    className="h-10 w-24 bg-white border border-slate-200 rounded-lg px-2 text-xs font-bold outline-none focus:border-indigo-500 disabled:opacity-50"
                                                />
                                            </td>
                                            <td className="px-2 py-4">
                                                <input
                                                    type="number"
                                                    placeholder="0"
                                                    value={shiftConfig.is_flexi ? 0 : shiftConfig.session1_grace_out}
                                                    disabled={shiftConfig.is_flexi}
                                                    onChange={(e) => setShiftConfig({ ...shiftConfig, session1_grace_out: e.target.value === '' ? '' : parseInt(e.target.value) || 0 })}
                                                    className="h-10 w-24 bg-white border border-slate-200 rounded-lg px-2 text-xs font-bold outline-none focus:border-indigo-500 disabled:opacity-50"
                                                />
                                            </td>
                                            <td className="px-2 py-4">
                                                <input
                                                    type="number"
                                                    placeholder="0"
                                                    value={shiftConfig.is_flexi ? 0 : shiftConfig.session1_in_margin}
                                                    disabled={shiftConfig.is_flexi}
                                                    onChange={(e) => setShiftConfig({ ...shiftConfig, session1_in_margin: e.target.value === '' ? '' : parseInt(e.target.value) || 0 })}
                                                    className="h-10 w-24 bg-white border border-slate-200 rounded-lg px-2 text-xs font-bold outline-none focus:border-indigo-500 disabled:opacity-50"
                                                />
                                            </td>
                                            <td className="px-2 py-4">
                                                <input
                                                    type="number"
                                                    placeholder="0"
                                                    value={shiftConfig.is_flexi ? 0 : shiftConfig.session1_out_margin}
                                                    disabled={shiftConfig.is_flexi}
                                                    onChange={(e) => setShiftConfig({ ...shiftConfig, session1_out_margin: e.target.value === '' ? '' : parseInt(e.target.value) || 0 })}
                                                    className="h-10 w-24 bg-white border border-slate-200 rounded-lg px-2 text-xs font-bold outline-none focus:border-indigo-500 disabled:opacity-50"
                                                />
                                            </td>
                                        </tr>
                                        <tr className={parseInt(shiftConfig.total_punches_required) !== 4 ? 'opacity-40' : ''}>
                                            <td className="px-6 py-4 text-xs font-bold text-slate-600 flex items-center gap-1">
                                                Session 2
                                                {parseInt(shiftConfig.total_punches_required) !== 4 && (
                                                    <span className="text-[8px] font-black uppercase text-amber-500 bg-amber-50 px-1 py-0.5 rounded">Disabled</span>
                                                )}
                                            </td>
                                            <td className="px-2 py-4">
                                                <input
                                                    type="time"
                                                    value={shiftConfig.is_flexi ? '00:00' : shiftConfig.session2_start_time}
                                                    disabled={shiftConfig.is_flexi || parseInt(shiftConfig.total_punches_required) !== 4}
                                                    onChange={(e) => {
                                                        const val = e.target.value;
                                                        const d = getDurationFromTimes(shiftConfig.start_time, shiftConfig.end_time, val, shiftConfig.session2_end_time, shiftConfig.total_punches_required);
                                                        setShiftConfig({ ...shiftConfig, session2_start_time: val, min_hours: String(d), min_hours_half: String(d / 2) });
                                                    }}
                                                    className="h-10 bg-white border border-slate-200 rounded-lg px-2 text-xs font-bold outline-none focus:border-indigo-500 disabled:opacity-50"
                                                />
                                            </td>
                                            <td className="px-2 py-4">
                                                <input
                                                    type="time"
                                                    value={shiftConfig.is_flexi ? '23:59' : shiftConfig.session2_end_time}
                                                    disabled={shiftConfig.is_flexi || parseInt(shiftConfig.total_punches_required) !== 4}
                                                    onChange={(e) => {
                                                        const val = e.target.value;
                                                        const d = getDurationFromTimes(shiftConfig.start_time, shiftConfig.end_time, shiftConfig.session2_start_time, val, shiftConfig.total_punches_required);
                                                        setShiftConfig({ ...shiftConfig, session2_end_time: val, min_hours: String(d), min_hours_half: String(d / 2) });
                                                    }}
                                                    className="h-10 bg-white border border-slate-200 rounded-lg px-2 text-xs font-bold outline-none focus:border-indigo-500 disabled:opacity-50"
                                                />
                                            </td>
                                            <td className="px-2 py-4">
                                                <input
                                                    type="number"
                                                    placeholder="15"
                                                    value={shiftConfig.is_flexi ? 0 : shiftConfig.session2_grace_in}
                                                    disabled={shiftConfig.is_flexi || parseInt(shiftConfig.total_punches_required) !== 4}
                                                    onChange={(e) => setShiftConfig({ ...shiftConfig, session2_grace_in: e.target.value === '' ? '' : parseInt(e.target.value) || 0 })}
                                                    className="h-10 w-24 bg-white border border-slate-200 rounded-lg px-2 text-xs font-bold outline-none focus:border-indigo-500 disabled:opacity-50"
                                                />
                                            </td>
                                            <td className="px-2 py-4">
                                                <input
                                                    type="number"
                                                    placeholder="0"
                                                    value={shiftConfig.is_flexi ? 0 : shiftConfig.session2_grace_out}
                                                    disabled={shiftConfig.is_flexi || parseInt(shiftConfig.total_punches_required) !== 4}
                                                    onChange={(e) => setShiftConfig({ ...shiftConfig, session2_grace_out: e.target.value === '' ? '' : parseInt(e.target.value) || 0 })}
                                                    className="h-10 w-24 bg-white border border-slate-200 rounded-lg px-2 text-xs font-bold outline-none focus:border-indigo-500 disabled:opacity-50"
                                                />
                                            </td>
                                            <td className="px-2 py-4">
                                                <input
                                                    type="number"
                                                    placeholder="0"
                                                    value={shiftConfig.is_flexi ? 0 : shiftConfig.session2_in_margin}
                                                    disabled={shiftConfig.is_flexi || parseInt(shiftConfig.total_punches_required) !== 4}
                                                    onChange={(e) => setShiftConfig({ ...shiftConfig, session2_in_margin: e.target.value === '' ? '' : parseInt(e.target.value) || 0 })}
                                                    className="h-10 w-24 bg-white border border-slate-200 rounded-lg px-2 text-xs font-bold outline-none focus:border-indigo-500 disabled:opacity-50"
                                                />
                                            </td>
                                            <td className="px-2 py-4">
                                                <input
                                                    type="number"
                                                    placeholder="0"
                                                    value={shiftConfig.is_flexi ? 0 : shiftConfig.session2_out_margin}
                                                    disabled={shiftConfig.is_flexi || parseInt(shiftConfig.total_punches_required) !== 4}
                                                    onChange={(e) => setShiftConfig({ ...shiftConfig, session2_out_margin: e.target.value === '' ? '' : parseInt(e.target.value) || 0 })}
                                                    className="h-10 w-24 bg-white border border-slate-200 rounded-lg px-2 text-xs font-bold outline-none focus:border-indigo-500 disabled:opacity-50"
                                                />
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
                                <div className="space-y-6">
                                    <h4 className="text-[10px] font-black text-slate-800 uppercase tracking-widest border-b border-slate-50 pb-2">Minimum working hours to mark present:</h4>
                                    <div className="flex items-center gap-4">
                                        <span className="text-xs font-bold text-slate-500 w-24">For Half day</span>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="number"
                                                step="0.5"
                                                min="0"
                                                max="24"
                                                value={shiftConfig.min_hours_half}
                                                onChange={(e) => {
                                                    const val = e.target.value;
                                                    const parsed = parseFloat(val);
                                                    setShiftConfig({
                                                        ...shiftConfig,
                                                        min_hours_half: val,
                                                        min_hours: isNaN(parsed) ? '' : String(parsed * 2)
                                                    });
                                                }}
                                                className="w-20 h-10 bg-slate-50 border border-slate-200 rounded-lg text-center text-xs font-black outline-none focus:border-indigo-500 px-2"
                                            />
                                            <span className="text-[10px] font-black text-slate-400 uppercase">hours</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-4">
                                        <span className="text-xs font-bold text-slate-500 w-24">For Full day</span>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="number"
                                                step="0.5"
                                                min="0"
                                                max="24"
                                                value={shiftConfig.min_hours}
                                                onChange={(e) => {
                                                    const val = e.target.value;
                                                    const parsed = parseFloat(val);
                                                    setShiftConfig({
                                                        ...shiftConfig,
                                                        min_hours: val,
                                                        min_hours_half: isNaN(parsed) ? '' : String(parsed / 2)
                                                    });
                                                }}
                                                className="w-20 h-10 bg-slate-50 border border-slate-200 rounded-lg text-center text-xs font-black outline-none focus:border-indigo-500 px-2"
                                            />
                                            <span className="text-[10px] font-black text-slate-400 uppercase">hours</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-6">
                                    <h4 className="text-[10px] font-black text-slate-800 uppercase tracking-widest border-b border-slate-50 pb-2">Advanced Config:</h4>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-1">
                                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Grace Cap / Mo</label>
                                            <input
                                                type="number"
                                                value={shiftConfig.grace_count_limit}
                                                disabled={shiftConfig.is_flexi}
                                                onChange={(e) => setShiftConfig({ ...shiftConfig, grace_count_limit: e.target.value === '' ? '' : parseInt(e.target.value) || 0 })}
                                                className="w-full h-10 bg-slate-50 border border-slate-200 rounded-xl px-4 text-xs font-bold text-slate-700 outline-none disabled:opacity-50"
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Night Shift</label>
                                            <div className="flex items-center h-10">
                                                <input
                                                    type="checkbox"
                                                    checked={shiftConfig.is_night_shift}
                                                    disabled={shiftConfig.is_flexi}
                                                    onChange={(e) => setShiftConfig({ ...shiftConfig, is_night_shift: e.target.checked })}
                                                    className="w-4 h-4 accent-indigo-600 disabled:opacity-50"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-1">
                                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Flexi / Anytime Shift</label>
                                            <div className="flex items-center h-10">
                                                <input
                                                    type="checkbox"
                                                    checked={shiftConfig.is_flexi}
                                                    onChange={(e) => setShiftConfig({ ...shiftConfig, is_flexi: e.target.checked })}
                                                    className="w-4 h-4 accent-indigo-600"
                                                />
                                            </div>
                                        </div>
                                        {shiftConfig.is_flexi && (
                                            <div className="space-y-1">
                                                <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Min Hours Required</label>
                                                <input
                                                    type="number"
                                                    step="0.5"
                                                    value={shiftConfig.min_hours}
                                                    onChange={(e) => {
                                                        const val = e.target.value;
                                                        const parsed = parseFloat(val);
                                                        setShiftConfig({
                                                            ...shiftConfig,
                                                            min_hours: val,
                                                            min_hours_half: isNaN(parsed) ? '' : String(parsed / 2)
                                                        });
                                                    }}
                                                    className="w-full h-10 bg-slate-50 border border-slate-200 rounded-xl px-4 text-xs font-bold text-slate-700 outline-none"
                                                />
                                            </div>
                                        )}
                                    </div>

                                    <div className="space-y-1">
                                        <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Shift Terminate Hour</label>
                                        <input 
                                            type="number" 
                                            placeholder="e.g. 2 (Absent if no check-out after shift end + 2 hours)"
                                            value={shiftConfig.terminate_hour === undefined || shiftConfig.terminate_hour === null ? '' : shiftConfig.terminate_hour} 
                                            onChange={(e) => setShiftConfig({...shiftConfig, terminate_hour: e.target.value === '' ? '' : parseInt(e.target.value)})}
                                            className="w-full h-10 bg-slate-50 border border-slate-200 rounded-xl px-4 text-xs font-bold text-slate-700 outline-none" 
                                        />
                                        <span className="text-[8px] text-slate-400 font-bold block mt-0.5">Absent status is automatically marked if the employee exceeds this duration without punching out.</span>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-1">
                                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Valid From</label>
                                            <input type="date" value={shiftConfig.from_date} onChange={(e) => setShiftConfig({ ...shiftConfig, from_date: e.target.value })} className="w-full h-10 bg-slate-50 border border-slate-200 rounded-xl px-4 text-xs font-bold text-slate-700 outline-none" />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Valid To</label>
                                            <input type="date" value={shiftConfig.to_date} onChange={(e) => setShiftConfig({ ...shiftConfig, to_date: e.target.value })} className="w-full h-10 bg-slate-50 border border-slate-200 rounded-xl px-4 text-xs font-bold text-slate-700 outline-none" />
                                        </div>
                                        <div className="col-span-2 text-[8px] text-amber-600 font-extrabold uppercase bg-amber-50 p-2 rounded border border-amber-100/50 leading-tight">
                                            ⚠️ Note: Validity dates are only applied if you select employees at the bottom to assign them. They are not stored as properties of the shift protocol template itself.
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="pt-8 border-t border-slate-50 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                        {editingShiftId
                                            ? 'Selected employees will be assigned to this shift after saving (Optional)'
                                            : 'New shift will be assigned to selected employees after saving'}
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Personnel Matrix for Assignment */}
                        <div className="bg-white rounded-[32px] border border-slate-100 shadow-xl overflow-hidden mt-8">
                            <div className="p-6 border-b border-slate-50 flex items-center justify-between bg-slate-50/30">
                                <h3 className="text-[10px] font-black text-slate-800 uppercase tracking-widest">
                                    {editingShiftId ? 'Assign to Employees (Optional)' : 'Select Employees for Assignment'}
                                </h3>
                                <div className="flex items-center gap-4 flex-wrap">
                                    <select
                                        value={selectedOutlet}
                                        onChange={(e) => setSelectedOutlet(e.target.value)}
                                        className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-[10px] font-bold outline-none focus:border-indigo-300 shadow-sm"
                                    >
                                        {uniqueLocations.map(loc => (
                                            <option key={loc} value={loc}>
                                                {loc === 'all' ? 'All Outlets' : loc}
                                            </option>
                                        ))}
                                    </select>
                                    <select
                                        value={selectedDept}
                                        onChange={(e) => setSelectedDept(e.target.value)}
                                        className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-[10px] font-bold outline-none focus:border-indigo-300 shadow-sm"
                                    >
                                        {uniqueDepts.map(dept => (
                                            <option key={dept} value={dept}>
                                                {dept === 'all' ? 'All Departments' : dept}
                                            </option>
                                        ))}
                                    </select>
                                    <select
                                        value={selectedDesignation}
                                        onChange={(e) => setSelectedDesignation(e.target.value)}
                                        className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-[10px] font-bold outline-none focus:border-indigo-300 shadow-sm"
                                    >
                                        {uniqueDesignations.map(desg => (
                                            <option key={desg} value={desg}>
                                                {desg === 'all' ? 'All Designations' : desg}
                                            </option>
                                        ))}
                                    </select>
                                    <select
                                        value={selectedAssignmentStatus}
                                        onChange={(e) => setSelectedAssignmentStatus(e.target.value)}
                                        className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-[10px] font-bold outline-none focus:border-indigo-300 shadow-sm"
                                    >
                                        <option value="all">All Status</option>
                                        <option value="assigned">Assigned Staff</option>
                                        <option value="unassigned">Unassigned Staff</option>
                                    </select>
                                    <div className="relative">
                                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                        <input
                                            type="text"
                                            placeholder="Search employees..."
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                            className="bg-white border border-slate-200 rounded-xl pl-9 pr-4 py-2 text-[10px] font-bold outline-none focus:border-indigo-300 w-64 shadow-sm"
                                        />
                                    </div>
                                    <button onClick={() => setSelectedEmployees(filteredEmployees.filter(e => !e.assigned_shift))} className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:text-indigo-800 transition-colors">Select All</button>
                                    <button onClick={() => setSelectedEmployees([])} className="text-[10px] font-black text-slate-400 uppercase tracking-widest hover:text-slate-600 transition-colors">Clear</button>
                                </div>
                            </div>
                            <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 max-h-[400px] overflow-y-auto custom-scrollbar">
                                {filteredEmployees.map(emp => (
                                    <div
                                        key={emp.id}
                                        onClick={() => handleEmployeeToggle(emp)}
                                        className={`flex items-center gap-3 p-3 rounded-2xl border transition-all cursor-pointer ${selectedEmployees.some(e => e.id === emp.id)
                                                ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg shadow-indigo-100'
                                                : 'bg-white border-slate-100 hover:border-slate-300 text-slate-700'
                                            }`}
                                    >
                                        <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-[10px] font-black uppercase ${selectedEmployees.some(e => e.id === emp.id) ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-400'
                                            }`}>
                                            {(emp.first_name?.[0] || '')}{(emp.last_name?.[0] || '')}
                                        </div>
                                        <div className="flex-1 min-w-0 leading-tight">
                                            <p className="text-[10px] font-black uppercase truncate mb-0.5">{emp.first_name} {emp.last_name}</p>
                                            <p className={`text-[8px] font-bold uppercase tracking-tighter truncate flex items-center gap-1 flex-wrap mb-0.5 ${selectedEmployees.some(e => e.id === emp.id) ? 'text-indigo-200' : 'text-slate-400'}`}>
                                                <span>#{emp.employee_id_number || 'N/A'}</span>
                                                {emp.office_location && (
                                                    <>
                                                        <span className="w-0.5 h-0.5 bg-current opacity-40 rounded-full" />
                                                        <span>{emp.office_location}</span>
                                                    </>
                                                )}
                                            </p>
                                            <div className="text-[7.5px] font-black uppercase tracking-wider truncate leading-tight">
                                                {emp.assigned_shift ? (
                                                    <span className={selectedEmployees.some(e => e.id === emp.id) ? 'text-white' : 'text-indigo-600'}>
                                                        {emp.assigned_shift} ({emp.assigned_from_date}{emp.assigned_to_date ? ` to ${emp.assigned_to_date}` : ''})
                                                    </span>
                                                ) : (
                                                    <span className={selectedEmployees.some(e => e.id === emp.id) ? 'text-white' : 'text-slate-400'}>Available</span>
                                                )}
                                                {emp.upcoming_shift && (
                                                    <div className={selectedEmployees.some(e => e.id === emp.id) ? 'text-indigo-200' : 'text-indigo-500'}>
                                                        Upcoming: {emp.upcoming_shift} ({emp.upcoming_from_date})
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                        {selectedEmployees.some(e => e.id === emp.id) && <CheckCircle size={14} className="text-white shrink-0" />}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            ) : viewMode === 'override' ? (
                /* Override Mode */
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start animate-in slide-in-from-bottom-4 duration-500">
                    <div className="lg:col-span-5 space-y-4">
                        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 space-y-4">
                            <div className="flex items-center justify-between pb-2 border-b border-slate-50">
                                <div className="flex items-center gap-2">
                                    <Zap size={14} className="text-amber-500" />
                                    <h3 className="text-[10px] font-black text-slate-800 uppercase tracking-widest">Override Logic</h3>
                                </div>
                                <button
                                    onClick={handleOverrideExecute}
                                    disabled={loading}
                                    className="px-4 py-1.5 bg-slate-900 text-white rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-slate-800 transition-all disabled:opacity-50"
                                >
                                    {loading ? 'Wait...' : 'Save Shift Override'}
                                </button>
                            </div>

                            <div className="space-y-4">
                                <div className="space-y-1">
                                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Select Target Protocol</label>
                                    <select
                                        value={selectedShiftId}
                                        onChange={(e) => setSelectedShiftId(e.target.value)}
                                        className="w-full h-10 bg-slate-50 border border-slate-100 rounded-xl px-4 text-xs font-bold text-slate-700 outline-none focus:border-indigo-500 transition-all"
                                    >
                                        <option value="">Choose Shift...</option>
                                        {shifts.map(s => (
                                            <option key={s.id} value={s.id}>{s.name} {s.is_flexi ? '(Flexi)' : `(${s.start_time} - ${s.end_time})`}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1">
                                        <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Effective From</label>
                                        <input type="date" value={overrideConfig.from_date} onChange={(e) => setOverrideConfig({ ...overrideConfig, from_date: e.target.value })} className="w-full h-10 bg-slate-50 border border-slate-100 rounded-xl px-4 text-xs font-bold text-slate-700 outline-none" />
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Effective To</label>
                                        <input type="date" value={overrideConfig.to_date} onChange={(e) => setOverrideConfig({ ...overrideConfig, to_date: e.target.value })} className="w-full h-10 bg-slate-50 border border-slate-100 rounded-xl px-4 text-xs font-bold text-slate-700 outline-none" placeholder="Indefinite" />
                                    </div>
                                </div>

                                <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl">
                                    <p className="text-[8px] font-black text-amber-600 uppercase tracking-widest mb-1">Warning</p>
                                    <p className="text-[10px] text-amber-700 leading-tight">Executing this override will immediately replace any existing shift assignments for the selected employees.</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="lg:col-span-7">
                        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm flex flex-col h-[600px]">
                            <div className="p-4 border-b border-slate-50 flex items-center justify-between gap-4 flex-wrap">
                                <h3 className="text-[10px] font-black text-slate-800 uppercase tracking-widest">Select Employees</h3>
                                <div className="flex items-center gap-4 flex-wrap">
                                    <select
                                        value={selectedOutlet}
                                        onChange={(e) => setSelectedOutlet(e.target.value)}
                                        className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-[10px] font-bold outline-none focus:border-indigo-300"
                                    >
                                        {uniqueLocations.map(loc => (
                                            <option key={loc} value={loc}>
                                                {loc === 'all' ? 'All Outlets' : loc}
                                            </option>
                                        ))}
                                    </select>
                                    <select
                                        value={selectedDept}
                                        onChange={(e) => setSelectedDept(e.target.value)}
                                        className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-[10px] font-bold outline-none focus:border-indigo-300"
                                    >
                                        {uniqueDepts.map(dept => (
                                            <option key={dept} value={dept}>
                                                {dept === 'all' ? 'All Departments' : dept}
                                            </option>
                                        ))}
                                    </select>
                                    <select
                                        value={selectedDesignation}
                                        onChange={(e) => setSelectedDesignation(e.target.value)}
                                        className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-[10px] font-bold outline-none focus:border-indigo-300"
                                    >
                                        {uniqueDesignations.map(desg => (
                                            <option key={desg} value={desg}>
                                                {desg === 'all' ? 'All Designations' : desg}
                                            </option>
                                        ))}
                                    </select>
                                    <select
                                        value={selectedAssignmentStatus}
                                        onChange={(e) => setSelectedAssignmentStatus(e.target.value)}
                                        className="bg-white border border-slate-200 rounded-lg px-2 py-1 text-[10px] font-bold outline-none focus:border-indigo-300"
                                    >
                                        <option value="all">All Status</option>
                                        <option value="assigned">Assigned Staff</option>
                                        <option value="unassigned">Unassigned Staff</option>
                                    </select>
                                    <div className="relative">
                                        <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                        <input
                                            type="text"
                                            placeholder="Quick filter..."
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                            className="bg-slate-50 border border-slate-100 rounded-lg pl-8 pr-3 py-1 text-[10px] font-bold outline-none focus:border-indigo-300 w-32"
                                        />
                                    </div>
                                    <button onClick={() => setSelectedEmployees(filteredEmployees)} className="text-[9px] font-black text-indigo-600 uppercase tracking-widest">Select All</button>
                                    <div className="w-px h-3 bg-slate-200" />
                                    <button onClick={() => setSelectedEmployees([])} className="text-[9px] font-black text-rose-500 uppercase tracking-widest">Clear</button>
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                                <div className="space-y-2">
                                    {filteredEmployees.map(emp => (
                                        <div
                                            key={emp.id}
                                            onClick={() => handleEmployeeToggle(emp)}
                                            className={`flex items-center justify-between p-2.5 rounded-xl border transition-all cursor-pointer ${selectedEmployees.some(e => e.id === emp.id)
                                                    ? 'bg-slate-900 border-slate-900 text-white'
                                                    : 'bg-white border-slate-50 hover:border-slate-200'
                                                }`}
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-[9px] font-black ${selectedEmployees.some(e => e.id === emp.id) ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-400'
                                                    }`}>
                                                    {(emp.first_name?.[0] || '')}{(emp.last_name?.[0] || '')}
                                                </div>
                                                <div className="leading-tight">
                                                    <p className={`text-[10px] font-black uppercase ${selectedEmployees.some(e => e.id === emp.id) ? 'text-white' : 'text-slate-700'}`}>{emp.first_name} {emp.last_name}</p>
                                                    <p className={`text-[8px] font-bold uppercase tracking-tighter flex items-center gap-1 flex-wrap mt-0.5 ${selectedEmployees.some(e => e.id === emp.id) ? 'text-slate-300' : 'text-slate-400'}`}>
                                                        <span>#{emp.employee_id_number || 'N/A'}</span>
                                                        {emp.office_location && (
                                                            <>
                                                                <span className="w-0.5 h-0.5 bg-current opacity-40 rounded-full" />
                                                                <span>{emp.office_location}</span>
                                                            </>
                                                        )}
                                                    </p>
                                                    <div className="text-[7.5px] font-black uppercase tracking-wider mt-0.5 leading-tight">
                                                        {emp.assigned_shift ? (
                                                            <span className={selectedEmployees.some(e => e.id === emp.id) ? 'text-white' : 'text-indigo-600'}>
                                                                Current: {emp.assigned_shift} ({emp.assigned_from_date}{emp.assigned_to_date ? ` to ${emp.assigned_to_date}` : ''})
                                                            </span>
                                                        ) : (
                                                            <span className={selectedEmployees.some(e => e.id === emp.id) ? 'text-white' : 'text-slate-400'}>Current: None</span>
                                                        )}
                                                        {emp.upcoming_shift && (
                                                            <div className={selectedEmployees.some(e => e.id === emp.id) ? 'text-slate-300' : 'text-indigo-500 font-extrabold'}>
                                                                Upcoming: {emp.upcoming_shift} ({emp.upcoming_from_date})
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                            {selectedEmployees.some(e => e.id === emp.id) && <CheckCircle size={14} className="text-white" />}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            <AnimatePresence>
                {success && (
                    <motion.div
                        initial={{ opacity: 0, y: 50 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 50 }}
                        className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[100] bg-slate-900 text-white px-6 py-3 rounded-xl shadow-xl flex items-center gap-3"
                    >
                        <CheckCircle size={14} className="text-emerald-400" />
                        <span className="text-[10px] font-black uppercase tracking-widest">Protocol Synchronised</span>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Custom Alert Modal */}
            <AnimatePresence>
                {alertConfig.show && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 backdrop-blur-sm"
                    >
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            className="bg-white rounded-[32px] p-8 max-w-sm w-full mx-4 shadow-2xl border border-slate-100 flex flex-col items-center text-center gap-5"
                        >
                            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${alertConfig.type === 'success'
                                    ? 'bg-emerald-50 text-emerald-600'
                                    : alertConfig.type === 'error'
                                        ? 'bg-rose-50 text-rose-600 animate-bounce'
                                        : 'bg-indigo-50 text-indigo-600'
                                }`}>
                                {alertConfig.type === 'success' ? <CheckCircle size={24} /> : <Info size={24} />}
                            </div>
                            <div>
                                <h4 className="text-xs font-black uppercase tracking-widest text-slate-800 mb-2">
                                    {alertConfig.type === 'success'
                                        ? 'Success'
                                        : alertConfig.type === 'error'
                                            ? 'Oops!'
                                            : 'Notification'}
                                </h4>
                                <p className="text-xs font-bold text-slate-500 leading-relaxed">{alertConfig.message}</p>
                            </div>
                            <button
                                onClick={() => setAlertConfig({ ...alertConfig, show: false })}
                                className="w-full py-3.5 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-colors shadow-lg shadow-slate-100 cursor-pointer active:scale-95"
                            >
                                Continue
                            </button>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Custom Confirm Modal */}
            <AnimatePresence>
                {confirmConfig.show && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 backdrop-blur-sm"
                    >
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            className="bg-white rounded-[32px] p-8 max-w-sm w-full mx-4 shadow-2xl border border-slate-100 flex flex-col items-center text-center gap-5"
                        >
                            <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center animate-pulse">
                                <Shield size={24} />
                            </div>
                            <div>
                                <h4 className="text-xs font-black uppercase tracking-widest text-slate-800 mb-2">Are you sure?</h4>
                                <p className="text-xs font-bold text-slate-500 leading-relaxed">{confirmConfig.message}</p>
                            </div>
                            <div className="flex gap-3 w-full">
                                <button
                                    onClick={() => {
                                        // Callers that await a decision need to hear "no" too,
                                        // otherwise they hang with the form stuck loading.
                                        if (confirmConfig.onCancel) confirmConfig.onCancel();
                                        setConfirmConfig({ show: false, message: '', onConfirm: null, onCancel: null });
                                    }}
                                    className="flex-1 py-3.5 bg-slate-155 hover:bg-slate-200 text-slate-600 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer border border-slate-100 active:scale-95"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => {
                                        if (confirmConfig.onConfirm) confirmConfig.onConfirm();
                                        setConfirmConfig({ show: false, message: '', onConfirm: null, onCancel: null });
                                    }}
                                    className="flex-1 py-3.5 bg-indigo-650 hover:bg-indigo-700 bg-indigo-600 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer shadow-lg shadow-indigo-50 active:scale-95"
                                >
                                    Confirm
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
            <style jsx>{`
                .custom-scrollbar::-webkit-scrollbar { width: 4px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 4px; }
            `}</style>
        </div>
    );
};

export default ShiftManagement;
