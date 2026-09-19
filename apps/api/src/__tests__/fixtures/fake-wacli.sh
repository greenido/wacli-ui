#!/bin/sh
# A stand-in wacli for tests that need real processes. It logs every
# invocation to $FAKE_LOG and models the store lock with an atomic mkdir of
# $FAKE_LOCK: `sync` holds it until it is signalled, and a second `sync`
# refuses to start while it is held, the way the real one does.
printf '%s\n' "$*" >> "${FAKE_LOG:?}"
case "$1" in
  sync)
    if mkdir "${FAKE_LOCK:?}" 2>/dev/null; then
      echo $$ >> "${FAKE_PIDS:?}"
      trap 'rmdir "$FAKE_LOCK" 2>/dev/null; exit 0' INT TERM
      echo '{"event":"connected"}' >&2
      while :; do sleep 0.1; done
    else
      echo 'store is locked (another wacli is running?)' >&2
      exit 1
    fi ;;
  --version) echo 'wacli 0.0.0-fake' ;;
  *) echo '{"success":true,"data":{}}' ;;
esac
