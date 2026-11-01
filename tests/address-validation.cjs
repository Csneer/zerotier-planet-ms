'use strict';

// Run against the actual patched image sources, with only Controller/storage
// I/O replaced. No daemon, production state or network request is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = process.env.ZTNCUI_SOURCE_DIR || '/opt/ztncui/src';
const addresses = require(path.join(app, 'addressValidation'));
const plain = value => JSON.parse(JSON.stringify(value));
const nwid = 'aabbccddeeff0011';
const memberId = 'aabbccddee';
let network;
let writes = [];
function reset() {
  network = {nwid, name: 'Test network', routes: [
    {target: '10.42.0.0/24', via: null}, {target: '2001:db8:42::/64', via: null}
  ], ipAssignmentPools: [], dns: {domain: 'existing.example', servers: ['10.42.0.53']}};
  writes = [];
}
const storage = {initSync() {}, getItem: async () => 'Test member'};
const zt = {
  network_detail: async () => plain(network),
  member_detail: async () => ({id: memberId, ipAssignments: []}),
  routes: async (id, route, action) => {
    writes.push({kind: 'route', id, route: plain(route), action}); return plain(network);
  },
  network_object: async (id, object) => {
    writes.push({kind: 'network', id, object: plain(object)}); return {...plain(network), ...object};
  },
  ipAssignmentPools: async (id, pool, action) => {
    writes.push({kind: 'pool', id, pool: plain(pool), action}); return plain(network);
  },
  ipAssignmentAdd: async (id, member, assignment) => {
    writes.push({kind: 'assignment', id, member, assignment: plain(assignment)});
    return {id: memberId, ipAssignments: [assignment.ipAddress]};
  },
  network_easy_setup: async (...args) => {writes.push({kind: 'easy', args: plain(args)}); return plain(network);}
};
const dependencies = {
  fs, util: require('node:util'), 'node-persist': storage, './zt': zt,
  '../addressValidation': addresses, '../uiStatus': {}, './monitoringController': {},
  '../public/javascripts/networkValidation': require(path.join(app, 'public/javascripts/networkValidation'))
};
const handlers = {};
vm.runInNewContext(fs.readFileSync(path.join(app, 'controllers/networkController.js'), 'utf8'), {
  exports: handlers, console: {error() {}},
  require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected handler dependency: ${name}`);
    return dependencies[name];
  }
}, {filename: 'networkController.js'});
function request(body, params = {}) {
  const errors = [];
  return {body, params: {nwid, id: memberId, ...params}, t: key => key,
    checkBody(key, msg) {
      return {notEmpty() {if (!body[key]) errors.push({msg}); return this;},
        custom(fn) {if (!fn(body[key])) errors.push({msg}); return this;},
        isIP(version) {const family = addresses.family(body[key]); if (!family || (version && family !== version)) errors.push({msg}); return this;}};
    },
    sanitize(key) {return {trim() {body[key] = addresses.trim(body[key]); return this;}, escape() {return this;}};},
    validationErrors() {return errors.length ? errors : null;}
  };
}
function response() {
  return {code: 200, model: null, status(code) {this.code = code; return this;},
    render(view, model) {this.view = view; this.model = model; return this;},
    send(body) {this.body = body; return this;}, redirect(url) {this.code = 302; this.url = url; return this;}};
}
async function invoke(handler, body, params) {
  const res = response(); await handlers[handler](request(body, params), res); return res;
}
async function rejected(handler, body, params) {
  reset(); const before = plain(network);
  const res = await invoke(handler, body, params);
  assert.equal(res.code, 400, `${handler} must reject invalid input`);
  assert.deepEqual(writes, [], `${handler} must not write invalid input`);
  assert.deepEqual(network, before, `${handler} must keep existing configuration`);
  return res;
}

(async () => {
  const invalidTargets = [undefined, null, [], {}, true, '010.042.000.001/24', '10.42.0.0',
    '10.42.0.0/24/1', '10.42.0.0/024', '10.42.0.0/24.0', '10.42.0.0/-1', '10.42.0.0/33',
    '2001:db8::/129', '2001:db8::%eth0/64', 'x'.repeat(10000) + '/24'];
  for (const target of invalidTargets) await rejected('routes', {target, via: ''});
  for (const via of ['010.042.000.001', '2001:db8::1', false, [], {}, 'x'.repeat(10000)]) {
    await rejected('routes', {target: '10.42.0.0/24', via});
  }
  for (const [target, via] of [['0.0.0.0/0', '192.0.2.1'], ['2001:db8::/64', '2001:db8::1'],
    ['::ffff:192.0.2.0/120', ''], ['10.42.0.0/24', null], ['::/0', undefined]]) {
    reset(); assert.equal((await invoke('routes', {target, via})).code, 200);
    assert.deepEqual(writes[0].route, {target, via: via === '' || via === undefined ? null : via});
  }
  await rejected('route_delete', {}, {target_ip: '10.42.0.0', target_prefix: '24/1'});
  reset(); await invoke('route_delete', {}, {target_ip: '2001:db8:42::', target_prefix: '64'});
  assert.equal(writes[0].action, 'delete');
  console.log('PASS: real route handlers reject malformed CIDR, ambiguous literals, wrong types and mixed-family gateways');

  for (const servers of [undefined, null, [], {}, '10.42.0.53\n010.042.000.001', '2001:db8::%eth0',
    '1.1.1.1/32', 'x'.repeat(10000)]) {
    const res = await rejected('dns', {domain: 'example.test', servers});
    assert.deepEqual(plain(res.model.network.dns), {domain: 'existing.example', servers: ['10.42.0.53']});
  }
  await rejected('dns', {domain: [], servers: '1.1.1.1'});
  reset(); await invoke('dns', {domain: 'example.test', servers: '10.42.0.53\r\n 2001:db8::53\n\n'});
  assert.deepEqual(writes[0].object, {dns: {domain: 'example.test', servers: ['10.42.0.53', '2001:db8::53']}});
  reset(); await invoke('dns', {domain: '', servers: '\n  \n'});
  assert.deepEqual(writes[0].object, {dns: {domain: '', servers: []}}, 'explicit empty settings may clear DNS');
  console.log('PASS: invalid DNS batches retain existing settings; mixed IPv4/IPv6 and intentional clearing remain supported');

  for (const ipAddress of ['010.042.000.001', '10.43.0.1', '2001:db8:43::1', '2001:db8:42::1%eth0',
    '10.42.0.1/24', null, [], {}, false, 'x'.repeat(10000)]) await rejected('assign_ip', {ipAddress});
  for (const ipAddress of ['10.42.0.1', '2001:db8:42::1']) {
    reset(); assert.equal((await invoke('assign_ip', {ipAddress})).code, 200);
    assert.deepEqual(writes[0].assignment, {ipAddress});
  }
  reset(); network.routes = [{target: '0.0.0.0/0'}, {target: 'invalid'}, null];
  assert.equal((await invoke('assign_ip', {ipAddress: '::1'})).code, 400);
  assert.equal(writes.length, 0, 'IPv4 default route must not authorize an IPv6 address');
  for (const [ipRangeStart, ipRangeEnd] of [['10.42.0.1', '2001:db8::1'], ['10.42.0.20', '10.42.0.10'],
    ['010.042.000.001', '10.42.0.20'], [[], '10.42.0.20']]) {
    await rejected('ipAssignmentPools', {ipRangeStart, ipRangeEnd});
  }
  for (const [ipRangeStart, ipRangeEnd] of [['10.42.0.1', '10.42.0.20'], ['2001:db8::1', '2001:db8::ff']]) {
    reset(); await invoke('ipAssignmentPools', {ipRangeStart, ipRangeEnd});
    assert.deepEqual(writes[0].pool, {ipRangeStart, ipRangeEnd});
  }
  reset(); await invoke('easy_post', {networkCIDR: '10.42.0.0/24', poolStart: '10.42.0.1', poolEnd: '10.42.0.254'});
  assert.equal(writes[0].kind, 'easy', 'easy setup still works with modern address library');
  console.log('PASS: manual assignments enforce same-family managed routes; ordered IPv4/IPv6 pools and easy setup remain valid');

  let posts = [];
  const api = async (url, options) => {
    if (options.method === 'POST') {posts.push(plain(options.body)); return {body: {...plain(network), ...options.body}};}
    return {body: plain(network)};
  };
  const backend = {};
  vm.runInNewContext(fs.readFileSync(path.join(app, 'controllers/zt.js'), 'utf8'), {
    exports: backend, process: {env: {}}, require: name => {
      if (name === 'got' || name === '../controllerHttp') return api;
      if (name === '../addressValidation') return addresses;
      if (name === './token') return {get: async () => 'disposable-test-token'};
      throw new Error(`Unexpected backend dependency: ${name}`);
    }
  }, {filename: 'zt.js'});
  reset(); await backend.routes(nwid, {target: '2001:0db8:0042:0000:0000:0000:0000:0000/64', via: null}, 'delete');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].routes, [{target: '10.42.0.0/24', via: null}], 'canonical IPv6 deletion matches existing compressed target');
  posts = []; reset();
  const legacyRoute = {target: '010.042.000.000/24', via: null};
  network.routes.unshift(legacyRoute, null);
  await backend.routes(nwid, {target: '2001:db8:42::/64', via: null}, 'delete');
  assert.deepEqual(posts[0].routes, [legacyRoute, null, {target: '10.42.0.0/24', via: null}],
    'legacy malformed entries must not block valid route deletion or be silently removed');
  posts = []; reset();
  await backend.routes(nwid, {target: '10.43.0.0/24', via: null}, 'add');
  assert.equal(posts[0].routes.at(-1).target, '10.43.0.0/24', 'IPv4 canonicalization must not construct Address6');
  posts = [];
  await assert.rejects(backend.routes(nwid, {target: '010.042.000.000/24', via: null}, 'add'));
  assert.equal(posts.length, 0);
  console.log('PASS: real Controller API helper preserves IPv4 and canonical IPv6 route add/delete with ip-address 10.x');
})().catch(error => {console.error(error); process.exitCode = 1;});
