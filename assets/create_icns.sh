#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
file="${1:-"${SCRIPT_DIR}/zoner.png"}"
iconset="$(mktemp -d)"
output_icon="$(mktemp).icns"

for size in 16 32 64 128 256 512; do
    sips --resampleHeightWidth "${size}" "${size}" "${file}" --out "${iconset}/icon_${size}x${size}.png"
    sips --resampleHeightWidth "$((size * 2))" "$((size * 2))" "${file}" --out "${iconset}/icon_${size}x${size}@2x.png"
done

mv "${iconset}" "${iconset}.iconset"
iconutil --convert icns "${iconset}.iconset" --output "${output_icon}"

mv "${output_icon}" "${SCRIPT_DIR}/zoner.icns"
echo "Created ${SCRIPT_DIR}/zoner.icns"
