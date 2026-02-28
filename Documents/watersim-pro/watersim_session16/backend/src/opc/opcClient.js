/**
 * WaterSim Pro — OPC-UA Client Manager
 *
 * Singleton manager for OPC-UA client sessions. Supports:
 * - Connect / disconnect to OPC-UA servers
 * - Browse server namespace (lazy tree)
 * - Read / write multiple tags
 * - Session caching (one session per endpoint)
 */

'use strict';

const {
  OPCUAClient,
  MessageSecurityMode,
  SecurityPolicy,
  AttributeIds,
  DataType,
  NodeClass,
  StatusCodes,
  coerceNodeId,
  BrowseDirection,
  ReferenceTypeIds,
} = require('node-opcua');

const logger = require('../config/index').logger || console;

// ── Session cache ────────────────────────────────────────────────────────────

/** @type {Map<string, { client: OPCUAClient, session: any, status: string }>} */
const sessions = new Map();

const CONNECTION_TIMEOUT = 30000; // 30 seconds

// ── Connect ──────────────────────────────────────────────────────────────────

async function connect(endpointUrl) {
  if (!endpointUrl) throw new Error('endpointUrl is required');

  // Return existing session if already connected
  const existing = sessions.get(endpointUrl);
  if (existing && existing.status === 'connected') {
    return { status: 'connected', sessionId: existing.session.sessionId?.toString() || 'active' };
  }

  const client = OPCUAClient.create({
    applicationName: 'WaterSimPro',
    connectionStrategy: {
      initialDelay: 1000,
      maxRetry: 3,
      maxDelay: 5000,
    },
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    endpointMustExist: false,
    requestedSessionTimeout: 60000,
  });

  try {
    await client.connect(endpointUrl);
    const session = await client.createSession();

    sessions.set(endpointUrl, { client, session, status: 'connected' });

    // Auto-cleanup on close
    client.on('close', () => {
      const entry = sessions.get(endpointUrl);
      if (entry) entry.status = 'disconnected';
    });

    logger.info?.('[OPC] Connected to %s', endpointUrl);

    return {
      status: 'connected',
      sessionId: session.sessionId?.toString() || 'active',
      serverInfo: {
        serverName: session.serverEndpoints?.[0]?.server?.applicationName?.text || 'Unknown',
        endpointUrl,
      },
    };
  } catch (err) {
    logger.error?.('[OPC] Connection failed: %s — %s', endpointUrl, err.message);
    // Cleanup partial state
    try { await client.disconnect(); } catch (_) { /* ignore */ }
    sessions.delete(endpointUrl);
    throw new Error(`OPC connection failed: ${err.message}`);
  }
}

// ── Disconnect ───────────────────────────────────────────────────────────────

async function disconnect(endpointUrl) {
  const entry = sessions.get(endpointUrl);
  if (!entry) return;

  try {
    await entry.session.close();
    await entry.client.disconnect();
  } catch (_) { /* ignore cleanup errors */ }

  sessions.delete(endpointUrl);
  logger.info?.('[OPC] Disconnected from %s', endpointUrl);
}

// ── Browse ───────────────────────────────────────────────────────────────────

async function browse(endpointUrl, nodeId) {
  const entry = sessions.get(endpointUrl);
  if (!entry || entry.status !== 'connected') {
    throw new Error('Not connected. Call connect() first.');
  }

  const browseNodeId = nodeId || 'RootFolder';

  try {
    const browseResult = await entry.session.browse({
      nodeId: browseNodeId,
      browseDirection: BrowseDirection.Forward,
      referenceTypeId: ReferenceTypeIds.HierarchicalReferences,
      includeSubtypes: true,
      nodeClassMask: 0, // all node classes
      resultMask: 63,   // all fields
    });

    if (!browseResult.references) return [];

    return browseResult.references.map(ref => ({
      nodeId: ref.nodeId?.toString() || '',
      browseName: ref.browseName?.name || ref.browseName?.toString() || '',
      displayName: ref.displayName?.text || ref.browseName?.name || '',
      nodeClass: NodeClass[ref.nodeClass] || String(ref.nodeClass),
      isFolder: ref.nodeClass === NodeClass.Object || ref.nodeClass === NodeClass.View,
    }));
  } catch (err) {
    logger.error?.('[OPC] Browse failed for %s: %s', browseNodeId, err.message);
    throw new Error(`Browse failed: ${err.message}`);
  }
}

// ── Read ─────────────────────────────────────────────────────────────────────

async function read(endpointUrl, tagIds) {
  const entry = sessions.get(endpointUrl);
  if (!entry || entry.status !== 'connected') {
    throw new Error('Not connected. Call connect() first.');
  }

  if (!tagIds || tagIds.length === 0) return [];

  try {
    const nodesToRead = tagIds.map(tagId => ({
      nodeId: tagId,
      attributeId: AttributeIds.Value,
    }));

    const dataValues = await entry.session.read(nodesToRead);

    return tagIds.map((tagId, i) => {
      const dv = dataValues[i];
      return {
        tagId,
        value: dv?.value?.value ?? null,
        dataType: DataType[dv?.value?.dataType] || 'Unknown',
        timestamp: dv?.serverTimestamp?.toISOString() || new Date().toISOString(),
        statusCode: dv?.statusCode?.name || 'Unknown',
        isGood: dv?.statusCode?.equals(StatusCodes.Good) || false,
      };
    });
  } catch (err) {
    logger.error?.('[OPC] Read failed: %s', err.message);
    throw new Error(`Read failed: ${err.message}`);
  }
}

// ── Write ────────────────────────────────────────────────────────────────────

async function write(endpointUrl, tags) {
  const entry = sessions.get(endpointUrl);
  if (!entry || entry.status !== 'connected') {
    throw new Error('Not connected. Call connect() first.');
  }

  if (!tags || tags.length === 0) return [];

  try {
    const results = [];
    for (const tag of tags) {
      try {
        const statusCode = await entry.session.write({
          nodeId: tag.tagId,
          attributeId: AttributeIds.Value,
          value: {
            value: {
              dataType: guessDataType(tag.value),
              value: tag.value,
            },
          },
        });

        results.push({
          tagId: tag.tagId,
          statusCode: statusCode?.name || 'Unknown',
          isGood: statusCode?.equals(StatusCodes.Good) || false,
        });
      } catch (writeErr) {
        results.push({
          tagId: tag.tagId,
          statusCode: 'BadWriteFailed',
          isGood: false,
          error: writeErr.message,
        });
      }
    }

    return results;
  } catch (err) {
    logger.error?.('[OPC] Write failed: %s', err.message);
    throw new Error(`Write failed: ${err.message}`);
  }
}

// ── Status ───────────────────────────────────────────────────────────────────

function getStatus(endpointUrl) {
  const entry = sessions.get(endpointUrl);
  if (!entry) return { status: 'disconnected' };
  return { status: entry.status };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function guessDataType(value) {
  if (typeof value === 'boolean') return DataType.Boolean;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? DataType.Int32 : DataType.Double;
  }
  if (typeof value === 'string') return DataType.String;
  return DataType.Variant;
}

// ── Discover Servers ─────────────────────────────────────────────────────────

async function discoverServers(hostname) {
  if (!hostname) hostname = 'localhost';
  const discoveryUrl = `opc.tcp://${hostname}:4840`;

  const client = OPCUAClient.create({
    applicationName: 'WaterSimPro-Discovery',
    connectionStrategy: { initialDelay: 500, maxRetry: 1, maxDelay: 3000 },
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    endpointMustExist: false,
    requestedSessionTimeout: 10000,
  });

  try {
    await client.connect(discoveryUrl);

    // findServers returns all OPC-UA servers registered on that host
    let servers = [];
    try {
      const found = await client.findServers();
      servers = (found || []).map(s => ({
        serverName: s.applicationName?.text || 'Unknown Server',
        applicationUri: s.applicationUri || '',
        productUri: s.productUri || '',
        discoveryUrls: s.discoveryUrls || [],
      }));
    } catch (_) {
      // findServers may not be supported; fall back to getEndpoints
    }

    // getEndpoints returns the endpoints of the server we connected to
    let endpoints = [];
    try {
      const eps = await client.getEndpoints();
      endpoints = (eps || []).map(ep => ({
        endpointUrl: ep.endpointUrl || '',
        securityMode: MessageSecurityMode[ep.securityMode] || String(ep.securityMode),
        securityPolicy: ep.securityPolicyUri?.split('#').pop() || 'Unknown',
        serverName: ep.server?.applicationName?.text || '',
      }));
    } catch (_) {
      // ignore
    }

    await client.disconnect();

    // If findServers returned results, attach endpoint details
    if (servers.length > 0) {
      // Match endpoints to servers by discoveryUrl overlap
      const extractHost = (url) => {
        try { return url.replace(/^opc\.tcp:\/\//, 'http://').split('/')[2]?.split(':')[0] || ''; } catch (_) { return ''; }
      };
      for (const srv of servers) {
        srv.endpoints = endpoints.filter(ep =>
          srv.discoveryUrls.some(du => { const h = extractHost(du); return h && ep.endpointUrl.includes(h); }) ||
          ep.serverName === srv.serverName
        );
        // If no match, include all endpoints (single-server case)
        if (srv.endpoints.length === 0) srv.endpoints = endpoints;
      }
      return servers;
    }

    // Fallback: no findServers results — build from endpoints
    if (endpoints.length > 0) {
      const grouped = {};
      for (const ep of endpoints) {
        const name = ep.serverName || 'OPC Server';
        if (!grouped[name]) grouped[name] = { serverName: name, applicationUri: '', discoveryUrls: [discoveryUrl], endpoints: [] };
        grouped[name].endpoints.push(ep);
      }
      return Object.values(grouped);
    }

    return [];
  } catch (err) {
    // Cleanup
    try { await client.disconnect(); } catch (_) { /* ignore */ }
    logger.error?.('[OPC] Discovery failed for %s: %s', discoveryUrl, err.message);
    throw new Error(`Discovery failed for ${hostname}: ${err.message}`);
  }
}

// ── Cleanup on process exit ──────────────────────────────────────────────────

async function disconnectAll() {
  for (const [url] of sessions) {
    try { await disconnect(url); } catch (_) { /* ignore */ }
  }
}

process.on('SIGINT', disconnectAll);
process.on('SIGTERM', disconnectAll);

module.exports = { connect, disconnect, browse, read, write, getStatus, discoverServers, disconnectAll };
