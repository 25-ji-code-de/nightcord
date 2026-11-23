"""Build Nightcord's original short melodic notification cues (no sample inputs).

Usage: python scripts/prepare-notification-sounds.py [--output-dir PATH]
Uses Python's standard library and ffmpeg. See docs/NOTIFICATION_SOUNDS.md.
SPDX-License-Identifier: AGPL-3.0-only
"""
import argparse
import array
import hashlib
import json
import math
import pathlib
import subprocess
import tempfile
import wave

RATE = 48000
# MIDI note, onset, decay length, relative amplitude. Shared D-major pentatonic
# palette, distinct rhythms; message/mention end high, offline resolves down.
SCORES = {
    "message": [(81, 0, .25, .85), (86, .13, .38, 1)],
    "reply": [(86, 0, .25, .85), (81, .15, .24, .65), (83, .29, .38, 1)],
    "mention": [(81, 0, .27, .85), (86, .14, .29, .9), (90, .31, .44, 1)],
    "online": [(74, 0, .28, .75), (81, .17, .38, 1)],
    "offline": [(81, 0, .27, .75), (74, .19, .38, .9)],
}
LEVELS = {"message": -20.5, "reply": -21, "mention": -19.5, "online": -23, "offline": -24}


def render(kind):
    score = SCORES[kind]
    duration = max(start + length for _, start, length, _ in score) + .11
    samples = [0.0] * math.ceil(duration * RATE)
    for midi, start, length, amplitude in score:
        frequency = 440 * 2 ** ((midi - 69) / 12)
        offset = round(start * RATE)
        for i in range(round(length * RATE)):
            t = i / RATE
            attack = min(1, t / .008)
            release = min(1, max(0, (length - t) / .08))
            envelope = attack * release * math.exp(-t * 5 / length)
            phase = 2 * math.pi * frequency * t
            # Rounded mallet body + softly decaying glass overtone, no hard click.
            tone = (math.sin(phase + .55 * math.exp(-t / .045) * math.sin(2 * phase))
                    + .22 * math.exp(-t / .12) * math.sin(2 * phase)
                    + .10 * math.exp(-t / .065) * math.sin(3.01 * phase))
            samples[offset + i] += amplitude * envelope * tone
    dry = samples[:]
    for delay, gain in [(.037, .10), (.069, .065), (.103, .035)]:
        shift = round(delay * RATE)
        for i in range(shift, len(samples)):
            samples[i] += dry[i - shift] * gain
    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    peak = max(abs(s) for s in samples)
    gain = min(10 ** (LEVELS[kind] / 20) / rms, 10 ** (-5 / 20) / peak)
    return samples, gain


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {"revision": "3", "source": "original additive/FM synthesis; no third-party samples", "sounds": {}}
    with tempfile.TemporaryDirectory(prefix='nightcord-chimes-') as temp:
        for kind in SCORES:
            samples, gain = render(kind)
            pcm = array.array('h', (round(max(-1, min(1, sample * gain)) * 32767) for sample in samples))
            import sys
            if sys.byteorder != 'little': pcm.byteswap()
            source = pathlib.Path(temp) / f'{kind}.wav'
            with wave.open(str(source), 'wb') as audio:
                audio.setparams((1, 2, RATE, len(pcm), 'NONE', 'not compressed'))
                audio.writeframes(pcm.tobytes())
            item = {"duration": round(len(samples) / RATE, 3), "notes": SCORES[kind], "files": {}}
            for extension, options in [('opus', ['-c:a', 'libopus', '-b:a', '64k']), ('mp3', ['-c:a', 'libmp3lame', '-b:a', '128k'])]:
                target = args.output_dir / f'se_notify_{kind}.{extension}'
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-map_metadata', '-1', *options, str(target)], check=True)
                item['files'][extension] = {"bytes": target.stat().st_size, "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
            report['sounds'][kind] = item
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
