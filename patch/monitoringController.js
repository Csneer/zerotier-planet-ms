'use strict';

const crypto = require('crypto');
const fs = require('fs');
const controllerHttp = require('../controllerHttp');
const storage = require('node-persist');
const statusTools = require('../uiStatus');
const rootStatus = require('../rootStatus');
const hostDiagnostics = require('../hostDiagnostics');
const communicationStats = require('../communicationStats');
const endpointProbes = require('../endpointProbes');
const zt = require('./zt');

storage.initSync({dir: 'etc/storage'});

const runtimePlanetPath = '/var/lib/zerotier-one/planet';
const distributedPlanetPath = '/app/dist/planet';
const metricsPath = '/var/lib/zerotier-one/metrics.prom';
let previousMetricSample = null;

async function sha256(path) {
  const content = await fs.promises.readFile(path);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function parseLabels(value) {
  const labels = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g;
  let match;
  while ((match = pattern.exec(value)) !== null) labels[match[1]] = match[2].replace(/\\"/g, '"');
  return labels;
}

function parseMetrics(content) {
  const traffic = {udpRx: 0, udpTx: 0, tcpRx: 0, tcpTx: 0};
  const packets = {rx: 0, tx: 0};
  for (const line of String(content).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)$/);
    if (!match) continue;
    const name = match[1].replace(/_total$/, '');
    const labels = parseLabels(match[2] || '');
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    if (name === 'zt_data') {
      const key = `${labels.protocol || ''}${labels.direction === 'rx' ? 'Rx' : 'Tx'}`;
      if (Object.prototype.hasOwnProperty.call(traffic, key)) traffic[key] = value;
    } else if (name === 'zt_packet' && (labels.direction === 'rx' || labels.direction === 'tx')) {
      packets[labels.direction] += value;
    }
  }
  return {traffic, packets};
}

function metricRates(metrics, now) {
  const result = {traffic: null, packets: null};
  if (previousMetricSample && now > previousMetricSample.time) {
    const seconds = (now - previousMetricSample.time) / 1000;
    result.traffic = {};
    for (const key of Object.keys(metrics.traffic)) {
      result.traffic[key] = Math.max(0, metrics.traffic[key] - previousMetricSample.metrics.traffic[key]) / seconds;
    }
    result.packets = {
      rx: Math.max(0, metrics.packets.rx - previousMetricSample.metrics.packets.rx) / seconds,
      tx: Math.max(0, metrics.packets.tx - previousMetricSample.metrics.packets.tx) / seconds
    };
  }
  previousMetricSample = {time: now, metrics};
  return result;
}

async function readMetrics(now) {
  try {
    const content = await fs.promises.readFile(metricsPath, 'utf8');
    if (!content.trim()) return {available: false, traffic: {}, packets: {}, rates: {traffic: null, packets: null}};
    const metrics = parseMetrics(content);
    return {available: true, traffic: metrics.traffic, packets: metrics.packets, rates: metricRates(metrics, now)};
  } catch (_) {
    return {available: false, traffic: {}, packets: {}, rates: {traffic: null, packets: null}};
  }
}

async function getProbe() {
  const address = process.env.ZT_PROBE_ADDR || 'http://127.0.0.1:9993';
  const tokenFile = process.env.ZT_PROBE_TOKEN_FILE || '/run/zerotier-probe/authtoken.secret';
  try {
    const token = (await fs.promises.readFile(tokenFile, 'utf8')).trim();
    if (!token) throw new Error('probe token is empty');
    const options = {
      json: true,
      headers: {'X-ZT1-Auth': token},
      timeout: 3000,
      retries: 0,
      followRedirect: false
    };
    const [status, peers] = await Promise.all([
      controllerHttp(`${address}/status`, options).then(response => response.body),
      controllerHttp(`${address}/peer`, options).then(response => response.body)
    ]);
    return {available: true, status, peers: Array.isArray(peers) ? peers : [], error: null};
  } catch (error) {
    return {available: false, status: null, peers: [], error: error.code || error.message};
  }
}

async function collectRoots(serviceStatus, peers, probe) {
  const [service, planetPeers, client] = await Promise.all([
    serviceStatus || zt.get_zt_status(), peers || zt.peers(), probe || getProbe()
  ]);
  let metadata = null;
  try {
    metadata = JSON.parse(await fs.promises.readFile('/app/config/planet-roots.json', 'utf8'));
  } catch (_) { /* Show unavailable metadata instead of inventing a topology. */ }
  const topology = rootStatus.build(metadata, service, planetPeers, client);
  topology.hostDiagnostics = await hostDiagnostics.collect(topology);
  return topology;
}

function memberVersion(member, peer) {
  if (peer && Number(peer.versionMajor) >= 0 && peer.version) return peer.version;
  if (Number(member.vMajor) >= 0) return `${member.vMajor}.${member.vMinor}.${member.vRev}`;
  return null;
}

function peerLatency(peer) {
  const value = peer && peer.latency;
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const latency = Number(value);
  return Number.isFinite(latency) && latency >= 0 ? latency : null;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatRate(value, suffix) {
  return Number.isFinite(value) ? `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${suffix}/s` : '—';
}

function formatAge(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return '< 1s';
  if (value < 60000) return `${Math.round(value / 1000)}s`;
  if (value < 3600000) return `${Math.round(value / 60000)}m`;
  return `${Math.round(value / 3600000)}h`;
}

async function collect() {
  const [serviceStatus, planetPeers, networks, probe, endpointProbeStatus] = await Promise.all([
    zt.get_zt_status(),
    zt.peers(),
    zt.network_list(),
    getProbe(),
    endpointProbes.collect()
  ]);
  const now = Number(serviceStatus.clock) || Date.now();
  const metrics = await readMetrics(now);
  const memberMap = new Map();

  // The embedded control API stalls for about four seconds when more than
  // eight member detail requests arrive concurrently. Keep these local calls
  // sequential; in practice the complete list returns in a few milliseconds.
  for (const network of networks) {
    const response = await zt.members(network.nwid);
    for (const id of statusTools.managedMemberIds(response)) {
      const detail = await zt.member_detail(network.nwid, id);
      const member = memberMap.get(id) || {
        id, name: await storage.getItem(id) || '', networks: [], authorized: false,
        activeBridge: false, detail
      };
      member.networks.push({nwid: network.nwid, name: network.name,
        authorized: detail.authorized === true,
        activeBridge: detail.activeBridge === true});
      member.authorized = member.authorized || detail.authorized === true;
      member.activeBridge = member.activeBridge || detail.activeBridge === true;
      member.detail = detail;
      memberMap.set(id, member);
    }
  }

  const planetPeerMap = new Map((Array.isArray(planetPeers) ? planetPeers : [])
    .map(peer => [String(peer.address).toLowerCase(), peer]));
  const probePeerMap = new Map(probe.peers.map(peer => [String(peer.address).toLowerCase(), peer]));
  const probeAddress = probe.status && String(probe.status.address || '').toLowerCase();
  const members = [...memberMap.values()].map(member => {
    const planetPeer = planetPeerMap.get(member.id);
    const probePeer = probePeerMap.get(member.id);
    const path = statusTools.preferredPath(planetPeer);
    const probePath = statusTools.preferredPath(probePeer);
    const version = memberVersion(member.detail, planetPeer);
    return {
      ...member,
      version,
      versionBehind: statusTools.compareVersions(version, serviceStatus.version) === -1,
      planet: {
        observed: Boolean(planetPeer),
        reachable: statusTools.isPlanetReachable(planetPeer),
        latency: peerLatency(planetPeer),
        path: path && path.address,
        pathCount: statusTools.activePaths(planetPeer).length,
        lastActivityMs: statusTools.lastActivityMs(planetPeer, now)
      },
      probe: {
        state: probe.available ? statusTools.probeLinkState(probePeer, probeAddress, member.id) : 'unavailable',
        latency: peerLatency(probePeer),
        path: probePath && probePath.address,
        pathCount: statusTools.activePaths(probePeer).length
      }
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const networkStats = communicationStats.buildNetworkStats(networks, members, probe.available === true);
  const communication = communicationStats.buildCommunicationSummary(networkStats, probe.available === true);

  let runtimeHash = null;
  let distributedHash = null;
  try {
    [runtimeHash, distributedHash] = await Promise.all([sha256(runtimePlanetPath), sha256(distributedPlanetPath)]);
  } catch (_) {
    // The page will surface a failed consistency check without exposing paths or secrets.
  }
  const topology = await collectRoots(serviceStatus, planetPeers, probe);
  const configuredRoots = topology.available ? new Set(topology.roots.map(root => root.id)) : null;
  const unexpectedPlanetCount = configuredRoots ? (Array.isArray(planetPeers) ? planetPeers : [])
    .filter(peer => peer && peer.role === 'PLANET' && !configuredRoots.has(String(peer.address).toLowerCase())).length : null;

  return {
    generatedAt: new Date(now).toISOString(),
    service: {
      ...serviceStatus,
      runtimePlanetHash: runtimeHash,
      distributedPlanetHash: distributedHash,
      planetMatches: Boolean(runtimeHash && distributedHash && runtimeHash === distributedHash),
      unexpectedPlanetCount,
      rootConfigAvailable: configuredRoots !== null,
      uptimeSeconds: process.uptime()
    },
    probe,
    topology,
    metrics,
    networkStats,
    communication,
    endpointProbes: endpointProbeStatus,
    members,
    summary: {
      networkCount: networks.length,
      memberCount: members.length,
      planetObservedCount: members.filter(member => member.planet.observed).length,
      planetUnknownCount: members.filter(member => !member.planet.observed).length,
      planetReachableCount: members.filter(member => member.planet.reachable).length,
      probeDirectCount: members.filter(member => member.probe.state === 'direct').length,
      probeRelayCount: members.filter(member => member.probe.state === 'relay' || member.probe.state === 'tcp_relay').length,
      probeUnknownCount: members.filter(member => member.probe.state === 'unknown').length,
      bridgeMemberCount: members.filter(member => member.activeBridge).length,
      oldVersionCount: members.filter(member => member.versionBehind).length
    }
  };
}

exports.index = async function(req, res) {
  const navigate = {active: 'monitor'};
  try {
    const monitor = await collect();
    res.set('Cache-Control', 'no-store');
    res.render('monitor', {
      title: req.t('monitor.title'), navigate, monitor,
      topology: monitor.topology, uiListeners: req.app.locals.uiListeners || [],
      formatBytes, formatRate, formatAge
    });
  } catch (error) {
    res.status(500).render('monitor', {
      title: req.t('monitor.title'), navigate, monitor: null,
      error: req.t('monitor.collect_error', {error: error.message}),
      formatBytes, formatRate, formatAge
    });
  }
};

exports.collect = collect;
exports.collectRoots = collectRoots;
exports.formatAge = formatAge;
exports.rootsJson = async function(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    const topology = await collectRoots();
    res.json({generatedAt: new Date().toISOString(), topology,
      listeners: req.app.locals.uiListeners || []});
  } catch (_) {
    res.status(503).json({error: 'Root observations temporarily unavailable'});
  }
};
