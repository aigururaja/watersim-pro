import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users, Building2, ShieldCheck, Plus, Pencil, Trash2, RefreshCw,
  KeyRound, ToggleLeft, ToggleRight, ChevronDown, Crown, Wrench,
  HardHat, Eye, X, Check, AlertTriangle, Loader2, BarChart3,
} from 'lucide-react';
import AppLayout from '../components/layout/AppLayout';
import { useAuth } from '../context/AuthContext';
import { useAnnounce } from '../components/AccessibilityProvider';
import { SkeletonCard, SkeletonTable } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import api from '../utils/api';

// ── Constants ─────────────────────────────────────────────────────────────────

const ROLES = [
  { value: 'admin',    label: 'Admin',    icon: Crown,    color: 'text-red-600    bg-red-50    border-red-200',    desc: 'Full access: user management, all settings' },
  { value: 'engineer', label: 'Engineer', icon: Wrench,   color: 'text-blue-600  bg-blue-50   border-blue-200',   desc: 'Create & run simulations, edit settings' },
  { value: 'operator', label: 'Operator', icon: HardHat,  color: 'text-amber-600 bg-amber-50  border-amber-200',  desc: 'View simulations, read-only access' },
  { value: 'viewer',   label: 'Viewer',   icon: Eye,      color: 'text-gray-600  bg-gray-50   border-gray-200',   desc: 'View-only access to projects and results' },
];

const roleInfo = Object.fromEntries(ROLES.map(r => [r.value, r]));

// ── Helpers ───────────────────────────────────────────────────────────────────

function RoleBadge({ role, size = 'sm' }) {
  const info = roleInfo[role] ?? roleInfo.viewer;
  const Icon = info.icon;
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border font-medium ${padding} ${info.color}`}>
      <Icon className={size === 'sm' ? 'w-3 h-3' : 'w-4 h-4'} aria-hidden="true" />
      {info.label}
    </span>
  );
}

function StatusBadge({ isActive }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border
      ${isActive ? 'text-green-700 bg-green-50 border-green-200' : 'text-gray-500 bg-gray-50 border-gray-200'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-green-500' : 'bg-gray-400'}`} aria-hidden="true" />
      {isActive ? 'Active' : 'Inactive'}
    </span>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-20 md:bottom-6 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-xl text-white text-sm font-medium
        transition-all duration-300 max-w-[calc(100vw-32px)]
        ${toast.ok ? 'bg-emerald-700' : 'bg-red-700'}`}
    >
      {toast.ok ? <Check className="w-4 h-4 flex-shrink-0" aria-hidden="true" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />}
      {toast.msg}
    </div>
  );
}

// ── InviteModal ───────────────────────────────────────────────────────────────

function InviteModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', role: 'engineer', password: '', confirmPassword: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const firstRef = useRef(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.password !== form.confirmPassword) { setError('Passwords do not match'); return; }
    setSaving(true);
    try {
      const { data } = await api.post('/admin/members', {
        email: form.email,
        firstName: form.firstName,
        lastName: form.lastName,
        role: form.role,
        password: form.password,
      });
      onCreated(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create member');
    } finally { setSaving(false); }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
      role="dialog" aria-modal="true" aria-labelledby="invite-title"
      onKeyDown={e => e.key === 'Escape' && onClose()}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white w-full max-w-lg rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 id="invite-title" className="text-lg font-bold text-gray-900">Invite team member</h2>
          <button onClick={onClose} aria-label="Close" className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1">
          <div className="px-6 py-4 space-y-4">
            {error && (
              <div role="alert" className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {error}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="inv-fname">First name *</label>
                <input id="inv-fname" ref={firstRef} className="input" required value={form.firstName}
                  onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} placeholder="Jane" />
              </div>
              <div>
                <label className="label" htmlFor="inv-lname">Last name *</label>
                <input id="inv-lname" className="input" required value={form.lastName}
                  onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} placeholder="Smith" />
              </div>
            </div>

            <div>
              <label className="label" htmlFor="inv-email">Email address *</label>
              <input id="inv-email" type="email" className="input" required value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="jane@example.com" />
            </div>

            {/* Role picker */}
            <div>
              <label className="label">Role *</label>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Select role">
                {ROLES.map(r => {
                  const Icon = r.icon;
                  const selected = form.role === r.value;
                  return (
                    <label key={r.value}
                      className={`flex items-start gap-2.5 p-3 rounded-xl border-2 cursor-pointer transition-all
                        ${selected ? 'border-brand-500 bg-brand-50' : 'border-gray-200 hover:border-gray-300'}`}
                    >
                      <input type="radio" name="role" value={r.value} checked={selected} className="sr-only"
                        onChange={() => setForm(f => ({ ...f, role: r.value }))} />
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${r.color.split(' ').slice(0,3).join(' ')}`}>
                        <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                      </div>
                      <div>
                        <p className={`text-sm font-semibold ${selected ? 'text-brand-700' : 'text-gray-800'}`}>{r.label}</p>
                        <p className="text-xs text-gray-500 leading-tight">{r.desc}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="label" htmlFor="inv-pass">Temporary password *</label>
              <input id="inv-pass" type="password" className="input" required value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                placeholder="Min 8 chars, upper + lower + digit" autoComplete="new-password" />
            </div>
            <div>
              <label className="label" htmlFor="inv-pass2">Confirm password *</label>
              <input id="inv-pass2" type="password" className="input" required value={form.confirmPassword}
                onChange={e => setForm(f => ({ ...f, confirmPassword: e.target.value }))}
                placeholder="Repeat password" autoComplete="new-password" />
            </div>
          </div>

          <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary text-sm" aria-busy={saving}>
              {saving ? <><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />Creating…</> : <><Plus className="w-4 h-4" aria-hidden="true" />Invite member</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── EditMemberModal ───────────────────────────────────────────────────────────

function EditMemberModal({ member, currentUserId, onClose, onSaved }) {
  const [form, setForm] = useState({
    firstName: member.firstName,
    lastName:  member.lastName,
    role:      member.role,
    isActive:  member.isActive,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const isSelf = member.id === currentUserId;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const { data } = await api.patch(`/admin/members/${member.id}`, form);
      onSaved(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Update failed');
    } finally { setSaving(false); }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
      role="dialog" aria-modal="true" aria-labelledby="edit-member-title"
      onKeyDown={e => e.key === 'Escape' && onClose()}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white w-full max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 id="edit-member-title" className="text-lg font-bold text-gray-900">
            Edit {member.firstName} {member.lastName}
          </h2>
          <button onClick={onClose} aria-label="Close" className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="px-6 py-4 space-y-4">
            {error && <div role="alert" className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="em-fname">First name</label>
                <input id="em-fname" className="input" value={form.firstName}
                  onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} required />
              </div>
              <div>
                <label className="label" htmlFor="em-lname">Last name</label>
                <input id="em-lname" className="input" value={form.lastName}
                  onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} required />
              </div>
            </div>

            {/* Role */}
            <div>
              <label className="label" htmlFor="em-role">Role</label>
              {isSelf ? (
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  You cannot change your own role.
                </p>
              ) : (
                <div className="relative">
                  <select id="em-role" className="input pr-8 appearance-none" value={form.role}
                    onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                    {ROLES.map(r => <option key={r.value} value={r.value}>{r.label} — {r.desc}</option>)}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" aria-hidden="true" />
                </div>
              )}
            </div>

            {/* Active toggle */}
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
              <div>
                <p className="text-sm font-medium text-gray-900">Account active</p>
                <p className="text-xs text-gray-500">Inactive users cannot log in</p>
              </div>
              {isSelf ? (
                <span className="text-xs text-gray-400">Cannot deactivate self</span>
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.isActive}
                  onClick={() => setForm(f => ({ ...f, isActive: !f.isActive }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                    ${form.isActive ? 'bg-brand-600' : 'bg-gray-300'}`}
                  aria-label={`${form.isActive ? 'Deactivate' : 'Activate'} this account`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform
                    ${form.isActive ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              )}
            </div>
          </div>

          <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary text-sm">
              {saving ? <><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />Saving…</> : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── ResetPasswordModal ────────────────────────────────────────────────────────

function ResetPasswordModal({ member, onClose, onReset }) {
  const [password, setPassword]         = useState('');
  const [confirmPassword, setConfirm]   = useState('');
  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    setSaving(true);
    try {
      await api.post(`/admin/members/${member.id}/reset-password`, { password });
      onReset();
    } catch (err) {
      setError(err.response?.data?.error || 'Reset failed');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
      role="dialog" aria-modal="true" aria-labelledby="reset-pw-title"
      onKeyDown={e => e.key === 'Escape' && onClose()}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white w-full max-w-sm rounded-t-2xl sm:rounded-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 id="reset-pw-title" className="text-lg font-bold text-gray-900">Reset password</h2>
          <button onClick={onClose} aria-label="Close" className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="px-6 py-4 space-y-3">
            <p className="text-sm text-gray-600">Setting a new password for <strong>{member.firstName} {member.lastName}</strong>. They will be logged out of all sessions.</p>
            {error && <div role="alert" className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
            <div>
              <label className="label" htmlFor="rp-pass">New password *</label>
              <input id="rp-pass" type="password" className="input" required value={password}
                onChange={e => setPassword(e.target.value)} autoComplete="new-password"
                placeholder="Min 8 chars, upper + lower + digit" autoFocus />
            </div>
            <div>
              <label className="label" htmlFor="rp-pass2">Confirm *</label>
              <input id="rp-pass2" type="password" className="input" required value={confirmPassword}
                onChange={e => setConfirm(e.target.value)} autoComplete="new-password" placeholder="Repeat" />
            </div>
          </div>
          <div className="px-6 py-4 border-t flex justify-end gap-3">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary text-sm bg-amber-600 hover:bg-amber-700">
              {saving ? 'Resetting…' : 'Reset password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── MemberRow ─────────────────────────────────────────────────────────────────

function MemberRow({ member, currentUserId, isAdmin, onEdit, onResetPassword, onToggleActive, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const isSelf = member.id === currentUserId;

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <tr className="border-t border-gray-100 hover:bg-gray-50 transition-colors">
      {/* Avatar + name */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 text-sm font-semibold flex-shrink-0" aria-hidden="true">
            {member.firstName[0]}{member.lastName[0]}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">
              {member.firstName} {member.lastName}
              {isSelf && <span className="ml-2 text-xs text-brand-600 font-medium">(you)</span>}
            </p>
            <p className="text-xs text-gray-500 truncate">{member.email}</p>
          </div>
        </div>
      </td>

      {/* Role */}
      <td className="px-4 py-3 hidden sm:table-cell">
        <RoleBadge role={member.role} />
      </td>

      {/* Status */}
      <td className="px-4 py-3 hidden md:table-cell">
        <StatusBadge isActive={member.isActive} />
      </td>

      {/* Last login */}
      <td className="px-4 py-3 hidden lg:table-cell text-xs text-gray-500">
        {member.lastLoginAt
          ? new Date(member.lastLoginAt).toLocaleDateString()
          : <span className="text-gray-300">Never</span>}
      </td>

      {/* Joined */}
      <td className="px-4 py-3 hidden lg:table-cell text-xs text-gray-500">
        {new Date(member.createdAt).toLocaleDateString()}
      </td>

      {/* Actions */}
      <td className="px-4 py-3 text-right">
        {isAdmin ? (
          <div className="relative inline-block" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(o => !o)}
              aria-label={`Actions for ${member.firstName} ${member.lastName}`}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z" />
              </svg>
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-9 z-20 w-48 bg-white border border-gray-200 rounded-xl shadow-xl py-1 text-sm"
              >
                <button role="menuitem" className="flex items-center gap-2 w-full px-4 py-2 text-gray-700 hover:bg-gray-50"
                  onClick={() => { onEdit(); setMenuOpen(false); }}>
                  <Pencil className="w-4 h-4" aria-hidden="true" /> Edit member
                </button>
                <button role="menuitem" className="flex items-center gap-2 w-full px-4 py-2 text-gray-700 hover:bg-gray-50"
                  onClick={() => { onResetPassword(); setMenuOpen(false); }}>
                  <KeyRound className="w-4 h-4" aria-hidden="true" /> Reset password
                </button>
                {!isSelf && (
                  <>
                    <button role="menuitem" className="flex items-center gap-2 w-full px-4 py-2 text-gray-700 hover:bg-gray-50"
                      onClick={() => { onToggleActive(); setMenuOpen(false); }}>
                      {member.isActive
                        ? <><ToggleLeft  className="w-4 h-4" aria-hidden="true" /> Deactivate</>
                        : <><ToggleRight className="w-4 h-4" aria-hidden="true" /> Reactivate</>
                      }
                    </button>
                    <div className="border-t border-gray-100 my-1" role="separator" />
                    <button role="menuitem" className="flex items-center gap-2 w-full px-4 py-2 text-red-600 hover:bg-red-50"
                      onClick={() => { onDelete(); setMenuOpen(false); }}>
                      <Trash2 className="w-4 h-4" aria-hidden="true" /> Delete member
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        ) : (
          <RoleBadge role={member.role} />
        )}
      </td>
    </tr>
  );
}

// ── MembersTab ────────────────────────────────────────────────────────────────

function MembersTab({ members, loading, currentUserId, isAdmin, onRefresh, showToast }) {
  const announce = useAnnounce();
  const [showInvite, setShowInvite]   = useState(false);
  const [editTarget, setEditTarget]   = useState(null);
  const [resetTarget, setResetTarget] = useState(null);
  const [search, setSearch]           = useState('');

  const filtered = members.filter(m =>
    !search ||
    `${m.firstName} ${m.lastName} ${m.email}`.toLowerCase().includes(search.toLowerCase())
  );

  const handleCreated = (newMember) => {
    setShowInvite(false);
    showToast(`${newMember.firstName} ${newMember.lastName} added`);
    announce(`${newMember.firstName} ${newMember.lastName} added as ${newMember.role}`);
    onRefresh();
  };

  const handleSaved = (updated) => {
    setEditTarget(null);
    showToast('Member updated');
    announce(`${updated.firstName} ${updated.lastName} updated`);
    onRefresh();
  };

  const handleReset = () => {
    setResetTarget(null);
    showToast('Password reset — user will need to log in again');
  };

  const handleToggleActive = async (member) => {
    try {
      await api.patch(`/admin/members/${member.id}`, { isActive: !member.isActive });
      showToast(`${member.firstName} ${member.isActive ? 'deactivated' : 'reactivated'}`);
      announce(`${member.firstName} ${member.isActive ? 'deactivated' : 'reactivated'}`);
      onRefresh();
    } catch (err) {
      showToast(err.response?.data?.error || 'Update failed', false);
    }
  };

  const handleDelete = async (member) => {
    if (!confirm(`Permanently delete ${member.firstName} ${member.lastName}? This cannot be undone.`)) return;
    try {
      await api.delete(`/admin/members/${member.id}`);
      showToast(`${member.firstName} ${member.lastName} deleted`);
      announce(`${member.firstName} ${member.lastName} deleted`);
      onRefresh();
    } catch (err) {
      showToast(err.response?.data?.error || 'Delete failed', false);
    }
  };

  return (
    <section aria-label="Team members">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-base font-bold text-gray-900">Team Members</h2>
          <p className="text-sm text-gray-500">{members.length} member{members.length !== 1 ? 's' : ''} in your organisation</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onRefresh} aria-label="Refresh members list"
            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors">
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
          </button>
          {isAdmin && (
            <button onClick={() => setShowInvite(true)} className="btn-primary text-sm">
              <Plus className="w-4 h-4" aria-hidden="true" /> Invite member
            </button>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="mb-3">
        <input
          type="search"
          className="input max-w-xs"
          placeholder="Search members…"
          aria-label="Search members"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-4" aria-busy="true"><SkeletonTable rows={4} cols={5} /></div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            title={search ? 'No members match' : 'No members yet'}
            description={search ? 'Try different keywords.' : 'Invite your first team member.'}
            action={isAdmin && !search ? { label: '+ Invite member', onClick: () => setShowInvite(true) } : undefined}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" aria-label="Members table">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Member</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden sm:table-cell">Role</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden lg:table-cell">Last login</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden lg:table-cell">Joined</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    {isAdmin ? 'Actions' : 'Role'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(member => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    currentUserId={currentUserId}
                    isAdmin={isAdmin}
                    onEdit={() => setEditTarget(member)}
                    onResetPassword={() => setResetTarget(member)}
                    onToggleActive={() => handleToggleActive(member)}
                    onDelete={() => handleDelete(member)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Role legend */}
      <div className="mt-4 p-4 bg-gray-50 rounded-xl">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Role permissions</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {ROLES.map(r => {
            const Icon = r.icon;
            return (
              <div key={r.value} className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium ${r.color}`}>
                  <Icon className="w-3 h-3" aria-hidden="true" />{r.label}
                </span>
                <span className="text-xs text-gray-500">{r.desc}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Modals */}
      {showInvite  && <InviteModal onClose={() => setShowInvite(false)} onCreated={handleCreated} />}
      {editTarget  && <EditMemberModal member={editTarget} currentUserId={currentUserId} onClose={() => setEditTarget(null)} onSaved={handleSaved} />}
      {resetTarget && <ResetPasswordModal member={resetTarget} onClose={() => setResetTarget(null)} onReset={handleReset} />}
    </section>
  );
}

// ── OrganisationTab ───────────────────────────────────────────────────────────

function OrganisationTab({ org, isAdmin, showToast, onOrgUpdated }) {
  const [name, setName]     = useState(org?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const dirty = name.trim() !== (org?.name ?? '');

  useEffect(() => { setName(org?.name ?? ''); }, [org]);

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const { data } = await api.patch('/admin/organisation', { name: name.trim() });
      onOrgUpdated(data);
      showToast('Organisation name updated');
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  return (
    <section aria-label="Organisation settings">
      <h2 className="text-base font-bold text-gray-900 mb-4">Organisation Profile</h2>

      <div className="card p-6 max-w-lg">
        {error && <div role="alert" className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}

        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="label" htmlFor="org-name">Organisation name</label>
            <input id="org-name" className="input" value={name} required disabled={!isAdmin}
              onChange={e => setName(e.target.value)} placeholder="Your organisation" />
          </div>
          <div>
            <label className="label" htmlFor="org-slug">URL slug <span className="text-gray-400 font-normal">(read-only)</span></label>
            <input id="org-slug" className="input bg-gray-50 text-gray-500" value={org?.slug ?? ''} readOnly
              aria-readonly="true" />
            <p className="mt-1 text-xs text-gray-400">The slug is set at registration and cannot be changed.</p>
          </div>

          <div className="flex items-center justify-between py-3 px-4 bg-gray-50 rounded-xl">
            <div>
              <p className="text-sm font-medium text-gray-900">Account status</p>
              <p className="text-xs text-gray-500">Whether this organisation is active in the system</p>
            </div>
            <StatusBadge isActive={org?.isActive ?? true} />
          </div>

          {isAdmin && (
            <div className="flex justify-end pt-2">
              <button type="submit" disabled={saving || !dirty} className="btn-primary text-sm disabled:opacity-50">
                {saving ? <><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />Saving…</> : 'Save changes'}
              </button>
            </div>
          )}
        </form>
      </div>

      {!isAdmin && (
        <p className="mt-4 text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
          🔒 Only admins can update the organisation name.
        </p>
      )}
    </section>
  );
}

// ── StatsTab ──────────────────────────────────────────────────────────────────

function StatsTab({ stats, loading }) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" aria-busy="true">
        {[1,2,3,4].map(i => <SkeletonCard key={i} lines={2} />)}
      </div>
    );
  }
  if (!stats) return <EmptyState icon={BarChart3} title="Stats unavailable" description="Could not load organisation stats." />;

  const roleBreakdown = ROLES.map(r => ({
    ...r,
    count: stats.members.byRole[r.value] ?? 0,
  }));

  return (
    <section aria-label="Organisation statistics">
      <h2 className="text-base font-bold text-gray-900 mb-4">Organisation Overview</h2>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total members',    value: stats.members.total,    icon: Users,        color: 'bg-blue-50 text-blue-600' },
          { label: 'Active members',   value: stats.members.active,   icon: ToggleRight,  color: 'bg-green-50 text-green-600' },
          { label: 'Inactive members', value: stats.members.inactive, icon: ToggleLeft,   color: 'bg-gray-50 text-gray-500' },
          { label: 'Projects',         value: stats.projects,         icon: Building2,    color: 'bg-purple-50 text-purple-600' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card p-5 flex items-center gap-4">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${color}`} aria-hidden="true">
              <Icon className="w-5 h-5" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{value}</p>
              <p className="text-xs text-gray-500">{label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Role breakdown */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Members by role</h3>
        <div className="space-y-3">
          {roleBreakdown.map(r => {
            const Icon = r.icon;
            const pct = stats.members.total ? Math.round((r.count / stats.members.total) * 100) : 0;
            return (
              <div key={r.value}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium ${r.color}`}>
                    <Icon className="w-3.5 h-3.5" aria-hidden="true" />{r.label}
                  </span>
                  <span className="text-sm font-semibold text-gray-700">{r.count}</span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden" aria-hidden="true">
                  <div
                    className="h-full rounded-full bg-brand-500 transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ── AdminPage ─────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'members', label: 'Members', icon: Users },
  { key: 'org',     label: 'Organisation', icon: Building2 },
  { key: 'stats',   label: 'Overview', icon: BarChart3 },
];

export default function AdminPage() {
  const { user } = useAuth();
  const navigate  = useNavigate();
  const isAdmin   = user?.role === 'admin';
  const canAccess = ['admin', 'engineer'].includes(user?.role);

  const [activeTab, setActiveTab] = useState('members');
  const [members, setMembers]     = useState([]);
  const [org, setOrg]             = useState(null);
  const [stats, setStats]         = useState(null);
  const [loading, setLoading]     = useState(true);
  const [toast, setToast]         = useState(null);

  // Guard: redirect non-admin/engineer
  useEffect(() => {
    if (user && !canAccess) navigate('/dashboard', { replace: true });
  }, [user, canAccess, navigate]);

  const showToast = useCallback((msg, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [membersRes, orgRes, statsRes] = await Promise.all([
        api.get('/admin/members'),
        api.get('/admin/organisation'),
        api.get('/admin/stats'),
      ]);
      setMembers(Array.isArray(membersRes.data) ? membersRes.data : []);
      setOrg(orgRes.data);
      setStats(statsRes.data);
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to load admin data', false);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { if (canAccess) load(); }, [load, canAccess]);

  if (!canAccess) return null;

  return (
    <AppLayout>
      <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">

        {/* Page header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Admin</h1>
            <p className="text-sm text-gray-500 mt-0.5">Manage your team and organisation settings</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 bg-brand-50 border border-brand-200 rounded-full text-xs font-semibold text-brand-700">
              <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
              {isAdmin ? 'Admin' : 'Engineer view'}
            </span>
          </div>
        </div>

        {/* Tab bar */}
        <div
          className="flex border-b border-gray-200"
          role="tablist"
          aria-label="Admin sections"
          onKeyDown={e => {
            const i = TABS.findIndex(t => t.key === activeTab);
            if (e.key === 'ArrowRight') setActiveTab(TABS[(i + 1) % TABS.length].key);
            if (e.key === 'ArrowLeft')  setActiveTab(TABS[(i - 1 + TABS.length) % TABS.length].key);
          }}
        >
          {TABS.map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                role="tab"
                aria-selected={active}
                aria-controls={`panel-${tab.key}`}
                id={`tab-${tab.key}`}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors
                  ${active
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
              >
                <Icon className="w-4 h-4" aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab panels */}
        <div
          id={`panel-members`}
          role="tabpanel"
          aria-labelledby="tab-members"
          hidden={activeTab !== 'members'}
        >
          {activeTab === 'members' && (
            <MembersTab
              members={members}
              loading={loading}
              currentUserId={user?.id}
              isAdmin={isAdmin}
              onRefresh={load}
              showToast={showToast}
            />
          )}
        </div>

        <div
          id="panel-org"
          role="tabpanel"
          aria-labelledby="tab-org"
          hidden={activeTab !== 'org'}
        >
          {activeTab === 'org' && (
            <OrganisationTab
              org={org}
              isAdmin={isAdmin}
              showToast={showToast}
              onOrgUpdated={setOrg}
            />
          )}
        </div>

        <div
          id="panel-stats"
          role="tabpanel"
          aria-labelledby="tab-stats"
          hidden={activeTab !== 'stats'}
        >
          {activeTab === 'stats' && (
            <StatsTab stats={stats} loading={loading} />
          )}
        </div>
      </div>

      <Toast toast={toast} />
    </AppLayout>
  );
}
