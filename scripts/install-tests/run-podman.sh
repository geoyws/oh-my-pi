#!/bin/sh
set -e

cd "$(dirname "$0")/../.."
bun scripts/e2e-host-guard.ts e2e install-tests/run-podman.sh || exit $?

echo "=== Testing binary build ==="
podman build -f scripts/install-tests/binary.dockerfile -t omp-test-binary .

echo ""
echo "=== Testing source install ==="
podman build -f scripts/install-tests/source.dockerfile -t omp-test-source .

echo ""
echo "=== Testing tarball install (publish simulation) ==="
podman build -f scripts/install-tests/tarball.dockerfile -t omp-test-tarball .

echo ""
echo "=== All tests passed ==="
