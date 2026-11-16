"""Audio + encoding half of the tutorial pipeline.

    python media.py tts       <narration.json> <workdir>
    python media.py assemble  <narration.json> <workdir> <out.mp4>

``tts`` voices every step with a neural voice (edge-tts) and writes
``durations.json`` (ms per step) for the recorder to pace itself by, plus the
sentence timings used for captions. ``assemble`` lays each clip at the moment
its step started on screen, mixes it over a quiet generated ambient bed
(ducked under speech), and encodes the screencast frames to H.264.

The music is synthesised here from sine partials rather than taken from a
library, so there is nothing to license.
"""

import asyncio
import hashlib
import json
import math
import os
import subprocess
import sys
import wave

import numpy as np
import imageio_ffmpeg

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
SR = 48000
VOICE = os.environ.get('TUT_VOICE', 'en-US-AndrewNeural')
RATE = os.environ.get('TUT_RATE', '-6%')
PITCH = os.environ.get('TUT_PITCH', '-2Hz')
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.cache', 'tts')


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:4])}...\n{p.stderr[-3000:]}")
    return p


def read_wav(path):
    with wave.open(path, 'rb') as w:
        n, ch, sw = w.getnframes(), w.getnchannels(), w.getsampwidth()
        data = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    return data.reshape(-1, ch).mean(axis=1) if ch > 1 else data


def write_wav(path, stereo):
    pcm = (np.clip(stereo, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


# ---------------------------------------------------------------------------
# Narration
# ---------------------------------------------------------------------------

async def _synth(text, mp3_path):
    import edge_tts
    comm = edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH, boundary='SentenceBoundary')
    sentences = []
    with open(mp3_path, 'wb') as f:
        async for chunk in comm.stream():
            if chunk['type'] == 'audio':
                f.write(chunk['data'])
            elif chunk['type'] in ('SentenceBoundary', 'WordBoundary'):
                sentences.append({'start': chunk['offset'] / 1e7,
                                  'end': (chunk['offset'] + chunk['duration']) / 1e7,
                                  'text': chunk['text']})
    return sentences


def tts_clip(text):
    """Voice *text* once; cached by content so re-records cost nothing."""
    os.makedirs(CACHE, exist_ok=True)
    key = hashlib.sha1(f"{VOICE}|{RATE}|{PITCH}|{text}".encode()).hexdigest()[:20]
    wav, meta = os.path.join(CACHE, key + '.wav'), os.path.join(CACHE, key + '.json')
    if not (os.path.exists(wav) and os.path.exists(meta)):
        mp3 = os.path.join(CACHE, key + '.mp3')
        for attempt in range(4):
            try:
                sentences = asyncio.run(_synth(text, mp3))
                break
            except Exception as e:  # the service occasionally drops a socket
                if attempt == 3:
                    raise
                print(f"  tts retry ({e})")
        run([FFMPEG, '-y', '-loglevel', 'error', '-i', mp3, '-ac', '1', '-ar', str(SR), wav])
        audio = read_wav(wav)
        with open(meta, 'w') as f:
            json.dump({'text': text, 'seconds': len(audio) / SR, 'sentences': sentences}, f)
    with open(meta) as f:
        return wav, json.load(f)


def cmd_tts(narration_path, workdir):
    with open(narration_path, encoding='utf-8') as f:
        narration = json.load(f)
    durations, clips = [], []
    for i, text in enumerate(narration['steps']):
        if not text:
            durations.append(0)
            clips.append(None)
            continue
        wav, meta = tts_clip(text)
        durations.append(int(round(meta['seconds'] * 1000)))
        clips.append({'wav': wav, **meta})
        print(f"  voiced {i + 1}/{len(narration['steps'])}", end='\r')
    os.makedirs(workdir, exist_ok=True)
    with open(os.path.join(workdir, 'durations.json'), 'w') as f:
        json.dump(durations, f)
    with open(os.path.join(workdir, 'clips.json'), 'w') as f:
        json.dump(clips, f)
    print(f"  narration: {sum(durations) / 1000:.1f}s over {len(durations)} steps")


# ---------------------------------------------------------------------------
# Music: a slow, quiet pad with a soft felt-piano arpeggio and a long reverb
# ---------------------------------------------------------------------------

def midi_hz(n):
    return 440.0 * 2 ** ((n - 69) / 12)


PROGRESSIONS = [
    # (root, chord tones as semitones) — gentle, unresolved major-seventh colours
    [(48, [0, 7, 11, 14, 16]), (45, [0, 7, 10, 14, 15]), (41, [0, 7, 11, 14, 16]), (43, [0, 7, 9, 14, 17])],
    [(50, [0, 7, 10, 14, 15]), (46, [0, 7, 11, 14, 16]), (43, [0, 7, 11, 14, 16]), (45, [0, 7, 10, 14, 17])],
    [(45, [0, 7, 10, 14, 15]), (41, [0, 7, 11, 14, 16]), (48, [0, 7, 11, 14, 16]), (43, [0, 7, 9, 14, 17])],
]


def reverb(x, seconds=3.2, mix=0.42, seed=7):
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros_like(x)
    for ch in range(x.shape[1]):
        ir = rng.standard_normal(n) * np.exp(-t * 6.9 / seconds)
        # darken the tail
        ir = np.convolve(ir, np.ones(24) / 24, mode='same')
        ir /= np.sqrt((ir ** 2).sum())
        block = 1 << 18
        size = 1 << int(math.ceil(math.log2(block + n)))
        IR = np.fft.rfft(ir, size)
        y = np.zeros(len(x) + n)
        for s in range(0, len(x), block):
            seg = x[s:s + block, ch]
            conv = np.fft.irfft(np.fft.rfft(seg, size) * IR, size)[:len(seg) + n]
            y[s:s + len(conv)] += conv
        out[:, ch] = y[:len(x)]
    return x * (1 - mix) + out * mix * 2.2


def make_music(seconds, seed=0):
    rng = np.random.default_rng(seed)
    total = int((seconds + 4) * SR)
    music = np.zeros((total, 2))
    prog = PROGRESSIONS[seed % len(PROGRESSIONS)]
    chord_len = 8.0
    t_chord = np.arange(int((chord_len + 4) * SR)) / SR

    # Pads: each chord swells in over ~3s and overlaps the next.
    for k in range(int(seconds / chord_len) + 2):
        root, tones = prog[k % len(prog)]
        start = int(k * chord_len * SR)
        if start >= total:
            break
        env = np.minimum(1, t_chord / 3.0) * np.clip((chord_len + 4 - t_chord) / 4.0, 0, 1)
        env = env ** 1.5
        for semi in tones:
            f = midi_hz(root + semi)
            for side, det in ((0, -0.0018), (1, 0.0018)):
                ff = f * (1 + det)
                tone = (np.sin(2 * np.pi * ff * t_chord)
                        + 0.18 * np.sin(2 * np.pi * 2 * ff * t_chord + 0.7)
                        + 0.05 * np.sin(2 * np.pi * 3 * ff * t_chord + 1.3))
                seg = 0.05 * env * tone
                end = min(total, start + len(seg))
                music[start:end, side] += seg[:end - start]
        # soft bass
        fb = midi_hz(root - 12)
        bass = 0.07 * env * np.sin(2 * np.pi * fb * t_chord)
        end = min(total, start + len(bass))
        music[start:end, :] += bass[:end - start, None]

    # Felt-piano arpeggio: sparse, quiet, panned a little.
    t_note = np.arange(int(3.5 * SR)) / SR
    pattern = [0, 2, 3, 4, 3, 2]
    beat = 0.75
    nbeats = int(seconds / beat)
    for b in range(nbeats):
        if rng.random() < 0.28:   # leave space
            continue
        k = int(b * beat / chord_len)
        root, tones = prog[k % len(prog)]
        semi = tones[pattern[b % len(pattern)] % len(tones)]
        f = midi_hz(root + 24 + semi)
        env = np.exp(-t_note * 2.4) * np.minimum(1, t_note / 0.008)
        note = env * (np.sin(2 * np.pi * f * t_note) + 0.25 * np.sin(4 * np.pi * f * t_note) * np.exp(-t_note * 3))
        vel = 0.030 + 0.012 * rng.random()
        pan = 0.5 + 0.25 * (rng.random() - 0.5)
        start = int(b * beat * SR)
        end = min(total, start + len(note))
        music[start:end, 0] += vel * (1 - pan) * 2 * note[:end - start]
        music[start:end, 1] += vel * pan * 2 * note[:end - start]

    music = reverb(music, seed=seed + 3)
    music = music[:int(seconds * SR)]
    # fade in / out
    fi, fo = int(2.5 * SR), int(3.5 * SR)
    music[:fi] *= np.linspace(0, 1, fi)[:, None]
    music[-fo:] *= np.linspace(1, 0, fo)[:, None]
    return music


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def speech_envelope(voice, attack_release=0.45):
    """0..1 'someone is talking' curve at audio rate, for ducking the music.

    Worked on 10ms frames: a sample-rate convolution with a half-second
    kernel over a five-minute track is hundreds of billions of operations.
    """
    hop = SR // 100
    n = len(voice) // hop
    if n == 0:
        return np.zeros(len(voice))
    frames = voice[:n * hop].reshape(n, hop)
    active = (np.sqrt((frames ** 2).mean(axis=1)) > 0.01).astype(float)
    k = np.hanning(2 * int(attack_release * 100) + 1)
    k /= k.sum()
    env = np.clip(np.convolve(active, k, mode='same') * 1.6, 0, 1)
    return np.interp(np.arange(len(voice)), np.arange(n) * hop + hop / 2, env)


def caption_cues(clips, steps):
    cues = []
    for step in steps:
        clip = clips[step['i']] if step['i'] < len(clips) else None
        if not clip:
            continue
        base = step['start']
        sentences = clip.get('sentences') or [{'start': 0, 'end': clip['seconds'], 'text': clip['text']}]
        for s in sentences:
            text = s['text'].strip()
            start, end = base + s['start'], base + max(s['end'], s['start'] + 0.8)
            # Long sentences become two cues, split at a word near the middle.
            if len(text) > 95:
                words = text.split()
                half, count = len(text) / 2, 0
                for idx, w in enumerate(words):
                    count += len(w) + 1
                    if count >= half:
                        break
                a, b = ' '.join(words[:idx + 1]), ' '.join(words[idx + 1:])
                mid = start + (end - start) * (len(a) / max(1, len(text)))
                cues.append((start, mid, a))
                cues.append((mid, end, b))
            else:
                cues.append((start, end, text))
    return cues


def ts(sec):
    sec = max(0, sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"


def cmd_assemble(narration_path, workdir, out_mp4):
    workdir, out_mp4 = os.path.abspath(workdir), os.path.abspath(out_mp4)
    with open(narration_path, encoding='utf-8') as f:
        narration = json.load(f)
    with open(os.path.join(workdir, 'timeline.json')) as f:
        tl = json.load(f)
    with open(os.path.join(workdir, 'clips.json')) as f:
        clips = json.load(f)

    length = tl['end']
    n = int(length * SR) + SR
    voice = np.zeros(n)
    for step in tl['steps']:
        clip = clips[step['i']] if step['i'] < len(clips) else None
        if not clip:
            continue
        audio = read_wav(clip['wav'])
        s = int(step['start'] * SR)
        e = min(n, s + len(audio))
        voice[s:e] += audio[:e - s]

    # Voice: gentle normalisation to about -16 LUFS-ish RMS while speaking.
    speaking = np.abs(voice) > 1e-4
    rms = np.sqrt(np.mean(voice[speaking] ** 2)) if speaking.any() else 1
    voice *= min(10 ** (-17 / 20) / max(rms, 1e-6), 0.92 / max(1e-6, np.abs(voice).max()))

    seed = int(hashlib.sha1(narration['id'].encode()).hexdigest(), 16) % 97
    music = make_music(length + 1, seed=seed)[:n]
    if len(music) < n:
        music = np.vstack([music, np.zeros((n - len(music), 2))])
    m_rms = np.sqrt(np.mean(music ** 2)) or 1
    music *= 10 ** (-31 / 20) / m_rms          # light bed
    # Duck a further ~6 dB under speech, with soft ramps.
    duck = 1 - 0.5 * speech_envelope(voice)
    music *= duck[:, None]

    mix = music + voice[:, None]
    peak = np.abs(mix).max()
    if peak > 0.97:
        mix *= 0.97 / peak
    audio_path = os.path.join(workdir, 'mix.wav')
    write_wav(audio_path, mix[:int(length * SR)])

    # Video: hold each screencast frame until the next one arrives.
    frames = tl['frames']
    lst = os.path.join(workdir, 'frames.txt')
    with open(lst, 'w') as f:
        for k, fr in enumerate(frames):
            t = max(0.0, fr['t'])
            nxt = frames[k + 1]['t'] if k + 1 < len(frames) else length
            dur = max(0.001, nxt - t)
            if k == 0 and t > 0:
                dur += t
            f.write(f"file '{os.path.join(workdir, 'frames', fr['name'])}'\nduration {dur:.4f}\n")
        f.write(f"file '{os.path.join(workdir, 'frames', frames[-1]['name'])}'\n")

    os.makedirs(os.path.dirname(os.path.abspath(out_mp4)), exist_ok=True)
    run([FFMPEG, '-y', '-loglevel', 'error',
         '-f', 'concat', '-safe', '0', '-i', lst,
         '-i', audio_path,
         '-vf', 'fps=30,scale=1920:1200:flags=lanczos,format=yuv420p',
         '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-profile:v', 'high',
         '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
         '-shortest', '-movflags', '+faststart', out_mp4])

    base = os.path.splitext(out_mp4)[0]
    # Poster from just after the title card clears.
    run([FFMPEG, '-y', '-loglevel', 'error', '-ss', str(min(4.5, length / 2)), '-i', out_mp4,
         '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', base + '.jpg'])

    with open(base + '.vtt', 'w', encoding='utf-8') as f:
        f.write('WEBVTT\n\n')
        for k, (a, b, text) in enumerate(caption_cues(clips, tl['steps']), 1):
            f.write(f"{k}\n{ts(a)} --> {ts(b)}\n{text}\n\n")

    size = os.path.getsize(out_mp4) / 1e6
    print(f"  wrote {out_mp4} ({length:.0f}s, {size:.1f} MB)")


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'tts':
        cmd_tts(sys.argv[2], sys.argv[3])
    elif cmd == 'assemble':
        cmd_assemble(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit(__doc__)
