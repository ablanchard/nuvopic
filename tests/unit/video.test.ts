import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { isSupportedMedia, isVideo } from '../../src/media.js';
import { extractVideoFile } from '../../src/extractors/video.js';

const exec = promisify(execFile);
let directory: string;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('video support', () => {
  it('recognizes case-insensitive media extensions without accepting arbitrary files', () => {
    expect(isVideo('folder/CLIP.MOV')).toBe(true);
    expect(isSupportedMedia('clip.webm')).toBe(true);
    expect(isSupportedMedia('photo.jpg')).toBe(true);
    expect(isVideo('photo.jpg')).toBe(false);
    expect(isSupportedMedia('clip.mp4.exe')).toBe(false);
  });

  it('extracts a real video poster, dimensions, duration and creation time', async () => {
    directory = await mkdtemp(join(tmpdir(), 'nuvopic-video-test-'));
    const input = join(directory, 'clip.mp4');
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=1',
      '-c:v', 'mpeg4', '-metadata', 'creation_time=2024-06-15T14:30:00Z', input]);
    const result = await extractVideoFile(input, join(directory, 'poster.jpg'));
    expect(result.width).toBe(160);
    expect(result.height).toBe(90);
    expect(result.durationSeconds).toBeCloseTo(1);
    expect(result.takenAt?.toISOString()).toBe('2024-06-15T14:30:00.000Z');
    expect((await sharp(result.poster).metadata()).format).toBe('jpeg');
  });

  it('rejects corrupt videos instead of producing a successful checkpoint', async () => {
    directory = await mkdtemp(join(tmpdir(), 'nuvopic-video-test-'));
    const input = join(directory, 'bad.mp4');
    await writeFile(input, 'not a video');
    await expect(extractVideoFile(input, join(directory, 'poster.jpg'))).rejects.toThrow();
  });
});
