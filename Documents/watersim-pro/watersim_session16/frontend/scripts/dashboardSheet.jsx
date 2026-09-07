/**
 * Render every seeded role's dashboard (from the running backend) into one
 * standalone HTML page, styled with the production CSS — a still to look at
 * without a browser session. Run `npx vite build` first for the CSS.
 *
 *   npx vite-node scripts/dashboardSheet.jsx out.html [http://localhost:3001/api/v1]
 */
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import RoleDashboard, { ROLE_META } from '../src/components/dashboard/RoleDashboards';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || resolve(here, '..', '..', 'dashboards.html');
const base = process.argv[3] || 'http://localhost:3001/api/v1';
const assets = resolve(here, '..', 'dist', 'assets');
const css = readdirSync(assets).filter((f) => f.endsWith('.css')).map((f) => readFileSync(resolve(assets, f), 'utf8')).join('\n');

const LOGINS = [
  ['admin', 'admin@itc-stp.local', 'Admin1234!'],
  ['manager', 'manager@itc-stp.local', 'Manager1!'],
  ['engineer', 'engineer@itc-stp.local', 'Engineer1!'],
  ['operator', 'operator@itc-stp.local', 'Operator1!'],
];

const blocks = [];
for (const [role, email, password] of LOGINS) {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, orgSlug: 'itc-stp' }) });
  const token = (await r.json()).data.accessToken;
  const d = await (await fetch(`${base}/dashboard`, { headers: { authorization: `Bearer ${token}` } })).json();
  const data = d.data !== undefined && !Array.isArray(d) ? d.data : d;
  const meta = ROLE_META[data.role];
  blocks.push(renderToStaticMarkup(
    <MemoryRouter>
      <div className="p-6 max-w-[1600px] mx-auto space-y-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{meta.title}</h2>
          <p className="text-gray-500 mt-1 text-sm">{email} · <span className="capitalize">{data.role}</span> · {data.sections.join(' · ')}</p>
          <p className="text-gray-400 text-xs mt-0.5">{meta.blurb}</p>
        </div>
        <RoleDashboard data={data} />
      </div>
    </MemoryRouter>,
  ));
  console.log(`${role}: ${data.sections.length} sections`);
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Role dashboards</title><style>${css}</style><style>body{background:#f3f4f6;margin:0}.sheet{border-bottom:4px solid #cbd5e1}</style></head><body>${blocks.map((b) => `<div class="sheet">${b}</div>`).join('')}</body></html>`;
writeFileSync(out, html);
console.log(`wrote ${out}`);
