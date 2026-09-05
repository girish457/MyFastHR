const express = require('express');
const attendanceService = require('../services/attendanceService');
const router = express.Router();
const { hasPermission } = require('../middlewares/authMiddleware');

// Shift Management
router.get('/shift-list', async (req, res) => {
    try {
        const shifts = await attendanceService.getShifts(req.company_id);
        res.json(shifts);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/eligible-employees', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const employees = await attendanceService.getEligibleEmployees(req.company_id);
        res.json(employees);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.post('/shift-list', hasPermission(['approve_attendance']), async (req, res) => {
    console.log('>>> [ATTENDANCE]: Received Shift Creation Request', req.body);
    try {
        const result = await attendanceService.createShift(req.company_id, req.body);
        res.status(201).json(result);
    } catch (err) {
        console.error('>>> [ATTENDANCE]: Shift Creation Failed', err.message);
        res.status(400).json({ message: err.message });
    }
});

router.put('/shift-list/:id', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.updateShift(req.company_id, req.params.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.delete('/shift-list/:id', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.deleteShift(req.company_id, req.params.id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.post('/shift-override', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.assignShift(req.user, req.company_id, req.body);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.post('/check-in', async (req, res) => {
    try {
        const { location, latitude, longitude, remarks, accuracy } = req.body || {};
        const record = await attendanceService.checkIn(
            req.user, 
            req.company_id, 
            { location, latitude, longitude, remarks, accuracy }, 
            req.ip
        );
        res.json({ message: 'Checked in successfully', record });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.post('/check-out', async (req, res) => {
    try {
        const { location, latitude, longitude, remarks, accuracy } = req.body || {};
        const record = await attendanceService.checkOut(
            req.user, 
            req.company_id, 
            { location, latitude, longitude, remarks, accuracy }
        );
        res.json({ message: 'Checked out successfully', record });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/status', async (req, res) => {
    try {
        const status = await attendanceService.getCurrentStatus(req.user, req.company_id);
        res.json(status || { check_in: null });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/history', async (req, res) => {
    try {
        const { month, year, extended } = req.query;
        const now = new Date();
        const history = await attendanceService.getHistory(
            req.user, 
            req.company_id, 
            month || (now.getMonth() + 1), 
            year || now.getFullYear(),
            extended === 'true'
        );
        res.json(history);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/matrix', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const { month, year } = req.query;
        const now = new Date();
        const data = await attendanceService.getMatrix(
            req.user, 
            month || (now.getMonth() + 1), 
            year || now.getFullYear()
        );
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.json(data);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/whos-in', async (req, res) => {
    try {
        const { date } = req.query;
        const data = await attendanceService.getWhosInStats(req.user, date);
        res.json(data);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.post('/override', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.manualOverride(req.user, req.body);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// --- New Manual Override Routes ---

router.get('/employees-by-shift', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const { shift_id, from_date, to_date } = req.query;
        const result = await attendanceService.getEmployeesByShift(req.company_id, shift_id, from_date, to_date);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.post('/shift-override-logic', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.shiftOverrideLogic(req.user, req.company_id, req.body);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/employee-history', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const { employee_id, from, to } = req.query;
        const result = await attendanceService.getEmployeeAttendanceHistory(req.company_id, employee_id, from, to);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/date-wise', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const { date } = req.query;
        const result = await attendanceService.getDateWiseAttendance(req.company_id, date);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.post('/manual-update', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.manualUpdateAttendance(req.user, req.company_id, req.body);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/override-history', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.getOverrideHistory(req.company_id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/roster', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const { month, year, employee_id } = req.query;
        const now = new Date();
        const result = await attendanceService.getShiftRoster(
            req.company_id,
            parseInt(month) || (now.getMonth() + 1),
            parseInt(year) || now.getFullYear(),
            { employee_id }
        );
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/my-roster', async (req, res) => {
    try {
        const { month, year } = req.query;
        const now = new Date();
        const employeeId = await attendanceService.getEmployeeId(req.user.id, req.company_id, req.user.employee_id);
        const result = await attendanceService.getShiftRoster(
            req.company_id,
            parseInt(month) || (now.getMonth() + 1),
            parseInt(year) || now.getFullYear(),
            { employee_id: employeeId }
        );
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// Weekend Override
router.get('/weekend-overrides', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const { month, year } = req.query;
        const result = await attendanceService.getWeekendOverrides(req.company_id, month, year);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.post('/weekend-overrides', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.createWeekendOverride(req.user, req.company_id, req.body);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.delete('/weekend-overrides/:id', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.deleteWeekendOverride(req.company_id, req.params.id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/weekend-overrides/employees', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.getEmployeesForWeekendOverride(req.company_id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// Attendance Schemes Routes
router.get('/schemes', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.getSchemes(req.company_id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.post('/schemes', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.createScheme(req.company_id, req.body);
        res.status(201).json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.put('/schemes/:id', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.updateScheme(req.company_id, req.params.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.delete('/schemes/:id', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.deleteScheme(req.company_id, req.params.id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/schemes/assignments', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.getSchemeAssignments(req.company_id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.post('/schemes/assign', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const { employee_ids, scheme_id } = req.body;
        const result = await attendanceService.assignScheme(req.user, req.company_id, employee_ids, scheme_id);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/day-detail', async (req, res) => {
    try {
        const { employee_id, date } = req.query;
        if (!employee_id || !date) {
            return res.status(400).json({ message: 'Employee ID and date are required' });
        }
        const empId = parseInt(employee_id);
        if (req.user.role_name === 'employee' && req.user.employee_id !== empId) {
            return res.status(403).json({ message: 'Access denied: Cannot view other employee details' });
        }
        const result = await attendanceService.getDayDetail(req.company_id, empId, date);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// --- Entry/Exit Exception Requests ---
router.get('/entry-requests/not-checked-in', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const result = await attendanceService.getTodayNotCheckedIn(req.company_id, req.user);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.post('/entry-requests/pre-approve', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const { employee_id, type, date } = req.body;
        const result = await attendanceService.preApproveException(req.company_id, req.user, employee_id, type, date);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.get('/entry-requests', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        const { status } = req.query;
        const result = await attendanceService.getEntryExitRequests(req.company_id, req.user, status);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.post('/entry-requests/:id/status', hasPermission(['approve_attendance']), async (req, res) => {
    try {
        // arrival_time is what makes a 'missing_in' approval resolvable: the punch the engine
        // recorded is ambiguous, so the approver supplies the real arrival. Errors from the service
        // (missing or after-the-punch arrival) surface as the 400 below.
        const { status, attendance_status, arrival_time } = req.body;
        const result = await attendanceService.approveRejectEntryExitRequest(req.company_id, req.user, req.params.id, status, attendance_status, arrival_time);
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

module.exports = router;
