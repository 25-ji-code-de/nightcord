#!/usr/bin/env bash
# 把 frames/*.jpg 与 build/audio.wav 合成最终视频（仓库根目录的 nightcord-demo.mp4）。
# 1080p / 60fps / H.264 High / AAC，yuv420p + bt709 电视范围 + faststart，
# QuickTime、Safari 与手机都能直接播放。JPEG 帧是全范围，所以要显式转成电视范围，否则会出现偏色。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-../nightcord-demo.mp4}"

ffmpeg -hide_banner -loglevel error -stats -y \
  -framerate 60 -i frames/f%05d.jpg \
  -i build/audio.wav \
  -vf "noise=alls=7:allf=t,scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p" \
  -c:v libopenh264 -profile:v high -b:v 8M -maxrate 12M -bufsize 16M -g 120 \
  -c:a aac -b:a 192k -ar 48000 \
  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -movflags +faststart -shortest \
  "$OUT"
ffprobe -v error -show_entries stream=codec_name,profile,width,height,r_frame_rate,pix_fmt,duration -of default=nw=1 "$OUT"
ls -lh "$OUT"
