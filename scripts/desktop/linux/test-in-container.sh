#!/bin/bash
# Runs inside a test container started with --network none (see docker-test.mjs).
#   /pkg     one program's packages (read-only)      /photos  a few JPEGs (read-only)
#   /out     where the evidence goes
# Usage: test-in-container.sh <program> deb|appimage [extra app flags, e.g. --no-sandbox]
#   <program>    photo-tool or photobook-editor: the package, the command and /opt/<program>
#   ENV_PREFIX   the program's variable prefix (PHOTO_TOOL or PHOTOBOOK), for its data folders
#   PRODUCT      the name in its window title (Photo Tool or Photobook Editor)
# Starts as root (dpkg needs it); the app itself always runs as the ordinary user "tester".
set -u
P=$1; mode=$2; shift 2
flags="$*"
: "${ENV_PREFIX:?ENV_PREFIX is not set}" "${PRODUCT:?PRODUCT is not set}"
out=/out
work=/home/tester/selftest
mkdir -p "$out"; chmod 777 "$out"
exec > >(tee "$out/test.log") 2>&1

echo "== $(. /etc/os-release; echo "$PRETTY_NAME")  program=$P  mode=$mode  flags='$flags'"
echo "== network interfaces: $(ls /sys/class/net | tr '\n' ' ')"
echo "== user namespaces for an ordinary user: $(runuser -u tester -- unshare -Ur true 2>&1 && echo available || echo NOT available)"

run_app() { # run_app <label> <command...>: the self-test as "tester" on a virtual display
  local label=$1; shift
  rm -rf "$work"; runuser -u tester -- mkdir -p "$work"
  echo "== [$label] $* $flags --self-test"
  ( # While it runs: which Chromium processes exist, how they are sandboxed, the window's class,
    # and the most memory the local server (the "node service" utility process) ever held.
    peak=0
    while [ ! -e /tmp/app-finished ]; do
      sleep 2
      procs=$(for p in $(pgrep -f -- '--type=(renderer|zygote|utility|gpu-process)'); do
        echo "proc $p $(tr '\0' ' ' < /proc/$p/cmdline | grep -oE -- '--type=[a-z-]*|--no-sandbox|--utility-sub-type=[a-zA-Z._]*' | tr '\n' ' ') seccomp=$(awk '/^Seccomp:/{print $2}' /proc/$p/status) userns=$(readlink /proc/$p/ns/user) pidns=$(readlink /proc/$p/ns/pid)"
      done 2>/dev/null)
      [ -n "$procs" ] && { echo "$procs"; echo "init userns=$(readlink /proc/1/ns/user) pidns=$(readlink /proc/1/ns/pid)"; } > "$out/$label-processes.txt"
      for p in $(pgrep -f -- 'node.mojom.NodeService'); do
        rss=$(awk '/^VmRSS:/{print $2}' /proc/$p/status 2>/dev/null); [ "${rss:-0}" -gt "$peak" ] && peak=$rss
      done
      echo "server peak memory: $((peak / 1024)) MB" > "$out/$label-server-memory.txt"
      d=$(ls /tmp/.X11-unix 2>/dev/null | head -1 | sed 's/^X/:/')
      for a in /tmp/xvfb-run.*/Xauthority; do
        w=$(XAUTHORITY=$a DISPLAY=$d xwininfo -root -tree 2>/dev/null | grep -iF "$PRODUCT"); [ -n "$w" ] && echo "$w" > "$out/$label-windows.txt"
      done
    done
  ) &
  local sampler=$!
  # Its data, browser profile and the shared photo info all go under $work, as in CI.
  runuser -u tester -- env "${ENV_PREFIX}_DATA_DIR=$work/data" "${ENV_PREFIX}_PROFILE_DIR=$work/profile" PHOTOINFO_FALLBACK_DIR="$work/photoinfo" HOME=/home/tester \
    timeout 900 xvfb-run -a -s '-screen 0 1600x1000x24' "$@" $flags --self-test /photos --self-test-out "$work/out" > "$out/$label-stdout.txt" 2>&1
  local code=$?
  touch /tmp/app-finished; wait $sampler; rm -f /tmp/app-finished
  echo "== [$label] exit code $code"
  mkdir -p "$out/$label"
  cp "$work"/out/result.json "$work"/out/*.png "$work"/data/logs/desktop.log "$out/$label/" 2>/dev/null
  echo "-- sandbox / GLib / crash lines in the output:"
  grep -ihE 'sandbox|GLib|GObject|assertion|segfault|SIGSEGV|SIGTRAP|core dumped|FATAL|cannot open shared|error while loading' "$out/$label-stdout.txt" "$out/$label/desktop.log" 2>/dev/null | sed -E 's/^\[[^]]*\] ?//; s/\(process:[0-9]+\)//; s/[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+//; s/^\[[0-9:\/.]+://' | sort | uniq -c | sort -rn | head -30
  echo "-- processes:"; cat "$out/$label-processes.txt" "$out/$label-server-memory.txt" 2>/dev/null
  echo "-- windows:"; cat "$out/$label-windows.txt" 2>/dev/null
  if grep -q 'GLib-GObject-CRITICAL' "$out/$label-stdout.txt"; then
    echo "== [$label] FAIL: sharp is using the wrong glib and leaks memory (see patch-sharp.mjs)"; code=1
  fi
  return $code
}

if [ "$mode" = deb ]; then
  touch /tmp/before-install; sleep 1
  echo "== dpkg -i"
  dpkg -i /pkg/*.deb; echo "== dpkg exit code $?"
  dpkg -s $P | grep -E '^(Status|Version|Depends|Recommends)'
  echo "== dependencies not satisfied:"; dpkg --audit; apt-get check 2>&1 | tail -5
  echo "== shared libraries the program cannot find:"; ldd "/opt/$P/$P" | grep 'not found'
  ls -l "/opt/$P/chrome-sandbox" /usr/bin/$P /etc/alternatives/$P /etc/apparmor.d/$P 2>&1
  if [ -n "${FORCE_SUID_SANDBOX:-}" ]; then
    # What the install script does on a system without user namespaces, and Chromium told to
    # use that setuid helper even though this kernel has them.
    chmod 4755 /opt/$P/chrome-sandbox; flags="$flags --disable-namespace-sandbox"
    ls -l /opt/$P/chrome-sandbox
  fi
  run_app deb $P; code=$?
  find / -xdev \( -path /proc -o -path /sys -o -path /tmp -o -path /out -o -path /var/lib/dpkg -o -path /var/log -o -path /var/cache \) -prune -o -newer /tmp/before-install -print 2>/dev/null | grep -v "^/opt/$P/\|^$work" | sort > "$out/files-after-install-and-run.txt"
  touch /tmp/before-remove; sleep 1
  echo "== dpkg -r"; dpkg -r $P; echo "== dpkg -r exit code $?"
  echo "== left behind by the package after removal:"
  ls -ld "/opt/$P" /usr/bin/$P /etc/alternatives/$P /etc/apparmor.d/$P /usr/share/applications/$P.desktop /usr/share/doc/$P 2>&1 | sed 's/^/   /'
  find /usr/share/icons -name "$P*" | sed 's/^/   /'
  dpkg -l $P 2>&1 | tail -1
  echo "== left behind in the user's home (the books are meant to stay):"
  find /home/tester -newer /tmp/before-install -maxdepth 2 | sed 's/^/   /' | head -40
else
  runuser -u tester -- cp /pkg/*.AppImage /home/tester/app.AppImage
  chmod +x /home/tester/app.AppImage
  echo "== fuse: $(ls /dev/fuse 2>&1); libfuse: $(ldconfig -p | grep -o 'libfuse[^ ]*' | sort -u | tr '\n' ' '); fusermount: $(command -v fusermount fusermount3 | tr '\n' ' ')"
  # First the way a double-click runs it: the AppImage mounts itself, which needs FUSE.
  run_app appimage-as-is /home/tester/app.AppImage; code=$?
  if [ $code -eq 0 ]; then
    echo "== the AppImage ran as it is"; cp -r "$out/appimage-as-is" "$out/appimage"
  else
    echo "== as it is, the AppImage did not run:"; grep -v '^$' "$out/appimage-as-is-stdout.txt" | head -8 | sed 's/^/   /'
    echo "== again, unpacking itself to /tmp instead of mounting (APPIMAGE_EXTRACT_AND_RUN=1)"
    export APPIMAGE_EXTRACT_AND_RUN=1
    run_app appimage /home/tester/app.AppImage; code=$?
  fi
  echo "== left behind in the user's home and /tmp:"
  find /home/tester /tmp -newer /home/tester/app.AppImage -maxdepth 2 2>/dev/null | grep -v "^$work" | sed 's/^/   /' | head -40
fi
echo "== RESULT $mode exit=$code ok=$(grep -m1 -o '"ok": *[a-z]*' "$out/$mode/result.json" 2>/dev/null)"
exit $code
