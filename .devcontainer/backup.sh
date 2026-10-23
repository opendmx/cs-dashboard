#!/usr/bin/env bash
set -euo pipefail

export GIT_TERMINAL_PROMPT=0
export GCM_INTERACTIVE=never
export GIT_ASKPASS=/bin/false
export SSH_ASKPASS=/bin/false

repo=$(git rev-parse --show-toplevel)
cd "$repo"
state="$(git rev-parse --absolute-git-dir)/codespace-backup"
mkdir -p "$state"

log() {
    printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"
}

snapshot() (
    set -euo pipefail
    head=$(git rev-parse HEAD) || exit 1
    index=$(mktemp "$state/index.XXXXXX") || exit 1
    rm "$index" || exit 1
    trap 'rm -f "$index"' EXIT
    export GIT_INDEX_FILE="$index"
    git read-tree "$head" || exit 1
    git add -A -- . || exit 1
    tree=$(git write-tree) || exit 1
    previous=$(git rev-parse --verify refs/codespace-backup/latest 2>/dev/null || true)
    if [[ -n "$previous" && "$tree" == "$(git rev-parse "$previous^{tree}")" && "$head" == "$(git rev-parse "$previous^")" ]]; then
        exit 0
    fi
    commit=$(git -c user.name="Codespace Backup" \
        -c user.email="codespace-backup@users.noreply.github.com" \
        -c commit.gpgSign=false commit-tree "$tree" -p "$head" \
        -m "Automatic Codespace backup $(date -u +%FT%TZ)") || exit 1
    name="$(date -u +%Y%m%dT%H%M%SZ)-$(cat /proc/sys/kernel/random/uuid)"
    # Queue and record the snapshot atomically so interrupted pushes can be retried.
    git update-ref --stdin <<EOF || exit 1
start
create refs/codespace-backup/pending/$name $commit
update refs/codespace-backup/latest $commit
prepare
commit
EOF
    log "Created backup snapshot $name"
)

backup() {
    local failed=0 ref name
    if ! snapshot; then
        log "ERROR: Snapshot failed; existing queued backups will still be retried."
        failed=1
    fi
    while IFS= read -r ref; do
        name=${ref##*/}
        if timeout 45s git -c core.hooksPath=/dev/null push origin \
            "$ref:refs/heads/codespace-backup/$name"; then
            if ! git update-ref -d "$ref"; then
                log "ERROR: Could not remove pushed snapshot from the queue."
                return 1
            fi
            log "Pushed codespace-backup/$name"
        else
            log "ERROR: Push failed for $name; snapshot retained for retry."
            failed=1
            break
        fi
    done < <(git for-each-ref --format='%(refname)' refs/codespace-backup/pending/)
    return "$failed"
}

case "${1:-}" in
    start)
        script="$repo/.devcontainer/backup.sh"
        nohup bash "$script" run >> "$state/backup.log" 2>&1 < /dev/null &
        log "Backup service requested; log: $state/backup.log"
        ;;
    run)
        exec 9>"$state/service.lock"
        if ! flock -n 9; then
            log "Backup service is already running."
            exit 0
        fi
        log "Backup service started (60-second interval)."
        trap 'log "Stopping; attempting a final backup."; backup; exit' TERM INT
        while true; do
            started=$SECONDS
            if ! backup; then
                log "ERROR: Backup incomplete; retrying on the next interval."
            fi
            remaining=$((60 - (SECONDS - started)))
            if (( remaining > 0 )); then
                sleep "$remaining" &
                wait "$!" || true
            fi
        done
        ;;
    once)
        exec 9>"$state/service.lock"
        flock -n 9
        backup
        ;;
    *)
        printf 'Usage: bash .devcontainer/backup.sh {start|run|once}\n' >&2
        exit 2
        ;;
esac
