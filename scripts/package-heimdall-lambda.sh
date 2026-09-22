#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/build/lambda"
PACKAGE_FILE="${ROOT_DIR}/build/heimdall-lambda.zip"

rm -rf "${BUILD_DIR}" "${PACKAGE_FILE}"
mkdir -p "${BUILD_DIR}/public"

pushd "${ROOT_DIR}" >/dev/null
npm run build
npx esbuild apps/api/src/lambda.ts \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=cjs \
  --outfile="${BUILD_DIR}/lambda.js"
popd >/dev/null

cp -R "${ROOT_DIR}/apps/web/dist/." "${BUILD_DIR}/public/"
cat > "${BUILD_DIR}/package.json" <<'EOF'
{
  "type": "commonjs"
}
EOF

pushd "${BUILD_DIR}" >/dev/null
zip -qr "${PACKAGE_FILE}" .
popd >/dev/null

echo "Created ${PACKAGE_FILE}"
