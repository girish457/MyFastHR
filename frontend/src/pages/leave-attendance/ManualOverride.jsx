import React, { useState, useEffect } from 'react';
import { 
    Clock, Users, CheckCircle, Search, Save, Shield, 
    Plus, X, Info, UserCheck, Trash2, Calendar, Layout, Zap,
    History, Filter, ChevronRight, ArrowRight, AlertCircle,
    UserMinus, Edit2, RotateCcw, Download, UserCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../../utils/api';
import { exportToCSV } from '../../utils/exportUtils';

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

const ManualOverride = () => {
    const [activeTab, setActiveTab] = useState('shift_override');
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState(null);

    // Common State
    const [shifts, setShifts] = useState([]);
    const [employees, setEmployees] = useState([]);

    useEffect(() => {
        fetchInitialData();
    }, []);

    useEffect(() => {
        if (success) {
            const timer = setTimeout(() => setSuccess(false), 3000);
            return () => clearTimeout(timer);
        }
    }, [success]);

    useEffect(() => {
        if (error) {
            const timer = setTimeout(() => setError(null), 5000);
            return () => clearTimeout(timer);
        }
    }, [error]);

    const fetchInitialData = async () => {
        try {
            const shiftRes = await api.get('/attendance/shift-list');
            setShifts(shiftRes || []);
        } catch (err) {
            console.error('Failed to fetch shifts', err);
        }
    };

    const tabs = [
        { id: 'shift_override', label: 'Shift Override', icon: Zap },
        { id: 'employee_wise', label: 'Employee Wise', icon: UserCircle },
        { id: 'date_wise', label: 'Date Wise', icon: Calendar },
        { id: 'history', label: 'Override History', icon: History },
    ];

    return (
        <div className="max-w-[1400px] mx-auto p-4 md:p-6 space-y-6 animate-in fade-in duration-500 pb-20">
            {/* Header */}
            <div className="flex justify-between items-center bg-white p-5 rounded-[24px] border border-slate-100 shadow-sm">
                <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-indigo-600 flex items-center justify-center text-white shadow-xl shadow-indigo-100">
                        <History size={24} />
                    </div>
                    <div>
                        <h1 className="text-xl font-black text-slate-800 tracking-tight">Manual Override</h1>
                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-[0.2em] mt-0.5">Manual Attendance Correction</p>
                    </div>
                </div>
            </div>

            {/* Tab Navigation */}
            <div className="flex items-center gap-1 bg-slate-100 p-1.5 rounded-2xl w-fit">
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                            activeTab === tab.id 
                            ? 'bg-white text-indigo-600 shadow-sm' 
                            : 'text-slate-500 hover:text-slate-800'
                        }`}
                    >
                        <tab.icon size={14} />
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Tab Content */}
            <div className="min-h-[600px]">
                <AnimatePresence mode="wait">
                    {activeTab === 'shift_override' && (
                        <ShiftOverrideTab key="shift" shifts={shifts} setLoading={setLoading} loading={loading} setSuccess={setSuccess} setError={setError} />
                    )}
                    {activeTab === 'employee_wise' && (
                        <EmployeeWiseTab key="emp" shifts={shifts} setLoading={setLoading} loading={loading} setSuccess={setSuccess} setError={setError} />
                    )}
                    {activeTab === 'date_wise' && (
                        <DateWiseTab key="date" setLoading={setLoading} loading={loading} setSuccess={setSuccess} setError={setError} />
                    )}
                    {activeTab === 'history' && (
                        <HistoryTab key="history" setLoading={setLoading} loading={loading} />
                    )}
                </AnimatePresence>
            </div>

            {/* Notifications */}
            <AnimatePresence>
                {success && (
                    <motion.div 
                        initial={{ opacity: 0, y: 50 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 50 }}
                        className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[100] bg-slate-900 text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-4 border border-slate-800"
                    >
                        <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400">
                            <CheckCircle size={14} />
                        </div>
                        <span className="text-[11px] font-black uppercase tracking-widest">Records Updated Successfully</span>
                    </motion.div>
                )}
                {error && (
                    <motion.div 
                        initial={{ opacity: 0, y: 50 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 50 }}
                        className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[100] bg-rose-900 text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-4 border border-rose-800"
                    >
                        <AlertCircle size={16} className="text-rose-400" />
                        <span className="text-[11px] font-black uppercase tracking-widest">{error}</span>
                        <button onClick={() => setError(null)} className="ml-2 hover:text-white/70 transition-colors"><X size={14}/></button>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// --- SUB-COMPONENTS ---

const ShiftOverrideTab = ({ shifts, setLoading, loading, setSuccess, setError }) => {
    const [config, setConfig] = useState({
        singleDay: true,
        fromDate: new Date().toISOString().split('T')[0],
        toDate: '',
        shiftId: '',
        assignMode: 'single' // 'single', 'multiple'
    });
    const [employees, setEmployees] = useState([]);
    const [selectedEmployees, setSelectedEmployees] = useState([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedOutlet, setSelectedOutlet] = useState('all');
    const [selectedDept, setSelectedDept] = useState('all');
    const [selectedDesignation, setSelectedDesignation] = useState('all');
    const [fetchingEmployees, setFetchingEmployees] = useState(false);

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

    const uniqueDepartments = React.useMemo(() => {
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

    useEffect(() => {
        if ((config.shiftId || config.assignMode === 'multiple') && config.fromDate) {
            fetchFilteredEmployees();
        }
    }, [config.shiftId, config.fromDate, config.toDate, config.singleDay, config.assignMode]);

    const fetchFilteredEmployees = async () => {
        try {
            setFetchingEmployees(true);
            const res = await api.get('/attendance/employees-by-shift', {
                params: {
                    shift_id: config.assignMode === 'multiple' ? 'all' : config.shiftId,
                    from_date: config.fromDate,
                    to_date: config.singleDay ? config.fromDate : config.toDate
                }
            });
            setEmployees(res || []);
            setSelectedEmployees([]); // Reset selection on change
        } catch (err) {
            console.error('Failed to fetch filtered employees', err);
        } finally {
            setFetchingEmployees(false);
        }
    };

    const handleApply = async () => {
        if (selectedEmployees.length === 0) {
            setError('Please select at least one employee');
            return;
        }
        try {
            setLoading(true);
            await api.post('/attendance/shift-override-logic', {
                employee_ids: selectedEmployees,
                shift_id: config.shiftId,
                from_date: config.fromDate,
                to_date: config.singleDay ? config.fromDate : config.toDate,
                type: 'shift_override'
            });
            setSuccess(true);
        } catch (err) {
            setError(err.message || 'Failed to apply shift override');
        } finally {
            setLoading(false);
        }
    };

    const filteredList = React.useMemo(() => {
        return employees.filter(emp => {
            const matchesQuery = `${emp.first_name || ''} ${emp.last_name || ''}`.toLowerCase().includes(searchQuery.toLowerCase()) ||
                                 (emp.employee_id_number || '').toLowerCase().includes(searchQuery.toLowerCase());
            const matchesOutlet = matchText(emp.office_location, selectedOutlet);
            const matchesDept = matchText(emp.department_name || emp.department, selectedDept);
            const matchesDesignation = matchText(emp.designation, selectedDesignation);
            return matchesQuery && matchesOutlet && matchesDept && matchesDesignation;
        });
    }, [employees, searchQuery, selectedOutlet, selectedDept, selectedDesignation]);

    const toggleEmployee = (id) => {
        setSelectedEmployees(prev => 
            prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
        );
    };

    return (
        <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="grid grid-cols-1 lg:grid-cols-12 gap-6"
        >
            <div className="lg:col-span-4 space-y-6">
                <div className="bg-white p-6 rounded-[24px] border border-slate-100 shadow-sm space-y-6">
                    <div className="flex items-center justify-between pb-3 border-b border-slate-50">
                        <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest">Configuration</h3>
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 rounded-xl cursor-pointer" onClick={() => setConfig({...config, singleDay: !config.singleDay})}>
                            <input type="checkbox" checked={config.singleDay} onChange={() => {}} className="accent-indigo-600" />
                            <span className="text-[10px] font-black text-slate-600 uppercase tracking-widest">Single Day</span>
                        </div>
                    </div>

                    <div className="space-y-4">
                        {/* Assign Type Selection */}
                        <div className="flex items-center gap-4 bg-slate-50/50 p-4 rounded-xl border border-slate-100">
                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Assign</span>
                            <div className="flex items-center gap-4">
                                <label className="flex items-center gap-2 cursor-pointer group">
                                    <input 
                                        type="radio" 
                                        name="assign_type" 
                                        checked={config.assignMode === 'single'} 
                                        onChange={() => setConfig({...config, assignMode: 'single'})}
                                        className="accent-indigo-600 w-4 h-4" 
                                    />
                                    <span className={`text-[10px] font-bold transition-colors ${config.assignMode === 'single' ? 'text-indigo-600' : 'text-slate-500 group-hover:text-slate-800'}`}>Single Shift</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer group">
                                    <input 
                                        type="radio" 
                                        name="assign_type" 
                                        checked={config.assignMode === 'multiple'} 
                                        onChange={() => setConfig({...config, assignMode: 'multiple'})}
                                        className="accent-indigo-600 w-4 h-4" 
                                    />
                                    <span className={`text-[10px] font-bold transition-colors ${config.assignMode === 'multiple' ? 'text-indigo-600' : 'text-slate-500 group-hover:text-slate-800'}`}>Multiple Shifts</span>
                                </label>
                            </div>
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">
                                {config.assignMode === 'single' ? 'Shift To Override' : 'Shifts To Override'}
                            </label>
                            {config.assignMode === 'single' ? (
                                <select 
                                    value={config.shiftId}
                                    onChange={(e) => setConfig({...config, shiftId: e.target.value})}
                                    className="w-full h-12 bg-slate-50 border border-slate-200 rounded-2xl px-4 text-sm font-bold text-slate-700 outline-none focus:border-indigo-500 transition-all"
                                >
                                    <option value="">Choose Shift Protocol...</option>
                                    {shifts.map(s => <option key={s.id} value={s.id}>{s.name} ({s.start_time}-{s.end_time})</option>)}
                                </select>
                            ) : (
                                <div className="w-full bg-indigo-50/30 border border-indigo-100 rounded-2xl p-4 flex items-center justify-between">
                                    <span className="text-[10px] font-black text-indigo-600 uppercase tracking-tight">All Existing Shifts Selected</span>
                                    <div className="flex -space-x-1.5">
                                        {shifts.slice(0, 2).map(s => (
                                            <div key={s.id} className="w-5 h-5 rounded-full bg-white border border-indigo-200 flex items-center justify-center text-[7px] font-black text-indigo-600 shadow-sm" title={s.name}>
                                                {s.name[0]}
                                            </div>
                                        ))}
                                        {shifts.length > 2 && <div className="w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[7px] font-black shadow-sm">+{shifts.length - 2}</div>}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className={`grid gap-4 ${config.singleDay ? 'grid-cols-1' : 'grid-cols-2'}`}>
                            <div className="space-y-1.5">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Effective From</label>
                                <input 
                                    type="date" 
                                    value={config.fromDate}
                                    onChange={(e) => setConfig({...config, fromDate: e.target.value})}
                                    className="w-full h-12 bg-slate-50 border border-slate-200 rounded-2xl px-4 text-sm font-bold text-slate-700 outline-none focus:border-indigo-500" 
                                />
                            </div>
                            {!config.singleDay && (
                                <div className="space-y-1.5">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">To Date</label>
                                    <input 
                                        type="date" 
                                        value={config.toDate}
                                        onChange={(e) => setConfig({...config, toDate: e.target.value})}
                                        className="w-full h-12 bg-slate-50 border border-slate-200 rounded-2xl px-4 text-sm font-bold text-slate-700 outline-none focus:border-indigo-500" 
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="bg-indigo-600 p-6 rounded-[24px] text-white space-y-4 shadow-xl shadow-indigo-100">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
                            <Shield size={18} />
                        </div>
                        <h4 className="text-xs font-black uppercase tracking-widest">Logic Rule</h4>
                    </div>
                    <p className="text-[11px] font-medium leading-relaxed opacity-90">
                        System will scan the selected dates. Employees marked <span className="font-black underline">Absent</span> will be converted to <span className="font-black underline">Present</span>. Existing Present records will remain untouched.
                    </p>
                    <button 
                        onClick={handleApply}
                        disabled={loading || !config.shiftId || selectedEmployees.length === 0}
                        className="w-full h-12 bg-white text-indigo-600 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-50 transition-all disabled:opacity-50"
                    >
                        {loading ? 'Processing...' : `Apply Override (${selectedEmployees.length})`}
                    </button>
                </div>
            </div>

            <div className="lg:col-span-8">
                <div className="bg-white rounded-[24px] border border-slate-100 shadow-sm flex flex-col h-[650px] overflow-hidden">
                    <div className="p-5 border-b border-slate-50 flex items-center justify-between bg-slate-50/30">
                        <div className="flex items-center gap-3">
                            <Users size={18} className="text-indigo-600" />
                            <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest">Select Employees</h3>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                            <select 
                                value={selectedOutlet}
                                onChange={(e) => setSelectedOutlet(e.target.value)}
                                className="h-10 bg-white border border-slate-200 rounded-xl px-3 text-xs font-bold text-slate-700 outline-none focus:border-indigo-300"
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
                                className="h-10 bg-white border border-slate-200 rounded-xl px-3 text-xs font-bold text-slate-700 outline-none focus:border-indigo-300"
                            >
                                {uniqueDepartments.map(dept => (
                                    <option key={dept} value={dept}>
                                        {dept === 'all' ? 'All Depts' : dept}
                                    </option>
                                ))}
                            </select>
                            <select 
                                value={selectedDesignation}
                                onChange={(e) => setSelectedDesignation(e.target.value)}
                                className="h-10 bg-white border border-slate-200 rounded-xl px-3 text-xs font-bold text-slate-700 outline-none focus:border-indigo-300"
                            >
                                {uniqueDesignations.map(desg => (
                                    <option key={desg} value={desg}>
                                        {desg === 'all' ? 'All Designations' : desg}
                                    </option>
                                ))}
                            </select>
                            <div className="relative">
                                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input 
                                    type="text" 
                                    placeholder="Search name or ID..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="h-10 bg-white border border-slate-200 rounded-xl pl-9 pr-4 text-xs font-bold text-slate-700 w-48 outline-none focus:border-indigo-300"
                                />
                            </div>
                            <button 
                                onClick={() => setSelectedEmployees(filteredList.map(e => e.id))}
                                className="text-[10px] font-black text-indigo-600 uppercase tracking-widest hover:underline"
                            >
                                Select All
                            </button>
                            <button 
                                onClick={() => setSelectedEmployees([])}
                                className="text-[10px] font-black text-rose-500 uppercase tracking-widest hover:underline"
                            >
                                Clear
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
                        {fetchingEmployees ? (
                            <div className="h-full flex flex-col items-center justify-center opacity-40">
                                <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mb-4" />
                                <p className="text-[10px] font-black uppercase tracking-widest">Scanning Registry...</p>
                            </div>
                        ) : filteredList.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center opacity-40">
                                <Users size={48} className="mb-4 text-slate-300" />
                                <p className="text-[10px] font-black uppercase tracking-widest">No matching employees found for this shift/date</p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {filteredList.map(emp => (
                                    <div 
                                        key={emp.id}
                                        onClick={() => toggleEmployee(emp.id)}
                                        className={`p-3.5 rounded-2xl border transition-all cursor-pointer group ${
                                            selectedEmployees.includes(emp.id) 
                                            ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg shadow-indigo-100' 
                                            : 'bg-white border-slate-100 hover:border-slate-300 text-slate-700'
                                        }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-[10px] font-black transition-colors ${
                                                selectedEmployees.includes(emp.id) ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-400 group-hover:bg-slate-200'
                                            }`}>
                                                {emp.first_name?.[0]}{emp.last_name?.[0]}
                                            </div>
                                            <div>
                                                <p className="text-[11px] font-black uppercase leading-tight">{emp.first_name} {emp.last_name}</p>
                                                <p className={`text-[9px] font-bold uppercase tracking-tighter mt-0.5 ${selectedEmployees.includes(emp.id) ? 'text-indigo-100' : 'text-slate-400'}`}>ID: #{emp.employee_id_number}</p>
                                            </div>
                                            {selectedEmployees.includes(emp.id) && <CheckCircle size={16} className="ml-auto text-white" />}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </motion.div>
    );
};

const EmployeeWiseTab = ({ shifts, setLoading, loading, setSuccess, setError }) => {
    const [employeeQuery, setEmployeeQuery] = useState('');
    const [selectedEmp, setSelectedEmp] = useState(null);
    const [dateRange, setDateRange] = useState({ from: '', to: '' });
    const [attendance, setAttendance] = useState([]);
    const [employeesData, setEmployeesData] = useState([]);
    const [selectedOutlet, setSelectedOutlet] = useState('all');
    const [selectedDept, setSelectedDept] = useState('all');
    const [selectedDesignation, setSelectedDesignation] = useState('all');
    const [selectedShift, setSelectedShift] = useState('all');
    const [showDropdown, setShowDropdown] = useState(false);
    const searchContainerRef = React.useRef(null);

    useEffect(() => {
        fetchAllEmployees();
        const handleClickOutside = (event) => {
            if (searchContainerRef.current && !searchContainerRef.current.contains(event.target)) {
                setShowDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (employeesData.length === 0) return;

        // Filter employee list based on active filters
        const matches = employeesData.filter(emp => {
            const matchesOutlet = matchText(emp.office_location, selectedOutlet);
            const matchesDept = matchText(emp.department_name || emp.department, selectedDept);
            const matchesDesignation = matchText(emp.designation, selectedDesignation);
            
            const shift = shifts.find(s => s.id === emp.shift_id);
            const matchesShift = matchText(shift ? shift.name : null, selectedShift);
            
            return matchesOutlet && matchesDept && matchesDesignation && matchesShift;
        });

        if (matches.length === 1) {
            setSelectedEmp(matches[0]);
            setShowDropdown(false);
        } else if (matches.length > 1) {
            // If the currently selected employee does not match the new filters, clear it
            if (selectedEmp) {
                const stillMatches = matches.some(m => m.id === selectedEmp.id);
                if (!stillMatches) {
                    setSelectedEmp(null);
                    setShowDropdown(true);
                }
            } else {
                setShowDropdown(true);
            }
        } else {
            setSelectedEmp(null);
            setShowDropdown(false);
        }
    }, [selectedOutlet, selectedDept, selectedDesignation, selectedShift, employeesData, shifts]);

    const fetchAllEmployees = async () => {
        try {
            const res = await api.get('/employees');
            setEmployeesData(res || []);
        } catch (err) {
            console.error('Failed to fetch employees', err);
        }
    };

    const uniqueLocations = React.useMemo(() => {
        const map = new Map();
        employeesData.forEach(e => {
            const val = e.office_location;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [employeesData]);

    const uniqueDepartments = React.useMemo(() => {
        const map = new Map();
        employeesData.forEach(e => {
            const val = e.department_name || e.department;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [employeesData]);

    const uniqueDesignations = React.useMemo(() => {
        const map = new Map();
        employeesData.forEach(e => {
            const val = e.designation;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [employeesData]);

    const uniqueShifts = React.useMemo(() => {
        const map = new Map();
        employeesData.forEach(e => {
            const shift = shifts.find(s => s.id === e.shift_id);
            const val = shift ? shift.name : null;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [employeesData, shifts]);

    const filteredSearchList = React.useMemo(() => {
        return employeesData.filter(emp => {
            const matchesQuery = !employeeQuery || 
                `${emp.first_name || ''} ${emp.last_name || ''}`.toLowerCase().includes(employeeQuery.toLowerCase()) ||
                (emp.employee_id_number || '').toLowerCase().includes(employeeQuery.toLowerCase());
            
            const matchesOutlet = matchText(emp.office_location, selectedOutlet);
            const matchesDept = matchText(emp.department_name || emp.department, selectedDept);
            const matchesDesignation = matchText(emp.designation, selectedDesignation);
            
            const shift = shifts.find(s => s.id === emp.shift_id);
            const matchesShift = matchText(shift ? shift.name : null, selectedShift);
            
            return matchesQuery && matchesOutlet && matchesDept && matchesDesignation && matchesShift;
        });
    }, [employeesData, employeeQuery, selectedOutlet, selectedDept, selectedDesignation, selectedShift, shifts]);

    const handleShow = async () => {
        if (!selectedEmp || !dateRange.from || !dateRange.to) {
            setError('Select employee and date range');
            return;
        }
        try {
            setLoading(true);
            const res = await api.get('/attendance/employee-history', {
                params: {
                    employee_id: selectedEmp.id,
                    from: dateRange.from,
                    to: dateRange.to
                }
            });
            setAttendance(res || []);
        } catch (err) {
            setError(err.message || 'Failed to load employee history');
        } finally {
            setLoading(false);
        }
    };

    const updateStatus = async (date, status) => {
        try {
            setLoading(true);
            await api.post('/attendance/manual-update', {
                employee_id: selectedEmp.id,
                date,
                status
            });
            setSuccess(true);
            // Re-fetch ledger data so updated status shows immediately
            const res = await api.get('/attendance/employee-history', {
                params: {
                    employee_id: selectedEmp.id,
                    from: dateRange.from,
                    to: dateRange.to
                }
            });
            setAttendance(res || []);
        } catch (err) {
            setError(err.message || 'Failed to update status');
        } finally {
            setLoading(false);
        }
    };


    const handleExport = () => {
        if (!attendance || attendance.length === 0) {
            setError("No data available to export.");
            return;
        }
        const dataToExport = attendance.map(row => ({
            "Employee Code": selectedEmp?.employee_id_number,
            "Employee Name": `${selectedEmp?.first_name || ''} ${selectedEmp?.last_name || ''}`.trim(),
            "Date": row.date,
            "Shift": row.shift_code || '---',
            "Status": row.status,
            "Punch In": row.first_in || '--:--',
            "Punch Out": row.last_out || '--:--',
            "Session 1": row.session1 || '0.0h',
            "Session 2": row.session2 || '0.0h'
        }));
        exportToCSV(dataToExport, `Attendance_Ledger_${selectedEmp?.employee_id_number || 'Employee'}.csv`);
    };

    return (
        <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-6"
        >
            <div className="bg-white p-6 rounded-[24px] border border-slate-100 shadow-sm space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-end">
                    <div ref={searchContainerRef} className="md:col-span-2 space-y-2 relative">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Search Employees</label>
                        <div className="relative">
                            <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input 
                                type="text" 
                                placeholder="Employee Name or ID..."
                                value={selectedEmp ? `${selectedEmp.first_name} ${selectedEmp.last_name} [${selectedEmp.employee_id_number}]` : employeeQuery}
                                onFocus={() => setShowDropdown(true)}
                                onChange={(e) => {
                                    setEmployeeQuery(e.target.value);
                                    if (selectedEmp) setSelectedEmp(null);
                                    setShowDropdown(true);
                                }}
                                className="w-full h-12 bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-4 text-sm font-bold text-slate-700 outline-none focus:border-indigo-500"
                            />
                            {showDropdown && filteredSearchList.length > 0 && !selectedEmp && (
                                <div className="absolute top-14 left-0 right-0 bg-white border border-slate-100 rounded-2xl shadow-2xl z-50 p-2 space-y-1 max-h-60 overflow-y-auto custom-scrollbar">
                                    {filteredSearchList.map(emp => (
                                        <div 
                                            key={emp.id}
                                            onClick={() => {
                                                setSelectedEmp(emp);
                                                setShowDropdown(false);
                                            }}
                                            className="p-3 hover:bg-slate-50 rounded-xl cursor-pointer flex items-center justify-between group"
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-lg bg-slate-100 text-[10px] font-black text-slate-400 flex items-center justify-center">
                                                    {emp.first_name?.[0]}{emp.last_name?.[0]}
                                                </div>
                                                <div>
                                                    <p className="text-[11px] font-black text-slate-800 uppercase">{emp.first_name} {emp.last_name}</p>
                                                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter mt-0.5">ID: {emp.employee_id_number} | {emp.designation}</p>
                                                </div>
                                            </div>
                                            <ChevronRight size={14} className="text-slate-300 group-hover:text-indigo-600 transition-colors" />
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 md:col-span-2">
                        <div className="space-y-2">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Date From</label>
                            <input type="date" value={dateRange.from} onChange={(e) => setDateRange({...dateRange, from: e.target.value})} className="w-full h-12 bg-slate-50 border border-slate-200 rounded-2xl px-4 text-sm font-bold text-slate-700 outline-none focus:border-indigo-500" />
                        </div>
                        <div className="space-y-2 relative">
                            <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Date To</label>
                            <div className="flex gap-2">
                                <input type="date" value={dateRange.to} onChange={(e) => setDateRange({...dateRange, to: e.target.value})} className="flex-1 h-12 bg-slate-50 border border-slate-200 rounded-2xl px-4 text-sm font-bold text-slate-700 outline-none focus:border-indigo-500" />
                                <button 
                                    onClick={handleShow}
                                    className="h-12 w-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100"
                                >
                                    <ArrowRight size={20} />
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-2 border-t border-slate-50">
                    <div className="space-y-1.5">
                        <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Outlet</label>
                        <select 
                            value={selectedOutlet}
                            onChange={(e) => setSelectedOutlet(e.target.value)}
                            className="w-full h-10 bg-slate-50 border border-slate-200 rounded-xl px-3 text-xs font-bold text-slate-700 outline-none focus:border-indigo-500"
                        >
                            {uniqueLocations.map(loc => (
                                <option key={loc} value={loc}>
                                    {loc === 'all' ? 'All Outlets' : loc}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Department</label>
                        <select 
                            value={selectedDept}
                            onChange={(e) => setSelectedDept(e.target.value)}
                            className="w-full h-10 bg-slate-50 border border-slate-200 rounded-xl px-3 text-xs font-bold text-slate-700 outline-none focus:border-indigo-500"
                        >
                            {uniqueDepartments.map(dept => (
                                <option key={dept} value={dept}>
                                    {dept === 'all' ? 'All Depts' : dept}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Designation</label>
                        <select 
                            value={selectedDesignation}
                            onChange={(e) => setSelectedDesignation(e.target.value)}
                            className="w-full h-10 bg-slate-50 border border-slate-200 rounded-xl px-3 text-xs font-bold text-slate-700 outline-none focus:border-indigo-500"
                        >
                            {uniqueDesignations.map(desg => (
                                <option key={desg} value={desg}>
                                    {desg === 'all' ? 'All Designations' : desg}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Shift</label>
                        <select 
                            value={selectedShift}
                            onChange={(e) => setSelectedShift(e.target.value)}
                            className="w-full h-10 bg-slate-50 border border-slate-200 rounded-xl px-3 text-xs font-bold text-slate-700 outline-none focus:border-indigo-500"
                        >
                            {uniqueShifts.map(sh => (
                                <option key={sh} value={sh}>
                                    {sh === 'all' ? 'All Shifts' : sh}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
            </div>

            <div className="bg-white rounded-[24px] border border-slate-100 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest">Attendance Ledger</h3>
                    <div className="flex items-center gap-4 flex-wrap">
                        {attendance.length > 0 && (
                            <button
                                type="button"
                                onClick={handleExport}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all shadow-sm active:scale-95 cursor-pointer"
                            >
                                <Download size={11} /> Export CSV
                            </button>
                        )}
                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> P = Present
                        </span>
                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-rose-500" /> A = Absent
                        </span>
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="bg-slate-50/50">
                            <tr>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Date</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Shift</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Status</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">First In</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Last Out</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Session 1</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Session 2</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {attendance.length === 0 ? (
                                <tr>
                                    <td colSpan={8} className="px-6 py-20 text-center">
                                        <Info size={32} className="mx-auto text-slate-200 mb-3" />
                                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Select an employee and dates to view ledger</p>
                                    </td>
                                </tr>
                            ) : (
                                attendance.map((row, i) => (
                                    <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                                        <td className="px-6 py-4 text-[11px] font-bold text-slate-600">{row.date}</td>
                                        <td className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-tighter">{row.shift_code || '---'}</td>
                                        <td className="px-6 py-4 text-center">
                                            <span className={`inline-flex px-2 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-widest ${
                                                row.status === 'P' ? 'bg-emerald-50 text-emerald-600' :
                                                row.status === 'A' ? 'bg-rose-50 text-rose-600' :
                                                row.status === 'OFF' ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-600'
                                            }`}>
                                                {row.status}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-[11px] font-medium text-slate-500">{row.first_in || '--:--'}</td>
                                        <td className="px-6 py-4 text-[11px] font-medium text-slate-500">{row.last_out || '--:--'}</td>
                                        <td className="px-6 py-4 text-[11px] font-medium text-slate-500">{row.session1 || '0.0h'}</td>
                                        <td className="px-6 py-4 text-[11px] font-medium text-slate-500">{row.session2 || '0.0h'}</td>
                                        <td className="px-6 py-4 text-right">
                                            <select
                                                value={row.status}
                                                onChange={(e) => updateStatus(row.date, e.target.value)}
                                                className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-[9px] font-black uppercase outline-none focus:border-indigo-300"
                                            >
                                                <option value="P">P</option>
                                                <option value="A">A</option>
                                                <option value="HD">HD</option>
                                                <option value="OFF">OFF</option>
                                                <option value="R">R</option>
                                                <option value="E">E</option>
                                                <option value="CI">CI</option>
                                                {/* L/H/PL/UL are computed, not a status this screen can write - shown so the
                                                    dropdown never silently mismatches into displaying P for one of them. */}
                                                {!['P', 'A', 'HD', 'OFF', 'R', 'E', 'CI'].includes(row.status) && (
                                                    <option value={row.status} disabled>{row.status}</option>
                                                )}
                                            </select>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </motion.div>
    );
};

const DateWiseTab = ({ setLoading, loading, setSuccess, setError }) => {
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [data, setData] = useState([]);
    const [search, setSearch] = useState('');
    const [selectedOutlet, setSelectedOutlet] = useState('all');
    const [selectedDept, setSelectedDept] = useState('all');
    const [selectedDesignation, setSelectedDesignation] = useState('all');

    const uniqueLocations = React.useMemo(() => {
        const map = new Map();
        data.forEach(e => {
            const val = e.office_location;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [data]);

    const uniqueDepartments = React.useMemo(() => {
        const map = new Map();
        data.forEach(e => {
            const val = e.department_name || e.department;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [data]);

    const uniqueDesignations = React.useMemo(() => {
        const map = new Map();
        data.forEach(e => {
            const val = e.designation;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [data]);

    useEffect(() => {
        fetchDateAttendance();
    }, [date]);

    const fetchDateAttendance = async () => {
        try {
            setLoading(true);
            const res = await api.get('/attendance/date-wise', { params: { date } });
            setData(res || []);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const updateStatus = async (empId, status) => {
        try {
            setLoading(true);
            await api.post('/attendance/manual-update', {
                employee_id: empId,
                date,
                status
            });
            setSuccess(true);
            fetchDateAttendance(); // Refresh
        } catch (err) {
            setError(err.message || 'Failed to update status');
        } finally {
            setLoading(false);
        }
    };

    const handleExport = () => {
        if (!filtered || filtered.length === 0) {
            setError("No data available to export.");
            return;
        }
        const dataToExport = filtered.map(row => ({
            "Employee Code": row.employee_id_number,
            "Employee Name": `${row.first_name || ''} ${row.last_name || ''}`.trim(),
            "Shift": row.shift_code || '---',
            "Status": row.status,
            "Punch In": row.first_in || '--:--',
            "Punch Out": row.last_out || '--:--',
            "Session 1": row.session1 || '0.0h',
            "Session 2": row.session2 || '0.0h'
        }));
        exportToCSV(dataToExport, `Attendance_Date_${date}.csv`);
    };

    const filtered = React.useMemo(() => {
        return data.filter(e => {
            const matchesSearch = `${e.first_name || ''} ${e.last_name || ''}`.toLowerCase().includes(search.toLowerCase()) ||
                                  (e.employee_id_number || '').toLowerCase().includes(search.toLowerCase());
            const matchesOutlet = matchText(e.office_location, selectedOutlet);
            const matchesDept = matchText(e.department_name || e.department, selectedDept);
            const matchesDesignation = matchText(e.designation, selectedDesignation);
            return matchesSearch && matchesOutlet && matchesDept && matchesDesignation;
        });
    }, [data, search, selectedOutlet, selectedDept, selectedDesignation]);

    return (
        <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-6"
        >
            <div className="bg-white p-6 rounded-[24px] border border-slate-100 shadow-sm flex flex-wrap items-end gap-6 justify-between">
                <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Attendance Date</label>
                    <input 
                        type="date" 
                        value={date} 
                        onChange={(e) => setDate(e.target.value)} 
                        className="h-12 bg-slate-50 border border-slate-200 rounded-2xl px-5 text-sm font-bold text-slate-700 outline-none focus:border-indigo-500" 
                    />
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                    {filtered.length > 0 && (
                        <button
                            type="button"
                            onClick={handleExport}
                            className="h-12 px-5 bg-white border border-slate-200 text-slate-700 rounded-2xl flex items-center gap-2 hover:bg-slate-50 transition-all shadow-sm font-bold text-xs active:scale-95 shrink-0 cursor-pointer"
                        >
                            <Download size={14} /> Export CSV
                        </button>
                    )}
                    <select 
                        value={selectedOutlet}
                        onChange={(e) => setSelectedOutlet(e.target.value)}
                        className="h-12 bg-white border border-slate-200 rounded-2xl px-4 text-xs font-bold text-slate-700 outline-none focus:border-indigo-500 shadow-sm"
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
                        className="h-12 bg-white border border-slate-200 rounded-2xl px-4 text-xs font-bold text-slate-700 outline-none focus:border-indigo-500 shadow-sm"
                    >
                        {uniqueDepartments.map(dept => (
                            <option key={dept} value={dept}>
                                {dept === 'all' ? 'All Depts' : dept}
                            </option>
                        ))}
                    </select>
                    <select 
                        value={selectedDesignation}
                        onChange={(e) => setSelectedDesignation(e.target.value)}
                        className="h-12 bg-white border border-slate-200 rounded-2xl px-4 text-xs font-bold text-slate-700 outline-none focus:border-indigo-500 shadow-sm"
                    >
                        {uniqueDesignations.map(desg => (
                            <option key={desg} value={desg}>
                                {desg === 'all' ? 'All Designations' : desg}
                            </option>
                        ))}
                    </select>
                    <div className="relative">
                        <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input 
                            type="text" 
                            placeholder="Filter list..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="h-12 bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-6 text-sm font-bold text-slate-700 outline-none focus:border-indigo-500 w-72 shadow-inner"
                        />
                    </div>
                </div>
            </div>

            <div className="bg-white rounded-[24px] border border-slate-100 shadow-sm overflow-hidden min-h-[500px]">
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="sticky top-0 bg-slate-50 z-10 border-b border-slate-100">
                            <tr>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Employee</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Shift</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Status</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Punch In</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Punch Out</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Session 1</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Session 2</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Quick Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {filtered.length === 0 ? (
                                <tr>
                                    <td colSpan={8} className="px-6 py-20 text-center">
                                        <div className="opacity-20 flex flex-col items-center">
                                            <Users size={48} className="mb-4" />
                                            <p className="text-[10px] font-black uppercase tracking-widest">No records found for this date</p>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                filtered.map(row => (
                                    <tr key={row.id} className="hover:bg-slate-50/50 transition-colors">
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-[10px] font-black text-slate-400">
                                                    {row.first_name[0]}{row.last_name[0]}
                                                </div>
                                                <div>
                                                    <p className="text-[11px] font-black text-slate-800 uppercase leading-none">{row.first_name} {row.last_name}</p>
                                                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter mt-1">ID: #{row.employee_id_number} • {row.designation || 'Staff'} ({row.department_name || 'General'})</p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-[10px] font-black text-slate-500 uppercase tracking-tighter">{row.shift_code || '---'}</td>
                                        <td className="px-6 py-4 text-center">
                                            <span className={`inline-flex px-2 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-widest ${
                                                row.status === 'P' ? 'bg-emerald-50 text-emerald-600' :
                                                row.status === 'A' ? 'bg-rose-50 text-rose-600' :
                                                row.status === 'OFF' ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-600'
                                            }`}>
                                                {row.status}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-[11px] font-medium text-slate-500">{row.first_in || '--:--'}</td>
                                        <td className="px-6 py-4 text-[11px] font-medium text-slate-500">{row.last_out || '--:--'}</td>
                                        <td className="px-6 py-4 text-[11px] font-medium text-slate-500">{row.session1 || '0.0h'}</td>
                                        <td className="px-6 py-4 text-[11px] font-medium text-slate-500">{row.session2 || '0.0h'}</td>
                                        <td className="px-6 py-4 text-right">
                                            <select
                                                value={row.status}
                                                onChange={(e) => updateStatus(row.id, e.target.value)}
                                                className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-[9px] font-black uppercase outline-none focus:border-indigo-300"
                                            >
                                                <option value="P">P</option>
                                                <option value="A">A</option>
                                                <option value="HD">HD</option>
                                                <option value="OFF">OFF</option>
                                                <option value="R">R</option>
                                                <option value="E">E</option>
                                                <option value="CI">CI</option>
                                                {/* L/H/PL/UL are computed, not a status this screen can write - shown so the
                                                    dropdown never silently mismatches into displaying P for one of them. */}
                                                {!['P', 'A', 'HD', 'OFF', 'R', 'E', 'CI'].includes(row.status) && (
                                                    <option value={row.status} disabled>{row.status}</option>
                                                )}
                                            </select>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </motion.div>
    );
};

const HistoryTab = ({ setLoading, loading }) => {
    const [history, setHistory] = useState([]);
    const [filters, setFilters] = useState({
        search: '',
        date: ''
    });

    useEffect(() => {
        fetchHistory();
    }, []);

    const fetchHistory = async () => {
        try {
            setLoading(true);
            const res = await api.get('/attendance/override-history');
            setHistory(res || []);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleExport = () => {
        if (!filtered || filtered.length === 0) {
            alert("No data available to export.");
            return;
        }
        const dataToExport = filtered.map(h => ({
            "Employee Code": h.employee_id,
            "Employee Name": h.employee_name,
            "Company": h.company_name,
            "Attendance Date": h.attendance_date || h.override_date,
            "Previous Status": h.previous_status,
            "Updated Status": h.updated_status,
            "Override Type": h.override_type,
            "Overridden By": h.overridden_by,
            "Timestamp": new Date(h.created_at).toLocaleString()
        }));
        exportToCSV(dataToExport, "Attendance_Override_Audit_Logs.csv");
    };

    const filtered = history.filter(h => 
        (h.employee_name?.toLowerCase().includes(filters.search.toLowerCase()) || h.employee_id?.toLowerCase().includes(filters.search.toLowerCase())) &&
        (!filters.date || h.override_date === filters.date)
    );

    return (
        <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-6"
        >
            <div className="bg-white p-6 rounded-[24px] border border-slate-100 shadow-sm flex flex-wrap items-center justify-between gap-6">
                <div className="flex items-center gap-4">
                    <div className="relative">
                        <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input 
                            type="text" 
                            placeholder="Search by name or ID..."
                            value={filters.search}
                            onChange={(e) => setFilters({...filters, search: e.target.value})}
                            className="h-11 bg-slate-50 border border-slate-200 rounded-xl pl-12 pr-6 text-xs font-bold text-slate-700 outline-none focus:border-indigo-300 w-64"
                        />
                    </div>
                    <input 
                        type="date" 
                        value={filters.date}
                        onChange={(e) => setFilters({...filters, date: e.target.value})}
                        className="h-11 bg-slate-50 border border-slate-200 rounded-xl px-4 text-xs font-bold text-slate-700 outline-none"
                    />
                </div>
                <button 
                    onClick={handleExport}
                    className="flex items-center gap-2 px-6 py-2.5 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-slate-200 hover:bg-slate-800 transition-all cursor-pointer"
                >
                    <Download size={14} /> Export Audit Logs
                </button>
            </div>

            <div className="bg-white rounded-[24px] border border-slate-100 shadow-sm overflow-hidden min-h-[500px]">
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="bg-slate-50/50">
                            <tr>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Employee</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Attendance Date</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Transition</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Override Type</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Processed By</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Timestamp</th>
                                <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50">
                            {filtered.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="px-6 py-20 text-center">
                                        <History size={32} className="mx-auto text-slate-200 mb-3" />
                                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">No override history recorded yet</p>
                                    </td>
                                </tr>
                            ) : (
                                filtered.map((h, i) => (
                                    <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                                        <td className="px-6 py-4">
                                            <div>
                                                <p className="text-[11px] font-black text-slate-800 uppercase leading-none">{h.employee_name}</p>
                                                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter mt-1">{h.employee_id} • {h.company_name}</p>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-[11px] font-bold text-slate-600">{h.attendance_date}</td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-2">
                                                <span className="text-[9px] font-black text-slate-400 uppercase">{h.previous_status}</span>
                                                <ArrowRight size={10} className="text-slate-300" />
                                                <span className="text-[9px] font-black text-indigo-600 uppercase">{h.updated_status}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest bg-slate-50 px-2 py-0.5 rounded-lg border border-slate-100">
                                                {h.override_type}
                                            </span>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-2">
                                                <div className="w-5 h-5 rounded bg-indigo-50 text-[8px] font-black text-indigo-600 flex items-center justify-center">AD</div>
                                                <span className="text-[10px] font-bold text-slate-600">{h.overridden_by}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-[10px] font-medium text-slate-500">{new Date(h.created_at).toLocaleString()}</td>
                                        <td className="px-6 py-4 text-right">
                                            <span className="inline-flex w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </motion.div>
    );
};

export default ManualOverride;
