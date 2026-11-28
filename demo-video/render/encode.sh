#!/usr/bin/env bash
# 用法：bash render/encode.sh [preview|final] [输出.mp4]
# 默认编码 DEMO_PROFILE 对应版本（未设置时为 preview）。不添加 noise/颗粒。
# 编码参数与完整性检查统一在 encode.mjs；兼容旧的首个参数为输出路径的用法。
set -euo pipefail
cd "$(dirname "$0")/.."
exec node render/encode.mjs "$@"
