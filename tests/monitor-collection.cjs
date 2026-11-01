'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const memberId = 'aaaaaaaaaa';
const networkId = 'bbbbbbbbbb000001';
const now = 1793500000000;
const service = {address: 'bbbbbbbbbb', clock: now, version: '1.16.2'};
const network = {nwid: networkId, name: 'Test network'};
let servicePeers = [];
let probePeers = [];

const dependencies = {
  crypto: require('node:crypto'),
  fs: {promises: {readFile: async file => {
    if (file === '/run/zerotier-probe/authtoken.secret') return 'disposable-test-token';
    if (file === '/var/lib/zerotier-one/planet' || file === '/app/dist/planet') return Buffer.from('test planet');
    throw Object.assign(new Error('fixture not available'), {code: 'ENOENT'});
  }}},
  got: async url => {
    if (url === 'http://127.0.0.1:9993/status') return {body: {address: 'cccccccccc', clock: now}};
    if (url === 'http://127.0.0.1:9993/peer') return {body: probePeers};
    throw new Error(`Unexpected probe request: ${url}`);
  },
  'node-persist': {initSync: () => {}, getItem: async () => 'Test member'},
  '../uiStatus': require('../patch/uiStatus'),
  '../rootStatus': require('../patch/rootStatus'),
  '../hostDiagnostics': {collect: async () => ({state: 'unknown'})},
  '../communicationStats': require('../patch/communicationStats'),
  '../endpointProbes': {collect: async () => ({available: false, results: []})},
  './zt': {
    get_zt_status: async () => service,
    peers: async () => servicePeers,
    network_list: async () => [network],
    members: async id => {
      assert.equal(id, networkId);
      return {[memberId]: 1};
    },
    member_detail: async (id, member) => {
      assert.equal(id, networkId);
      assert.equal(member, memberId);
      return {authorized: true, vMajor: 1, vMinor: 16, vRev: 2};
    }
  }
};
const controller = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../patch/monitoringController.js'), 'utf8'), {
  exports: controller,
  require: name => {
    assert.ok(Object.prototype.hasOwnProperty.call(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  },
  process: {env: {}, uptime: () => 10}
}, {filename: 'monitoringController.js'});

function peer(latency) {
  return {address: memberId, role: 'LEAF', latency, versionMajor: 1, version: '1.16.2',
    paths: [{address: '192.0.2.1/9993', active: true, lastReceive: now - 10}]};
}

(async () => {
  const cases = [
    [undefined, null], [null, null], ['', null], ['   ', null], [true, null], [false, null],
    [{}, null], [[], null], [-1, null], [-42, null], ['-1', null], [Infinity, null],
    [-Infinity, null], [NaN, null], ['Infinity', null], ['invalid', null],
    [0, 0], ['0', 0], [7, 7], [7.5, 7.5], ['7.5', 7.5], [' 7 ', 7]
  ];
  for (const [value, expected] of cases) {
    for (const source of ['planet', 'probe']) {
      servicePeers = [peer(source === 'planet' ? value : 11)];
      probePeers = [peer(source === 'probe' ? value : 13)];
      const monitor = await controller.collect();
      assert.equal(monitor.members.length, 1);
      const member = monitor.members[0];
      assert.equal(member.planet.latency, source === 'planet' ? expected : 11,
        `service latency for ${source} sample ${String(value)}`);
      assert.equal(member.probe.latency, source === 'probe' ? expected : 13,
        `probe latency for ${source} sample ${String(value)}`);
      assert.equal(member.planet.reachable, true);
      assert.equal(member.probe.state, 'direct');
    }
  }
  servicePeers = [];
  probePeers = [];
  const unobserved = (await controller.collect()).members[0];
  assert.equal(unobserved.planet.latency, null);
  assert.equal(unobserved.probe.latency, null);
  assert.equal(unobserved.planet.observed, false);
  assert.equal(unobserved.probe.state, 'unknown');
  console.log('PASS: monitoring collection preserves unknown latency and valid zero samples for service and probe peers');
})().catch(error => { console.error(error); process.exitCode = 1; });
