# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MyFastHR is a multi-tenant HRMS/CRM SaaS platform: React (Vite) frontend + Express/Knex/MySQL backend. Core domains are attendance/biometric sync, payroll, leave management, employee records, org charts, document vault, and letter generation.

## Commands

There is no root-level build; the frontend and backend are run as two separate apps.

**Backend** (from `backend/`):
```bash
npm install
npm run dev      # nodemon src/server.js, http://localhost:5000
npm start        # node src/server.js (production)
```
There is no general backend test suite (`npm test` is a stub) and no lint script, but the
punch engine has a regression harness:
```bash
npm run punch:replay    # replays ~19 punch scenarios through the real processPunch()
```
It refuses to run against any database whose name does not end in `_replay`/`_test`/`_verify`/
`_scratch`, so set up a scratch DB first (schema-only dump of `myfasthr_db`, then boot the app
once against it so `syncDatabaseSchema()` adds any new columns) — the header of
`backend/scripts/replayPunches.js` has the exact commands. **Run it before and after any change
to `machineAttendanceService.js`, and add a scenario for the bug you are fixing.** Every
attendance fix before this one was verified with a throwaway script that was then discarded,
which is why the same bugs kept coming back.

The read path (muster / history sheet / date-wise / day-detail / the employee's own
"My Attendance") has two more:
```bash
npm run resolver:test    # ~250 pure assertions on services/attendance/dayResolver.js, NO database
npm run readpath:replay  # asserts all five read screens agree cell for cell on seeded fixtures
```
`resolver:test` needs nothing but node and runs in ~50ms, so run it on every save while editing
`services/attendance/dayResolver.js` or `time.js` — those two modules are pure by contract (no
`db`/knex import, no clock read; `now`/`todayStr` arrive as arguments) and the test asserts that
contract as well as the behaviour. `readpath:replay` needs the same kind of scratch DB as
`punch:replay`; its header has the setup, and it asserts that all FIVE read screens answer
the same letter for the same day - a read screen that is not in that harness is a screen free
to drift back out of alignment, so wire any new one in. **Run all three before and after any change to
`attendanceService.js`, `dayResolver.js` or `machineAttendanceService.js`.**

`backend/scripts/` also holds `auditShiftAssignments.js`, a read-only report of employees with
overlapping or missing shift assignments that prints the repair SQL without running it. Older
one-off diagnostics still sit loose in `backend/` (`check_*.js`, `test_assignments.js`); new
tooling belongs in `scripts/`.

**Frontend** (from `frontend/`):
```bash
npm install
npm run dev       # vite, http://localhost:5173
npm run build     # production build to frontend/dist
npm run lint      # eslint .
npm run cap:sync  # build + sync into the Capacitor Android shell (frontend/android)
```
There is no frontend test suite.

**Database**: MySQL, database name `myfasthr_db`. There are no Knex migration files (`database/migrations` is referenced in `backend/knexfile.js` but does not exist) — schema is instead self-healing: `backend/src/app.js` runs `syncDatabaseSchema()` on every boot, which checks `hasTable`/`hasColumn` and applies missing tables/columns idempotently. **When you add a new column or table, add the corresponding `hasTable`/`hasColumn` + `alterTable`/`createTable` block in `syncDatabaseSchema()` in `backend/src/app.js`** — this is the only mechanism that keeps dev/staging/production schemas in sync since there's no formal migration runner. Only `database/seeds/01_initial_users.js` exists under `database/`.

Root-level `package.json`, `purge_files.js`, `purge_screenshots.js`, and `deploy_prep.js` are referenced by `README.md` but are not present in the working tree (they're also gitignored) — don't assume they exist without checking first.

## Architecture

### Backend structure (`backend/src/`)
Layered per-domain: `routes/` → `controllers/` → `services/` → `repositories/` → Knex query builder against `config/db.js`. Business logic lives in `services/`; `repositories/` are thin query modules. `backend/src/app.js` is unusually large — besides Express wiring, it contains the schema auto-sync routine, static/upload file serving with a "virtual router" for multi-tenant-isolated upload folders, CORS origin logic, a global system-freeze write-lock middleware, the ZKTeco/biometric-machine webhook handlers (`/Device/SaveDevice`, `/api/attendance/machine-log`), and public unauthenticated routes (branding, case studies, book-demo, onboarding). Read it before assuming route wiring lives only in `routes/`.

### Multi-tenancy model
Despite naming vestiges suggesting per-tenant databases (`db.centralDb`, `db.getTenantDb`, `db.initTenantDb` in `config/db.js`), the app actually uses a **single shared MySQL database** with row-level isolation via a `company_id` column on tenant-scoped tables. Those tenant-DB-shaped functions are now no-op aliases that all resolve to the same connection — don't try to wire up real per-tenant databases without confirming with the user first, since that would be a significant architecture change.

Tenant isolation is enforced by middleware chain: `authenticateToken` (JWT → `req.user`) → `tenantMiddleware`/`tenantFilter` (resolves `req.company_id`, `req.user.employee_id`) → `tenantGuard` (blocks if `company.subscription_status === 'inactive'`). Routes are mounted in `app.js` as `app.use('/api/x', authenticateToken, tenantGuard, xRoutes)`. `super_admin` bypasses company scoping (`req.company_id = null` unless impersonating via `company_id` query/body param).

### Auth dev-bypass tokens
`authMiddleware.js` has hardcoded literal tokens (`test.super.token`, `test.admin.token`, `test.manager.token`, `test.employee.token`, `test.employee1.token`) that map to deterministic demo user contexts, **not gated behind `NODE_ENV`**. The frontend's `utils/api.js` defaults to `test.admin.token` when no `auth_token` is in localStorage. Be aware of this when reasoning about auth security or when a request behaves like a specific role unexpectedly.

### Attendance/shift engine
This is the most complex and bug-prone subsystem. Before touching `attendanceService.js`, `machineAttendanceService.js`, or shift/muster logic, **read `MyFastHR_Attendance_Master_Prompt.md` and `ATTENDANCE_TROUBLESHOOTING.md` in the repo root** — they document the shift resolution hierarchy, night-shift logical-date rules, the 3 shift types (standard 2-punch, split/session 4-punch, flexi), status-priority rules for the muster grid, and a list of previously-fixed bugs with root causes (e.g. shift-assignment ordering must be `.orderBy('esa.from_date', 'desc').orderBy('esa.id', 'desc')`, not creation order). Re-introducing one of these already-fixed bugs is the main risk when editing this code.

All datetime handling in the attendance path must go through `dbDateToUTC()` and IST (`Asia/Kolkata`) conversions as done in `attendanceService.js` — don't use raw `Date` math, since DB timestamps and server timezone are not guaranteed to align with logical (Asia/Kolkata) day boundaries, especially for night shifts.

### Frontend structure (`frontend/src/`)
Route-based, role-gated via `ProtectedRoute` in `App.jsx`: reads `user_role` from localStorage and compares against `allowedRoles` arrays (`allRoles`, `exceptAdmin`, `exceptEmployee`, `restrictedBoth`). Role-specific dashboards live in `pages/dashboards/` (`SuperAdminDashboard`, `AdminDashboard`, `ManagerDashboard`, `EmployeeDashboard`). Attendance/leave admin screens are grouped under `pages/leave-attendance/` with their own layout (`LeaveAttendanceLayout.jsx`). All API calls go through the shared axios instance in `utils/api.js`, which auto-attaches the bearer token (defaulting to `test.admin.token`), auto-redirects to `/login` on 401/403, and intercepts a custom `DELETE_KEY_REQUIRED` response code to prompt for a delete-security PIN before retrying the original request.

### Deployment
Single-VPS PM2 + Nginx deployment (see `deployment_notes.md`). `ecosystem.config.js` points PM2 at `./backend/index.js` in cluster mode — confirm this still matches the real entry point (`backend/src/server.js` per `package.json`'s `start` script) before relying on it. Frontend is built and its `dist/` output is copied into `backend/public/`, which Express serves statically before hitting the API routes.
