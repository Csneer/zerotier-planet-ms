#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

SERVICE=myztplanet
COMPOSE_JSON=
LAST_BACKUP=
RESUME_SERVICE_ON_EXIT=0
UPGRADE_ROLLBACK_CONFIG=

log() {
    printf '[planet] %s\n' "$*"
}

warn() {
    printf '[planet] WARNING: %s\n' "$*" >&2
}

die() {
    printf '[planet] ERROR: %s\n' "$*" >&2
    exit 1
}

cleanup() {
    if [[ -n "$UPGRADE_ROLLBACK_CONFIG" ]]; then
        rm -f -- "$UPGRADE_ROLLBACK_CONFIG" || warn "could not remove private rollback configuration: $UPGRADE_ROLLBACK_CONFIG"
    fi
    if ((RESUME_SERVICE_ON_EXIT)); then
        warn 'an operation failed after stopping the service; attempting to resume it'
        docker compose start "$SERVICE" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

# Restore swaps stop the service before changing any live directory.  Once the
# first swap starts, an EXIT trap must never restart the service automatically:
# a failed rename or deletion can leave an operator-visible recovery layout.
# Keep rollback best-effort but explicit so `set -e` cannot turn a cleanup
# failure into an implicit restart of mixed data.
restore_rollback_swaps() {
    local j target old_path rollback_failed=0
    for ((j=swapped - 1; j >= 0; j--)); do
        target=${restore_targets[$j]}
        old_path=${old_targets[$j]}
        if [[ -e "$target" ]] && ! rm -rf -- "$target"; then
            warn "rollback could not remove staged directory: $target; pre-restore data: $old_path"
            rollback_failed=1
            continue
        fi
        if [[ ! -e "$old_path" ]] || ! mv -- "$old_path" "$target"; then
            warn "rollback could not restore pre-restore directory: $old_path -> $target"
            rollback_failed=1
        fi
    done
    return "$rollback_failed"
}

restore_cleanup_artifacts() {
    local item cleanup_failed=0
    for item in "${stages[@]}"; do
        if [[ -e "$item" ]] && ! rm -rf -- "$item"; then
            warn "could not remove restore staging directory; leaving it for recovery: $item"
            cleanup_failed=1
        fi
    done
    for item in "${missing_targets[@]}"; do
        if [[ -e "$item" ]] && ! rmdir -- "$item"; then
            warn "could not remove temporary empty directory; leaving it for recovery: $item"
            cleanup_failed=1
        fi
    done
    return "$cleanup_failed"
}

usage() {
    cat <<'EOF'
Usage: ./manage.sh COMMAND [options]

Commands:
  doctor [--staged]               Validate Docker, Compose, .env and mounts.
                                 --staged permits pending external files; no start.
  build                          Build the configured local image.
  up                             Start the service without replacing data.
  upgrade                        Build/pull, back up, recreate and health-check.
  status                         Show Compose, ZeroTier, World/Root and network status.
  diagnose [--install-timer]      Read host Root policy into the Web diagnostics snapshot.
                                 --install-timer refreshes it every minute (requires root).
  logs [docker compose args]     Follow service logs (default: --tail 200 -f).
  restart                        Restart and wait for a healthy service.
  backup [--online]              Create a checksummed backup. Default is offline
                                 for a consistent snapshot and resumes service.
  restore BACKUP --yes           Back up current data, then restore BACKUP.
  controller COMMAND             Manual Controller standby: stage/verify/status/fence/promote.
  root COMMAND                   Prepare an independent Root or generate an add-only candidate.
  reset-password --yes           Back up users, reset to admin/password, restart.
  down                           Remove the container but preserve all data.
  uninstall [--purge-data --yes] Remove the container; data purge is opt-in and
                                 always creates a final backup first.
  help                           Show this help.

IMAGE_SOURCE in .env controls upgrade behavior:
  build (default)  build the checked-out source with ./build.sh
  pull             pull ZT_IMAGE from its registry

In-place upgrades keep existing bind mounts and identity; see docs/in-place-upgrade.md.
Prepare independent Root identities and a verified config/planet before external up.
external upgrades retain backups but never auto-activate an older image on failure.
EOF
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

env_value() {
    local key=$1 fallback=${2:-} line value
    if [[ -f .env ]]; then
        line=$(grep -m1 -E "^${key}=" .env || true)
        if [[ -n "$line" ]]; then
            value=${line#*=}
            value=${value%$'\r'}
            if [[ "$value" == \"*\" && "$value" == *\" ]]; then
                value=${value:1:${#value}-2}
            elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
                value=${value:1:${#value}-2}
            fi
            printf '%s' "$value"
            return
        fi
    fi
    printf '%s' "$fallback"
}

load_config() {
    [[ -s .env ]] || die '.env is missing; run ./install.sh --ip PUBLIC_IPV4 first'
    COMPOSE_JSON=$(docker compose config --format json) || die 'docker compose configuration is invalid'
    jq -e --arg service "$SERVICE" '.services[$service]' <<<"$COMPOSE_JSON" >/dev/null \
        || die "Compose service not found: $SERVICE"
}

config_value() {
    jq -r "$1" <<<"$COMPOSE_JSON"
}

container_name() {
    config_value ".services.${SERVICE}.container_name // \"${SERVICE}\""
}

image_name() {
    config_value ".services.${SERVICE}.image"
}

mount_source() {
    local target=$1
    jq -r --arg service "$SERVICE" --arg target "$target" \
        '.services[$service].volumes[] | select(.target == $target and .type == "bind") | .source' \
        <<<"$COMPOSE_JSON" | head -n 1
}

container_exists() {
    docker inspect "$(container_name)" >/dev/null 2>&1
}

container_running() {
    [[ "$(docker inspect "$(container_name)" --format '{{.State.Running}}' 2>/dev/null || true)" == true ]]
}

wait_healthy() {
    local name deadline status state
    name=$(container_name)
    deadline=$((SECONDS + ${HEALTH_TIMEOUT_SECONDS:-120}))
    while ((SECONDS < deadline)); do
        state=$(docker inspect "$name" --format '{{.State.Status}}' 2>/dev/null || true)
        status=$(docker inspect "$name" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)
        if [[ "$state" == running && "$status" == healthy ]]; then
            log "$name is running ($status)"
            return 0
        fi
        [[ "$state" != exited && "$state" != dead ]] || break
        sleep 2
    done
    docker logs --tail 120 "$name" >&2 2>/dev/null || true
    return 1
}

safe_directory() {
    local path=$1 resolved lexical _ _ _ _ _ home_dir _
    [[ -n "$path" ]] || return 1
    [[ ! -L "$path" ]] || return 1
    resolved=$(realpath -m -- "$path")
    lexical=$(realpath -ms -- "$path")
    # Refuse any symlinked parent as well as broad operating-system paths.
    # This keeps purge/restore from following a path that was redirected after
    # configuration, while still allowing conventional /var/lib/<app> data.
    [[ "$resolved" == "$lexical" ]] || return 1
    case "$resolved" in
        /|/bin|/bin/*|/boot|/boot/*|/dev|/dev/*|/etc|/etc/*|/home|/lib|/lib/*|/lib32|/lib32/*|/lib64|/lib64/*|/proc|/proc/*|/root|/run|/run/*|/sbin|/sbin/*|/sys|/sys/*|/usr|/usr/*|/var|/var/lib|/var/lib/docker|/var/lib/docker/*|/var/lib/containerd|/var/lib/containerd/*)
            return 1
            ;;
    esac
    [[ "$resolved" != "$HOME" && "$resolved" != "$ROOT_DIR" ]] || return 1
    while IFS=: read -r _ _ _ _ _ home_dir _; do
        [[ -z "$home_dir" || "$resolved" != "$home_dir" ]] || return 1
    done </etc/passwd
    return 0
}

paths_overlap() {
    local left right
    left=$(realpath -m -- "$1")
    right=$(realpath -m -- "$2")
    [[ "$left" == "$right" || "$left" == "$right/"* || "$right" == "$left/"* ]]
}

valid_port() {
    [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535))
}

valid_ipv4() {
    require_command python3
    python3 -c 'import ipaddress,sys; sys.exit(0 if ipaddress.ip_address(sys.argv[1]).version == 4 else 1)' "$1" \
        >/dev/null 2>&1
}

valid_ipv6() {
    [[ "$1" == *:* && "$1" != *%* ]] || return 1
    require_command python3
    python3 -c 'import ipaddress,sys; sys.exit(0 if ipaddress.ip_address(sys.argv[1]).version == 6 else 1)' "$1" \
        >/dev/null 2>&1
}

valid_root_ipv6() {
    [[ "$1" == *:* && "$1" != *%* ]] || return 1
    require_command python3
    python3 -c 'import ipaddress,sys; a=ipaddress.ip_address(sys.argv[1]); sys.exit(0 if a.version == 6 and a.ipv4_mapped is None and not (a.is_unspecified or a.is_loopback or a.is_link_local or a.is_multicast) else 1)' "$1" \
        >/dev/null 2>&1
}

backup_root() {
    local root
    root=$(env_value BACKUP_DIR ./backups)
    if [[ "$root" != /* ]]; then
        root="$ROOT_DIR/$root"
    fi
    printf '%s' "$(realpath -m -- "$root")"
}

backup_discard() {
    local path=${1:-}
    if [[ -n "$path" && -e "$path" ]] && ! rm -rf -- "$path"; then
        warn "could not remove incomplete backup; inspect it before reuse: $path"
    fi
}

backup_data() {
    local online=${1:-0} resume=${2:-1} recovery=${3:-0}
    local name was_running=0 stamp destination label source
    local -a labels=(dist one config ztncui-state)
    local -a targets=(/app/dist /var/lib/zerotier-one /app/config /var/lib/ztncui)

    load_config
    name=$(container_name)
    if container_running; then
        was_running=1
        if ((online == 0)); then
            log 'Stopping service for a consistent backup'
            docker compose stop -t 20 "$SERVICE"
            RESUME_SERVICE_ON_EXIT=1
        else
            warn 'creating an online backup; files may change during the snapshot'
        fi
    fi

    stamp=$(date +%Y%m%d-%H%M%S)
    destination="$(backup_root)/planet-$stamp"
    if [[ -e "$destination" ]]; then
        destination="${destination}-$$"
    fi
    install -d -m 0700 "$destination"

    for i in "${!labels[@]}"; do
        label=${labels[$i]}
        source=$(mount_source "${targets[$i]}")
        if ((recovery)) && [[ -n "$source" && ! -e "$source" ]]; then
            install -d -m 0700 "$destination/$label"
            continue
        fi
        if [[ -z "$source" || ! -d "$source" ]]; then
            backup_discard "$destination"
            if ((was_running && online == 0 && resume)); then
                docker compose start "$SERVICE" || true
            fi
            die "persistent directory is missing for ${targets[$i]}: ${source:-<unset>}"
        fi
        install -d -m 0700 "$destination/$label"
        if ! cp -a --reflink=auto "$source/." "$destination/$label/"; then
            backup_discard "$destination"
            if ((was_running && online == 0 && resume)); then
                docker compose start "$SERVICE" || true
            fi
            die "failed to copy $source"
        fi
        # The ZeroTier state directory ships three convenience symlinks to
        # binaries in the image.  They are not persistent state and must not
        # enter an offline backup.  Keep every other symlink rejected rather
        # than silently discarding user data or hiding a redirected path.
        if [[ "$label" == one ]]; then
            for tool in zerotier-one zerotier-cli zerotier-idtool; do
                tool_path="$destination/$label/$tool"
                if [[ -L "$tool_path" ]]; then
                    tool_target=$(readlink -- "$tool_path")
                    if [[ "$tool_target" != /usr/sbin/zerotier-one ]]; then
                        backup_discard "$destination"
                        die "unsupported symbolic link in backup source: $label/$tool -> $tool_target"
                    fi
                    rm -f -- "$tool_path"
                fi
            done
        fi
        link=$(find "$destination/$label" -type l -print -quit)
        if [[ -n "$link" ]]; then
            link_target=$(readlink -- "$link" 2>/dev/null || printf '<unreadable>')
            backup_discard "$destination"
            die "unsupported symbolic link in backup source: ${link#"$destination/"} -> $link_target"
        fi
    done

    if ! cp -p .env docker-compose.yml "$destination/"; then
        backup_discard "$destination"
        die 'failed to copy configuration into backup'
    fi
    if container_exists; then
        if ! docker inspect "$name" >"$destination/container-inspect.json"; then
            backup_discard "$destination"
            die 'failed to record container metadata in backup'
        fi
    fi
    {
        printf 'backup_format=2\n'
        printf 'PLANET_MODE=%s\n' "$(config_value ".services.${SERVICE}.environment.PLANET_MODE // \"generated\"")"
        printf 'ROOT_ONLY=%s\n' "$(config_value ".services.${SERVICE}.environment.ROOT_ONLY // \"0\"")"
        printf 'CONTROLLER_ONLY=%s\n' "$(config_value ".services.${SERVICE}.environment.CONTROLLER_ONLY // \"0\"")"
        printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        if ((recovery)); then
            printf 'consistency=recovery\n'
            for i in "${!labels[@]}"; do
                [[ -e "$(mount_source "${targets[$i]}")" ]] || printf 'missing_dataset=%s\n' "${labels[$i]}"
            done
        elif ((online == 0)); then
            printf 'consistency=offline\n'
        else
            printf 'consistency=online\n'
        fi
        printf 'repository_revision=%s\n' "$(git rev-parse HEAD 2>/dev/null || printf unknown)"
        printf 'image=%s\n' "$(image_name)"
        printf 'container=%s\n' "$name"
    } >"$destination/manifest.env"
    if ! (
        cd "$destination" || exit 1
        sums=$(mktemp .SHA256SUMS.tmp.XXXXXXXX) || exit 1
        find . -type f ! -path ./SHA256SUMS ! -path "./$sums" -print0 | sort -z | xargs -0 sha256sum >"$sums" || exit 1
        mv -- "$sums" SHA256SUMS || exit 1
        sha256sum -c SHA256SUMS >/dev/null || exit 1
    ); then
        backup_discard "$destination"
        die 'failed to verify backup manifest'
    fi
    find "$destination" -type d -exec chmod 0700 {} +
    find "$destination" -type f -exec chmod 0600 {} +
    LAST_BACKUP=$destination
    log "Backup verified: $destination"

    if ((was_running && online == 0 && resume)); then
        docker compose start "$SERVICE"
        wait_healthy || die 'backup succeeded, but the service did not become healthy after restart'
    fi
    RESUME_SERVICE_ON_EXIT=0
}

prepare_image() {
    local source image version
    source=$(env_value IMAGE_SOURCE build)
    image=$(image_name)
    case "$source" in
        build)
            version=$(env_value ZT_VERSION 1.16.2)
            log "Building $image from the current checkout"
            ZT_VERSION="$version" IMAGE="$image" "$ROOT_DIR/build.sh"
            ;;
        pull)
            log "Pulling $image"
            docker compose pull "$SERVICE"
            ;;
        *)
            die "IMAGE_SOURCE must be 'build' or 'pull', got: $source"
            ;;
    esac
}

cmd_doctor() {
    local ip ip6 host source target key value root planet_mode controller_only staged=0
    local -a sources=()
    if (($#)); then
        [[ $# == 1 && "$1" == --staged ]] || die 'usage: ./manage.sh doctor [--staged]'
        staged=1
    fi
    require_command bash
    require_command docker
    require_command jq
    require_command realpath
    docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required'
    if ((staged == 0)); then
        docker info >/dev/null 2>&1 || die 'cannot connect to the Docker daemon'
    fi
    load_config
    planet_mode=$(config_value ".services.${SERVICE}.environment.PLANET_MODE // \"generated\"")
    case "$planet_mode" in generated|external) ;; *) die 'PLANET_MODE must be generated or external' ;; esac
    value=$(config_value ".services.${SERVICE}.environment.ROOT_ONLY // \"0\"")
    case "$value" in 0|1) ;; *) die 'ROOT_ONLY must be 0 or 1' ;; esac
    controller_only=$(config_value ".services.${SERVICE}.environment.CONTROLLER_ONLY // \"0\"")
    case "$controller_only" in 0|1) ;; *) die 'CONTROLLER_ONLY must be 0 or 1' ;; esac
    [[ "$controller_only" == 0 || "$value" == 0 ]] || die 'ROOT_ONLY and CONTROLLER_ONLY are mutually exclusive'
    [[ "$controller_only" == 0 || "$planet_mode" == external ]] || die 'CONTROLLER_ONLY requires PLANET_MODE=external'
    ip=$(config_value ".services.${SERVICE}.environment.IP_ADDR4")
    ip6=$(config_value ".services.${SERVICE}.environment.IP_ADDR6")
    if [[ "$controller_only" == 0 ]]; then
        [[ -n "$ip" || -n "$ip6" ]] || die 'Root requires IP_ADDR4 or IP_ADDR6'
        [[ "$ip" != 203.0.113.10 ]] || die 'IP_ADDR4 still contains the example address'
    else
        [[ "$ip" != 203.0.113.10 ]] || die 'Controller-only IP_ADDR4 must be empty or a real address'
    fi
    [[ -z "$ip" ]] || valid_ipv4 "$ip" || die "IP_ADDR4 is invalid: $ip"
    [[ -z "$ip6" ]] || valid_root_ipv6 "$ip6" || die "IP_ADDR6 is invalid: $ip6"
    [[ "$(config_value ".services.${SERVICE}.network_mode")" == host ]] || die 'network_mode must remain host for the optimized deployment'
    for key in ZT_PORT API_PORT; do
        value=$(config_value ".services.${SERVICE}.environment.${key}")
        valid_port "$value" || die "$key must be an integer between 1 and 65535"
    done
    [[ "$(config_value ".services.${SERVICE}.environment.ZT_PORT")" \
        != "$(config_value ".services.${SERVICE}.environment.API_PORT")" ]] || die 'ZT_PORT and API_PORT must be different'
    value=$(config_value ".services.${SERVICE}.environment.DEFAULT_NETWORK_MTU")
    if [[ ! "$value" =~ ^[0-9]+$ ]] || ((10#$value < 1280 || 10#$value > 2800)); then
        die 'DEFAULT_NETWORK_MTU must be between 1280 and 2800'
    fi
    case "$(env_value IMAGE_SOURCE build)" in
        build|pull) ;;
        *) die "IMAGE_SOURCE must be 'build' or 'pull'" ;;
    esac
    for target in /app/dist /var/lib/zerotier-one /app/config /var/lib/ztncui; do
        source=$(mount_source "$target")
        [[ -n "$source" ]] || die "missing bind mount for $target"
        safe_directory "$source" || die "unsafe persistent path for $target: $source"
        for value in "${sources[@]}"; do
            paths_overlap "$source" "$value" && die "persistent paths overlap: $source and $value"
        done
        sources+=("$source")
    done
    root=$(backup_root)
    safe_directory "$root" || die "unsafe BACKUP_DIR: $root"
    for source in "${sources[@]}"; do
        paths_overlap "$root" "$source" && die "BACKUP_DIR overlaps persistent data: $root and $source"
    done
    if [[ "$planet_mode" == external ]]; then
        source=$(mount_source /app/config)
        if [[ ! -s "$source/planet" ]]; then
            if ((staged)); then
                warn 'Pending config/planet: install a verified signed bundle before doctor/up'
            else
                die 'External mode requires config/planet; generate and verify a bundle first'
            fi
        fi
        source=$(mount_source /var/lib/zerotier-one)
        if [[ ! -s "$source/identity.secret" ]]; then
            if ((staged)); then
                warn 'Pending Root identity: prepare an independent identity included in the signed Planet before up'
            else
                die 'External mode requires a prepared Root identity in one/identity.secret; do not copy another running Root identity'
            fi
        fi
    fi
    host=$(config_value ".services.${SERVICE}.environment.HTTP_HOST")
    [[ "$host" == localhost ]] || valid_ipv4 "$host" || valid_ipv6 "$host" || die 'HTTP_HOST must be an explicit IP or localhost'
    value=$(config_value ".services.${SERVICE}.environment.HTTP_EXTRA_HOSTS // \"\"")
    if [[ -n "$value" ]]; then
        [[ "$host" != 0.0.0.0 && "$host" != :: ]] || die 'Wildcard HTTP_HOST cannot be combined with HTTP_EXTRA_HOSTS'
        local -a extra_hosts=()
        IFS=',' read -r -a extra_hosts <<<"$value"
        for ip in "${extra_hosts[@]}"; do
            ip=${ip//[[:space:]]/}
            [[ -n "$ip" ]] || continue
            [[ "$ip" != 0.0.0.0 && "$ip" != :: ]] || die 'HTTP_EXTRA_HOSTS cannot contain wildcard addresses'
            [[ "$ip" == localhost ]] || valid_ipv4 "$ip" || valid_ipv6 "$ip" || die 'HTTP_EXTRA_HOSTS requires comma-separated IPs, not a subnet'
        done
    fi
    [[ "$host" != 0.0.0.0 && "$host" != :: ]] || warn 'Wildcard HTTP_HOST exposes the management UI; restrict it with a firewall or reverse proxy'
    if ((staged)); then
        log 'Staged configuration checks passed; daemon, World signature/identity and service health are not verified'
    else
        log 'Docker, Compose and configuration checks passed (World signature/identity verified at container startup)'
    fi
}

cmd_build() {
    cmd_doctor
    prepare_image
}

cmd_up() {
    local image
    cmd_doctor
    image=$(image_name)
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        prepare_image
    fi
    docker compose up -d --no-build "$SERVICE"
    wait_healthy || die 'service failed its health check'
}

cmd_upgrade() {
    local old_id image rollback_tag planet_mode
    cmd_doctor
    image=$(image_name)
    planet_mode=$(config_value ".services.${SERVICE}.environment.PLANET_MODE // \"generated\"")
    old_id=$(docker inspect "$(container_name)" --format '{{.Image}}' 2>/dev/null || true)
    prepare_image
    if [[ -n "$old_id" ]]; then
        rollback_tag="zerotier-planet:rollback-$(date +%Y%m%d-%H%M%S)"
        docker tag "$old_id" "$rollback_tag"
        log "Rollback image: $rollback_tag"
    fi
    backup_data 0 0
    if docker compose up -d --no-build --force-recreate "$SERVICE" && wait_healthy; then
        log "Upgrade complete; backup: $LAST_BACKUP"
        return
    fi

    if [[ -n "$old_id" && "$planet_mode" == external ]]; then
        # An older image may not understand PLANET_MODE=external and can
        # regenerate/overwrite a signed multi-root world as a single-root
        # planet. Keep the old image tagged for an operator-reviewed recovery,
        # but never activate it automatically after an external-mode failure.
        die "external Planet upgrade failed; automatic rollback is disabled (review ${rollback_tag} and backup: ${LAST_BACKUP})"
    fi
    if [[ -n "$old_id" ]]; then
        warn 'new container failed; restoring the previous image'
        if [[ "$image" == *@* ]]; then
            # A digest is immutable and cannot be the target of docker tag.
            # Reuse Compose's serialized model, which already escapes literal
            # dollars, to retain overrides, mounts and project identity.
            UPGRADE_ROLLBACK_CONFIG=$(mktemp "${TMPDIR:-/tmp}/planet-upgrade-rollback.XXXXXX") \
                || die "could not prepare rollback configuration; recovery image: $rollback_tag; data backup: $LAST_BACKUP"
            jq --arg service "$SERVICE" --arg image "$old_id" \
                '.services[$service].image = $image' \
                <<<"$COMPOSE_JSON" >"$UPGRADE_ROLLBACK_CONFIG" \
                || die "could not write rollback configuration; recovery image: $rollback_tag; data backup: $LAST_BACKUP"
            docker compose --project-directory "$ROOT_DIR" --project-name "$(config_value '.name')" \
                -f "$UPGRADE_ROLLBACK_CONFIG" up -d --no-build --pull never --force-recreate "$SERVICE" \
                || die "upgrade and automatic rollback startup both failed; recovery image: $rollback_tag; data backup: $LAST_BACKUP"
        else
            docker tag "$old_id" "$image" && docker compose up -d --no-build --force-recreate "$SERVICE" \
                || die "upgrade and automatic rollback startup both failed; recovery image: $rollback_tag; data backup: $LAST_BACKUP"
        fi
        wait_healthy || die "upgrade and automatic rollback both failed; data backup: $LAST_BACKUP"
        if [[ "$image" == *@* ]]; then
            warn "the configured digest was not changed; set ZT_IMAGE to a verified working image before the next up or upgrade (recovery image: $rollback_tag)"
        fi
        die "upgrade failed and was rolled back; data backup: $LAST_BACKUP"
    fi
    die "upgrade failed; data backup: $LAST_BACKUP"
}

cmd_status() {
    local name token port
    load_config
    docker compose ps
    name=$(container_name)
    if container_running; then
        docker inspect "$name" --format 'image={{.Config.Image}} image_id={{.Image}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}}'
        token=$(docker exec "$name" cat /var/lib/zerotier-one/authtoken.secret 2>/dev/null || true)
        port=$(config_value ".services.${SERVICE}.environment.ZT_PORT")
        if [[ -n "$token" ]]; then
            docker exec -e TOKEN="$token" -e ZT_API_PORT="$port" "$name" bash -lc '
                curl -fsS -H "X-ZT1-Auth: $TOKEN" "http://127.0.0.1:$ZT_API_PORT/status" |
                    jq "{address,online,version,tcpFallbackActive}"
                if test -s /app/config/planet-roots.json; then
                    jq "{worldId:.id,timestamp,rootCount:(.roots|length),roots:[.roots[]|{id:(.identity|split(\":\")[0]),stableEndpoints}]}" \
                        /app/config/planet-roots.json
                fi
                curl -fsS -H "X-ZT1-Auth: $TOKEN" "http://127.0.0.1:$ZT_API_PORT/peer" |
                    jq "[.[]|select(.role==\"PLANET\")|{address,latency,paths:(.paths//[]|map({active,address,lastReceive,lastSend}))}]"
                for nwid in $(curl -fsS -H "X-ZT1-Auth: $TOKEN" "http://127.0.0.1:$ZT_API_PORT/controller/network" | jq -r ".[]"); do
                    curl -fsS -H "X-ZT1-Auth: $TOKEN" "http://127.0.0.1:$ZT_API_PORT/controller/network/$nwid" |
                        jq "{nwid,name,mtu,revision}"
                done
            '
        fi
    fi
}

cmd_diagnose() {
    local config_dir port
    local -a options=()
    (($# == 0)) || [[ $# == 1 && $1 == --install-timer ]] \
        || die 'usage: ./manage.sh diagnose [--install-timer]'
    require_command python3
    load_config
    config_dir=$(mount_source /app/config)
    safe_directory "$config_dir" && [[ -d "$config_dir" ]] \
        || die 'diagnostics requires an existing safe config bind mount'
    port=$(config_value ".services.${SERVICE}.environment.ZT_PORT")
    if (($#)); then options+=(--install-timer); fi
    python3 "$ROOT_DIR/host-network-diagnostics.py" \
        --output "$config_dir/host-network-diagnostics.json" --port "$port" "${options[@]}"
    log 'Host policy snapshot refreshed; unavailable checks remain unknown in the Web UI'
}

cmd_logs() {
    load_config
    if (($#)); then
        docker compose logs "$@" "$SERVICE"
    else
        docker compose logs --tail 200 -f "$SERVICE"
    fi
}

cmd_restart() {
    load_config
    docker compose restart "$SERVICE"
    wait_healthy || die 'service failed its health check after restart'
}

cmd_backup() {
    local online=0
    while (($#)); do
        case "$1" in
            --online) online=1 ;;
            *) die "unknown backup option: $1" ;;
        esac
        shift
    done
    cmd_doctor
    backup_data "$online" 1
}

# Restore validates its input before stopping or writing to the current instance.
validate_restore_backup() {
    require_command python3
    python3 - "$@" <<'PYBACKUP'
import hashlib
import os
from pathlib import Path
import re
import stat
import sys

root = Path(sys.argv[1])
def require(condition, message):
    if not condition:
        raise ValueError(message)

def validate():
    require(root.is_dir(), "backup is not a directory")
    actual = set()
    def walk_error(error):
        raise error
    for parent, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
        for name in dirs + files:
            item = Path(parent) / name
            mode = item.lstat().st_mode
            require(stat.S_ISDIR(mode) or stat.S_ISREG(mode), "backup contains symlink or special file")
            if stat.S_ISREG(mode):
                actual.add(item.relative_to(root).as_posix())
    require("SHA256SUMS" in actual, "backup has no SHA256SUMS")
    recorded = set()
    for line in (root / "SHA256SUMS").read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64}) [ *](.+)", line)
        require(match, "unsupported checksum entry")
        name = match[2]
        if name.startswith("./"):
            name = name[2:]
        require(name and not name.startswith("/") and all(part not in ("", ".", "..") for part in name.split("/")),
                "unsafe checksum path")
        require(name != "SHA256SUMS" and name not in recorded, "duplicate/self checksum entry")
        require(name in actual, "missing checksum file")
        digest = hashlib.sha256()
        with (root / name).open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        require(digest.hexdigest() == match[1], "backup checksum mismatch")
        recorded.add(name)
    require(recorded == actual - {"SHA256SUMS"}, "backup contains unlisted files")
    def required(name):
        require(name in recorded and (root / name).stat().st_size > 0, "missing required state: " + name)
    for label in ("dist", "one", "config", "ztncui-state"):
        require((root / label).is_dir(), "missing dataset: " + label)
    for name in ("manifest.env", ".env", "docker-compose.yml", "one/identity.secret", "one/identity.public", "one/planet", "dist/planet"):
        required(name)
    def metadata(file, roles_only=False):
        result = {}
        for line in (root / file).read_text().splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            match = re.fullmatch(r"\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)", line)
            if roles_only and (not match or match[1] not in ("PLANET_MODE", "ROOT_ONLY", "CONTROLLER_ONLY")):
                continue
            require(match, "invalid metadata: " + file)
            key, value = match.groups()
            require(key not in result, "duplicate metadata key: " + key)
            if roles_only:
                parsed = re.fullmatch(r"(?:'([^']*)'|\"([^\"]*)\"|([^\s#'\"]+))\s*(?:#.*)?", value)
                require(parsed, "ambiguous backup role value: " + key)
                value = next(part for part in parsed.groups() if part is not None)
            result[key] = value
        return result
    manifest = metadata("manifest.env")
    require(manifest.get("consistency") == "offline", "restore requires an offline backup")
    require(manifest.get("repository_revision") and manifest.get("image"), "missing backup version metadata")
    env = metadata(".env", roles_only=True)
    keys = ("PLANET_MODE", "ROOT_ONLY", "CONTROLLER_ONLY")
    if manifest.get("backup_format") == "2":
        require(all(key in manifest for key in keys), "missing resolved backup role metadata")
        roles = manifest
    else:
        # Legacy backups lack resolved Compose configuration. Require explicit
        # roles rather than guessing defaults for an ambiguous old snapshot.
        require(all(key in env for key in keys), "legacy backup lacks explicit roles; create a new backup")
        roles = env
    mode, root_only, controller_only = (roles[key] for key in keys)
    require(controller_only == "0", "Controller-only backups require controller stage")
    if len(sys.argv) > 2:
        require(list(sys.argv[2:]) == [mode, root_only, controller_only], "backup role does not match the current Compose role")
    require(mode in ("generated", "external") and root_only in ("0", "1") and controller_only in ("0", "1"), "invalid backup role")
    require(controller_only == "0" or (root_only == "0" and mode == "external"), "invalid backup role combination")
    if mode == "external":
        required("config/planet")
    else:
        for name in ("one/current.c25519", "one/previous.c25519", "one/moon.json"):
            required(name)
    if root_only == "0":
        required("ztncui-state/passwd")
        required("config/session.secret")
        # A Controller with no networks is legitimate; its network directory
        # need not exist until the first network is created.
    require(not (root / "config/controller-standby.json").exists(), "managed standby backup requires controller stage")
try:
    validate()
except (ValueError, OSError, UnicodeError) as error:
    print("[planet] ERROR: " + str(error), file=sys.stderr)
    sys.exit(1)
PYBACKUP
}

restore_preflight() {
    local target source other root
    local -a sources=()
    require_command docker
    require_command jq
    require_command realpath
    docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required'
    docker info >/dev/null 2>&1 || die 'cannot connect to the Docker daemon'
    load_config
    for target in /app/dist /var/lib/zerotier-one /app/config /var/lib/ztncui; do
        source=$(mount_source "$target")
        safe_directory "$source" || die "unsafe persistent path for $target: $source"
        [[ ! -e "$source" || -d "$source" ]] || die "persistent path is not a directory: $source"
        for other in "${sources[@]}"; do
            paths_overlap "$source" "$other" && die "persistent paths overlap: $source and $other"
        done
        sources+=("$source")
    done
    root=$(backup_root)
    safe_directory "$root" || die "unsafe BACKUP_DIR: $root"
    for source in "${sources[@]}"; do
        paths_overlap "$root" "$source" && die "BACKUP_DIR overlaps persistent data: $root and $source"
    done
    return 0
}

cmd_restore() {
    local source=${1:-} confirm=${2:-}
    local target label current_backup was_running=0 stamp parent base stage old failed_path recovering=0
    local i swapped=0 rollback_failed=0
    local -a labels=(dist one config ztncui-state)
    local -a targets=(/app/dist /var/lib/zerotier-one /app/config /var/lib/ztncui)
    local -a restore_targets=() stages=() old_targets=() failed_targets=() missing_targets=()
    [[ -n "$source" && "$confirm" == --yes && $# == 2 ]] || die 'usage: ./manage.sh restore BACKUP --yes'
    [[ "$(realpath -m -- "$source")" == "$(realpath -ms -- "$source")" ]] \
        || die 'backup path must not contain symlinks'
    source=$(realpath -e -- "$source") || die 'backup directory does not exist'
    validate_restore_backup "$source" || die 'backup validation failed'
    restore_preflight
    validate_restore_backup "$source" \
        "$(config_value ".services.${SERVICE}.environment.PLANET_MODE // \"generated\"")" \
        "$(config_value ".services.${SERVICE}.environment.ROOT_ONLY // \"0\"")" \
        "$(config_value ".services.${SERVICE}.environment.CONTROLLER_ONLY // \"0\"")" \
        || die 'backup role validation failed'
    [[ ! -e "$(mount_source /app/config)/controller-standby.json" ]] \
        || die 'Managed Controller standby: use controller stage, not restore (which starts the service)'
    for target in "${targets[@]}"; do
        target=$(mount_source "$target")
        paths_overlap "$source" "$target" && die "backup source overlaps restore target: $source and $target"
    done
    container_running && was_running=1
    for target in "${targets[@]}"; do
        [[ -e "$(mount_source "$target")" ]] || recovering=1
    done
    backup_data 0 0 "$recovering"
    current_backup=$LAST_BACKUP
    ((was_running == 0)) || RESUME_SERVICE_ON_EXIT=1
    stamp=$(date +%Y%m%d-%H%M%S)

    # Copy every dataset beside its destination before changing live data.
    # The later renames stay on the same filesystem and are therefore atomic.
    for i in "${!labels[@]}"; do
        label=${labels[$i]}
        target=$(mount_source "${targets[$i]}")
        safe_directory "$target" || die "refusing to replace unsafe path: $target"
        if [[ ! -e "$target" ]]; then
            missing_targets+=("$target")
        fi
        install -d -m 0700 "$target"
        parent=$(dirname -- "$target")
        base=$(basename -- "$target")
        stage=$(mktemp -d "$parent/.${base}.restore.XXXXXXXX") || {
            for stage in "${stages[@]}"; do rm -rf -- "$stage"; done
            for target in "${missing_targets[@]}"; do rmdir -- "$target" 2>/dev/null || true; done
            die "failed to create restore staging directory beside $target"
        }
        chmod 0700 "$stage"
        restore_targets[i]=$target
        stages[i]=$stage
        if ! cp -a --reflink=auto "$source/$label/." "$stage/"; then
            for stage in "${stages[@]}"; do rm -rf -- "$stage"; done
            for target in "${missing_targets[@]}"; do rmdir -- "$target" 2>/dev/null || true; done
            die "failed to stage backup data for $label; live data was not changed"
        fi
    done

    # Never let EXIT cleanup start a partially exchanged set of directories.
    RESUME_SERVICE_ON_EXIT=0
    for i in "${!labels[@]}"; do
        label=${labels[$i]}
        target=${restore_targets[$i]}
        old="${target}.pre-restore-${stamp}-$$"
        old_targets[i]=$old
        if [[ -e "$old" ]] || ! mv -- "$target" "$old"; then
            restore_rollback_swaps || die "rollback incomplete; service remains stopped; manual recovery required; recovery snapshot: $current_backup"
            restore_cleanup_artifacts || die "rollback data restored but cleanup failed; service remains stopped; recovery snapshot: $current_backup"
            if ((was_running)); then
                docker compose start "$SERVICE" && wait_healthy || die "rollback data restored but service restart failed; recovery snapshot: $current_backup"
            fi
            die "failed to preserve the current $label directory; restore was rolled back"
        fi
        if ! mv -- "${stages[$i]}" "$target"; then
            if ! mv -- "$old" "$target"; then
                warn "rollback could not restore pre-restore directory: $old -> $target; staged data: ${stages[$i]}"
                rollback_failed=1
            fi
            restore_rollback_swaps || rollback_failed=1
            ((rollback_failed == 0)) || die "rollback incomplete; service remains stopped; manual recovery required; recovery snapshot: $current_backup"
            restore_cleanup_artifacts || die "rollback data restored but cleanup failed; service remains stopped; recovery snapshot: $current_backup"
            if ((was_running)); then
                docker compose start "$SERVICE" && wait_healthy || die "rollback data restored but service restart failed; recovery snapshot: $current_backup"
            fi
            die "failed to activate staged $label data; restore was rolled back"
        fi
        swapped=$((swapped + 1))
    done

    if ! docker compose up -d --no-build --force-recreate "$SERVICE" || ! wait_healthy; then
        RESUME_SERVICE_ON_EXIT=0
        warn 'restored data failed its health check; returning to the pre-restore data'
        if ! docker compose down --remove-orphans >/dev/null 2>&1; then
            RESUME_SERVICE_ON_EXIT=0
            die "restore health check failed and the new service could not be stopped; live data left in place: ${restore_targets[*]}; pre-restore data: ${old_targets[*]}; manual recovery required; recovery snapshot: $current_backup"
        fi
        for ((i=${#labels[@]} - 1; i >= 0; i--)); do
            target=${restore_targets[$i]}
            failed_path="${target}.failed-restore-${stamp}-$$"
            failed_targets[i]=$failed_path
            if ! mv -- "$target" "$failed_path"; then
                die "restore failed and $target could not be moved aside; pre-restore data: ${old_targets[$i]}; service remains stopped; manual recovery required; recovery snapshot: $current_backup"
            fi
            if ! mv -- "${old_targets[$i]}" "$target"; then
                die "rollback could not restore ${old_targets[$i]} -> $target; failed data: $failed_path; service remains stopped; manual recovery required; recovery snapshot: $current_backup"
            fi
        done
        for target in "${missing_targets[@]}"; do rmdir -- "$target" 2>/dev/null || true; done
        if ((was_running == 0)) || { docker compose up -d --no-build "$SERVICE" && wait_healthy; }; then
            RESUME_SERVICE_ON_EXIT=0
            for failed_path in "${failed_targets[@]}"; do rm -rf -- "$failed_path"; done
            die "restore failed its health check and was rolled back; verified backup: $current_backup"
        fi
        die "restore and automatic rollback both failed; verified backup: $current_backup"
    fi

    RESUME_SERVICE_ON_EXIT=0
    for old in "${old_targets[@]}"; do rm -rf -- "$old"; done
    log "Restore complete; pre-restore backup: $current_backup"
}

cmd_reset_password() {
    [[ "${1:-}" == --yes && $# == 1 ]] || die 'usage: ./manage.sh reset-password --yes'
    local name root backup
    cmd_doctor
    name=$(container_name)
    container_running || die 'service is not running'
    root=$(backup_root)
    backup="$root/password-$(date +%Y%m%d-%H%M%S)"
    if [[ -e "$backup" ]]; then
        backup="${backup}-$$"
    fi
    install -d -m 0700 "$backup"
    docker cp "$name:/var/lib/ztncui/passwd" "$backup/passwd"
    chmod 0600 "$backup/passwd"
    (cd "$backup" && sha256sum passwd >SHA256SUMS)
    chmod 0600 "$backup/SHA256SUMS"
    docker exec "$name" bash -lc 'cp /var/lib/ztncui/default.passwd /var/lib/ztncui/passwd && chmod 0600 /var/lib/ztncui/passwd'
    cmd_restart
    log "Password reset to admin/password; change it immediately. Previous file: $backup"
}

cmd_down() {
    load_config
    docker compose down --remove-orphans
    log 'Container removed; persistent data was preserved'
}

cmd_uninstall() {
    local purge=0 confirm=0 target
    while (($#)); do
        case "$1" in
            --purge-data) purge=1 ;;
            --yes) confirm=1 ;;
            *) die "unknown uninstall option: $1" ;;
        esac
        shift
    done
    if ((purge == 0)); then
        load_config
        cmd_down
        return
    fi
    ((confirm)) || die 'data purge requires both --purge-data and --yes'
    cmd_doctor
    backup_data 0 0
    docker compose down --remove-orphans
    for target in /app/dist /var/lib/zerotier-one /app/config /var/lib/ztncui; do
        target=$(mount_source "$target")
        safe_directory "$target" || die "refusing to purge unsafe path: $target"
        find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    done
    log "Container and persistent data removed; final backup: $LAST_BACKUP"
}

command_name=${1:-help}
shift || true
case "$command_name" in
    doctor) cmd_doctor "$@" ;;
    build) cmd_build "$@" ;;
    up) cmd_up "$@" ;;
    upgrade) cmd_upgrade "$@" ;;
    status) cmd_status "$@" ;;
    diagnose) cmd_diagnose "$@" ;;
    logs) cmd_logs "$@" ;;
    restart) cmd_restart "$@" ;;
    backup) cmd_backup "$@" ;;
    restore) cmd_restore "$@" ;;
    controller) require_command python3; exec python3 "$ROOT_DIR/scripts/controller_standby.py" "$@" ;;
    root) exec bash "$ROOT_DIR/root-manage.sh" "$@" ;;
    reset-password) cmd_reset_password "$@" ;;
    down) cmd_down "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    help|-h|--help) usage ;;
    *) die "unknown command: $command_name (run ./manage.sh help)" ;;
esac
