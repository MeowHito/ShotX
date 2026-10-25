import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaConfig } from '@shotx/shared';
import { isTransientMediaFailure, MediaDecodeError } from './errors';
import { parseUtcOffset } from './exif';

export interface VideoTools {
  ffmpegPath: string;
  ffprobePath: string;
  /** x264 preset for preview.mp4. */
  x264Preset: string;
  audioBitrateKbps: number;
}

export interface VideoProbe {
  /** Display size: after the rotation in the container's display matrix. */
  width: number;
  height: number;
  durationSeconds: number | null;
  takenAt: Date | null;
  hasAudio: boolean;
}

const STDERR_LIMIT = 4096;

class ToolFailure extends Error {
  constructor(
    readonly tool: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`${tool} exited with ${exitCode ?? 'a signal'}: ${stderr.slice(-500)}`);
    this.name = 'ToolFailure';
  }
}

/** Runs a tool; resolves with stdout. Never goes through a shell. */
function run(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-STDERR_LIMIT);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new ToolFailure(command, code, err));
    });
  });
}

function classify(error: unknown, what: string): Error {
  if (error instanceof ToolFailure) {
    if (isTransientMediaFailure(error.stderr)) return error;
    return new MediaDecodeError(`${what}: ${error.stderr.slice(-300)}`);
  }
  // ENOENT (ffmpeg missing), AbortError: not the file's fault.
  return error instanceof Error ? error : new Error(String(error));
}

interface FfprobeOutput {
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    tags?: Record<string, string>;
    side_data_list?: Array<{ rotation?: number | string }>;
  }>;
  format?: { duration?: string; tags?: Record<string, string> };
}

function rotationOf(stream: NonNullable<FfprobeOutput['streams']>[number]): number {
  for (const side of stream.side_data_list ?? []) {
    if (side.rotation !== undefined) return Number(side.rotation) || 0;
  }
  return Number(stream.tags?.rotate ?? 0) || 0;
}

/**
 * Capture time from container tags: Apple's `com.apple.quicktime.creationdate` keeps the local
 * offset (e.g. `2026-10-20T08:30:00+0700`); `creation_time` is UTC. Null when absent or bogus.
 */
export function videoTakenAt(tags: Record<string, string> | undefined): Date | null {
  if (tags === undefined) return null;
  const candidates = [tags['com.apple.quicktime.creationdate'], tags.creation_time];
  for (const raw of candidates) {
    if (raw === undefined) continue;
    // +0700 -> +07:00 so Date can parse it.
    const normalized = raw.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const tz = /([+-]\d{2}:\d{2}|Z)$/.exec(normalized)?.[1];
    if (tz !== undefined && tz !== 'Z' && parseUtcOffset(tz) === null) continue;
    const date = new Date(normalized);
    if (!Number.isNaN(date.getTime()) && date.getUTCFullYear() >= 1990) return date;
  }
  return null;
}

export async function probeVideo(
  path: string,
  tools: VideoTools,
  signal?: AbortSignal,
): Promise<VideoProbe> {
  let output: FfprobeOutput;
  try {
    const json = await run(
      tools.ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
      signal,
    );
    output = JSON.parse(json) as FfprobeOutput;
  } catch (error) {
    if (error instanceof SyntaxError) throw new MediaDecodeError('ffprobe output is not JSON');
    throw classify(error, 'Video could not be probed');
  }
  const video = output.streams?.find((s) => s.codec_type === 'video');
  if (video?.width === undefined || video.height === undefined || video.width <= 0) {
    throw new MediaDecodeError('The file has no video stream');
  }
  const quarterTurns = Math.round(rotationOf(video) / 90);
  const rotated = Math.abs(quarterTurns) % 2 === 1;
  const duration = Number(output.format?.duration);
  return {
    width: rotated ? video.height : video.width,
    height: rotated ? video.width : video.height,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    takenAt: videoTakenAt({ ...video.tags, ...output.format?.tags }),
    hasAudio: output.streams?.some((s) => s.codec_type === 'audio') ?? false,
  };
}

const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

/**
 * Size of preview.mp4: the short edge becomes `targetShortEdge` (720 for "720p", portrait or
 * landscape), never upscaled, both sides even (yuv420p needs it).
 */
export function previewSize(
  width: number,
  height: number,
  targetShortEdge: number,
): { width: number; height: number } {
  const short = Math.min(width, height);
  const scale = Math.min(1, targetShortEdge / short);
  return { width: even(width * scale), height: even(height * scale) };
}

/** Writes a full-size PNG frame of the video (autorotated) to `outDir`. */
export async function extractPosterFrame(
  path: string,
  probe: VideoProbe,
  outDir: string,
  tools: VideoTools,
  signal?: AbortSignal,
): Promise<string> {
  const out = join(outDir, 'poster-frame.png');
  // A second in skips black lead-in frames; short clips use their middle.
  const at = probe.durationSeconds === null ? 0 : Math.min(1, probe.durationSeconds / 2);
  const attempt = (seconds: number) =>
    run(
      tools.ffmpegPath,
      [
        '-v',
        'error',
        '-y',
        '-ss',
        seconds.toFixed(3),
        '-i',
        path,
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-an',
        '-sn',
        '-dn',
        '-map_metadata',
        '-1',
        '-f',
        'image2',
        '-c:v',
        'png',
        out,
      ],
      signal,
    );
  try {
    await attempt(at);
    if ((await stat(out).catch(() => null))?.size ?? 0) return out;
    if (at > 0) {
      await attempt(0);
      if ((await stat(out).catch(() => null))?.size ?? 0) return out;
    }
  } catch (error) {
    throw classify(error, 'Poster frame could not be extracted');
  }
  throw new MediaDecodeError('The video has no decodable frame');
}

/**
 * Transcodes preview.mp4: H.264 (yuv420p, high profile) at {@link previewSize}, AAC stereo when
 * the source has audio, `+faststart` so playback starts before the download ends, and no
 * metadata or chapters (that drops GPS and device tags).
 */
export async function transcodePreview(
  path: string,
  probe: VideoProbe,
  outDir: string,
  config: MediaConfig,
  tools: VideoTools,
  signal?: AbortSignal,
): Promise<string> {
  const out = join(outDir, 'preview.mp4');
  const size = previewSize(probe.width, probe.height, config.videoPreview.height);
  const audio = probe.hasAudio
    ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', `${tools.audioBitrateKbps}k`, '-ac', '2']
    : ['-an'];
  try {
    await run(
      tools.ffmpegPath,
      [
        '-v',
        'error',
        '-y',
        '-i',
        path,
        '-map',
        '0:v:0',
        ...audio,
        '-vf',
        `scale=${size.width}:${size.height},format=yuv420p`,
        '-c:v',
        'libx264',
        '-preset',
        tools.x264Preset,
        '-crf',
        String(config.videoPreview.crf),
        '-profile:v',
        'high',
        '-movflags',
        '+faststart',
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        '-sn',
        '-dn',
        '-max_muxing_queue_size',
        '1024',
        out,
      ],
      signal,
    );
  } catch (error) {
    throw classify(error, 'Video preview could not be transcoded');
  }
  return out;
}
