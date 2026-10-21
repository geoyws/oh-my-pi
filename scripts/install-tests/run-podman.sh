#!/bin/sh
set -e

cd "$(dirname "$0")/../.."
bun scripts/e2e-host-guard.ts e2e install-tests/run-podman.sh || exit $?
# --remote=false pins the local engine: CONTAINER_HOST, CONTAINER_CONNECTION or a
# containers.conf remote connection cannot move these builds to another machine.

echo "=== Testing binary build ==="
podman --remote=false build -f scripts/install-tests/binary.dockerfile -t omp-test-binary .

echo ""
echo "=== Testing source install ==="
podman --remote=false build -f scripts/install-tests/source.dockerfile -t omp-test-source .

echo ""
echo "=== Testing tarball install (publish simulation) ==="
podman --remote=false build -f scripts/install-tests/tarball.dockerfile -t omp-test-tarball .

echo ""
echo "=== All tests passed ==="
