#!/bin/sh
# Initialize once. Never overwrite a deployed configuration.
set -eu
config_dir=${1:-/var/lib/vm2api-egress}
checker=${2:-sing-box}
umask 077
mkdir -p "$config_dir"
chmod 700 "$config_dir"
if [ ! -e "$config_dir/config.json" ]; then
  candidate=$(mktemp "$config_dir/.bootstrap.XXXXXX")
  trap 'rm -f "$candidate"' EXIT HUP INT TERM
  printf '%s\n' '{"log":{"disabled":true},"inbounds":[],"outbounds":[],"route":{"rules":[{"action":"reject"}]}}' > "$candidate"
  if ! "$checker" check -c "$candidate" >/dev/null 2>&1; then
    echo 'Managed egress bootstrap configuration check failed' >&2
    exit 1
  fi
  # Hard-link publication is atomic and cannot replace an existing file.
  if ! ln "$candidate" "$config_dir/config.json" 2>/dev/null; then
    [ -f "$config_dir/config.json" ] || exit 1
  fi
  rm -f "$candidate"
  trap - EXIT HUP INT TERM
fi
if ! "$checker" check -c "$config_dir/config.json" >/dev/null 2>&1; then
  echo 'Managed egress existing configuration check failed; file preserved' >&2
  exit 1
fi
