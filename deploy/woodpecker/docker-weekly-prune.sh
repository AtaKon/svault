#!/bin/sh
# Weekly Docker cleanup for the NAS.
#
# Install as /mnt/Storage/apps/woodpecker/bin/docker-weekly-prune, owned by
# root and mode 0755, and schedule it in TrueNAS under
# System > Advanced > Cron Jobs (user root, weekly).
#
# It removes images no container uses (running or stopped) that are older
# than a week, plus old build cache. svault-deploy already keeps svault images
# down to the current and previous commit; this catches leftovers from
# TrueNAS app updates and CI builds. Kaniko fails with "no space left on
# device" when the Docker dataset fills up, which shows up in Woodpecker as a
# publish step that never finishes.

set -u

BEFORE=$(zfs list -H -o avail Storage/ix-apps 2>/dev/null || echo unknown)
docker image prune -a -f --filter until=168h >/dev/null 2>&1
docker builder prune -f --filter until=168h >/dev/null 2>&1
AFTER=$(zfs list -H -o avail Storage/ix-apps 2>/dev/null || echo unknown)

logger -t docker-weekly-prune "Docker dataset free space: $BEFORE before, $AFTER after"
