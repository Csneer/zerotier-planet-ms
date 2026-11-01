'use strict';

// Real Compose expansion and shell checks in isolated state. The Docker shim
// permits only config/version and mocks info: it cannot start any container.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-install-config-'));
const realDocker = spawnSync('bash', ['-c', 'command -v docker'], {encoding: 'utf8'}).stdout.trim();
assert.ok(realDocker, 'Docker Compose CLI is required, but no daemon is used');
const cleanEnv = {...process.env};
for (const key of Object.keys(cleanEnv)) {
  if (/^(ZT_|COMPOSE_|HTTP_|IP_ADDR|PLANET_|ROOT_ONLY$|CONTROLLER_ONLY$|DATA_DIR$|BACKUP_DIR$|CONTAINER_NAME$|IMAGE|SOURCE_|API_PORT$|DEFAULT_NETWORK_MTU$)/.test(key)) delete cleanEnv[key];
}

function fixture(name) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir);
  for (const file of ['install.sh', 'manage.sh', 'docker-compose.yml']) fs.copyFileSync(path.join(root, file), path.join(dir, file));
  return {dir, data: path.join(dir, 'state'), envFile: path.join(dir, '.env')};
}
function run(test, script, args = [], env = {}) {
  return spawnSync('bash', [path.join(test.dir, script), ...args], {
    cwd: test.dir, encoding: 'utf8', timeout: 30000,
    env: {...cleanEnv, PATH: path.join(temp, 'bin') + ':' + cleanEnv.PATH,
      ZT_INSTALL_TEST_DOCKER: realDocker, ...env}
  });
}
function ok(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr + result.stdout);
}
function fails(result, pattern) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, pattern);
}
try {
  fs.mkdirSync(path.join(temp, 'bin'));
  fs.writeFileSync(path.join(temp, 'bin/docker'), `#!/bin/bash
set -eu
if [[ "$*" == info ]]; then [[ "\${ZT_INSTALL_TEST_OFFLINE:-0}" != 1 ]]; exit $?; fi
if [[ "$1" == compose && ( "$2" == config || "$2" == version ) ]]; then
  exec "$ZT_INSTALL_TEST_DOCKER" "$@"
fi
echo 'FAIL: test tried to mutate Docker' >&2
exit 99
`, {mode: 0o755});

  const unsafePathParts = ['$PLANET_PATH_TEST', '${PLANET_PATH_TEST}', '"quoted"', "'quoted'", '\\escaped'];
  for (const source of ['cli', 'environment']) {
    for (const [index, part] of unsafePathParts.entries()) {
      const invalid = fixture(`unsafe-path-${source}-${index}`);
      const data = path.join(invalid.dir, 'state-' + part);
      const args = ['--ip', '198.51.100.23', '--configure-only'];
      if (source === 'cli') args.push('--data-dir', data);
      fails(run(invalid, 'install.sh', args, source === 'environment' ? {DATA_DIR: data} : {}),
        /data directory contains unsupported characters/);
      assert.ok(!fs.existsSync(invalid.envFile), 'reject unsafe paths before creating .env');
      assert.ok(!fs.existsSync(data), 'reject unsafe paths before creating data directories');
      assert.deepEqual(fs.readdirSync(invalid.dir).sort(), ['docker-compose.yml', 'install.sh', 'manage.sh']);
    }
  }
  console.log('PASS: CLI and environment paths reject dotenv interpolation, quoting and escape syntax before writing state');

  const staged = fixture('external');
  ok(run(staged, 'install.sh', ['--ip', '198.51.100.20', '--data-dir', staged.data,
    '--planet-mode', 'external', '--root-only', '1', '--configure-only']));
  const initial = fs.readFileSync(staged.envFile, 'utf8');
  for (const line of ['PLANET_MODE=external', 'ROOT_ONLY=1', `DATA_DIR=${staged.data}`]) assert.ok(initial.split('\n').includes(line));
  assert.equal(fs.statSync(staged.envFile).mode & 0o777, 0o600);
  ok(run(staged, 'install.sh', ['--configure-only']));
  assert.equal(fs.readFileSync(staged.envFile, 'utf8'), initial, 'repeat must preserve .env');
  fails(run(staged, 'install.sh', ['--planet-mode', 'generated', '--configure-only']), /already exists/);
  fails(run(staged, 'manage.sh', ['doctor']), /requires config\/planet/);
  fails(run(staged, 'manage.sh', ['up']), /requires config\/planet/);
  fs.writeFileSync(path.join(staged.data, 'config/planet'), 'placeholder only; not a signed world');
  fails(run(staged, 'manage.sh', ['doctor']), /prepared Root identity/);
  fs.writeFileSync(path.join(staged.data, 'one/identity.secret'), 'test-placeholder');
  ok(run(staged, 'manage.sh', ['doctor'])); // No signature claim; startup verifies it.
  fs.writeFileSync(staged.envFile, initial.replace('ZT_PORT=9994', 'ZT_PORT=70000'));
  fails(run(staged, 'install.sh', ['--configure-only']), /ZT_PORT must be/);
  fs.writeFileSync(staged.envFile, initial.replace('ROOT_ONLY=1', 'ROOT_ONLY=invalid'));
  fails(run(staged, 'install.sh', ['--configure-only']), /ROOT_ONLY must be/);
  fs.writeFileSync(staged.envFile, initial.replace(`ZTNCUI_STATE_DIR=${staged.data}/ztncui-state`, 'ZTNCUI_STATE_DIR=/'));
  fails(run(staged, 'install.sh', ['--configure-only']), /unsafe persistent path/);
  console.log('PASS: external staging reuses resolved .env, keeps strict up guards and checks ports/modes/paths');

  const v6only = fixture('v6-only');
  ok(run(v6only, 'install.sh', ['--ipv6', '2001:db8::20', '--data-dir', v6only.data, '--configure-only']));
  const v6env = fs.readFileSync(v6only.envFile, 'utf8');
  assert.match(v6env, /^IP_ADDR4=$/m);
  assert.match(v6env, /^IP_ADDR6=2001:db8::20$/m);
  ok(run(v6only, 'manage.sh', ['doctor']));
  for (const [flag, value] of [['--ipv6', 'not-an-ip'], ['--ip', '2001:db8::1']]) {
    const invalid = fixture('invalid-' + flag.slice(2));
    fails(run(invalid, 'install.sh', [flag, value, '--data-dir', invalid.data, '--configure-only']), /invalid IPv/);
    assert.ok(!fs.existsSync(invalid.envFile));
  }
  const invalidRootV6 = ['::', '::1', '0:0:0:0:0:0:0:1', 'fe80::1', 'febf::1', 'ff02::1', '::ffff:0.0.0.0', '::ffff:127.0.0.1', '::ffff:224.0.0.1', '::ffff:198.51.100.10'];
  for (const [index, address] of invalidRootV6.entries()) {
    const invalid = fixture('unusable-v6-' + index);
    fails(run(invalid, 'install.sh', ['--ipv6', address, '--data-dir', invalid.data, '--configure-only']), /invalid IPv6/);
    assert.ok(!fs.existsSync(invalid.envFile));
    fs.writeFileSync(v6only.envFile, v6env.replace('IP_ADDR6=2001:db8::20', 'IP_ADDR6=' + address));
    fails(run(v6only, 'manage.sh', ['doctor']), /IP_ADDR6 is invalid/);
  }
  const ula = fixture('ula');
  ok(run(ula, 'install.sh', ['--ipv6', 'fd00::20', '--data-dir', ula.data, '--configure-only']));
  const ulaEnv = fs.readFileSync(ula.envFile, 'utf8').replace(/^HTTP_HOST=.*$/m, 'HTTP_HOST=::1');
  fs.writeFileSync(ula.envFile, ulaEnv);
  ok(run(ula, 'manage.sh', ['doctor']));
  fs.writeFileSync(v6only.envFile, v6env);
  console.log('PASS: unusable IPv6 Root endpoints rejected; ULA and HTTP loopback remain valid');
  const dual = fixture('dual-stack');
  ok(run(dual, 'install.sh', ['--ip', '198.51.100.30', '--ipv6', '2001:db8::30', '--data-dir', dual.data, '--configure-only']));
  assert.match(fs.readFileSync(dual.envFile, 'utf8'), /^IP_ADDR4=198.51.100.30$/m);
  assert.match(fs.readFileSync(dual.envFile, 'utf8'), /^IP_ADDR6=2001:db8::30$/m);
  ok(run(dual, 'manage.sh', ['doctor']));
  // Compose intentionally turns an omitted family into an explicit empty
  // container variable. Check resolved values, not only the .env text.
  for (const [contents, ipv4, ipv6, valid] of [
    [v6env, '', '2001:db8::20', true],
    [v6env.replace(/^IP_ADDR4=.*\n/m, ''), '', '2001:db8::20', true],
    [v6env.replace(/^IP_ADDR6=.*$/m, 'IP_ADDR6='), '', '', false],
    [v6env.replace(/^IP_ADDR4=.*$/m, 'IP_ADDR4=198.51.100.20').replace(/^IP_ADDR6=.*\n/m, ''), '198.51.100.20', '', true]
  ]) {
    fs.writeFileSync(v6only.envFile, contents);
    const expanded = spawnSync(realDocker, ['compose', 'config', '--format', 'json'], {
      cwd: v6only.dir, env: cleanEnv, encoding: 'utf8', timeout: 30000
    });
    ok(expanded);
    const environment = JSON.parse(expanded.stdout).services.myztplanet.environment;
    assert.equal(environment.IP_ADDR4, ipv4);
    assert.equal(environment.IP_ADDR6, ipv6);
    if (valid) ok(run(v6only, 'manage.sh', ['doctor']));
    else fails(run(v6only, 'manage.sh', ['doctor']), /Root requires IP_ADDR4 or IP_ADDR6/);
  }
  console.log('PASS: IPv6-only/dual-stack validation and Compose empty or omitted family semantics');

  const inherited = fixture('inherited');
  ok(run(inherited, 'install.sh', ['--ip', '198.51.100.21', '--data-dir', inherited.data, '--configure-only'],
    {PLANET_MODE: 'external', ROOT_ONLY: '1'}));
  assert.match(fs.readFileSync(inherited.envFile, 'utf8'), /^PLANET_MODE=external$/m);
  assert.match(fs.readFileSync(inherited.envFile, 'utf8'), /^ROOT_ONLY=1$/m);
  ok(run(inherited, 'install.sh', ['--configure-only']));
  const generated = fixture('generated');
  ok(run(generated, 'install.sh', ['--ip', '198.51.100.22', '--data-dir', generated.data, '--configure-only']));
  assert.match(fs.readFileSync(generated.envFile, 'utf8'), /^PLANET_MODE=generated$/m);
  ok(run(generated, 'manage.sh', ['doctor']));
  const retry = fixture('failed-first-install');
  const failedInstall = run(retry, 'install.sh', ['--ip', '198.51.100.24', '--data-dir', retry.data], {ZT_INSTALL_TEST_OFFLINE: '1'});
  fails(failedInstall, /cannot connect to the Docker daemon/);
  assert.match(failedInstall.stderr, /Configuration was kept/);
  assert.match(failedInstall.stderr, /without initialization flags/);
  const retainedEnv = fs.readFileSync(retry.envFile, 'utf8');
  ok(run(retry, 'install.sh', ['--configure-only']));
  assert.equal(fs.readFileSync(retry.envFile, 'utf8'), retainedEnv);
  for (const [flag, value, pattern] of [['--planet-mode', 'unknown', /PLANET_MODE/], ['--root-only', '2', /ROOT_ONLY/]]) {
    const invalid = fixture(flag.slice(2));
    fails(run(invalid, 'install.sh', ['--ip', '198.51.100.23', '--data-dir', invalid.data, flag, value, '--configure-only']), pattern);
    assert.ok(!fs.existsSync(invalid.envFile));
  }
  console.log('PASS: CLI/environment modes persist, failed installs retain configuration with retry instructions, generated defaults remain compatible');
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
