#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_TMP=
CREATED_ENV=0
cd "$ROOT_DIR"

cleanup() {
    local status=$?
    trap - EXIT
    [[ -z "$ENV_TMP" ]] || rm -f -- "$ENV_TMP"
    if ((status != 0 && CREATED_ENV)); then
        printf 'Configuration was kept in %s. After fixing the failure, run ./install.sh without initialization flags, or run ./manage.sh doctor && ./manage.sh up.\n' "$ENV_FILE" >&2
    fi
    exit "$status"
}
trap cleanup EXIT

die() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage:
  ./install.sh --ip PUBLIC_IPV4 [--ipv6 PUBLIC_IPV6] [options]
  ./install.sh --ipv6 PUBLIC_IPV6 [options]
  ./install.sh                         # reuse an existing .env

Options:
  --ip ADDRESS          Public IPv4 address advertised by the Planet.
  --ipv6 ADDRESS        Public IPv6 address; may be used without --ip.
  --data-dir PATH       Persistent data directory (default: ./data/zerotier).
  --image IMAGE         Image tag to build or pull.
  --pull                Pull --image instead of building locally.
  --planet-mode MODE    generated (single Root) or external (signed multi-Root).
  --root-only 0|1       Start the Root-only service without Web UI (default: 0).
  --controller-only 0|1 Use external Controller-only role with restored identity.
  --configure-only      Stage and check .env; external identity/planet may be pending.
  -h, --help            Show this help.

The installer never removes or overwrites an existing data directory. If .env
already exists, it is preserved and command-line configuration options are
rejected. Edit .env explicitly when changing an existing deployment.
External mode requires a pre-generated independent Root identity and a verified
config/planet containing it before startup. See docs/in-place-upgrade.md.
EOF
}

valid_ipv4() {
    command -v python3 >/dev/null 2>&1 || die 'python3 is required to validate IP addresses'
    python3 -c 'import ipaddress,sys; sys.exit(0 if ipaddress.ip_address(sys.argv[1]).version == 4 else 1)' "$1" \
        >/dev/null 2>&1
}

valid_root_ipv6() {
    local address=$1
    [[ "$address" == *:* && "$address" != *%* ]] || return 1
    command -v python3 >/dev/null 2>&1 || die 'python3 is required to validate IP addresses'
    python3 -c 'import ipaddress,sys; a=ipaddress.ip_address(sys.argv[1]); sys.exit(0 if a.version == 6 and a.ipv4_mapped is None and not (a.is_unspecified or a.is_loopback or a.is_link_local or a.is_multicast) else 1)' "$address" \
        >/dev/null 2>&1
}

safe_env_value() {
    # Values are written unquoted to Compose's .env. Reject interpolation,
    # quoting and escape syntax so the mounted path stays the requested path.
    [[ "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" != *'#'* &&
       "$1" != *'$'* && "$1" != *'"'* && "$1" != *"'"* && "$1" != *'\'* ]]
}

public_ip="${IP_ADDR4:-}"
public_ipv6="${IP_ADDR6:-}"
data_dir="${DATA_DIR:-./data/zerotier}"
image="${ZT_IMAGE:-}"
image_source="build"
image_explicit=0
configure_only=0
configuration_requested=0
planet_mode="${PLANET_MODE:-generated}"
root_only="${ROOT_ONLY:-0}"
controller_only="${CONTROLLER_ONLY:-0}"

while (($#)); do
    case "$1" in
        --ip)
            (($# >= 2)) || die '--ip requires a value'
            public_ip=$2
            configuration_requested=1
            shift 2
            ;;
        --ipv6)
            (($# >= 2)) || die '--ipv6 requires a value'
            public_ipv6=$2
            configuration_requested=1
            shift 2
            ;;
        --data-dir)
            (($# >= 2)) || die '--data-dir requires a value'
            data_dir=$2
            configuration_requested=1
            shift 2
            ;;
        --image)
            (($# >= 2)) || die '--image requires a value'
            image=$2
            image_explicit=1
            configuration_requested=1
            shift 2
            ;;
        --pull)
            image_source=pull
            configuration_requested=1
            shift
            ;;
        --planet-mode)
            (($# >= 2)) || die '--planet-mode requires generated or external'
            planet_mode=$2
            configuration_requested=1
            shift 2
            ;;
        --root-only)
            (($# >= 2)) || die '--root-only requires 0 or 1'
            root_only=$2
            configuration_requested=1
            shift 2
            ;;
        --controller-only)
            (($# >= 2)) || die '--controller-only requires 0 or 1'
            controller_only=$2
            configuration_requested=1
            shift 2
            ;;
        --configure-only)
            configure_only=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "unknown option: $1"
            ;;
    esac
done

if [[ -e "$ENV_FILE" ]]; then
    ((configuration_requested == 0)) || die '.env already exists; edit it explicitly instead of passing configuration options'
else
    if [[ -z "$public_ip" && -z "$public_ipv6" && "$controller_only" != 1 && -t 0 ]]; then
        read -r -p 'Public IPv4 address: ' public_ip
    fi
    [[ -n "$public_ip" || -n "$public_ipv6" || "$controller_only" == 1 ]] || die '--ip or --ipv6 is required when creating .env'
    [[ -z "$public_ip" ]] || valid_ipv4 "$public_ip" || die "invalid IPv4 address: $public_ip"
    [[ -z "$public_ipv6" ]] || valid_root_ipv6 "$public_ipv6" || die "invalid IPv6 address: $public_ipv6"
    case "$planet_mode" in generated|external) ;; *) die 'PLANET_MODE must be generated or external' ;; esac
    case "$root_only" in 0|1) ;; *) die 'ROOT_ONLY must be 0 or 1' ;; esac
    case "$controller_only" in 0|1) ;; *) die 'CONTROLLER_ONLY must be 0 or 1' ;; esac
    [[ "$controller_only" == 0 || ( "$root_only" == 0 && "$planet_mode" == external ) ]] \
        || die 'CONTROLLER_ONLY requires external mode and ROOT_ONLY=0'
    safe_env_value "$data_dir" || die 'data directory contains unsupported characters'
    [[ "$data_dir" != *[[:space:]]* ]] || die 'data directory must not contain whitespace'

    zt_version="${ZT_VERSION:-1.16.2}"
    if [[ "$image_source" == pull && -z "$image" && $image_explicit -eq 0 ]]; then
        die '--pull requires --image (or the ZT_IMAGE environment variable)'
    fi
    [[ -n "$image" ]] || image="zerotier-planet:${zt_version}-optimized"
    [[ "$image" =~ ^[A-Za-z0-9._/@:-]+$ ]] || die 'image name contains unsupported characters'

    umask 077
    ENV_TMP=$(mktemp "${ENV_FILE}.tmp.XXXXXX")
    {
        printf 'ZT_VERSION=%s\n' "$zt_version"
        printf 'ZTNCUI_COMMIT=%s\n' "${ZTNCUI_COMMIT:-1b2284864de48d2dcae22582fff122fe24909c3d}"
        printf 'MKWORLD_ZT_VERSION=%s\n' "${MKWORLD_ZT_VERSION:-1.14.2}"
        printf 'DEBIAN_MIRROR=%s\n' "${DEBIAN_MIRROR:-mirrors.aliyun.com}"
        printf 'ZT_IMAGE=%s\n' "$image"
        printf 'IMAGE_SOURCE=%s\n' "$image_source"
        printf 'SOURCE_REPOSITORY=%s\n' "${SOURCE_REPOSITORY:-}"
        printf 'DATA_DIR=%s\n' "$data_dir"
        printf 'ZTNCUI_STATE_DIR=%s\n' "${data_dir%/}/ztncui-state"
        printf 'BACKUP_DIR=%s\n' "${BACKUP_DIR:-./backups}"
        printf 'CONTAINER_NAME=%s\n' "${CONTAINER_NAME:-myztplanet}"
        printf '\nIP_ADDR4=%s\n' "$public_ip"
        printf 'IP_ADDR6=%s\n' "$public_ipv6"
        printf 'ZT_PORT=%s\n' "${ZT_PORT:-9994}"
        printf 'API_PORT=%s\n' "${API_PORT:-3443}"
        printf 'DEFAULT_NETWORK_MTU=%s\n' "${DEFAULT_NETWORK_MTU:-1280}"
        printf 'HTTP_HOST=%s\n' "${HTTP_HOST:-127.0.0.1}"
        printf 'HTTP_EXTRA_HOSTS=%s\n' "${HTTP_EXTRA_HOSTS:-}"
        printf 'PLANET_MODE=%s\n' "$planet_mode"
        printf 'ROOT_ONLY=%s\n' "$root_only"
        printf 'CONTROLLER_ONLY=%s\n' "$controller_only"
        printf 'ZT_PROBE_STATE_DIR=%s\n' "${ZT_PROBE_STATE_DIR:-${data_dir%/}/probe-state}"
        printf 'ZT_PROBE_ADDR=%s\n' "${ZT_PROBE_ADDR:-http://127.0.0.1:9993}"
        printf 'ZT_ENDPOINT_PROBES_FILE=%s\n' "${ZT_ENDPOINT_PROBES_FILE:-/app/config/endpoint-probes.json}"
        printf 'TZ=%s\n' "${TZ:-Asia/Shanghai}"
    } >"$ENV_TMP"
    chmod 0600 "$ENV_TMP"
    if ! ln "$ENV_TMP" "$ENV_FILE" 2>/dev/null; then
        die '.env was created concurrently; the existing file was preserved'
    fi
    rm -f -- "$ENV_TMP"
    ENV_TMP=
    CREATED_ENV=1
    printf 'Created %s\n' "$ENV_FILE"
fi

if ((CREATED_ENV)); then
    install -d -m 0700 \
        "${data_dir%/}/dist" \
        "${data_dir%/}/one" \
        "${data_dir%/}/config" \
        "${data_dir%/}/ztncui-state" \
        "${data_dir%/}/probe-state"
fi

if ((configure_only)); then
    # Resolve existing .env values and actual mounts through Compose, rather
    # than using the defaults above (which only apply when creating .env).
    "$ROOT_DIR/manage.sh" doctor --staged
    printf 'Configuration staged; no service was started. Run ./manage.sh doctor after preparing external identity/planet files.\n'
    exit 0
fi

"$ROOT_DIR/manage.sh" doctor
"$ROOT_DIR/manage.sh" up
"$ROOT_DIR/manage.sh" status
