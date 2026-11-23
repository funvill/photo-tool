#!/bin/sh
# Runs inside the build container (see docker-build.mjs): /src is a read-only snapshot of the
# source, /out receives the packages. The build happens on the container's own disk, so that
# `npm ci` installs the Linux binaries of sharp and Electron and nothing touches the host's
# node_modules.
set -eu
rm -rf /build/* /build/.[!.]* 2>/dev/null || true
cp -a /src/. /build/
cd /build
npm ci --no-audit --no-fund
npm run dist
cp dist/installer/*.deb dist/installer/*.AppImage /out/
cp dist/installer/builder-debug.yml /out/ 2>/dev/null || true
ls -l /out
