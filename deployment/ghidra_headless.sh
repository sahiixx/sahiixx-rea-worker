#!/bin/bash
# Deep RE — requires local Ghidra + real binary. Edge is triage-only.
set -e
if [ -z "$1" ]; then
  echo "Usage: GHIDRA_HOME=/path/to/ghidra ./deployment/ghidra_headless.sh /path/to/binary"
  exit 1
fi
if [ -z "$GHIDRA_HOME" ]; then
  echo "Set GHIDRA_HOME"
  exit 1
fi
BINARY="$1"
PROJECT_DIR="/tmp/ghidra_rea"
PROJECT_NAME="rea_analysis"
mkdir -p "$PROJECT_DIR"
"$GHIDRA_HOME/support/analyzeHeadless" "$PROJECT_DIR" "$PROJECT_NAME" -import "$BINARY" -overwrite
"$GHIDRA_HOME/support/analyzeHeadless" "$PROJECT_DIR" "$PROJECT_NAME" -process -overwrite
echo "Search Defined Strings for clusterProperties / gridSize"
echo "Export decompile -> swarm/revenue path"
