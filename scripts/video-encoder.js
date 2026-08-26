/**
 * Production-grade multi-resolution HLS video encoder
 * ---------------------------------------------------
 * - Creates 240p / 360p / 720p / 1080p (only those ≤ source height)
 * - Outputs HLS segments + master playlist
 * - Leaves the original video.mp4 untouched
 * - Safe to call from upload pipeline (auto) or manually by videoId
 *
 * Directory layout after encoding:
 *   object-storage/videos/{videoId}/
 *     ├── video.mp4          (original – untouched)
 *     ├── thumbnail.jpg
 *     ├── master.m3u8        (adaptive bitrate master)
 *     ├── 240p/
 *     │   ├── index.m3u8
 *     │   └── seg_000.ts …
 *     ├── 360p/
 *     │   └── …
 *     ├── 720p/
 *     └── 1080p/
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration – tweak for your hardware / quality targets
// ---------------------------------------------------------------------------
const CONFIG = {
  // Absolute base path of your object storage videos folder
  VIDEOS_ROOT: process.env.VIDEOS_ROOT ||
    '/home/hridoy/Secret_Project/server/object-storage/videos',

  // Source filename inside each video folder
  SOURCE_FILENAME: 'video.mp4',

  // HLS segment length in seconds
  SEGMENT_DURATION: 4,

  // Encoding preset: ultrafast | superfast | veryfast | faster | fast | medium | slow
  // "faster" is a good production balance; use "medium" for higher quality
  PRESET: process.env.FFMPEG_PRESET || 'faster',

  // Number of ffmpeg threads (leave headroom for the Node process)
  THREADS: Math.max(1, Math.min(4, require('os').cpus().length - 1)),

  // Variant ladder – ordered low → high
  // height, video bitrate (kbps), audio bitrate (kbps), maxrate, bufsize
  VARIANTS: [
    { name: '240p',  height: 240,  vBitrate: 400,  aBitrate: 64,  maxrate: 450,  bufsize: 800  },
    { name: '360p',  height: 360,  vBitrate: 800,  aBitrate: 96,  maxrate: 900,  bufsize: 1600 },
    { name: '720p',  height: 720,  vBitrate: 2500, aBitrate: 128, maxrate: 2800, bufsize: 5000 },
    { name: '1080p', height: 1080, vBitrate: 5000, aBitrate: 192, maxrate: 5500, bufsize: 10000 },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Probe source video with ffprobe (JSON)
 */
async function probeVideo(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    filePath,
  ], { maxBuffer: 10 * 1024 * 1024 });

  const data = JSON.parse(stdout);
  const videoStream = data.streams.find(s => s.codec_type === 'video');
  const audioStream = data.streams.find(s => s.codec_type === 'audio');

  if (!videoStream) {
    throw new Error(`No video stream found in ${filePath}`);
  }

  return {
    width: videoStream.width,
    height: videoStream.height,
    duration: parseFloat(data.format.duration) || 0,
    hasAudio: Boolean(audioStream),
    codec: videoStream.codec_name,
    bitrate: parseInt(data.format.bit_rate, 10) || 0,
  };/**
 * Production-grade multi-resolution HLS video encoder
 * ---------------------------------------------------
 * - Creates 240p / 360p / 720p / 1080p (only those ≤ source height)
 * - Outputs HLS segments + master playlist
 * - Leaves the original video.mp4 untouched
 * - Safe to call from upload pipeline (auto) or manually by videoId
 *
 * Directory layout after encoding:
 *   object-storage/videos/{videoId}/
 *     ├── video.mp4          (original – untouched)
 *     ├── thumbnail.jpg
 *     ├── master.m3u8        (adaptive bitrate master)
 *     ├── 240p/
 *     │   ├── index.m3u8
 *     │   └── seg_000.ts …
 *     ├── 360p/
 *     │   └── …
 *     ├── 720p/
 *     └── 1080p/
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration – tweak for your hardware / quality targets
// ---------------------------------------------------------------------------
const CONFIG = {
  // Absolute base path of your object storage videos folder
  VIDEOS_ROOT: process.env.VIDEOS_ROOT ||
    '/home/hridoy/Secret_Project/server/object-storage/videos',

  // Source filename inside each video folder
  SOURCE_FILENAME: 'video.mp4',

  // HLS segment length in seconds
  SEGMENT_DURATION: 4,

  // Encoding preset: ultrafast | superfast | veryfast | faster | fast | medium | slow
  // "faster" is a good production balance; use "medium" for higher quality
  PRESET: process.env.FFMPEG_PRESET || 'faster',

  // Number of ffmpeg threads (leave headroom for the Node process)
  THREADS: Math.max(1, Math.min(4, require('os').cpus().length - 1)),

  // Variant ladder – ordered low → high
  // height, video bitrate (kbps), audio bitrate (kbps), maxrate, bufsize
  VARIANTS: [
    { name: '240p',  height: 240,  vBitrate: 400,  aBitrate: 64,  maxrate: 450,  bufsize: 800  },
    { name: '360p',  height: 360,  vBitrate: 800,  aBitrate: 96,  maxrate: 900,  bufsize: 1600 },
    { name: '720p',  height: 720,  vBitrate: 2500, aBitrate: 128, maxrate: 2800, bufsize: 5000 },
    { name: '1080p', height: 1080, vBitrate: 5000, aBitrate: 192, maxrate: 5500, bufsize: 10000 },
  ],
};

}
}

/**
 * Select only variants that make sense for the source height
 * (never upscale)
 */
function selectVariants(sourceHeight) {
  return CONFIG.VARIANTS.filter(v => v.height <= sourceHeight);
}

/**
 * Build ffmpeg args for a single resolution variant
 */
function buildVariantArgs(sourcePath, outDir, variant, hasAudio) {
  const playlist = path.join(outDir, 'index.m3u8');
  // fMP4 segments: timeline starts at 0 (mpegts often starts ~1.4s and breaks seek-to-0)
  const segmentPattern = path.join(outDir, 'seg_%03d.m4s');
  const initFile = path.join(outDir, 'init.mp4');

  const scaleFilter = `scale=-2:${variant.height}:flags=lanczos`;
  const gop = CONFIG.SEGMENT_DURATION * 30;

  const args = [
    '-hide_banner',
    '-y',
    '-fflags', '+genpts',
    '-i', sourcePath,
    '-vf', scaleFilter,
    '-c:v', 'libx264',
    '-profile:v', 'main',
    '-level', '4.0',
    '-preset', CONFIG.PRESET,
    '-b:v', `${variant.vBitrate}k`,
    '-maxrate', `${variant.maxrate}k`,
    '-bufsize', `${variant.bufsize}k`,
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${CONFIG.SEGMENT_DURATION})`,
    '-pix_fmt', 'yuv420p',
    '-threads', String(CONFIG.THREADS),
    '-movflags', '+faststart',
    '-avoid_negative_ts', 'make_zero',
  ];

  if (hasAudio) {
    args.push(
      '-c:a', 'aac',
      '-b:a', `${variant.aBitrate}k`,
      '-ac', '2',
      '-ar', '48000',
    );
  } else {
    args.push('-an');
  }

  args.push(
    '-f', 'hls',
    '-hls_time', String(CONFIG.SEGMENT_DURATION),
    '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', segmentPattern,
    '-hls_flags', 'independent_segments',
    '-hls_list_size', '0',
    playlist,
  );

  return args;
}

/**
 * Run ffmpeg and stream logs
 */
function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      // Optional: progress logging
      // process.stderr.write(`[${label}] ${chunk}`);
    });

    proc.on('error', (err) => {
      reject(new Error(`ffmpeg spawn failed (${label}): ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Keep last 2 KB of stderr for debugging
        const tail = stderr.slice(-2048);
        reject(new Error(`ffmpeg exited with code ${code} (${label})\n${tail}`));
      }
    });
  });
}

/**
 * Write the master playlist that references all variants
 */
async function writeMasterPlaylist(videoDir, variants, hasAudio) {
  const lines = [/**
 * Production-grade multi-resolution HLS video encoder
 * ---------------------------------------------------
 * - Creates 240p / 360p / 720p / 1080p (only those ≤ source height)
 * - Outputs HLS segments + master playlist
 * - Leaves the original video.mp4 untouched
 * - Safe to call from upload pipeline (auto) or manually by videoId
 *
 * Directory layout after encoding:
 *   object-storage/videos/{videoId}/
 *     ├── video.mp4          (original – untouched)
 *     ├── thumbnail.jpg
 *     ├── master.m3u8        (adaptive bitrate master)
 *     ├── 240p/
 *     │   ├── index.m3u8
 *     │   └── seg_000.ts …
 *     ├── 360p/
 *     │   └── …
 *     ├── 720p/
 *     └── 1080p/
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration – tweak for your hardware / quality targets
// ---------------------------------------------------------------------------
const CONFIG = {
  // Absolute base path of your object storage videos folder
  VIDEOS_ROOT: process.env.VIDEOS_ROOT ||
    '/home/hridoy/Secret_Project/server/object-storage/videos',

  // Source filename inside each video folder
  SOURCE_FILENAME: 'video.mp4',

  // HLS segment length in seconds
  SEGMENT_DURATION: 4,

  // Encoding preset: ultrafast | superfast | veryfast | faster | fast | medium | slow
  // "faster" is a good production balance; use "medium" for higher quality
  PRESET: process.env.FFMPEG_PRESET || 'faster',

  // Number of ffmpeg threads (leave headroom for the Node process)
  THREADS: Math.max(1, Math.min(4, require('os').cpus().length - 1)),

  // Variant ladder – ordered low → high
  // height, video bitrate (kbps), audio bitrate (kbps), maxrate, bufsize
  VARIANTS: [
    { name: '240p',  height: 240,  vBitrate: 400,  aBitrate: 64,  maxrate: 450,  bufsize: 800  },
    { name: '360p',  height: 360,  vBitrate: 800,  aBitrate: 96,  maxrate: 900,  bufsize: 1600 },
    { name: '720p',  height: 720,  vBitrate: 2500, aBitrate: 128, maxrate: 2800, bufsize: 5000 },
    { name: '1080p', height: 1080, vBitrate: 5000, aBitrate: 192, maxrate: 5500, bufsize: 10000 },
  ],
};

}
    '#EXTM3U',
    '#EXT-X-VERSION:3',
  ];

  for (const v of variants) {
    // Approximate bandwidth = video + audio
    const bandwidth = (v.vBitrate + (hasAudio ? v.aBitrate : 0)) * 1000;
    const resolution = `${Math.round(v.height * 16 / 9)}x${v.height}`; // 16:9 assumption is fine for bandwidth signalling

    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution},NAME="${v.name}"`,
      `${v.name}/index.m3u8`,
    );
  }

  const masterPath = path.join(videoDir, 'master.m3u8');
  await fs.writeFile(masterPath, lines.join('\n') + '\n', 'utf8');
  return masterPath;
}

/**
 * Clean previous encode artifacts for a variant (idempotent)
 */
async function cleanVariantDir(dir) {
  if (await pathExists(dir)) {
    const entries = await fs.readdir(dir);
    await Promise.all(
      entries.map(e => fs.rm(path.join(dir, e), { recursive: true, force: true }))
    );
  } else {
    await ensureDir(dir);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode a video by its ID.
 *
 * @param {string} videoId  - Folder name under VIDEOS_ROOT
 * @param {object} [options]
 * @param {boolean} [options.force=false] - Re-encode even if master.m3u8 exists
 * @returns {Promise<object>}  Result summary
 */
async function encodeVideo(videoId, options = {}) {
  if (!videoId || typeof videoId !== 'string') {
    throw new Error('videoId is required and must be a string');
  }

  // Basic sanitisation – prevent path traversal
  if (videoId.includes('..') || videoId.includes('/') || videoId.includes('\\')) {
    throw new Error('Invalid videoId');
  }

  const videoDir = path.join(CONFIG.VIDEOS_ROOT, videoId);
  const sourcePath = path.join(videoDir, CONFIG.SOURCE_FILENAME);

  if (!(await pathExists(sourcePath))) {
    throw new Error(`Source video not found: ${sourcePath}`);
  }

  const masterPath = path.join(videoDir, 'master.m3u8');
  if (!options.force && (await pathExists(masterPath))) {
    return {
      videoId,
      status: 'already_encoded',
      masterPlaylist: masterPath,
    };
  }

  // Probe
  const probe = await probeVideo(sourcePath);
  const variants = selectVariants(probe.height);

  if (variants.length === 0) {
    throw new Error(
      `Source height ${probe.height}px is smaller than the lowest variant (240p). ` +
      `Cannot produce adaptive ladder without upscaling.`
    );
  }

  const results = [];

  // Encode each variant sequentially (safer for memory / CPU on shared hosts)
  // Change to Promise.allSettled if you have powerful hardware and want parallel encodes
  for (const variant of variants) {
    const outDir = path.join(videoDir, variant.name);
    await cleanVariantDir(outDir);

    const args = buildVariantArgs(sourcePath, outDir, variant, probe.hasAudio);
    const start = Date.now();

    try {
      await runFfmpeg(args, variant.name);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      results.push({
        variant: variant.name,
        status: 'ok',
        elapsedSec: Number(elapsed),
        path: outDir,
      });
    } catch (err) {
      results.push({
        variant: variant.name,
        status: 'error',
        error: err.message,
      });
      // Fail the whole job if any variant fails – caller can decide to retry
      throw new Error(`Failed encoding ${variant.name}: ${err.message}`);
    }
  }

  // Write master playlist
  await writeMasterPlaylist(videoDir, variants, probe.hasAudio);

  return {
    videoId,
    status: 'encoded',
    source: {
      width: probe.width,
      height: probe.height,
      duration: probe.duration,
      hasAudio: probe.hasAudio,
    },
    variants: results,
    masterPlaylist: masterPath,
  };
}

/**
 * Convenience wrapper for the upload pipeline.
 * Call this right after the file has been written to disk.
 *
 * @param {string} videoId
 * @returns {Promise<object>}
 */
async function encodeAfterUpload(videoId) {
  return encodeVideo(videoId, { force: false });
}

/**
 * CLI entry point – allows manual encoding:
 *   node video-encoder.js <videoId> [--force]
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Usage:
  node video-encoder.js <videoId> [--force]

Examples:
  node video-encoder.js 792d1e8e-0bd0-4fc6-b3c2-9fd0c133e582
  node video-encoder.js 792d1e8e-0bd0-4fc6-b3c2-9fd0c133e582 --force

Environment:
  VIDEOS_ROOT     Override storage path (default: ${CONFIG.VIDEOS_ROOT})
  FFMPEG_PRESET   Encoding preset (default: ${CONFIG.PRESET})
`);
    process.exit(0);
  }

  const videoId = args[0];
  const force = args.includes('--force');

  console.log(`[encoder] Starting encode for videoId=${videoId} force=${force}`);
  try {
    const result = await encodeVideo(videoId, { force });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('[encoder] FATAL:', err.message);
    process.exit(1);
  }
}

// Export for use from your Express / Nest / Fastify upload handler
module.exports = {
  encodeVideo,
  encodeAfterUpload,
  CONFIG,
};

// Run as CLI when executed directly
if (require.main === module) {
  main();
}
