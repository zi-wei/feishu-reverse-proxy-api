#!/usr/bin/env bash
set -euo pipefail

archive="${1:?Usage: linux-package-smoke.sh <package.tar.gz>}"
test_dir="$(mktemp -d /tmp/aily-openai-linux-test.XXXXXX)"
cleanup() {
  case "$test_dir" in
    /tmp/aily-openai-linux-test.*) rm -rf -- "$test_dir" ;;
    *) return 1 ;;
  esac
}
trap cleanup EXIT

tar -xzf "$archive" -C "$test_dir"
cd "$test_dir"

test "$(./runtime/node --version)" = "v24.19.0"
./runtime/node app/cli.mjs --help | grep -q '"tool":"aily-openai"'
test "$(stat -c '%a' runtime/node)" = "755"
for launcher in connect-feishu.sh connect-lele.sh start-gateway.sh reconnect-account.sh stop-gateway.sh; do
  test "$(stat -c '%a' "$launcher")" = "755"
done
test "$(stat -c '%a' app/installation.json)" = "644"

export AILY_DATA_DIR="$test_dir/state"
./runtime/node --input-type=module -e 'const s = await import("./app/state.mjs"); s.saveAuth({ headers: { cookie: "probe" }, apiKey: "probe-key" }); const auth = s.loadAuth(); if (auth.apiKey !== "probe-key" || !s.authPath.endsWith("credentials.json")) process.exit(1);'
test "$(stat -c '%a' "$test_dir/state/credentials.json")" = "600"

set +e
feishu_output="$(./connect-feishu.sh 2>&1)"
feishu_code=$?
lele_output="$(./connect-lele.sh 2>&1)"
lele_code=$?
set -e
test "$feishu_code" -eq 1
test "$lele_code" -eq 1
grep -q 'browser_missing' <<<"$feishu_output"
grep -q 'browser_missing' <<<"$lele_output"

printf '%s\n' 'LINUX_PACKAGE_OK'
