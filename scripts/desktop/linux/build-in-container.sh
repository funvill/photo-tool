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
# Both programs: dist/installer/photo-tool and dist/installer/photobook-editor.
npm run dist:all
cp dist/installer/*/*.deb dist/installer/*/*.AppImage /out/
for d in dist/installer/*/; do cp "$d/builder-debug.yml" "/out/$(basename "$d")-builder-debug.yml" 2>/dev/null || true; done
ls -l /out
