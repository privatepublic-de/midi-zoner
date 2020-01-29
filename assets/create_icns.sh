
    file="${1}"
    iconset="$(mktemp -d)"
    output_icon="$(mktemp).icns"

    for size in {16,32,64,128,256,512}; do
    sips --resampleHeightWidth "${size}" "${size}" "${file}" --out "${iconset}/icon_${size}x${size}.png" &> /dev/null
    sips --resampleHeightWidth "$((size * 2))" "$((size * 2))" "${file}" --out "${iconset}/icon_${size}x${size}@2x.png" &> /dev/null
    done

    mv "${iconset}" "${iconset}.iconset"
    iconutil --convert icns "${iconset}.iconset" --output "${output_icon}"

    mv "${output_icon}" ./zoner.icns


