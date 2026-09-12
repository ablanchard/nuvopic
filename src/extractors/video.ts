import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getObject } from '../s3/client.js';

const exec = promisify(execFile);

/** Work from disk so large videos are never buffered in Node's heap. */
export async function extractVideo(bucket: string, key: string) {
  const directory = await mkdtemp(join(tmpdir(), 'nuvopic-video-'));
  try {
    const input = join(directory, 'source');
    const response = await getObject(bucket, key);
    if (!response.Body) throw new Error('Empty video response');
    await pipeline(response.Body as AsyncIterable<Uint8Array>, createWriteStream(input));
    return await extractVideoFile(input, join(directory, 'poster.jpg'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function extractVideoFile(input: string, posterPath: string) {
  const options = { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 };
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi', '-select_streams', 'V:0',
    '-show_streams', '-show_format', '-of', 'json', input,
  ], options);
  const probe = JSON.parse(stdout);
  const stream = probe.streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error('No video stream found');
  const duration = Number(probe.format?.duration ?? stream.duration);
  const durationSeconds = Number.isFinite(duration) && duration >= 0 ? duration : null;
  const rawDate = stream.tags?.creation_time ?? probe.format?.tags?.creation_time;
  const date = rawDate ? new Date(rawDate) : null;
  const rotation = Number(stream.side_data_list?.find((side: { rotation?: number }) => side.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
  const rotated = Math.abs(rotation % 180) === 90;
  await exec('ffmpeg', [
    '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi', '-i', input,
    '-map', '0:V:0', '-frames:v', '1', '-threads', '1',
    '-vf', 'scale=1024:1024:force_original_aspect_ratio=decrease', posterPath,
  ], options);
  return {
    width: rotated ? stream.height as number : stream.width as number,
    height: rotated ? stream.width as number : stream.height as number,
    durationSeconds,
    takenAt: date && Number.isFinite(date.getTime()) ? date : null,
    poster: await readFile(posterPath),
  };
}
