#!/bin/sh
# Builds the app and uploads dist/ with rsync.
#
# The rsync target comes from $DEPLOY_TARGET, or from deploy.local in the
# project root (ignored by git), e.g.:
#
#   DEPLOY_TARGET=example.com:www/syncplay/
set -eu
cd "$(dirname "$0")/.."

if [ -z "${DEPLOY_TARGET:-}" ] && [ -f deploy.local ]; then
  # shellcheck source=/dev/null # local file, not in the repo
  . ./deploy.local
fi
if [ -z "${DEPLOY_TARGET:-}" ]; then
  echo "No deploy target. Create deploy.local containing e.g.:" >&2
  echo "  DEPLOY_TARGET=example.com:www/syncplay/" >&2
  exit 1
fi

npm run build
rsync -avz dist/ "$DEPLOY_TARGET"
