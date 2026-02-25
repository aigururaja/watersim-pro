# WaterSim Pro — Project State File
> Keep this file updated at each session end. Hand it to the new chat to resume.

## Current Phase: Session 14 — Multi-tenancy & Admin UI
## Overall Progress: Phase 1 ✅ | Phase 2 ✅ | Phase 3 ✅ | Phase 4 ✅ | Phase 5 ✅ | Phase 6 ✅ | Session 12 ✅ | Session 13 ✅ | Session 14 ✅

---

## ✅ Session 14 — Multi-tenancy & Admin: Organisation Management UI, User Invite/Management, Role Assignment (Step 53)

### Scope
Full admin UI for organisation management, user invite/management, and role assignment.
The RBAC system existed on the backend (roles: admin/engineer/operator/viewer with `requireRole` middleware).
This session adds the missing admin controller, admin API routes, and a complete admin frontend page.

---

### New Backend Files

#### `backend/src/controllers/admin.controller.js` — NEW
All admin-facing controller actions:
- `getOrganisation` — GET org profile (engineer+)
- `updateOrganisation` — PATCH org name, slug is immutable (admin only)
- `listMembers` — GET all users in the org, formatted without password hash (engineer+)
- `inviteMember` — POST create a new user with password; validates password strength & role; checks email uniqueness within org (admin only)
- `updateMember` — PATCH role/firstName/lastName/isActive for any user; guards against self-demotion and self-deactivation (admin only)
- `resetMemberPassword` — POST set new password for any member; revokes all their refresh tokens forcing re-login (admin only)
- `deleteMember` — DELETE hard-deletes a member; blocks self-deletion (admin only)
- `getStats` — GET quick org stats: member counts by role, active/inactive, project count (engineer+)
- All actions are org-scoped via `req.user.org`; cross-org access is impossible

#### `backend/src/routes/admin.js` — NEW
Mounted at `/api/v1/admin`:
- `GET    /organisation`           — requireRole('engineer')
- `PATCH  /organisation`           — requireAdmin
- `GET    /stats`                  — requireRole('engineer')
- `GET    /members`                — requireRole('engineer')
- `POST   /members`                — requireAdmin
- `PATCH  /members/:userId`        — requireAdmin
- `POST   /members/:userId/reset-password` — requireAdmin
- `DELETE /members/:userId`        — requireAdmin

### Modified Backend Files

#### `backend/src/server.js` — UPDATED
- Imports `adminRoutes`
- Mounts at `${API}/admin`

#### `backend/src/models/user.model.js` — UPDATED
- `findByOrganisation` now returns `updated_at` column as well

---

### New Frontend Files

#### `frontend/src/pages/AdminPage.jsx` — NEW
Complete admin UI page with three tabs — Members, Organisation, Overview:

**MembersTab**
- Responsive table: Name/email, Role badge, Status badge, Last login, Joined date, Actions menu
- Columns progressively hidden on narrow screens (sm:, md:, lg: breakpoints)
- Search bar to filter by name or email
- Per-row action menu (⋮): Edit member, Reset password, Deactivate/Reactivate, Delete
- Cannot delete or deactivate yourself
- InviteModal: creates a user with name, email, 4-option visual role picker, password + confirm
- EditMemberModal: first/last name, role dropdown, active toggle switch; self-role-change blocked
- ResetPasswordModal: admin sets new password, user gets logged out everywhere
- Role legend below table explaining each role
- Skeleton loading state; EmptyState when no members

**OrganisationTab**
- Org name edit field (admin only) — slug shown read-only with explanation
- Account status badge (active/inactive)
- Read-only notice for non-admins

**StatsTab (Overview)**
- 4 stat cards: total members, active, inactive, projects
- Horizontal bar chart breakdown of members by role

**Global features**
- Tab bar with WCAG `role="tablist"` + arrow key navigation
- `role="dialog"` + focus management on all three modals
- Toast notifications for all mutations
- `useAnnounce()` for screen reader feedback on invite/edit/delete
- Access guard: redirects non-admin/engineer to `/dashboard`
- Accessible role picker using `radio` inputs with `sr-only` and visual cards
- Toggle switches use `role="switch"` + `aria-checked`
- Action menus use `role="menu"` + `role="menuitem"`

**RoleBadge** — inline role badge component with icon + color per role:
- Admin: Crown icon, red
- Engineer: Wrench icon, blue
- Operator: HardHat icon, amber
- Viewer: Eye icon, gray

**StatusBadge** — green "Active" / gray "Inactive" dot badge

---

### Modified Frontend Files

#### `frontend/src/App.jsx` — UPDATED
- Imports `AdminPage`
- Route: `GET /admin` → `<ProtectedRoute><ErrorBoundary scope="Admin"><AdminPage /></ErrorBoundary></ProtectedRoute>`

#### `frontend/src/components/layout/AppLayout.jsx` — UPDATED
- Imports `ShieldCheck` from lucide-react
- Nav items split into `baseNavItems` (always shown) and `adminNavItem` (shown for admin/engineer only)
- Admin link has amber accent styling (distinct from blue nav items) with a separator rule above it
- Desktop sidebar: `canAccessAdmin` flag drives whether admin item appears
- Bottom mobile nav: stays as `baseNavItems` only (4 items max to avoid overcrowding); Admin accessible via hamburger drawer

---

### Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Who sees Admin nav** | admin + engineer | Engineers benefit from team visibility (read) even without write perms |
| **Invite = create** | Direct create with password | No email infra yet; admin sets temporary password and shares it out-of-band |
| **Password reset** | Admin sets new password + revokes all tokens | Simple, auditable; no email flow needed |
| **Soft delete / hard delete** | Hard delete on demand | Users table has no shared cross-org data; clean removal is safe |
| **Deactivate** | `is_active = false` | Prevents login without data loss; reversible |
| **Slug immutability** | Slug read-only after registration | Slug is used in auth flow; changing it would break existing sessions/bookmarks |
| **Admin nav accent** | Amber separator + amber hover | Visually distinct from normal nav; signals elevated/administrative context |
| **Bottom nav Admin exclusion** | Admin not in bottom nav | Mobile bottom bar limited to 4 primary items; Admin via hamburger |
| **Role picker in invite modal** | Visual radio cards | More discoverable than a plain select; shows role description inline |
| **RBAC enforcement** | Backend enforces; UI hides/disables | Backend is the source of truth; UI is a usability layer, not a security layer |

---

## Tech Stack (unchanged)
- React 18 + Vite + Tailwind CSS + ReactFlow
- Node.js + Express + PostgreSQL
- WebSocket collaboration
- Docker / Kubernetes production deployment

## Dev Credentials (unchanged)
| User | Email | Password | Role |
|---|---|---|---|
| Ada Admin | admin@watersim.dev | Admin1234! | admin |
| Eddie Engineer | engineer@watersim.dev | Engineer1! | engineer |
| Olivia Operator | operator@watersim.dev | Operator1! | operator |
| Org slug | `demo-org` | — | — |

## New API Endpoints (Session 14)
| Method | Path | Auth | Description |
|---|---|---|---|
| GET    | /api/v1/admin/organisation | engineer+ | Get org profile |
| PATCH  | /api/v1/admin/organisation | admin | Update org name |
| GET    | /api/v1/admin/stats | engineer+ | Org-level stats |
| GET    | /api/v1/admin/members | engineer+ | List all members |
| POST   | /api/v1/admin/members | admin | Invite (create) member |
| PATCH  | /api/v1/admin/members/:id | admin | Update role/name/status |
| POST   | /api/v1/admin/members/:id/reset-password | admin | Reset password + revoke tokens |
| DELETE | /api/v1/admin/members/:id | admin | Delete member |

## How to Resume in a New Chat
> "We are building WaterSim Pro — a React + Node.js + PostgreSQL web-based process simulation platform for wastewater treatment. Sessions 1–14 are complete. SESSION_STATE_session14.md documents everything. We are starting Session 15: [describe next task]."
