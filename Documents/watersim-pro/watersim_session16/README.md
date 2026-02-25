# WaterSim Pro

> Web-Based Wastewater & Water Purification Process Simulation Platform

## Stack
- **Frontend:** React 18 + Vite + Tailwind CSS + React Router + TanStack Query + Zustand
- **Backend:** Node.js + Express + PostgreSQL
- **Auth:** JWT (access token) + httpOnly cookie (refresh token) + RBAC

## Quick Start

### Prerequisites
- Node.js >= 18
- PostgreSQL >= 14
- npm >= 9

### Setup
```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp backend/.env.example backend/.env
# Edit backend/.env with your DB credentials and JWT secret

# 3. Create database
createdb watersim_dev

# 4. Run schema migration
psql watersim_dev < backend/migrations/001_initial_schema.sql

# 5. Start dev servers (both frontend + backend)
npm run dev
```

### Ports
| Service  | URL                        |
|----------|----------------------------|
| Frontend | http://localhost:5173      |
| Backend  | http://localhost:3001      |
| API      | http://localhost:3001/api  |
| Health   | http://localhost:3001/api/health |

## Project Structure
```
watersim/
├── backend/
│   ├── migrations/        # SQL schema migrations
│   ├── src/
│   │   ├── config/        # Environment config
│   │   ├── controllers/   # Route handlers
│   │   ├── db/            # PostgreSQL pool + query helpers
│   │   ├── middleware/     # Auth, RBAC, error handling
│   │   ├── models/        # DB query functions
│   │   ├── routes/        # Express routers
│   │   └── utils/         # Logger, JWT helpers
│   └── server.js
├── frontend/
│   ├── src/
│   │   ├── components/    # Reusable UI (canvas, layout, shared)
│   │   ├── context/       # React context (Auth)
│   │   ├── hooks/         # Custom hooks
│   │   ├── pages/         # Page components
│   │   ├── services/      # API service layer
│   │   └── utils/
│   └── index.html
└── docs/
```

## Auth Flow
1. Register: `POST /api/auth/register` (creates org + admin user)
2. Login: `POST /api/auth/login` → access token (JSON) + refresh token (httpOnly cookie)
3. All protected requests: `Authorization: Bearer <accessToken>`
4. Refresh: `POST /api/auth/refresh` → new access token + rotated refresh cookie
5. Logout: `POST /api/auth/logout`

## Roles
| Role      | Can Do |
|-----------|--------|
| admin     | Full access + user management |
| engineer  | Create/edit projects and flowsheets, run simulations |
| operator  | View and run existing flowsheets |
| viewer    | Read-only access |
