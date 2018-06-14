#!/bin/sh

progdir=$(dirname "$0")
. "$progdir/../../lib/shlib.sh"

trap "rm -f /tmp/startx.sh.$$" EXIT
cat "$progdir/../../lib/shlib.sh" "$progdir/startx.sh" >/tmp/startx.sh.$$

builder_create \
    --image-project=freebsd-org-cloud-dev \
    --image=freebsd-11-1-release-amd64 \
    --metadata-from-file=startup-script=/tmp/startx.sh.$$ \
    builder-freebsd11
