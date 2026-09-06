import React, { useState, useEffect } from 'react';
import { 
    Calendar, Users, Download, RotateCcw, ChevronLeft, 
    ChevronRight, Filter, Search, FileSpreadsheet, UserCheck,
    Briefcase, MapPin, MoreHorizontal, ArrowUpDown, X
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../../utils/api';
import { exportToCSV } from '../../utils/exportUtils';

// Hash function to generate consistent pastel HSL colors for any shift name
const getHashColor = (str) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return {
        bg: `hsl(${hue}, 80%, 94%)`,
        text: `hsl(${hue}, 90%, 30%)`,
        border: `hsl(${hue}, 50%, 85%)`
    };
};

const getShiftBadgeStyle = (status) => {
    if (status === 'OFF') {
        return {
            text: 'OFF',
            style: { backgroundColor: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0' },
            className: 'font-bold text-slate-500'
        };
    }
    if (status === '---' || !status) {
        return {
            text: '-',
            style: { backgroundColor: '#ffffff', color: '#cbd5e1', border: '1px solid #f1f5f9' },
            className: 'italic text-slate-300'
        };
    }
    
    // Generate abbreviation
    let short = '';
    const parts = status.split(/[\s_-]+/);
    if (parts.length > 1) {
        short = parts.map(p => p[0]).join('').slice(0, 3).toUpperCase();
    } else {
        short = status.slice(0, 3).toUpperCase();
    }
    
    const colors = getHashColor(status);
    return {
        text: short,
        style: { backgroundColor: colors.bg, color: colors.text, borderColor: colors.border, border: '1px solid' },
        className: 'font-black'
    };
};

const ShiftRoaster = () => {
    const [loading, setLoading] = useState(false);
    const [rosterData, setRosterData] = useState([]);
    const [daysInMonth, setDaysInMonth] = useState(31);
    const [filters, setFilters] = useState({
        month: new Date().getMonth() + 1,
        year: new Date().getFullYear(),
        employeeId: 'All',
        category: 'All',
        cycle: 'All'
    });
    const [employees, setEmployees] = useState([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [departments, setDepartments] = useState([]);
    const [schemes, setSchemes] = useState([]);
    const [selectedOutlet, setSelectedOutlet] = useState('all');
    const [selectedDesignation, setSelectedDesignation] = useState('All');

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
        rosterData.forEach(e => {
            const val = e.location;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['all', ...Array.from(map.values()).sort()];
    }, [rosterData]);

    const uniqueDesignations = React.useMemo(() => {
        const map = new Map();
        rosterData.forEach(e => {
            const val = e.designation;
            if (val) {
                const clean = val.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                if (!map.has(clean)) {
                    map.set(clean, formatLabel(val));
                }
            }
        });
        return ['All', ...Array.from(map.values()).sort()];
    }, [rosterData]);

    // Shift overriding states
    const [selectedCell, setSelectedCell] = useState(null); // { employee, date, day }
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [selectedShiftId, setSelectedShiftId] = useState('');
    const [fromDate, setFromDate] = useState('');
    const [toDate, setToDate] = useState('');
    const [isPermanent, setIsPermanent] = useState(false);
    const [shifts, setShifts] = useState([]);
    const [saveLoading, setSaveLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');
    const [successMsg, setSuccessMsg] = useState('');
    // The backend refuses a backdated assignment unless the caller confirms it (assignShift,
    // allow_backdate), because re-resolving days already worked rewrites their muster status
    // and the payroll computed from it. Fixing a past cell is exactly what this grid is for -
    // rotations are routinely keyed in after the punches - so the first Save on a past date
    // shows the warning below and the second one sends the confirmation. Same contract as
    // ShiftOverride.jsx, done inline because this drawer has no confirm modal of its own.
    const [backdateWarningShown, setBackdateWarningShown] = useState(false);

    const isBackdated = (dateStr) => {
        const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
        return !!dateStr && dateStr < todayStr;
    };

    useEffect(() => {
        fetchRoster();
        fetchEmployees();
        fetchShifts();
    }, [filters.month, filters.year, filters.employeeId]);

    useEffect(() => {
        const fetchFilterOptions = async () => {
            try {
                const [deptList, schemeList] = await Promise.all([
                    api.get('/org/departments'),
                    api.get('/attendance/schemes')
                ]);
                setDepartments(deptList || []);
                setSchemes(schemeList || []);
            } catch (err) {
                console.error('Failed to load filter options', err);
            }
        };
        fetchFilterOptions();
    }, []);

    const fetchEmployees = async () => {
        try {
            const res = await api.get('/employees');
            setEmployees(res || []);
        } catch (err) {
            console.error('Failed to fetch employees', err);
        }
    };

    const fetchShifts = async () => {
        try {
            const res = await api.get('/attendance/shift-list');
            setShifts(res || []);
        } catch (err) {
            console.error('Failed to fetch shifts', err);
        }
    };

    const fetchRoster = async () => {
        try {
            setLoading(true);
            const res = await api.get('/attendance/roster', {
                params: {
                    month: filters.month,
                    year: filters.year,
                    employee_id: filters.employeeId
                }
            });
            setRosterData(res.roster || []);
            setDaysInMonth(res.daysInMonth || 31);
        } catch (err) {
            console.error('Failed to fetch roster', err);
        } finally {
            setLoading(false);
        }
    };

    const getDaysArray = () => {
        const days = [];
        for (let i = 1; i <= daysInMonth; i++) {
            const date = new Date(filters.year, filters.month - 1, i);
            const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
            days.push({ day: i, name: dayName });
        }
        return days;
    };

    const days = getDaysArray();

    const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];

    const handleExport = () => {
        if (!filteredRoster || filteredRoster.length === 0) {
            alert('No roster data to export.');
            return;
        }

        const dataToExport = filteredRoster.map(row => {
            const exportRow = {
                employee_code: row.employee_id_number || '',
                name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
                designation: row.designation || '',
                location: row.location || '',
                working_days: row.wd || 0,
                offs: row.off || 0
            };
            // Add shift names for days 1 to daysInMonth
            for (let d = 1; d <= daysInMonth; d++) {
                exportRow[`day_${d}`] = row.days[d] || '-';
            }
            return exportRow;
        });

        const headers = {
            employee_code: 'Employee ID',
            name: 'Name',
            designation: 'Designation',
            location: 'Location',
            working_days: 'Working Days',
            offs: 'Off Days'
        };
        for (let d = 1; d <= daysInMonth; d++) {
            headers[`day_${d}`] = `Day ${d}`;
        }

        exportToCSV(dataToExport, `Shift_Roster_${filters.month}_${filters.year}.csv`, headers);
    };

    const handleCellClick = (employee, dayObj) => {
        const targetDateStr = `${filters.year}-${String(filters.month).padStart(2, '0')}-${String(dayObj.day).padStart(2, '0')}`;
        
        setSelectedCell({
            employee,
            day: dayObj.day,
            date: targetDateStr
        });
        
        // Find existing assignment for this day if any
        const currentStatus = employee.days[dayObj.day];
        const currentShift = shifts.find(s => s.name === currentStatus);
        
        setSelectedShiftId(currentShift ? currentShift.id : '');
        setFromDate(targetDateStr);
        setToDate(targetDateStr);
        setIsPermanent(false);
        setErrorMsg('');
        setSuccessMsg('');
        setBackdateWarningShown(false);
        setDrawerOpen(true);
    };

    const handleSaveOverride = async (e) => {
        e.preventDefault();
        if (!selectedShiftId) {
            setErrorMsg('Please select a shift');
            return;
        }

        // First Save on a past From Date only raises the warning; the admin has to press
        // Save again to confirm. Editing the date withdraws the confirmation (see onChange).
        if (isBackdated(fromDate) && !backdateWarningShown) {
            setBackdateWarningShown(true);
            return;
        }
        
        try {
            setSaveLoading(true);
            setErrorMsg('');
            setSuccessMsg('');
            
            await api.post('/attendance/shift-override', {
                employee_ids: [selectedCell.employee.id],
                shift_id: parseInt(selectedShiftId),
                from_date: fromDate,
                to_date: isPermanent ? null : toDate,
                // Only ever true after the warning above was shown and Save pressed again.
                allow_backdate: backdateWarningShown
            });
            
            setSuccessMsg('Shift assigned successfully!');
            setTimeout(() => {
                setDrawerOpen(false);
                fetchRoster();
            }, 1000);
        } catch (err) {
            console.error('Failed to save shift override', err);
            setErrorMsg(err.response?.data?.message || err.message || 'Failed to save shift assignment');
        } finally {
            setSaveLoading(false);
        }
    };

    const filteredRoster = React.useMemo(() => {
        return rosterData.filter(emp => {
            const query = searchQuery.toLowerCase().trim();
            const searchMatch = query === '' || 
                `${emp.first_name || ''} ${emp.last_name || ''}`.toLowerCase().includes(query) ||
                (emp.employee_id_number || '').toLowerCase().includes(query);

            const categoryMatch = filters.category === 'All' || 
                matchText(emp.department_name, filters.category) ||
                String(emp.department_id) === String(filters.category);

            const cycleMatch = filters.cycle === 'All' || 
                String(emp.scheme_id) === String(filters.cycle) ||
                matchText(emp.scheme_name, filters.cycle);

            const outletMatch = matchText(emp.location, selectedOutlet);

            const designationMatch = matchText(emp.designation, selectedDesignation);

            return searchMatch && categoryMatch && cycleMatch && outletMatch && designationMatch;
        });
    }, [rosterData, searchQuery, filters.category, filters.cycle, selectedOutlet, selectedDesignation]);

    return (
        <div className="max-w-[1600px] mx-auto p-4 md:p-6 space-y-6 pb-20">
            {/* Control Panel */}
            <div className="bg-white rounded-[24px] border border-slate-100 shadow-sm overflow-hidden">
                <div className="p-5 border-b border-slate-50 grid grid-cols-1 md:grid-cols-5 gap-6 items-end">
                    <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Select Month</label>
                        <div className="relative">
                            <Calendar size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-indigo-500" />
                            <select 
                                value={filters.month}
                                onChange={(e) => setFilters({...filters, month: parseInt(e.target.value)})}
                                className="w-full h-11 bg-slate-50 border border-slate-200 rounded-xl pl-12 pr-4 text-xs font-bold text-slate-700 outline-none focus:border-indigo-500 appearance-none"
                            >
                                {months.map((m, i) => (
                                    <option key={i} value={i+1}>{m} {filters.year}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className="space-y-2 md:col-span-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Attendance Scheme</label>
                        <div className="flex flex-wrap gap-2.5">
                            <button
                                type="button"
                                onClick={() => setFilters({...filters, cycle: 'All'})}
                                className={`h-11 px-5 rounded-xl text-xs font-bold border transition-all duration-200 ${
                                    filters.cycle === 'All'
                                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-lg shadow-indigo-100/50'
                                        : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                                }`}
                            >
                                All Schemes
                            </button>
                            {schemes.map(s => (
                                <button
                                    key={s.id}
                                    type="button"
                                    onClick={() => setFilters({...filters, cycle: String(s.id)})}
                                    className={`h-11 px-5 rounded-xl text-xs font-bold border transition-all duration-200 ${
                                        String(filters.cycle) === String(s.id)
                                            ? 'bg-slate-50 text-slate-800 border-slate-300 font-extrabold shadow-sm'
                                            : 'bg-slate-50/40 text-slate-500 border-slate-200 hover:bg-slate-150'
                                    }`}
                                >
                                    {s.name}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="md:col-span-2 flex items-center justify-end gap-3 h-11">
                        <button 
                            onClick={handleExport}
                            className="flex items-center gap-2 px-6 py-2.5 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-slate-200 hover:bg-slate-800 transition-all h-full"
                        >
                            <FileSpreadsheet size={16} /> Excel Export
                        </button>
                        <button 
                            onClick={fetchRoster}
                            className="w-11 h-11 bg-white border border-slate-200 text-slate-600 rounded-xl flex items-center justify-center hover:bg-slate-50 transition-all shadow-sm"
                        >
                            <RotateCcw size={18} />
                        </button>
                    </div>
                </div>

                <div className="p-5 flex flex-wrap items-center gap-4 bg-slate-50/30">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-slate-400 uppercase">Outlet:</span>
                        <select 
                            value={selectedOutlet}
                            onChange={(e) => setSelectedOutlet(e.target.value)}
                            className="h-9 bg-white border border-slate-200 rounded-lg px-3 text-[10px] font-black text-slate-700 outline-none focus:border-indigo-500 cursor-pointer"
                        >
                            {uniqueLocations.map(loc => (
                                <option key={loc} value={loc}>
                                    {loc === 'all' ? 'All Outlets' : loc}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-slate-400 uppercase">Department:</span>
                        <select 
                            value={filters.category}
                            onChange={(e) => setFilters({...filters, category: e.target.value})}
                            className="h-9 bg-white border border-slate-200 rounded-lg px-3 text-[10px] font-black text-slate-700 outline-none focus:border-indigo-500 cursor-pointer"
                        >
                            <option value="All">All Departments</option>
                            {departments.map(d => (
                                <option key={d.id} value={d.id}>{d.name}</option>
                            ))}
                        </select>
                    </div>

                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-slate-400 uppercase">Designation:</span>
                        <select 
                            value={selectedDesignation}
                            onChange={(e) => setSelectedDesignation(e.target.value)}
                            className="h-9 bg-white border border-slate-200 rounded-lg px-3 text-[10px] font-black text-slate-700 outline-none focus:border-indigo-500 cursor-pointer"
                        >
                            {uniqueDesignations.map(desg => (
                                <option key={desg} value={desg}>
                                    {desg === 'All' ? 'All Designations' : desg}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-slate-400 uppercase">Employee:</span>
                        <select 
                            value={filters.employeeId}
                            onChange={(e) => setFilters({...filters, employeeId: e.target.value})}
                            className="h-9 bg-white border border-slate-200 rounded-lg px-3 text-[10px] font-black text-slate-700 outline-none focus:border-indigo-500"
                        >
                            <option value="All">All Employees</option>
                            {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                        </select>
                    </div>

                    <div className="ml-auto relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input 
                            type="text" 
                            placeholder="Quick Search..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="h-9 bg-white border border-slate-200 rounded-lg pl-9 pr-4 text-[10px] font-bold text-slate-700 w-64 outline-none focus:border-indigo-300"
                        />
                    </div>
                </div>
            </div>

            {/* Roster Grid */}
            <div className="bg-white rounded-[24px] border border-slate-100 shadow-xl overflow-hidden flex flex-col min-h-[600px]">
                <div className="overflow-x-auto overflow-y-auto custom-scrollbar flex-1 relative">
                    <table className="w-full border-collapse text-left table-fixed min-w-[1200px]">
                        <thead>
                            <tr className="bg-slate-700 text-white">
                                <th className="sticky left-0 z-30 bg-[#54879b] px-4 py-3 text-[10px] font-black uppercase tracking-widest border-r border-white/10 w-[120px]">
                                    <div className="flex items-center justify-between">
                                        Employee No <ArrowUpDown size={12} className="opacity-50" />
                                    </div>
                                </th>
                                <th className="sticky left-[120px] z-30 bg-[#54879b] px-6 py-3 text-[10px] font-black uppercase tracking-widest border-r border-white/10 w-[240px]">
                                    Employee Name
                                </th>
                                <th className="sticky left-[360px] z-30 bg-[#54879b] px-3 py-3 text-[10px] font-black uppercase tracking-widest border-r border-white/10 w-[60px] text-center">
                                    WD
                                </th>
                                <th className="sticky left-[420px] z-30 bg-[#54879b] px-3 py-3 text-[10px] font-black uppercase tracking-widest border-r border-white/20 w-[60px] text-center">
                                    OFF
                                </th>
                                {days.map(d => (
                                    <th key={d.day} className={`px-2 py-3 text-[10px] font-black uppercase tracking-widest text-center border-r border-white/5 w-[55px] ${d.name === 'Sun' ? 'bg-[#3e6878]' : ''}`}>
                                        <div className="text-[11px] mb-0.5">{d.day}</div>
                                        <div className="text-[8px] opacity-60 font-bold uppercase">{d.name}</div>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {loading ? (
                                <tr>
                                    <td colSpan={daysInMonth + 4} className="px-6 py-40 text-center">
                                        <div className="flex flex-col items-center">
                                            <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mb-4" />
                                            <p className="text-[11px] font-black text-slate-400 uppercase tracking-[0.2em]">Loading roster...</p>
                                        </div>
                                    </td>
                                </tr>
                            ) : filteredRoster.length === 0 ? (
                                <tr>
                                    <td colSpan={daysInMonth + 4} className="px-6 py-40 text-center text-slate-400 italic">
                                        No personnel found in the selected registry.
                                    </td>
                                </tr>
                            ) : (
                                filteredRoster.map((row, idx) => (
                                    <tr key={idx} className="hover:bg-slate-50/80 transition-colors group">
                                        <td className="sticky left-0 z-20 bg-white group-hover:bg-slate-50 px-4 py-3 text-[11px] font-black text-slate-500 border-r border-slate-100">
                                            {row.employee_id_number}
                                        </td>
                                        <td className="sticky left-[120px] z-20 bg-white group-hover:bg-slate-50 px-6 py-3 border-r border-slate-100">
                                            <div>
                                                <p className="text-[11px] font-black text-slate-800 uppercase leading-none">{row.first_name} {row.last_name}</p>
                                                <p className="text-[8px] font-bold text-indigo-500 uppercase tracking-tighter mt-1">{row.designation}, {row.location}</p>
                                            </div>
                                        </td>
                                        <td className="sticky left-[360px] z-20 bg-white group-hover:bg-slate-50 px-3 py-3 text-[11px] font-black text-slate-600 border-r border-slate-100 text-center">
                                            {row.wd}
                                        </td>
                                        <td className="sticky left-[420px] z-20 bg-white group-hover:bg-slate-50 px-3 py-3 text-[11px] font-black text-slate-600 border-r-2 border-slate-100 text-center">
                                            {row.off}
                                        </td>
                                        {days.map(d => {
                                            const status = row.days[d.day];
                                            const isOff = status === 'OFF';
                                            const isSunday = d.name === 'Sun';
                                            const badge = getShiftBadgeStyle(status);
                                            
                                            return (
                                                <td 
                                                    key={d.day} 
                                                    onClick={() => handleCellClick(row, d)}
                                                    style={badge.style}
                                                    title={status && status !== '---' ? `${status} (Click to override)` : 'Click to assign shift'}
                                                    className={`px-1 py-3 text-[9px] text-center border-r border-slate-50 cursor-pointer select-none whitespace-nowrap overflow-hidden transition-all duration-150 active:scale-95 hover:brightness-95 ${badge.className} ${isSunday && !isOff ? 'filter brightness-95' : ''}`}
                                                >
                                                    {badge.text}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
                
                <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Total Items: {filteredRoster.length}</p>
                    <div className="flex flex-wrap gap-4 max-w-[70%] justify-end">
                        <div className="flex items-center gap-1.5">
                            <div className="w-3 h-3 rounded-sm border border-slate-200 bg-slate-100" />
                            <span className="text-[9px] font-black text-slate-500 uppercase tracking-wider">OFF (Weekly Off)</span>
                        </div>
                        {shifts.map(s => {
                            const colors = getHashColor(s.name);
                            return (
                                <div key={s.id} className="flex items-center gap-1.5">
                                    <div 
                                        className="w-3 h-3 rounded-sm border" 
                                        style={{ backgroundColor: colors.bg, borderColor: colors.border }} 
                                    />
                                    <span className="text-[9px] font-black text-slate-500 uppercase tracking-wider">
                                        {s.name} ({s.start_time.slice(0, 5)}-{s.end_time.slice(0, 5)})
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
            
            {/* Slide-out Drawer */}
            <AnimatePresence>
                {drawerOpen && (
                    <>
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 0.5 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setDrawerOpen(false)}
                            className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50"
                        />
                        
                        <motion.div
                            initial={{ x: '100%' }}
                            animate={{ x: 0 }}
                            exit={{ x: '100%' }}
                            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                            className="fixed right-0 top-0 h-full w-[450px] max-w-full bg-white/90 backdrop-blur-md border-l border-slate-200/50 shadow-2xl z-50 flex flex-col justify-between"
                        >
                            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                                <div>
                                    <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Shift Override Assignment</h3>
                                    <h2 className="text-sm font-black text-slate-800 uppercase mt-1">
                                        {selectedCell?.employee?.first_name} {selectedCell?.employee?.last_name}
                                    </h2>
                                    <p className="text-[10px] font-bold text-indigo-500 uppercase mt-0.5">
                                        {selectedCell?.employee?.designation} • {selectedCell?.employee?.location}
                                    </p>
                                </div>
                                <button 
                                    onClick={() => setDrawerOpen(false)}
                                    className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 hover:bg-slate-200 transition-colors"
                                >
                                    <X size={16} />
                                </button>
                            </div>

                            <form onSubmit={handleSaveOverride} className="p-6 flex-1 space-y-6 overflow-y-auto">
                                {errorMsg && (
                                    <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-600 text-[10px] font-black uppercase tracking-wider">
                                        {errorMsg}
                                    </div>
                                )}
                                {successMsg && (
                                    <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-600 text-[10px] font-black uppercase tracking-wider animate-pulse">
                                        {successMsg}
                                    </div>
                                )}
                                {backdateWarningShown && (
                                    <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-amber-700 text-[10px] font-black uppercase tracking-wider leading-relaxed">
                                        From Date {fromDate} is in the past. Attendance already recorded from that date will be re-evaluated against this shift, which can change days that are already settled. Press Save again to apply anyway.
                                    </div>
                                )}

                                <div className="space-y-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Select Shift Type</label>
                                    <select 
                                        value={selectedShiftId}
                                        onChange={(e) => setSelectedShiftId(e.target.value)}
                                        className="w-full h-11 bg-slate-50 border border-slate-200 rounded-xl px-4 text-xs font-bold text-slate-700 outline-none focus:border-indigo-500 appearance-none"
                                        required
                                    >
                                        <option value="">-- Choose Shift --</option>
                                        {shifts.map(s => (
                                            <option key={s.id} value={s.id}>
                                                {s.name} ({s.start_time.slice(0, 5)} - {s.end_time.slice(0, 5)})
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div className="flex items-center gap-3 p-4 bg-slate-50 border border-slate-200/50 rounded-xl">
                                    <input 
                                        type="checkbox" 
                                        id="permanent-toggle"
                                        checked={isPermanent}
                                        onChange={(e) => setIsPermanent(e.target.checked)}
                                        className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                                    />
                                    <label htmlFor="permanent-toggle" className="text-[10px] font-black text-slate-700 uppercase tracking-wider cursor-pointer select-none">
                                        Make Permanent Shift Assignment
                                    </label>
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">From Date</label>
                                        <input 
                                            type="date" 
                                            value={fromDate}
                                            onChange={(e) => { setFromDate(e.target.value); setBackdateWarningShown(false); }}
                                            className="w-full h-11 bg-slate-50 border border-slate-200 rounded-xl px-4 text-xs font-bold text-slate-700 outline-none focus:border-indigo-500"
                                            required
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className={`text-[10px] font-black uppercase tracking-widest ml-1 ${isPermanent ? 'text-slate-300' : 'text-slate-400'}`}>To Date</label>
                                        <input 
                                            type="date" 
                                            value={toDate}
                                            onChange={(e) => setToDate(e.target.value)}
                                            disabled={isPermanent}
                                            className="w-full h-11 bg-slate-50 border border-slate-200 rounded-xl px-4 text-xs font-bold text-slate-700 outline-none focus:border-indigo-500 disabled:opacity-40"
                                            required={!isPermanent}
                                        />
                                    </div>
                                </div>
                                
                                <div className="text-[10px] font-bold text-slate-400 uppercase leading-relaxed p-2 bg-indigo-50/50 rounded-lg border border-indigo-100/50">
                                    💡 Info: Overridden shifts automatically override previous configurations for the specified date range. Setting a permanent assignment changes the default shift going forward.
                                </div>
                            </form>

                            <div className="p-6 border-t border-slate-100 bg-slate-50/50 flex gap-4">
                                <button 
                                    type="button"
                                    onClick={() => setDrawerOpen(false)}
                                    className="flex-1 h-11 bg-white border border-slate-200 rounded-xl text-[10px] font-black uppercase tracking-widest text-slate-600 hover:bg-slate-100 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button 
                                    type="submit"
                                    onClick={handleSaveOverride}
                                    disabled={saveLoading}
                                    className="flex-1 h-11 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-indigo-100 hover:bg-indigo-500 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                                >
                                    {saveLoading ? (
                                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                    ) : (backdateWarningShown ? 'Yes, Apply To Past Dates' : 'Save Override')}
                                </button>
                            </div>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>
            
            <style dangerouslySetInnerHTML={{ __html: `
                .custom-scrollbar::-webkit-scrollbar {
                    width: 6px;
                    height: 6px;
                }
                .custom-scrollbar::-webkit-scrollbar-track {
                    background: #f8fafc;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: #cbd5e1;
                    border-radius: 10px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: #94a3b8;
                }
            `}} />
        </div>
    );
};

export default ShiftRoaster;
