'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('../patch/controllerHttp');

const token = 'disposable-http-test-token';
let redirectedRequests = 0;
const servers = [];

async function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {server, base: `http://127.0.0.1:${server.address().port}`};
}

function json(response, body, status = 200) {
  response.writeHead(status, {'Content-Type': 'application/json'});
  response.end(JSON.stringify(body));
}

function safeError(error) {
  assert.ok(!String(error.stack).includes(token), 'errors must not include authentication or response content');
  assert.ok(!JSON.stringify(error).includes(token), 'enumerable errors must not expose authentication or response content');
}

(async () => {
  try {
    const destination = await listen((req, res) => {
      redirectedRequests++;
      json(res, {unexpected: true});
    });
    const {base} = await listen((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, {Location: destination.base + '/destination'});
        res.end(token);
      } else if (req.url === '/unix-redirect') {
        res.writeHead(307, {Location: 'http://unix:/tmp/forbidden.sock:/status'});
        res.end();
      } else if (req.url === '/invalid-json') {
        res.end(token);
      } else if (req.url === '/empty' || req.url === '/blank') {
        res.writeHead(req.url === '/empty' ? 204 : 200);
        res.end();
      } else if (req.url === '/missing') {
        json(res, {error: token}, 404);
      } else if (req.url === '/failure') {
        res.writeHead(503);
        res.end(token);
      } else if (req.url === '/slow-headers' || req.url === '/slow-body') {
        if (req.url === '/slow-body') {
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.write('{"ok":');
        }
        const timer = setTimeout(() => res.end(req.url === '/slow-body' ? 'true}' : '{"ok":true}'), 1000);
        res.once('close', () => clearTimeout(timer));
      } else {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => json(res, {method: req.method, body,
          auth: req.headers['x-zt1-auth'], accept: req.headers.accept,
          contentType: req.headers['content-type']}));
      }
    });
    const options = {json: true, headers: {'X-ZT1-Auth': token}, retries: 0, followRedirect: false};

    const get = await request(base + '/echo', options);
    assert.equal(get.statusCode, 200);
    assert.equal(get.body.method, 'GET');
    assert.equal(get.body.auth, token);
    assert.equal(get.body.accept, 'application/json');
    assert.equal(get.body.body, '');
    const payload = {name: 'test network', routes: [{target: '10.42.0.0/24', via: null}]};
    const post = await request(base + '/echo', {...options, method: 'POST', body: payload});
    assert.equal(post.body.method, 'POST');
    assert.equal(post.body.contentType, 'application/json');
    assert.deepEqual(JSON.parse(post.body.body), payload);
    const deleted = await request(base + '/echo', {...options, method: 'DELETE'});
    assert.equal(deleted.body.method, 'DELETE');
    assert.equal(deleted.body.body, '');
    for (const route of ['/empty', '/blank']) {
      assert.equal((await request(base + route, options)).body, '', 'empty success responses match existing JSON caller semantics');
    }
    console.log('PASS: native Controller HTTP preserves authenticated GET/POST/DELETE, JSON and empty successes');

    await assert.rejects(request(base + '/invalid-json', options), error => {
      safeError(error);
      return error.code === 'ERR_INVALID_JSON' && error.statusCode === 200;
    });
    for (const [route, status] of [['/missing', 404], ['/failure', 503], ['/redirect', 302], ['/unix-redirect', 307]]) {
      await assert.rejects(request(base + route, {...options, followRedirect: true}), error => {
        safeError(error);
        return error instanceof request.HTTPError && error.statusCode === status;
      });
    }
    assert.equal(redirectedRequests, 0, 'redirect targets must never receive requests or tokens');
    console.log('PASS: HTTPError retains 404 handling; invalid JSON and redirects fail without leaking tokens or response bodies');

    for (const route of ['/slow-headers', '/slow-body']) {
      const start = Date.now();
      await assert.rejects(request(base + route, {...options, timeout: 100}), error => error.code === 'ETIMEDOUT');
      assert.ok(Date.now() - start < 900, 'timeout covers both headers and response body consumption');
    }
    const unused = await listen((req, res) => res.end());
    await new Promise(resolve => unused.server.close(resolve));
    await assert.rejects(request(unused.base, options), error => error.code === 'ECONNREFUSED');
    console.log('PASS: request deadlines cover stalled headers and bodies; connection error codes remain useful');

    for (const address of ['file:///etc/passwd', 'ftp://127.0.0.1/file', 'data:application/json,{}',
      'unix:/tmp/socket', 'http://user:secret@127.0.0.1/', 'localhost:9993/status', 'not a URL']) {
      await assert.rejects(request(address, options), error => error.code === 'ERR_INVALID_URL');
    }
    for (const timeout of [-1, 1.5, NaN, '3000']) {
      await assert.rejects(request(base + '/echo', {...options, timeout}), /timeout must be a non-negative integer/);
    }
    console.log('PASS: only explicit credential-free HTTP(S) URLs and valid timeout values are accepted');
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
