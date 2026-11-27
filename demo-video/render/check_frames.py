"""检查 frames/ 里 3017 帧是否连续、非空。"""
from pathlib import Path

d = Path(__file__).resolve().parents[1] / 'frames'
total = round(60 * 50.3)
missing = [i for i in range(total) if not (d / f'f{i:05d}.jpg').exists() or (d / f'f{i:05d}.jpg').stat().st_size < 2000]
print('应有', total, '帧；缺失/过小', len(missing), missing[:20])
sizes = [(d / f'f{i:05d}.jpg').stat().st_size for i in range(total) if i not in missing]
print('最小', min(sizes), '最大', max(sizes))
