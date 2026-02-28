/**
 * OpcConnectionDialog — Simple popup for one-time OPC server connection.
 *
 * Contains only: protocol toggle, server discovery, credentials (DA), connect/disconnect.
 * All state lives in the global opcStore (Zustand).
 */

import React from 'react';
import useOpcStore from '../../store/opcStore';

function PressBtn({ style, onClick, disabled, children, title }) {
  const [pressed, setPressed] = React.useState(false);
  const bg = style?.background || '#ccc';
  const activeBg = pressed && !disabled ? darken(bg) : bg;
  return (
    <button
      style={{ ...style, background: activeBg, transition: 'background 0.1s, transform 0.1s', transform: pressed ? 'scale(0.96)' : 'scale(1)' }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

function darken(hex) {
  if (!hex || hex[0] !== '#') return hex;
  const num = parseInt(hex.slice(1), 16);
  const r = Math.max(0, ((num >> 16) & 0xFF) - 40);
  const g = Math.max(0, ((num >> 8) & 0xFF) - 40);
  const b = Math.max(0, (num & 0xFF) - 40);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export default function OpcConnectionDialog({ onClose }) {
  const {
    protocol, setProtocol,
    endpointUrl, setEndpointUrl,
    daServer, setDaServer,
    connStatus, connError,
    discoveryHost, setDiscoveryHost,
    discoveredServers, discovering, discoveryError,
    daUser, setDaUser, daPassword, setDaPassword,
    discover, connect, disconnect,
  } = useOpcStore();

  const statusDot = {
    disconnected: '#9CA3AF',
    connecting:   '#F59E0B',
    connected:    '#16A34A',
    error:        '#DC2626',
  }[connStatus];

  const canConnect = protocol === 'da' ? !!daServer?.progId : !!endpointUrl.trim();

  const selectDaServer = (srv) => {
    setDaServer({ ...srv, address: discoveryHost.trim() || 'localhost' });
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.dialog} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={S.header}>
          <span style={{ fontWeight: 700, fontSize: 14, color: '#1F4E79' }}>OPC Connection</span>
          <button style={S.closeBtn} onClick={onClose}>&#10005;</button>
        </div>

        {/* Protocol Toggle */}
        <div style={S.section}>
          <div style={S.secTitle}>Protocol</div>
          <div style={S.protocolToggle}>
            <button
              style={{ ...S.protocolBtn, ...(protocol === 'da' ? S.protocolActive : S.protocolInactive) }}
              onClick={() => setProtocol('da')}
            >
              OPC DA
            </button>
            <button
              style={{ ...S.protocolBtn, ...(protocol === 'ua' ? S.protocolActive : S.protocolInactive) }}
              onClick={() => setProtocol('ua')}
            >
              OPC UA
            </button>
          </div>
          <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 4 }}>
            {protocol === 'da' ? 'Classic OPC (COM/DCOM) — Windows only' : 'Modern OPC Unified Architecture'}
          </div>
        </div>

        {/* Server Discovery */}
        <div style={S.section}>
          <div style={S.secTitle}>Server Discovery</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            <input
              type="text"
              placeholder="localhost or IP address"
              value={discoveryHost}
              onChange={e => setDiscoveryHost(e.target.value)}
              style={{ ...S.input, flex: 1 }}
            />
            <PressBtn
              style={{ ...S.btn, background: '#4F46E5', color: '#fff', whiteSpace: 'nowrap' }}
              onClick={discover}
              disabled={discovering}
            >
              {discovering ? 'Searching...' : 'Discover'}
            </PressBtn>
          </div>

          {discoveryError && (
            <div style={{ fontSize: 11, color: '#DC2626', marginBottom: 6, padding: '4px 8px', background: '#FEF2F2', borderRadius: 4 }}>
              {discoveryError}
            </div>
          )}

          {/* DA server list */}
          {protocol === 'da' && discoveredServers.length > 0 && (
            <div style={S.serverList}>
              {discoveredServers.map((srv, si) => (
                <div
                  key={si}
                  style={{
                    ...S.serverItem,
                    background: daServer?.progId === srv.progId ? '#EFF6FF' : '#fff',
                    border: daServer?.progId === srv.progId ? '1px solid #3B82F6' : '1px solid #E5E7EB',
                  }}
                  onClick={() => selectDaServer(srv)}
                >
                  <span style={{ fontSize: 14, color: daServer?.progId === srv.progId ? '#3B82F6' : '#9CA3AF' }}>
                    {daServer?.progId === srv.progId ? '\u25CF' : '\u25CB'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#1F2937' }}>{srv.name || srv.progId}</div>
                    <div style={{ fontSize: 10, color: '#6B7280' }}>ProgID: {srv.progId}</div>
                    <div style={{ fontSize: 10, color: '#9CA3AF', wordBreak: 'break-all' }}>CLSID: {srv.clsid}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* UA server list */}
          {protocol === 'ua' && discoveredServers.length > 0 && (
            <div style={S.serverList}>
              {discoveredServers.map((srv, si) => (
                <div key={si}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', padding: '4px 0 2px' }}>
                    {srv.serverName}
                  </div>
                  {(srv.endpoints || []).map((ep, ei) => (
                    <div
                      key={ei}
                      style={{
                        ...S.serverItem,
                        background: endpointUrl === ep.endpointUrl ? '#EFF6FF' : '#fff',
                        border: endpointUrl === ep.endpointUrl ? '1px solid #3B82F6' : '1px solid #E5E7EB',
                      }}
                      onClick={() => setEndpointUrl(ep.endpointUrl)}
                    >
                      <span style={{ fontSize: 14, color: endpointUrl === ep.endpointUrl ? '#3B82F6' : '#9CA3AF' }}>
                        {endpointUrl === ep.endpointUrl ? '\u25CF' : '\u25CB'}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, color: '#1F2937', wordBreak: 'break-all' }}>{ep.endpointUrl}</div>
                        <div style={{ fontSize: 10, color: '#9CA3AF' }}>Security: {ep.securityMode} / {ep.securityPolicy}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Connection */}
        <div style={S.section}>
          <div style={S.secTitle}>Connection</div>

          {/* UA: endpoint URL input */}
          {protocol === 'ua' && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              <input
                type="text"
                placeholder="opc.tcp://192.168.1.100:4840"
                value={endpointUrl}
                onChange={e => setEndpointUrl(e.target.value)}
                style={{ ...S.input, flex: 1 }}
              />
            </div>
          )}

          {/* DA: selected server info */}
          {protocol === 'da' && daServer && (
            <div style={{ fontSize: 11, color: '#374151', marginBottom: 6, padding: '4px 8px', background: '#F3F4F6', borderRadius: 4 }}>
              <strong>{daServer.name || daServer.progId}</strong>
              <div style={{ fontSize: 10, color: '#6B7280' }}>{daServer.progId} @ {daServer.address || 'localhost'}</div>
            </div>
          )}
          {protocol === 'da' && !daServer && (
            <div style={{ fontSize: 11, color: '#9CA3AF', fontStyle: 'italic', marginBottom: 6 }}>
              Discover and select a DA server above
            </div>
          )}

          {/* DA: DCOM credentials */}
          {protocol === 'da' && daServer && (
            <>
              <div style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                <label style={{ fontSize: 11, color: '#6B7280', whiteSpace: 'nowrap', width: 62 }}>User:</label>
                <input
                  type="text"
                  placeholder="Username (e.g., QCSApp)"
                  value={daUser}
                  onChange={e => setDaUser(e.target.value)}
                  style={{ ...S.input, flex: 1, fontSize: 11 }}
                />
              </div>
              <div style={{ display: 'flex', gap: 4, marginBottom: 6, alignItems: 'center' }}>
                <label style={{ fontSize: 11, color: '#6B7280', whiteSpace: 'nowrap', width: 62 }}>Password:</label>
                <input
                  type="password"
                  placeholder="Windows password"
                  value={daPassword}
                  onChange={e => setDaPassword(e.target.value)}
                  style={{ ...S.input, flex: 1, fontSize: 11 }}
                />
              </div>
            </>
          )}

          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {connStatus !== 'connected' ? (
              <PressBtn
                style={{ ...S.btn, background: '#1D4ED8', color: '#fff' }}
                onClick={connect}
                disabled={connStatus === 'connecting' || !canConnect}
              >
                {connStatus === 'connecting' ? 'Connecting...' : 'Connect'}
              </PressBtn>
            ) : (
              <PressBtn style={{ ...S.btn, background: '#DC2626', color: '#fff' }} onClick={disconnect}>
                Disconnect
              </PressBtn>
            )}
            <span style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusDot, display: 'inline-block' }} />
              {connStatus}
            </span>
          </div>
          {connError && <div style={{ fontSize: 11, color: '#DC2626', marginTop: 4 }}>{connError}</div>}
        </div>
      </div>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const S = {
  overlay:   { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  dialog:    { background: '#fff', borderRadius: 10, width: 440, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.25)' },
  header:    { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #E5E7EB' },
  closeBtn:  { background: 'none', border: 'none', cursor: 'pointer', color: '#9CA3AF', fontSize: 16, minWidth: 32, minHeight: 32 },
  section:   { padding: '10px 18px', borderBottom: '1px solid #F3F4F6' },
  secTitle:  { fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 },
  btn:       { border: 'none', borderRadius: 5, padding: '5px 10px', fontWeight: 600, cursor: 'pointer', fontSize: 12, minHeight: 30 },
  input:     { padding: '5px 8px', border: '1px solid #D1D5DB', borderRadius: 4, fontSize: 12, outline: 'none' },

  protocolToggle:   { display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid #D1D5DB' },
  protocolBtn:      { flex: 1, padding: '6px 0', fontWeight: 700, fontSize: 12, cursor: 'pointer', border: 'none', textAlign: 'center', transition: 'all 0.15s' },
  protocolActive:   { background: '#1D4ED8', color: '#fff' },
  protocolInactive: { background: '#F9FAFB', color: '#6B7280' },

  serverList: { maxHeight: 180, overflowY: 'auto', border: '1px solid #E5E7EB', borderRadius: 6, padding: 4, background: '#F9FAFB' },
  serverItem: { display: 'flex', alignItems: 'flex-start', gap: 6, padding: '6px 8px', borderRadius: 4, cursor: 'pointer', marginBottom: 2 },
};
