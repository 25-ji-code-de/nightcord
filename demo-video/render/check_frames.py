"""兼容旧检查命令；由 Node 检查指定版本的 PNG 帧（默认 preview）。"""
from pathlib import Path
import subprocess
import sys

raise SystemExit(subprocess.call([
    'node', str(Path(__file__).resolve().with_suffix('.mjs')), *sys.argv[1:]
]))
