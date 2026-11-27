"""用仓库自带的原创提示音，按时间轴混出一条音轨（48kHz 立体声）。

音效与画面事件对齐：进入房间、新消息、提及、回复、成员上线。
另外合成一层很轻的环境底噪（低频正弦和弦），让片子不是纯静音。
"""
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
out = Path(__file__).resolve().parents[1] / 'build' / 'audio.wav'
out.parent.mkdir(exist_ok=True)
DUR = 50.3

# (文件, 开始时间 s, 音量 dB)
CUES = [
    ('se_nightcord_enter.mp3', 9.55, -4),   # 进入房间
    ('se_notify_online.mp3', 10.3, -12),    # 成员上线
    ('se_notify_message.mp3', 15.62, -6),   # 发出消息后收到回传
    ('se_notify_reply.mp3', 17.95, -6),     # 被回复
    ('se_notify_mention.mp3', 18.35, -5),   # 被提及
    ('se_notify_online.mp3', 28.45, -9),    # 语音成员出现
    ('se_notify_message.mp3', 43.5, -14),
]

inputs, filters, labels = [], [], []
for i, (name, at, db) in enumerate(CUES):
    inputs += ['-i', str(root / name)]
    ms = int(at * 1000)
    filters.append(f'[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={db}dB,adelay={ms}|{ms}[c{i}]')
    labels.append(f'[c{i}]')

n = len(CUES)
# 环境底噪：A2 + E3 + A3 的正弦，随片头淡入、片尾淡出
pad = ('aevalsrc=0.5*sin(2*PI*110*t)+0.35*sin(2*PI*164.81*t)+0.25*sin(2*PI*220*t)|'
       f'0.5*sin(2*PI*110*t)+0.35*sin(2*PI*164.81*t)+0.25*sin(2*PI*220*t):s=48000:d={DUR}')
filters.append(
    f'{pad},lowpass=f=420,volume=-34dB,afade=t=in:st=0:d=3,afade=t=out:st={DUR - 3.5}:d=3.4[pad]'
)
filters.append(
    ''.join(labels) + '[pad]' + f'amix=inputs={n + 1}:normalize=0:duration=longest,'
    f'volume=9dB,alimiter=limit=0.89,atrim=0:{DUR},afade=t=out:st={DUR - 1.2}:d=1.1[mix]'
)

cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *inputs,
       '-filter_complex', ';'.join(filters), '-map', '[mix]', '-ar', '48000', '-ac', '2', str(out)]
res = subprocess.run(cmd, capture_output=True, text=True)
if res.returncode:
    print(res.stderr)
    sys.exit(res.returncode)
print('ok', out, out.stat().st_size // 1024, 'KB')
