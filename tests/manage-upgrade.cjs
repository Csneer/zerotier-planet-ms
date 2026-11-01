// Execute cmd_upgrade with Docker lifecycle stubs and real Compose config.
// All files are disposable; this test cannot start or mutate any container.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '..', 'manage.sh'), 'utf8');
const upgrade = source.match(/cmd_upgrade\(\) \{[\s\S]*?\n\}\n(?=\ncmd_status)/)?.[0];
const cleanup = source.match(/cleanup\(\) \{[\s\S]*?\n\}\n/)?.[0];
assert.ok(upgrade && cleanup, 'upgrade and cleanup functions must be found');
const realDocker = spawnSync('bash', ['-c', 'command -v docker'], {encoding: 'utf8'}).stdout.trim();
assert.ok(realDocker, 'Docker Compose CLI is required, but no daemon is used');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'planet-upgrade-test-'));
const oldImage = 'sha256:' + '1'.repeat(64);
const digestImage = 'example.invalid/planet@sha256:' + '2'.repeat(64);
const cleanEnv = {...process.env};
for (const key of Object.keys(cleanEnv)) if (/^COMPOSE_/.test(key)) delete cleanEnv[key];

const stubs = String.raw`
set -Eeuo pipefail
SERVICE=myztplanet
ROOT_DIR=$UPGRADE_TEST_DIR
LAST_BACKUP=/tmp/mock-backup
RESUME_SERVICE_ON_EXIT=0
UPGRADE_ROLLBACK_CONFIG=
UP_CALLS=0
cmd_doctor() { COMPOSE_JSON=$(cat "$UPGRADE_TEST_DIR/resolved.json"); }
image_name() { jq -r '.services.myztplanet.image' <<<"$COMPOSE_JSON"; }
config_value() { jq -r "$1" <<<"$COMPOSE_JSON"; }
container_name() { printf 'test-container'; }
prepare_image() { :; }
backup_data() { :; }
date() { printf 'test-timestamp'; }
log() { printf 'LOG %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; }
die() { printf 'ERROR %s\n' "$*"; exit 17; }
wait_healthy() {
    if ((UP_CALLS == 1)); then [[ "$UPGRADE_TEST_HEALTHY" == 1 ]];
    else [[ "$UPGRADE_TEST_ROLLBACK_HEALTHY" == 1 ]]; fi
}
docker() {
    if [[ "$1" == inspect ]]; then
        printf '%s' "$UPGRADE_TEST_OLD_IMAGE"
    elif [[ "$1" == tag ]]; then
        [[ "$3" != *@* ]] || { printf 'digest tag target rejected\n'; return 1; }
        printf 'tag %s %s\n' "$2" "$3"
    elif [[ "$1" == compose && "$2" == up ]]; then
        ((UP_CALLS += 1))
        printf 'compose-up %s\n' "$UP_CALLS"
    elif [[ "$1" == compose && "$2" == --project-directory ]]; then
        local -a config_args=()
        shift
        while [[ "$1" != up ]]; do config_args+=("$1"); shift; done
        printf '%s\n' "$@" >"$UPGRADE_TEST_DIR/rollback-args"
        stat -c '%a' "$UPGRADE_ROLLBACK_CONFIG" >"$UPGRADE_TEST_DIR/rollback-mode"
        "$UPGRADE_TEST_DOCKER" compose "${'${config_args[@]}'}" config --format json >"$UPGRADE_TEST_DIR/rollback-resolved.json"
        ((UP_CALLS += 1))
        printf 'compose-up %s\n' "$UP_CALLS"
        [[ "$UPGRADE_TEST_ROLLBACK_STARTS" == 1 ]]
    else
        printf 'unexpected docker call: %s\n' "$*" >&2
        return 99
    fi
}
`;

const cases = [
  {mode: 'external', healthy: false},
  {mode: 'generated', healthy: false},
  {mode: 'external', healthy: true},
  {mode: 'generated', healthy: true},
  {mode: 'generated', healthy: true, digest: true},
  {mode: 'generated', healthy: false, digest: true},
  {mode: 'external', healthy: false, digest: true},
  {mode: 'external', healthy: true, digest: true},
  {mode: 'generated', healthy: false, digest: true, rollbackHealthy: false},
  {mode: 'generated', healthy: false, digest: true, rollbackStarts: false},
];

try {
  for (const [index, test] of cases.entries()) {
    const dir = path.join(temp, String(index));
    fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, 'tmp'));
    const env = {...cleanEnv, UPGRADE_TEST_DIR: dir, UPGRADE_TEST_DOCKER: realDocker,
      UPGRADE_TEST_OLD_IMAGE: oldImage, UPGRADE_TEST_HEALTHY: test.healthy ? '1' : '0',
      UPGRADE_TEST_ROLLBACK_HEALTHY: test.rollbackHealthy === false ? '0' : '1',
      UPGRADE_TEST_ROLLBACK_STARTS: test.rollbackStarts === false ? '0' : '1',
      UPGRADE_TEST_EXPAND: 'must-not-replace-literal', TMPDIR: path.join(dir, 'tmp'),
      COMPOSE_PROJECT_NAME: 'upgrade-existing-project'};
    const model = {name: 'base-project', services: {myztplanet: {
      image: test.digest ? digestImage : 'test:image', container_name: 'test-container',
      network_mode: 'host', environment: {PLANET_MODE: test.mode, KEEP: 'base-value'},
      command: ['sh', '-c', 'echo "$$UPGRADE_TEST_EXPAND"'],
      volumes: [{type: 'bind', source: './data-$$UPGRADE_TEST_EXPAND', target: '/var/lib/zerotier-one'}],
    }}};
    fs.writeFileSync(path.join(dir, 'base.json'), JSON.stringify(model));
    fs.writeFileSync(path.join(dir, 'override.json'), JSON.stringify({services: {myztplanet: {
      environment: {KEEP: 'override-value', LITERAL: '$$UPGRADE_TEST_EXPAND $${UPGRADE_TEST_EXPAND}'},
      labels: {'test.override': 'retained'},
    }}}));
    const initial = spawnSync(realDocker, ['compose', '--project-directory', dir,
      '-f', path.join(dir, 'base.json'), '-f', path.join(dir, 'override.json'), 'config', '--format', 'json'],
    {cwd: dir, env, encoding: 'utf8', timeout: 30000});
    assert.equal(initial.status, 0, initial.stderr);
    const resolved = JSON.parse(initial.stdout);
    fs.writeFileSync(path.join(dir, 'resolved.json'), initial.stdout);
    const envFile = `ZT_IMAGE=${model.services.myztplanet.image}\n`;
    fs.writeFileSync(path.join(dir, '.env'), envFile);
    const result = spawnSync('bash', ['-s'], {
      input: `${stubs}\n${cleanup}\ntrap cleanup EXIT\n${upgrade}\ncmd_upgrade\n`,
      encoding: 'utf8', timeout: 30000, cwd: dir, env,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, test.healthy ? 0 : 17, result.stderr + result.stdout);
    const rollback = !test.healthy && test.mode === 'generated';
    const recreates = (result.stdout.match(/^compose-up /gm) || []).length;
    assert.equal(recreates, rollback ? 2 : 1, result.stdout);
    assert.equal(result.stdout.includes(`tag ${oldImage} test:image`), rollback && !test.digest);
    assert.equal(result.stdout.includes('automatic rollback is disabled'), !test.healthy && test.mode === 'external');
    assert.equal(result.stdout.includes('Upgrade complete'), test.healthy);
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), envFile, 'never rewrite the configured image');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'remove private rollback config on every exit');
    if (rollback && test.digest) {
      const expected = structuredClone(resolved);
      expected.services.myztplanet.image = oldImage;
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'rollback-resolved.json'), 'utf8')), expected,
        'real Compose roundtrip must preserve project, overrides, mounts and literal dollar values');
      assert.equal(fs.readFileSync(path.join(dir, 'rollback-mode'), 'utf8').trim(), '600');
      assert.deepEqual(fs.readFileSync(path.join(dir, 'rollback-args'), 'utf8').trim().split('\n'),
        ['up', '-d', '--no-build', '--pull', 'never', '--force-recreate', 'myztplanet']);
      if (test.rollbackStarts === false) assert.match(result.stdout, /rollback startup both failed/);
      else if (test.rollbackHealthy === false) assert.match(result.stdout, /rollback both failed/);
      else {
        assert.match(result.stdout, /configured digest was not changed; set ZT_IMAGE/);
        assert.match(result.stdout, /upgrade failed and was rolled back/);
      }
    }
    console.log(`PASS: upgrade mode=${test.mode}, digest=${!!test.digest}, healthy=${test.healthy}, rollbackStarts=${test.rollbackStarts !== false}, rollbackHealthy=${test.rollbackHealthy !== false}`);
  }
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
