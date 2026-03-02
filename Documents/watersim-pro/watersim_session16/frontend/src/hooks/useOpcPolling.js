/**
 * useOpcPolling — Background OPC read/write polling.
 *
 * Runs at the CanvasPage level so OPC values are continuously polled
 * regardless of whether the OPC Tag Table is open. Each poll:
 *   1. Reads all mapped OPC tags via the backend API
 *   2. Updates opc_read node tagMappings with lastValue
 *   3. Pushes overridden values to upstream inlet node params
 *   4. Writes mapped OPC tags (if any write mappings exist)
 *
 * This ensures the solver always has fresh OPC data — both for
 * steady-state simulations and the continuous live sim runner.
 */

import { useEffect, useRef, useCallback } from 'react';
import useOpcStore from '../store/opcStore';
import api from '../utils/api';
import { applyTransform } from '../utils/opcTransform';

/**
 * @param {Array} nodes — React Flow nodes array
 * @param {Function} onUpdateParam — (nodeId, key, value) => void
 */
export default function useOpcPolling(nodes, onUpdateParam) {
  const protocol   = useOpcStore(s => s.protocol);
  const connStatus = useOpcStore(s => s.connStatus);
  const daServer   = useOpcStore(s => s.daServer);
  const endpointUrl = useOpcStore(s => s.endpointUrl);
  const markDisconnected = useOpcStore(s => s.markDisconnected);

  const timerRef = useRef(null);
  const busyRef  = useRef(false);

  // Keep latest refs so the interval callback doesn't go stale
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const onUpdateParamRef = useRef(onUpdateParam);
  onUpdateParamRef.current = onUpdateParam;

  // ── Collect opc_read / opc_write nodes and their mappings ──────────
  const getOpcNodes = useCallback(() => {
    const readNodes = [];
    const writeNodes = [];
    for (const n of nodesRef.current) {
      const op = n.data?.opType;
      if (op === 'opc_read') readNodes.push(n);
      if (op === 'opc_write') writeNodes.push(n);
    }
    return { readNodes, writeNodes };
  }, []);

  // ── Read all mapped tags ───────────────────────────────────────────
  const doRead = useCallback(async () => {
    const { readNodes } = getOpcNodes();
    if (readNodes.length === 0) return;

    // Collect all tag IDs from all opc_read nodes
    const allMappings = [];
    for (const rn of readNodes) {
      const mappings = rn.data?.params?.tagMappings || [];
      for (const m of mappings) {
        if (m.opcTag) allMappings.push({ ...m, nodeId: rn.id });
      }
    }
    if (allMappings.length === 0) return;

    const tagIds = allMappings.map(m => m.opcTag);

    let values;
    try {
      if (protocol === 'da') {
        const { data } = await api.post('/opc/da/read', {
          progId: daServer?.progId,
          address: daServer?.address || 'localhost',
          tagIds,
        });
        values = data.values || [];
      } else {
        const { data } = await api.post('/opc/read', { endpointUrl, tagIds });
        values = data.values || [];
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      if (err.response?.status >= 500 || /not connected/i.test(msg)) {
        markDisconnected(msg);
      }
      return;
    }

    if (!values.length) return;

    // Build value map
    const valMap = {};
    for (const v of values) valMap[v.tagId] = v;

    // Update each opc_read node's tagMappings with lastValue
    const readMappingsMap = {};
    const streamVarOverrides = {};

    for (const m of allMappings) {
      const match = valMap[m.opcTag];
      const rawOpc = match ? match.value : m.lastValue;
      const lastValue = m.filter ? applyTransform(rawOpc, m.filter) : rawOpc;
      if (!readMappingsMap[m.nodeId]) readMappingsMap[m.nodeId] = [];
      readMappingsMap[m.nodeId].push({
        streamVar: m.streamVar,
        opcTag: m.opcTag,
        lastValue,
        rawValue: match ? match.value : m.rawValue,
        filter: m.filter,
      });

      // Track overrides to push to upstream nodes (uses transformed value)
      if (lastValue != null && m.streamVar) {
        const parts = (m.projectTag || m.streamVar || '').split('::');
        const targetNodeId = parts.length > 1 ? parts[0] : null;
        const streamVar = parts.length > 1 ? parts[1] : parts[0];
        if (targetNodeId && streamVar) {
          streamVarOverrides[`${targetNodeId}::${streamVar}`] = lastValue;
        }
      }
    }

    const update = onUpdateParamRef.current;

    // Push updated tagMappings to each opc_read node
    for (const rn of readNodes) {
      if (readMappingsMap[rn.id]) {
        update(rn.id, 'tagMappings', readMappingsMap[rn.id]);
      }
    }

    // Push OPC values to upstream node params (e.g. inlet Q)
    for (const [key, val] of Object.entries(streamVarOverrides)) {
      const [targetNodeId, streamVar] = key.split('::');
      update(targetNodeId, streamVar, val);
    }
  }, [protocol, daServer, endpointUrl, markDisconnected, getOpcNodes]);

  // ── Write all mapped tags ──────────────────────────────────────────
  const doWrite = useCallback(async () => {
    const { writeNodes, readNodes } = getOpcNodes();
    if (writeNodes.length === 0) return;

    // Build map of OPC-read values by streamVar
    const readValueByStreamVar = {};
    for (const rn of readNodes) {
      for (const m of (rn.data?.params?.tagMappings || [])) {
        if (m.lastValue != null && m.streamVar) {
          readValueByStreamVar[m.streamVar] = m.lastValue;
        }
      }
    }

    const tags = [];
    for (const wn of writeNodes) {
      for (const m of (wn.data?.params?.tagMappings || [])) {
        if (!m.opcTag || !m.streamVar) continue;
        const parts = (m.projectTag || m.streamVar || '').split('::');
        const sv = parts.length > 1 ? parts[1] : parts[0];
        const raw = readValueByStreamVar[sv] ?? m.lastValue;
        if (raw == null || raw === '') continue;
        const asNum = Number(raw);
        let value = isNaN(asNum) ? raw : asNum;
        if (m.filter && typeof value === 'number') {
          value = applyTransform(value, m.filter);
        }
        tags.push({ tagId: m.opcTag, value });
      }
    }
    if (tags.length === 0) return;

    try {
      if (protocol === 'da') {
        await api.post('/opc/da/write', {
          progId: daServer?.progId,
          address: daServer?.address || 'localhost',
          tags,
        });
      } else {
        await api.post('/opc/write', { endpointUrl, tags });
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      if (err.response?.status >= 500 || /not connected/i.test(msg)) {
        markDisconnected(msg);
      }
    }
  }, [protocol, daServer, endpointUrl, markDisconnected, getOpcNodes]);

  // ── Polling loop ───────────────────────────────────────────────────
  useEffect(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (connStatus !== 'connected') return;

    // Check if there are any mapped tags at all
    const { readNodes, writeNodes } = getOpcNodes();
    const hasReadMappings = readNodes.some(n =>
      (n.data?.params?.tagMappings || []).some(m => m.opcTag)
    );
    const hasWriteMappings = writeNodes.some(n =>
      (n.data?.params?.tagMappings || []).some(m => m.opcTag)
    );
    if (!hasReadMappings && !hasWriteMappings) return;

    // Get interval from first opc node
    const anyNode = readNodes[0] || writeNodes[0];
    const intervalSec = anyNode?.data?.params?.intervalSec || 5;
    const ms = intervalSec * 1000;

    const tick = async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        if (hasReadMappings) await doRead();
        if (hasWriteMappings) await doWrite();
      } finally {
        busyRef.current = false;
      }
    };

    // First tick immediately
    tick();
    timerRef.current = setInterval(tick, ms);

    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [connStatus, getOpcNodes, doRead, doWrite]);

  // Cleanup on unmount
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);
}
