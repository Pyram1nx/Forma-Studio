#!/bin/sh
# Adds extra background space to the left edge of public/images/os-icons.png.
# Usage: scripts/pad-os-icons.sh [pixels]   (default 60)
set -e
F=public/images/os-icons.png
N=${1:-60}
W=$(sips -g pixelWidth "$F" | awk '/pixelWidth/{print $2}')
H=$(sips -g pixelHeight "$F" | awk '/pixelHeight/{print $2}')
# Pad 2N wider (N each side), then crop N off the right edge.
sips -p "$H" $((W + 2*N)) --padColor FDFDFE "$F" >/dev/null
sips --cropToHeightWidth "$H" $((W + N)) --cropOffset 0 0 "$F" >/dev/null
