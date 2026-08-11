import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CALIBRATION_CASES,
  EXPECTED_MP4BOX_VERSION,
  FIXTURE_ROOT,
  FRONTEND_ROOT,
  KASUMI_CHUNK_SIZE,
  OUTPUT_ROOT,
  REPOSITORY_ROOT,
  buildManifest,
  aggregateLiveParserCosts,
  assertExpectedMp4BoxVersion,
  classifyResourceAcceptance,
  deriveResourcePolicies,
  estimateParserMemory,
  fitPreExpansionResourceModel,
  linearFit,
  median,
  parseChildOutput,
  requireExplicitGc,
  resolveMp4BoxVersion,
  scanMp4ResourceMetadata,
  summarize,
  validateResourceModel,
  writeJsonAtomic,
} from './mp4-resource-calibration-lib.mjs';

const require = createRequire(import.meta.url);
const TIMEOUT_MS = 180_000;
const REPETITIONS = 3;
const CHUNK_BYTES = KASUMI_CHUNK_SIZE;
const BASE_CASE_ID = 'classic-faststart-v30-10k';
const BROWSER_CASE_IDS = [
  'classic-faststart-v30-10k',
  'classic-faststart-v30-50k',
  'fragmented-v30-10k',
];
const SYNTHETIC_CLASSIC_MIB = [
  [1_000, 0.34], [10_000, 2.09], [25_000, 5.28], [50_000, 10.35], [100_000, 20.83], [200_000, 42.07],
];
const SYNTHETIC_UNIFORM_MIB = [
  [1_000, 0.22], [10_000, 2.07], [25_000, 5.29], [50_000, 10.32], [100_000, 20.84], [200_000, 42.09],
];
const SYNTHETIC_FRAGMENTED_MIB = [
  [1_000, 0.23], [10_000, 1.85], [25_000, 4.76], [50_000, 9.16], [100_000, 18.66], [200_000, 37.94],
];

function sanitize(value) {
  return String(value ?? '')
    .replaceAll(REPOSITORY_ROOT, '<repository>')
    .replaceAll(REPOSITORY_ROOT.replaceAll('\\', '/'), '<repository>')
    .replaceAll(OUTPUT_ROOT, '<quality-output>')
    .replaceAll(OUTPUT_ROOT.replaceAll('\\', '/'), '<quality-output>')
    .split(/\r?\n/)
    .slice(-12)
    .join('\n');
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: options.timeout ?? TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: result.status,
    error: result.error ? sanitize(result.error.message) : null,
    stdout: result.stdout ?? '',
    stderr: sanitize(result.stderr ?? ''),
    signal: result.signal ?? null,
  };
}

function findTopLevelBoxes(bytes) {
  const boxes = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const declared = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    let size = declared;
    let headerSize = 8;
    if (declared === 1) {
      if (offset + 16 > bytes.length) throw new Error('Truncated extended MP4 box header.');
      const extendedSize = bytes.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Oversized MP4 box.');
      size = Number(extendedSize);
      headerSize = 16;
    } else if (declared === 0) {
      size = bytes.length - offset;
    }
    if (size < headerSize || offset + size > bytes.length) throw new Error(`Invalid top-level MP4 box: ${type}.`);
    boxes.push({ type, start: offset, size, headerSize });
    offset += size;
  }
  if (offset !== bytes.length) throw new Error('Trailing bytes do not form a complete MP4 box.');
  return boxes;
}

function makeArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function createParser(MP4Box, bootstrap, startProcessing) {
  const file = MP4Box.createFile();
  let resolveReady;
  let rejectReady;
  let info = null;
  let parserError = null;
  const segments = {
    count: 0,
    bytes: 0,
    releasedSampleNumber: 0,
    payloadSamplesBeforeRelease: 0,
    payloadBytesBeforeRelease: 0,
    sampleDataBytesAfterRelease: null,
  };
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  file.onError = (error) => {
    parserError = sanitize(error);
    rejectReady(new Error('MP4Box parser error.'));
  };
  file.onSegment = (trackId, _user, buffer, sampleNumber) => {
    segments.count += 1;
    segments.bytes += buffer?.byteLength ?? 0;
    segments.releasedSampleNumber = Math.max(segments.releasedSampleNumber, Number(sampleNumber) || 0);
    const track = file.getTrackById(trackId);
    const start = track?.lastValidSample ?? 0;
    for (let index = start; index < sampleNumber; index += 1) {
      const sample = track?.samples?.[index];
      if (sample?.data != null) {
        segments.payloadSamplesBeforeRelease += 1;
        segments.payloadBytesBeforeRelease += sample.data.byteLength ?? sample.size ?? 0;
      }
    }
    file.releaseUsedSamples(trackId, sampleNumber);
    segments.sampleDataBytesAfterRelease = file.samplesDataSize;
  };
  file.onReady = (readyInfo) => {
    info = readyInfo;
    for (const track of readyInfo.tracks ?? []) {
      file.setSegmentOptions(track.id, null, { nbSamples: 35, rapAlignement: true });
    }
    file.initializeSegmentation();
    if (startProcessing) file.start();
    resolveReady();
  };

  return {
    file,
    ready,
    get info() { return info; },
    get error() { return parserError; },
    segments,
    bootstrap,
  };
}

async function feedBuffer(parser, bytes) {
  const size = bytes.byteLength;
  for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
    const end = Math.min(offset + CHUNK_BYTES, size);
    const input = makeArrayBuffer(bytes.subarray(offset, end));
    input.fileStart = offset;
    parser.file.appendBuffer(input, end === size);
  }
  parser.file.flush();
  await parser.ready;
  if (parser.error) throw new Error('MP4Box reported an error while parsing the fixture.');
  return parser;
}

async function feedCandidate(MP4Box, bootstrap, moov, startProcessing = false) {
  const parser = createParser(MP4Box, bootstrap, startProcessing);
  const chunk0 = makeArrayBuffer(bootstrap);
  chunk0.fileStart = 0;
  parser.file.appendBuffer(chunk0);
  if (moov) {
    const moovBuffer = makeArrayBuffer(moov.bytes);
    moovBuffer.fileStart = moov.start;
    parser.file.appendBuffer(moovBuffer);
  }
  parser.file.flush();
  await parser.ready;
  if (parser.error) throw new Error('MP4Box reported an error while parsing candidate metadata.');
  return parser;
}

async function startCandidate(MP4Box, bootstrap, moov, durationSeconds, gc) {
  let parser = await feedCandidate(MP4Box, bootstrap, moov, false);
  const candidateSampleCount = getSampleInfo(parser).sampleCount;
  const candidateSeek = parser.file.seek(durationSeconds / 2, true);
  parser.file.start();
  const combined = memorySnapshot(gc);
  const metrics = {
    candidateSampleCount,
    candidateSeekOffset: candidateSeek?.offset ?? null,
  };
  const fileRef = new WeakRef(parser.file);
  parser = null;
  return { metrics, combined, fileRef };
}

async function startTwoCandidates(MP4Box, bootstrap, moov, durationSeconds, gc) {
  let first = await feedCandidate(MP4Box, bootstrap, moov, false);
  let second = await feedCandidate(MP4Box, bootstrap, moov, false);
  const eachCandidateSampleCount = getSampleInfo(first).sampleCount;
  first.file.seek(durationSeconds / 2, true);
  second.file.seek(durationSeconds / 2, true);
  first.file.start();
  second.file.start();
  const combined = memorySnapshot(gc);
  const refs = [new WeakRef(first.file), new WeakRef(second.file)];
  first = null;
  second = null;
  return { eachCandidateSampleCount, combined, refs };
}

async function collectAfterCandidateRelease(gc, refs) {
  let collectedCandidateObjects = 0;
  for (let attempt = 0; attempt < 4 && collectedCandidateObjects < refs.length; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
    collectedCandidateObjects = refs.filter((reference) => reference.deref() === undefined).length;
  }
  await new Promise((resolve) => setImmediate(resolve));
  gc();
  const heapUsed = process.memoryUsage().heapUsed;
  return {
    heapUsed,
    collectedCandidateObjects,
  };
}

function memorySnapshot(gc) {
  gc();
  const { heapUsed, heapTotal, rss, external, arrayBuffers } = process.memoryUsage();
  return { heapUsed, heapTotal, rss, external, arrayBuffers };
}

function memoryDelta(before, after) {
  return Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
}

function getSampleInfo(parser) {
  const tracks = (parser.info?.tracks ?? []).map((track) => {
    const internal = parser.file.getTrackById(track.id);
    const samples = internal?.samples ?? [];
    let payloadSamples = 0;
    for (const sample of samples) if (sample.data != null) payloadSamples += 1;
    return {
      id: track.id,
      type: track.type,
      codec: track.codec,
      timescale: track.timescale,
      infoSampleCount: Number(track.nb_samples) || 0,
      indexSampleCount: samples.length,
      payloadSamples,
    };
  });
  return { tracks, sampleCount: tracks.reduce((total, track) => total + track.indexSampleCount, 0) };
}

function collectBoxCounts(file) {
  const topLevel = (file.boxes ?? []).map((box) => box.type);
  let trunCount = 0;
  for (const moof of file.moofs ?? []) {
    for (const traf of moof.trafs ?? []) trunCount += (traf.truns ?? []).length;
  }
  return { topLevel, moofCount: (file.moofs ?? []).length, trunCount };
}

function seekSamples(file, durationSeconds) {
  const positions = [10, 50, 90];
  const seeks = {};
  for (const percent of positions) {
    const elapsed = [];
    let result = null;
    for (let index = 0; index < 10; index += 1) {
      const started = process.hrtime.bigint();
      result = file.seek(durationSeconds * percent / 100, true);
      elapsed.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    seeks[percent] = { medianMs: median(elapsed), maxMs: Math.max(...elapsed), offset: result?.offset ?? null };
  }
  return seeks;
}

async function runNodeChild(caseId, fixtureDir = FIXTURE_ROOT) {
  const gc = requireExplicitGc();
  const fixture = CALIBRATION_CASES.find((item) => item.id === caseId);
  if (!fixture) throw new Error('Unknown calibration case.');
  const filename = path.join(fixtureDir, `${fixture.id}.mp4`);
  const beforeRead = memorySnapshot(gc);
  const bytes = fs.readFileSync(filename);
  const topLevel = findTopLevelBoxes(bytes);
  const moovBox = topLevel.find((box) => box.type === 'moov');
  const bootstrap = Buffer.from(bytes.subarray(0, Math.min(bytes.length, CHUNK_BYTES)));
  const moov = fixture.moov === 'tail' && moovBox
    ? { start: moovBox.start, bytes: Buffer.from(bytes.subarray(moovBox.start, moovBox.start + moovBox.size)) }
    : null;
  const afterRead = memorySnapshot(gc);
  const baseline = memorySnapshot(gc);
  const mp4boxVersion = resolveMp4BoxVersion();
  const MP4Box = require('mp4box');
  if (typeof MP4Box.createFile !== 'function') throw new Error('Resolved MP4Box has no createFile API.');

  let active = createParser(MP4Box, bootstrap, true);
  await feedBuffer(active, bytes);
  const afterParse = memorySnapshot(gc);
  const activeMemory = memoryDelta(baseline, afterParse);
  const sampleInfo = getSampleInfo(active);
  const counts = collectBoxCounts(active.file);
  const releaseBefore = sampleInfo.tracks.map(({ id, indexSampleCount }) => ({ id, indexSampleCount }));
  for (const track of sampleInfo.tracks) active.file.releaseUsedSamples(track.id, track.indexSampleCount);
  const afterSegmentation = memorySnapshot(gc);
  const afterExplicitRelease = memorySnapshot(gc);
  const afterReleaseInfo = getSampleInfo(active);
  const seeks = seekSamples(active.file, (active.info.duration || 0) / (active.info.timescale || 1));
  let candidate = null;
  let candidateMetrics = null;
  let multiCandidateMetrics = null;
  if (fixture.candidate) {
    const activeAnchor = memorySnapshot(gc);
    candidate = await startCandidate(MP4Box, bootstrap, moov, fixture.videoFrames / fixture.fps, gc);
    candidateMetrics = {
      candidateBootstrapBytes: bootstrap.byteLength + (moov?.bytes.byteLength ?? 0),
      activeParserHeapBytes: activeMemory.heapUsed,
      combinedParserHeapBytes: candidate.combined.heapUsed - baseline.heapUsed,
      candidateIncrementalHeapBytes: candidate.combined.heapUsed - activeAnchor.heapUsed,
      candidateSampleCount: candidate.metrics.candidateSampleCount,
      candidateSeekOffset: candidate.metrics.candidateSeekOffset,
    };
    const afterCandidateRelease = await collectAfterCandidateRelease(gc, [candidate.fileRef]);
    candidateMetrics.afterCandidateReleaseHeapBytes = afterCandidateRelease.heapUsed - baseline.heapUsed;
    candidateMetrics.candidateReleaseObservedBytes = candidate.combined.heapUsed - afterCandidateRelease.heapUsed;
    candidateMetrics.collectedCandidateObjects = afterCandidateRelease.collectedCandidateObjects;

    if (fixture.multipleCandidates) {
      const beforeTwoCandidates = memorySnapshot(gc);
      const candidates = await startTwoCandidates(MP4Box, bootstrap, moov, fixture.videoFrames / fixture.fps, gc);
      multiCandidateMetrics = {
        candidateCount: 2,
        combinedParserHeapBytes: candidates.combined.heapUsed - baseline.heapUsed,
        candidateIncrementalHeapBytes: candidates.combined.heapUsed - beforeTwoCandidates.heapUsed,
        activeParserHeapBytes: activeMemory.heapUsed,
        eachCandidateSampleCount: candidates.eachCandidateSampleCount,
      };
      const afterRelease = await collectAfterCandidateRelease(gc, candidates.refs);
      multiCandidateMetrics.afterReleaseHeapBytes = afterRelease.heapUsed - baseline.heapUsed;
      multiCandidateMetrics.collectedCandidateObjects = afterRelease.collectedCandidateObjects;
    }
  }

  const afterReadDelta = memoryDelta(beforeRead, afterRead);
  const releaseMetrics = {
    sampleCountBeforeRelease: releaseBefore.reduce((sum, item) => sum + item.indexSampleCount, 0),
    sampleCountAfterRelease: afterReleaseInfo.sampleCount,
    payloadSamplesAfterSegmentation: afterReleaseInfo.tracks.reduce((sum, track) => sum + track.payloadSamples, 0),
    sampleCountChanged: afterReleaseInfo.sampleCount !== sampleInfo.sampleCount,
    onSegmentCalls: active.segments.count,
    segmentBytesProduced: active.segments.bytes,
    segmentSampleNumberMax: active.segments.releasedSampleNumber,
    payloadSamplesBeforeRelease: active.segments.payloadSamplesBeforeRelease,
    payloadBytesBeforeRelease: active.segments.payloadBytesBeforeRelease,
    sampleDataBytesAfterRelease: active.segments.sampleDataBytesAfterRelease,
    heapAfterSegmentationBytes: afterSegmentation.heapUsed - baseline.heapUsed,
    heapAfterReleaseBytes: afterExplicitRelease.heapUsed - baseline.heapUsed,
  };
  const box = {
    topLevel: counts.topLevel,
    moofCount: counts.moofCount,
    trunCount: counts.trunCount,
    moovPosition: moovBox ? (moovBox.start < (topLevel.find((item) => item.type === 'mdat')?.start ?? Infinity) ? 'head' : 'tail') : null,
  };
  const durationSeconds = fixture.videoFrames / fixture.fps;
  const result = {
    schema: 1,
    caseId,
    status: 'completed',
    mp4boxVersion: mp4boxVersion.version,
    fileBytes: bytes.byteLength,
    fileSha256: createHash('sha256').update(bytes).digest('hex'),
    durationSeconds,
    indexHeapBytes: activeMemory.heapUsed,
    tracks: sampleInfo.tracks,
    sampleCount: sampleInfo.sampleCount,
    box,
    memoryBytes: {
      inputAndBootstrapExternalDelta: afterReadDelta.external,
      inputAndBootstrapArrayBuffersDelta: afterReadDelta.arrayBuffers,
      indexHeapBytes: activeMemory.heapUsed,
      parserHeapTotalDelta: activeMemory.heapTotal,
      parserRssDelta: activeMemory.rss,
      parserExternalDelta: activeMemory.external,
      parserArrayBuffersDelta: activeMemory.arrayBuffers,
    },
    release: releaseMetrics,
    seeks,
    candidate: candidateMetrics,
    multipleCandidates: multiCandidateMetrics,
    durationMeasurement: 'fixture videoFrames / fps; cross-checked against ffprobe container duration',
    chunkBytes: CHUNK_BYTES,
    parserInput: 'sequential ArrayBuffer slices with absolute fileStart; one 4 MiB maximum per append',
    privatePathsExcluded: true,
  };
  active = null;
  return result;
}

function ffmpegArgs(item, filename) {
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-fflags', '+bitexact', '-f', 'lavfi', '-i', `color=c=black:s=64x64:r=${item.fps}`,
  ];
  for (let index = 0; index < item.audioTracks; index += 1) {
    const layout = index === 0 ? 'stereo' : 'mono';
    args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=${layout}:sample_rate=48000`);
  }
  args.push('-map', '0:v:0', '-frames:v', String(item.videoFrames), '-c:v', 'libx264', '-preset', 'ultrafast',
    '-tune', 'zerolatency', '-threads:v', '1', '-pix_fmt', 'yuv420p', '-g', String(item.fps * 20),
    '-x264-params', `keyint=${item.fps * 20}:min-keyint=${item.fps * 20}:scenecut=0`,
    '-flags:v', '+bitexact', '-map_metadata', '-1', '-metadata', 'creation_time=1970-01-01T00:00:00Z');
  for (let index = 0; index < item.audioTracks; index += 1) args.push('-map', `${index + 1}:a:0`);
  if (item.audioTracks > 0) args.push('-c:a', 'aac', '-b:a', '32k', '-shortest');
  if (item.mode === 'fragmented') {
    args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof');
  } else if (item.moov === 'head') {
    args.push('-movflags', '+faststart');
  }
  args.push('-f', 'mp4', filename);
  return args;
}

function runToolVersion(command) {
  const result = runProcess(command, ['-version'], { timeout: 15_000 });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0] : null;
}

function makeRunId() {
  const now = new Date().toISOString().replaceAll(/[-:]/g, '').replaceAll('.', '').replaceAll('Z', 'Z');
  return `run-${now}-${process.pid}`;
}

function runChild(command, caseId, runDir, fixtureDir) {
  const result = runProcess(process.execPath,
    ['--expose-gc', fileURLToPath(import.meta.url), command, '--case', caseId,
      '--run-dir', runDir, '--fixture-dir', fixtureDir],
    { cwd: FRONTEND_ROOT, timeout: TIMEOUT_MS });
  if (result.status !== 0) throw new Error(result.error ?? result.stderr ?? `Child ${caseId} failed.`);
  return parseChildOutput(result.stdout.trim(), result.status);
}

export function expectedCorpusShape(item, probe) {
  const streams = probe.streams ?? [];
  const video = streams.filter((stream) => stream.codec_type === 'video');
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  const expectedTracks = 1 + item.audioTracks;
  const boxes = probe.box;
  const moovPlacementValid = item.mode === 'fragmented'
    ? boxes.topLevel.includes('moof') && boxes.trunCount > 0 && boxes.moofCount > 0
    : boxes.moovPosition === item.moov;
  return {
    valid: streams.length === expectedTracks && video.length === 1 && audio.length === item.audioTracks && moovPlacementValid,
    expectedTracks,
    actualTracks: streams.length,
    videoStreams: video.length,
    audioStreams: audio.length,
    moovPlacementValid,
    topLevel: boxes.topLevel,
    moofCount: boxes.moofCount,
    trunCount: boxes.trunCount,
    mp4boxSampleCount: probe.sampleCount,
    ffprobePackets: streams.map((stream) => ({ type: stream.codec_type, packets: stream.nb_read_packets, frames: stream.nb_read_frames })),
    fileBytes: probe.fileBytes,
    durationSeconds: Number(probe.format?.duration ?? probe.mp4box.durationSeconds),
  };
}

function aggregateCase(item, runs, corpusValidation) {
  const completed = runs.filter((run) => run.status === 'completed');
  const metrics = (key) => summarize(completed.map((run) => run.memoryBytes[key]));
  const seek = Object.fromEntries([10, 50, 90].map((position) => [position, {
    medianMs: completed.length ? median(completed.map((run) => run.seeks[position].medianMs)) : null,
    maxMs: completed.length ? Math.max(...completed.map((run) => run.seeks[position].maxMs)) : null,
  }]));
  return {
    caseId: item.id,
    mode: item.mode,
    moov: item.moov,
    fps: item.fps,
    videoFrames: item.videoFrames,
    audioTracks: item.audioTracks,
    durationSeconds: corpusValidation.durationSeconds,
    sampleCount: median(completed.map((run) => run.sampleCount)),
    fileBytes: corpusValidation.fileBytes,
    sha256: completed[0]?.fileSha256 ?? corpusValidation.sha256,
    status: completed.length === runs.length ? 'completed' : 'partial',
    repetitionsCompleted: completed.length,
    parserIndexHeapBytes: completed.length ? metrics('indexHeapBytes') : null,
    parserExternalBytes: completed.length ? metrics('parserExternalDelta') : null,
    parserArrayBufferBytes: completed.length ? metrics('parserArrayBuffersDelta') : null,
    inputAndBootstrapBytes: completed.length ? metrics('inputAndBootstrapArrayBuffersDelta') : null,
    tracks: completed[0]?.tracks ?? [],
    box: completed[0]?.box ?? null,
    seek,
    release: completed.map((run) => run.release),
    candidate: completed.map((run) => run.candidate).filter(Boolean),
    multipleCandidates: completed.map((run) => run.multipleCandidates).filter(Boolean),
    ffprobe: corpusValidation.ffprobe,
    validation: corpusValidation.validation,
  };
}

function modelFor(mode, results) {
  const rows = results.filter((item) => item.status === 'completed' && item.mode === mode && item.audioTracks === 0);
  const bySamples = new Map();
  for (const row of rows) {
    const x = row.sampleCount;
    const y = row.parserIndexHeapBytes.median;
    if (!bySamples.has(x)) bySamples.set(x, []);
    bySamples.get(x).push(y);
  }
  const points = [...bySamples].map(([x, values]) => ({ x, y: median(values) })).sort((a, b) => a.x - b.x);
  if (points.length < 2) return { points, fit: null };
  return { points, fit: linearFit(points) };
}

function syntheticFits() {
  const fit = (rows) => linearFit(rows.map(([x, mib]) => ({ x, y: mib * 1024 * 1024 })));
  return {
    classicStszVariable: fit(SYNTHETIC_CLASSIC_MIB),
    classicStszUniform: fit(SYNTHETIC_UNIFORM_MIB),
    fragmentedTrun: fit(SYNTHETIC_FRAGMENTED_MIB),
    source: 'Prior synthetic results supplied in the B.89-R1 task; input MiB values rounded to 0.01 MiB, so fitted slope is approximate.',
  };
}

function buildSummary(results, secondRound, browserResults) {
  const classic = modelFor('classic', results);
  const fragmented = modelFor('fragmented', results);
  return {
    schema: 1,
    status: results.every((item) => item.status === 'completed') ? 'completed' : 'partial',
    cases: results,
    independentSecondRound: secondRound,
    models: { classic, fragmented, priorSynthetic: syntheticFits() },
    browser: browserResults,
    policies: deriveResourcePolicies(results),
    resourceModelLimits: [
      'heapUsed delta estimates retained V8 index/object cost after explicit GC; it is not total player memory.',
      'external and arrayBuffers are recorded separately and include parser-retained inputs/bootstrap copies.',
      'browser media decoder, MSE, GPU and native process memory are not measured by the Node probe.',
      'low-resolution fixtures characterize parser indexing, not decoder cost or playback compatibility at higher resolutions.',
    ],
  };
}

function validateFfprobe(output) {
  const result = runProcess('ffprobe', [
    '-v', 'error', '-count_frames', '-count_packets', '-show_streams', '-show_format', '-of', 'json', output,
  ], { timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr || 'ffprobe validation failed.');
  return JSON.parse(result.stdout);
}

function makeEnvironment(runId, versions, chromiumVersion = null) {
  const head = runProcess('git', ['rev-parse', 'HEAD'], { timeout: 10_000 }).stdout.trim();
  const branch = runProcess('git', ['branch', '--show-current'], { timeout: 10_000 }).stdout.trim();
  return {
    schema: 1,
    runId,
    timestamp: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    mp4box: resolveMp4BoxVersion(),
    ffmpeg: versions.ffmpeg,
    ffprobe: versions.ffprobe,
    chromium: chromiumVersion,
    gitHead: head || null,
    branch: branch || null,
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
}

function runBrowserProfile(caseId, fixtureDir = FIXTURE_ROOT) {
  const item = CALIBRATION_CASES.find((candidate) => candidate.id === caseId);
  if (!item) throw new Error('Unknown browser fixture case.');
  const filename = `${item.id}.mp4`;
  const fixturePath = path.join(fixtureDir, filename);
  const mp4Entry = require.resolve('mp4box');
  const distRoot = path.dirname(mp4Entry);
  const workerSource = `
    import { createFile } from '/lib/mp4box.all.mjs';
    self.postMessage({ status: 'ready' });
    self.onmessage = async ({ data }) => {
      if (data.action === 'release') {
        self.activeState = null;
        self.postMessage({ status: 'released' });
        return;
      }
      try {
        const bytes = await (await fetch('/fixture/' + encodeURIComponent(data.filename))).arrayBuffer();
        const file = createFile();
        let resolveReady; let rejectReady;
        const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        let segments = 0;
        file.onError = () => rejectReady(new Error('MP4Box parser error'));
        file.onSegment = (id, _user, _buffer, sampleNumber) => { segments++; file.releaseUsedSamples(id, sampleNumber); };
        file.onReady = (info) => {
          for (const track of info.tracks || []) file.setSegmentOptions(track.id, null, { nbSamples: 35, rapAlignement: true });
          file.initializeSegmentation(); file.start(); resolveReady(info);
        };
        for (let start = 0; start < bytes.byteLength; start += ${CHUNK_BYTES}) {
          const end = Math.min(start + ${CHUNK_BYTES}, bytes.byteLength);
          const chunk = bytes.slice(start, end); chunk.fileStart = start;
          file.appendBuffer(chunk, end === bytes.byteLength);
        }
        file.flush();
        const info = await ready;
        const duration = data.durationSeconds;
        const seeks = [];
        for (const percent of [10, 50, 90]) {
          const start = performance.now();
          for (let index = 0; index < 10; index++) file.seek(duration * percent / 100, true);
          seeks.push({ percent, total10Ms: performance.now() - start });
        }
        self.activeState = file;
        postMessage({ status: 'completed', tracks: info.tracks.map((track) => ({ type: track.type, samples: file.getTrackById(track.id)?.samples?.length || 0 })), segments, seeks, bytes: bytes.byteLength, duration });
      } catch { postMessage({ status: 'parser_error' }); }
    };
  `;
  let server;
  return new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><meta charset="utf-8"><title>Local MP4 memory probe</title>');
        return;
      }
      if (url.pathname === '/worker.mjs') {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end(workerSource);
        return;
      }
      if (url.pathname === `/fixture/${filename}`) {
        response.setHeader('Content-Type', 'video/mp4');
        fs.createReadStream(fixturePath).pipe(response);
        return;
      }
      if (url.pathname.startsWith('/lib/')) {
        const relative = decodeURIComponent(url.pathname.slice('/lib/'.length));
        const resolved = path.resolve(distRoot, relative);
        if (!resolved.startsWith(`${distRoot}${path.sep}`) || !/\.(?:mjs|js|cjs|wasm)$/.test(resolved)) {
          response.writeHead(404).end();
          return;
        }
        response.setHeader('Content-Type', resolved.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8');
        fs.createReadStream(resolved).on('error', () => response.writeHead(404).end()).pipe(response);
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', async () => {
      let browser;
      try {
        const { chromium } = require('@playwright/test');
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const browserSession = await browser.newBrowserCDPSession();
        await browserSession.send('Target.setDiscoverTargets', { discover: true });
        await page.evaluate(() => {
          window.__mp4ProbeMessages = [];
          const worker = new Worker('/worker.mjs', { type: 'module' });
          window.__mp4ProbeWorker = worker;
          worker.onmessage = (event) => window.__mp4ProbeMessages.push(event.data);
          worker.onerror = () => window.__mp4ProbeMessages.push({ status: 'worker_error' });
        });
        await page.waitForFunction(() => window.__mp4ProbeMessages.some((message) => message.status === 'ready'), null, { timeout: 15_000 });

        let workerTarget = null;
        for (let attempt = 0; attempt < 40 && !workerTarget; attempt += 1) {
          const { targetInfos } = await browserSession.send('Target.getTargets');
          workerTarget = targetInfos.find((target) => target.type === 'worker' && new URL(target.url).pathname === '/worker.mjs') ?? null;
          if (!workerTarget) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!workerTarget) throw new Error('Dedicated Worker CDP target was not discoverable.');

        const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId: workerTarget.targetId, flatten: false });
        let nextProtocolId = 1;
        const pending = new Map();
        browserSession.on('Target.receivedMessageFromTarget', (event) => {
          if (event.sessionId !== sessionId) return;
          let message;
          try { message = JSON.parse(event.message); } catch { return; }
          if (!pending.has(message.id)) return;
          const waiter = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) waiter.reject(new Error(message.error.message || 'Worker CDP command failed.'));
          else waiter.resolve(message.result ?? {});
        });
        const sendWorker = async (method, params = {}) => {
          const id = nextProtocolId++;
          const response = new Promise((resolveCommand, rejectCommand) => pending.set(id, { resolve: resolveCommand, reject: rejectCommand }));
          await browserSession.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
          return response;
        };
        const heap = async () => {
          await sendWorker('HeapProfiler.collectGarbage');
          return sendWorker('Runtime.getHeapUsage');
        };
        await sendWorker('Runtime.enable');
        await sendWorker('HeapProfiler.enable');
        const before = await heap();
        await page.evaluate(({ caseFilename, durationSeconds }) =>
          window.__mp4ProbeWorker.postMessage({ filename: caseFilename, durationSeconds }),
        { caseFilename: filename, durationSeconds: item.videoFrames / item.fps });
        await page.waitForFunction(() => window.__mp4ProbeMessages.some((message) => ['completed', 'parser_error', 'worker_error'].includes(message.status)), null, { timeout: 60_000 });
        const outcome = await page.evaluate(() => window.__mp4ProbeMessages.findLast((message) => ['completed', 'parser_error', 'worker_error'].includes(message.status)));
        const afterParse = await heap();
        await page.evaluate(() => window.__mp4ProbeWorker.postMessage({ action: 'release' }));
        await page.waitForFunction(() => window.__mp4ProbeMessages.some((message) => message.status === 'released'), null, { timeout: 5_000 });
        const afterRelease = await heap();
        const measurement = {
          status: outcome.status === 'completed' ? 'completed' : 'partial',
          method: 'Chrome DevTools Protocol Runtime.getHeapUsage on dedicated Worker target after HeapProfiler.collectGarbage',
          target: { type: workerTarget.type, urlPath: new URL(workerTarget.url).pathname },
          outcome,
          workerHeapBeforeBytes: before.usedSize,
          workerHeapAfterParseBytes: afterParse.usedSize,
          workerParserHeapDeltaBytes: afterParse.usedSize - before.usedSize,
          workerHeapAfterReleaseBytes: afterRelease.usedSize,
          workerHeapReleaseDeltaBytes: afterParse.usedSize - afterRelease.usedSize,
          includesEmbedderHeapBytes: afterParse.embedderHeapUsedSize ?? null,
          backingStorageBytes: afterParse.backingStorageSize ?? null,
          scopeLimitation: 'JavaScript worker heap only; excludes browser main thread, MSE, decoder, GPU and native allocations',
        };
        await browserSession.send('Target.detachFromTarget', { sessionId });
        await browserSession.detach();
        await page.evaluate(() => window.__mp4ProbeWorker.terminate());
        resolve({ schema: 1, caseId, browserVersion: browser.version(), measurement });
      } catch (error) {
        resolve({ schema: 1, caseId, status: 'blocked', reason: sanitize(error?.message ?? error) });
      } finally {
        await browser?.close();
        server.close();
      }
    });
    server.on('error', reject);
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--case') options.caseId = argv[++index];
    else if (value === '--run-dir') options.runDir = argv[++index];
    else if (value === '--fixture-dir') options.fixtureDir = argv[++index];
    else if (value === '--summary-output') options.summaryOutput = argv[++index];
    else if (value === '--report-dir') options.reportDir = argv[++index];
    else if (value === '--report-output') options.reportOutput = argv[++index];
    else if (value === '--round') options.round = argv[++index];
    else if (value === '--repetitions') options.repetitions = Number(argv[++index]);
    else if (value === '--summary') options.summary = argv[++index];
    else if (value === '--file') options.file = argv[++index];
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function resolveQualityOutput(value, label) {
  const resolved = path.resolve(REPOSITORY_ROOT, value);
  const qualityRoot = path.resolve(REPOSITORY_ROOT, '.quality');
  const relative = path.relative(qualityRoot, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside .quality and name a specific path.`);
  }
  return resolved;
}

async function runCalibration(mode, options = {}) {
  const runId = makeRunId();
  const customRunDir = options.runDir ? resolveQualityOutput(options.runDir, 'Run directory') : null;
  const runDir = customRunDir ?? path.join(OUTPUT_ROOT, 'runs', runId);
  const fixtureDir = customRunDir ? path.join(runDir, 'fixtures') : FIXTURE_ROOT;
  const summaryOutput = options.summaryOutput ? resolveQualityOutput(options.summaryOutput, 'Summary output') : null;
  if (customRunDir && fs.existsSync(runDir) && fs.readdirSync(runDir).length > 0) {
    throw new Error('Custom run directory is not empty; choose a fresh quality-artifact path.');
  }
  if (summaryOutput && fs.existsSync(summaryOutput)) {
    throw new Error('Summary output already exists; refusing to overwrite a quality artifact.');
  }
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const selectedCases = mode === 'smoke'
    ? CALIBRATION_CASES.filter((item) => item.id === BASE_CASE_ID)
    : CALIBRATION_CASES;
  const manifest = buildManifest(selectedCases);
  writeJsonAtomic(path.join(runDir, 'manifest.json'), manifest);

  const versions = { ffmpeg: runToolVersion('ffmpeg'), ffprobe: runToolVersion('ffprobe') };
  const environment = makeEnvironment(runId, versions);
  writeJsonAtomic(path.join(runDir, 'environment.json'), environment);
  if (!versions.ffmpeg || !versions.ffprobe) {
    const blocked = { schema: 1, status: 'blocked', reason: 'FFmpeg/ffprobe unavailable; corpus generation is required for valid-file characterization.' };
    writeJsonAtomic(path.join(runDir, 'summary.json'), blocked);
    writeJsonAtomic(path.join(customRunDir ? runDir : OUTPUT_ROOT, 'latest.json'), { runId, runDir: path.relative(OUTPUT_ROOT, runDir).replaceAll(path.sep, '/'), status: 'blocked' });
    if (summaryOutput) writeJsonAtomic(summaryOutput, { schema: 1, round: 'B.89-R3.M2', summaryPath: path.relative(REPOSITORY_ROOT, path.join(runDir, 'summary.json')).replaceAll(path.sep, '/'), status: blocked.status, summary: blocked });
    return 2;
  }
  assertExpectedMp4BoxVersion(environment.mp4box);

  const corpus = [];
  const firstPass = new Map();
  for (const item of selectedCases) {
    const output = path.join(fixtureDir, `${item.id}.mp4`);
    const args = ffmpegArgs(item, output);
    const generation = runProcess('ffmpeg', args, { timeout: TIMEOUT_MS });
    if (generation.status !== 0 || !fs.existsSync(output)) {
      corpus.push({ caseId: item.id, status: generation.error?.includes('timed out') ? 'timeout' : 'generation_failed', command: ['ffmpeg', ...args.slice(0, -1), `${item.id}.mp4`], stderr: generation.stderr || generation.error });
      writeJsonAtomic(path.join(runDir, 'corpus.json'), { schema: 1, fixtures: corpus });
      continue;
    }
    try {
      const ffprobe = validateFfprobe(output);
      corpus.push({
        caseId: item.id,
        filename: `${item.id}.mp4`,
        status: 'generated',
        command: ['ffmpeg', ...args.slice(0, -1), `${item.id}.mp4`],
        sha256: createHash('sha256').update(fs.readFileSync(output)).digest('hex'),
        fileBytes: fs.statSync(output).size,
        ffprobe: {
          duration: ffprobe.format?.duration,
          formatName: ffprobe.format?.format_name,
          streams: (ffprobe.streams ?? []).map(({ codec_type, codec_name, r_frame_rate, avg_frame_rate, duration, nb_read_frames, nb_read_packets }) =>
            ({ codec_type, codec_name, r_frame_rate, avg_frame_rate, duration, nb_read_frames, nb_read_packets })),
        },
        rawFfprobeSanitized: (() => {
          if (ffprobe.format) ffprobe.format.filename = `${item.id}.mp4`;
          return ffprobe;
        })(),
      });
    } catch (error) {
      corpus.push({ caseId: item.id, filename: `${item.id}.mp4`, status: 'validation_failed', reason: sanitize(error.message) });
    }
    writeJsonAtomic(path.join(runDir, 'corpus.json'), { schema: 1, fixtures: corpus });
  }

  const repetitions = mode === 'smoke' ? (options.repetitions ?? REPETITIONS) : (options.repetitions ?? REPETITIONS);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error('Repetitions must be between 1 and 5.');
  const caseResults = [];
  for (const item of selectedCases) {
    const corpusRow = corpus.find((row) => row.caseId === item.id);
    const fixturePath = path.join(fixtureDir, `${item.id}.mp4`);
    if (corpusRow?.status !== 'generated') {
      caseResults.push({ caseId: item.id, status: corpusRow?.status ?? 'blocked', repetitionsCompleted: 0 });
      continue;
    }
    const runs = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      try {
        const result = runChild('child', item.id, runDir, fixtureDir);
        const validation = expectedCorpusShape(item, { ...result, streams: corpusRow.ffprobe.streams, format: { duration: corpusRow.ffprobe.duration } });
        const shape = {
          valid: validation.valid,
          expectedTracks: validation.expectedTracks,
          actualTracks: validation.actualTracks,
          videoStreams: validation.videoStreams,
          audioStreams: validation.audioStreams,
          moovPlacementValid: validation.moovPlacementValid,
          topLevel: validation.topLevel,
          moofCount: validation.moofCount,
          trunCount: validation.trunCount,
          mp4boxSampleCount: validation.mp4boxSampleCount,
          ffprobePackets: validation.ffprobePackets,
          durationSeconds: validation.durationSeconds,
          fileBytes: validation.fileBytes,
        };
        if (!shape.valid) throw new Error(`Corpus structure validation failed for ${item.id}.`);
        result.corpusValidation = shape;
        runs.push(result);
        if (repetition === 0) firstPass.set(item.id, result);
      } catch (error) {
        runs.push({ status: 'probe_failed', reason: sanitize(error.message) });
      }
      writeJsonAtomic(path.join(runDir, 'node-progress.json'), { schema: 1, caseId: item.id, repetition: repetition + 1, completed: runs });
    }
    const shape = runs.find((row) => row.corpusValidation)?.corpusValidation;
    caseResults.push(aggregateCase(item, runs, {
      ...(shape ?? {}),
      sha256: corpusRow.sha256,
      fileBytes: corpusRow.fileBytes,
      ffprobe: corpusRow.ffprobe,
      validation: shape?.valid ? 'validated by ffprobe + MP4Box' : 'not validated',
    }));
    console.log(`${item.id}: ${runs.filter((row) => row.status === 'completed').length}/${repetitions} Node runs`);
    writeJsonAtomic(path.join(runDir, 'node-results.json'), caseResults);
  }

  const secondRound = [];
  if (mode === 'run') {
    for (const caseId of ['classic-faststart-v30-50k', 'fragmented-v30-50k']) {
      if (!firstPass.has(caseId)) continue;
      try {
        secondRound.push(runChild('child', caseId, runDir, fixtureDir));
      } catch (error) {
        secondRound.push({ caseId, status: 'probe_failed', reason: sanitize(error.message) });
      }
    }
  }

  let browserResults = [];
  if (mode === 'run') {
    for (const caseId of BROWSER_CASE_IDS) {
      const row = corpus.find((entry) => entry.caseId === caseId);
      if (row?.status !== 'generated') continue;
      try {
        browserResults.push(await runBrowserProfile(caseId, fixtureDir));
      } catch (error) {
        browserResults.push({ schema: 1, caseId, status: 'blocked', reason: sanitize(error.message) });
      }
      writeJsonAtomic(path.join(runDir, 'browser-results.json'), browserResults);
    }
  }

  const joined = caseResults.map((item) => {
    const source = selectedCases.find((candidate) => candidate.id === item.caseId);
    const runs = firstPass.get(item.caseId);
    return { ...item, videoFrames: source.videoFrames, audioTracks: source.audioTracks, mode: source.mode,
      candidate: (item.candidate ?? []).map((result) => ({
        ...result,
        combinedParserHeapBytes: result.combinedParserHeapBytes,
      })) };
  });
  const summary = buildSummary(joined, secondRound, browserResults);
  const allNodeCasesGreen = mode === 'smoke'
    ? caseResults.length === 1 && caseResults[0].status === 'completed' && caseResults[0].repetitionsCompleted === repetitions
    : caseResults.length === selectedCases.length && caseResults.every((item) => item.status === 'completed' && item.repetitionsCompleted === repetitions);
  summary.status = allNodeCasesGreen ? 'completed' : 'partial';
  summary.environment = environment;
  writeJsonAtomic(path.join(runDir, 'summary.json'), summary);
  writeJsonAtomic(path.join(customRunDir ? runDir : OUTPUT_ROOT, 'latest.json'), {
    schema: 1,
    runId,
    runDirectory: path.relative(OUTPUT_ROOT, runDir).replaceAll(path.sep, '/'),
    status: summary.status,
    caseCount: caseResults.length,
    timestamp: environment.timestamp,
  });
  if (summaryOutput) {
    writeJsonAtomic(summaryOutput, {
      schema: 1,
      round: 'B.89-R3.M2',
      summaryPath: path.relative(REPOSITORY_ROOT, path.join(runDir, 'summary.json')).replaceAll(path.sep, '/'),
      status: summary.status,
      mp4box: environment.mp4box,
      summary,
    });
  }
  console.log(`MP4 resource calibration ${summary.status}; results: ${path.relative(REPOSITORY_ROOT, path.join(runDir, 'summary.json'))}`);
  return allNodeCasesGreen ? 0 : 1;
}

async function runFileProbe(filename) {
  const gc = requireExplicitGc();
  const resolved = path.resolve(REPOSITORY_ROOT, filename);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('Independent MP4 fixture was not found.');
  const bytes = fs.readFileSync(resolved);
  const metadata = scanMp4ResourceMetadata(bytes);
  if (metadata.status !== 'characterized') throw new Error(`Independent MP4 is not characterized: ${metadata.reasons.join(', ')}`);
  const baseline = memorySnapshot(gc);
  const MP4Box = require('mp4box');
  const bootstrap = Buffer.from(bytes.subarray(0, Math.min(bytes.length, CHUNK_BYTES)));
  let parser = createParser(MP4Box, bootstrap, true);
  await feedBuffer(parser, bytes);
  const afterParse = memorySnapshot(gc);
  const sampleInfo = getSampleInfo(parser);
  const output = {
    schema: 1,
    status: 'completed',
    fileName: path.basename(resolved),
    fileSha256: createHash('sha256').update(bytes).digest('hex'),
    mp4box: resolveMp4BoxVersion(),
    metadata,
    mp4boxSampleCount: sampleInfo.sampleCount,
    tracks: sampleInfo.tracks.map(({ id, type, indexSampleCount }) => ({ id, type, indexSampleCount })),
    observedParserHeapBytes: memoryDelta(baseline, afterParse).heapUsed,
    memoryBytes: memoryDelta(baseline, afterParse),
    scope: 'isolated Node MP4Box parser heap delta after explicit GC; excludes complete player/browser/decoder memory',
  };
  parser = null;
  return output;
}

async function runModelRatification(options = {}) {
  const summaryPath = path.resolve(REPOSITORY_ROOT, options.summary ?? '.quality/mp4-resource-calibration/runs/run-20260923T174033253Z-3320/summary.json');
  const fixtureDir = options.fixtureDir ? resolveQualityOutput(options.fixtureDir, 'Fixture directory') : FIXTURE_ROOT;
  const customReportDir = options.reportDir ? resolveQualityOutput(options.reportDir, 'Report directory') : null;
  const reportOutput = options.reportOutput ? resolveQualityOutput(options.reportOutput, 'Report output') : null;
  const reportDir = customReportDir ?? path.join(OUTPUT_ROOT, 'ratifications', makeRunId());
  if (customReportDir && fs.existsSync(reportDir) && fs.readdirSync(reportDir).length > 0) {
    throw new Error('Custom report directory is not empty; choose a fresh quality-artifact path.');
  }
  if (reportOutput && fs.existsSync(reportOutput)) {
    throw new Error('Report output already exists; refusing to overwrite a quality artifact.');
  }
  const rawSummary = fs.readFileSync(summaryPath);
  const summaryHash = createHash('sha256').update(rawSummary).digest('hex');
  const historical = JSON.parse(rawSummary.toString('utf8'));
  if (historical.schema !== 1 || historical.status !== 'completed' || historical.cases?.length !== CALIBRATION_CASES.length) {
    throw new Error('Historical calibration summary is not a complete 16-fixture run.');
  }
  const rows = historical.cases.map((item) => {
    const fixturePath = path.join(fixtureDir, `${item.caseId}.mp4`);
    const bytes = fs.readFileSync(fixturePath);
    const metadata = scanMp4ResourceMetadata(bytes);
    if (metadata.status !== 'characterized' || metadata.declaredSamples !== item.sampleCount) {
      throw new Error(`Fixture ${item.caseId} could not be independently characterized against the preserved summary.`);
    }
    return { ...item, ...metadata, status: item.status, mode: item.mode, metadata, observedParserHeapBytes: item.parserIndexHeapBytes.max };
  });
  const holdouts = ['classic-av-v30-50k', 'fragmented-av-v30-50k'];
  const models = Object.fromEntries(['classic', 'fragmented'].map((mode) => [mode,
    fitPreExpansionResourceModel(rows, mode, { holdoutCaseIds: holdouts.filter((id) => rows.find((row) => row.caseId === id)?.mode === mode) })]));
  const modelValidation = Object.fromEntries(Object.entries(models).map(([mode, model]) => [mode,
    validateResourceModel(model, rows.filter((row) => row.mode === mode))]));
  const perCase = rows.map((row) => {
    const model = models[row.mode];
    const estimateBytes = estimateParserMemory(model, { ...row.metadata, status: row.metadata.status });
    return {
      caseId: row.caseId,
      mode: row.mode,
      validation: row.validation,
      status: row.metadata.status,
      sampleCountFromMp4Box: row.sampleCount,
      declaredSamplesFromPreflight: row.metadata.declaredSamples,
      trackCount: row.metadata.trackCount,
      tracks: row.metadata.tracks,
      auxiliaryEntryCount: row.metadata.auxiliaryEntryCount,
      auxiliaryEntryCountsByType: row.metadata.auxiliaryEntryCountsByType,
      perSampleFieldUnits: row.metadata.perSampleFieldUnits,
      auxiliaryUnits: row.metadata.auxiliaryUnits,
      metadataBytes: row.metadata.metadataBytes,
      visitedBoxes: row.metadata.visitedBoxes,
      structuralUnits: row.metadata.structuralUnits,
      observedParserHeapBytesMax: row.parserIndexHeapBytes.max,
      estimateBytes,
      marginBytes: estimateBytes - row.parserIndexHeapBytes.max,
      conservativeForObservation: estimateBytes >= row.parserIndexHeapBytes.max,
      candidateBootstrapBytes: row.candidate?.map((entry) => entry.candidateBootstrapBytes) ?? [],
      observedActiveAndCandidateHeapBytes: row.candidate?.map((entry) => entry.combinedParserHeapBytes) ?? [],
      observedMultipleCandidateHeapBytes: row.multipleCandidates?.map((entry) => ({ candidateCount: entry.candidateCount, combinedParserHeapBytes: entry.combinedParserHeapBytes })) ?? [],
      candidateCollectedCounts: row.multipleCandidates?.map((entry) => entry.collectedCandidateObjects) ?? [],
    };
  });
  const tiers = [50_000, 100_000, 200_000].map((targetSamples, index) => {
    const perMode = Object.fromEntries(Object.entries(models).map(([mode, model]) => {
      const modeRows = rows.filter((row) => row.mode === mode);
      const maxUnitsPerSample = Math.max(...modeRows.map((row) => row.metadata.structuralUnits / row.metadata.declaredSamples));
      const maxMetadataBytesPerSample = Math.max(...modeRows.map((row) => row.metadata.metadataBytes / row.metadata.declaredSamples));
      const targetAuxiliaryUnits = Math.ceil(targetSamples * (maxUnitsPerSample - 1));
      const targetMetadataBytes = Math.ceil(targetSamples * maxMetadataBytesPerSample);
      return [mode, {
        maxObservedStructuralUnitsPerSample: maxUnitsPerSample,
        targetAuxiliaryUnits,
        maxMetadataBytesPerSample,
        targetMetadataBytes,
        estimateBytes: estimateParserMemory(model, { status: 'characterized', mode, sampleCount: targetSamples, auxiliaryUnits: targetAuxiliaryUnits, metadataBytes: targetMetadataBytes }),
      }];
    }));
    const perParserBudgetBytes = Math.max(...Object.values(perMode).map((entry) => entry.estimateBytes));
    const aggregateThreeParserBudgetBytes = perParserBudgetBytes * 3;
    const classified = perCase.map((item) => ({
      caseId: item.caseId,
      estimatedBytes: item.estimateBytes,
      classification: classifyResourceAcceptance({ estimatedBytes: item.estimateBytes, budgetBytes: perParserBudgetBytes }),
    }));
    return {
      name: ['A — conservadora', 'B — intermediária', 'C — permissiva'][index],
      targetDeclaredSamplesPerParser: targetSamples,
      perMode,
      perParserBudgetBytes,
      aggregateThreeParserBudgetBytes,
      aggregateSlots: 'um parser ativo + dois candidates vivos; limite proposto, ainda sem enforcement de produção',
      acceptedCaseIds: classified.filter((entry) => entry.classification === 'accept').map((entry) => entry.caseId),
      rejectedCaseIds: classified.filter((entry) => entry.classification === 'reject').map((entry) => entry.caseId),
      classifications: classified,
    };
  });
  const representative = {
    parserSlots: [
      { id: 'active-classic-10k', role: 'active', mode: 'classic', caseId: 'classic-faststart-v30-10k' },
      { id: 'candidate-a-classic-av-10k', role: 'candidate-a', mode: 'classic', caseId: 'classic-av-v30-10k' },
      { id: 'candidate-b-fragmented-50k', role: 'candidate-b', mode: 'fragmented', caseId: 'fragmented-v30-50k' },
    ].map((slot) => {
      const item = perCase.find((entry) => entry.caseId === slot.caseId);
      return { ...slot, estimatedBytes: item.estimateBytes };
    }),
  };
  representative.heterogeneousAggregateBytes = aggregateLiveParserCosts(representative.parserSlots.map(({ id, estimatedBytes }) => ({ id, estimatedBytes })));
  representative.removingCandidateABytes = aggregateLiveParserCosts(representative.parserSlots.filter((slot) => slot.id !== 'candidate-a-classic-av-10k').map(({ id, estimatedBytes }) => ({ id, estimatedBytes })));
  representative.promotingCandidateBBytes = aggregateLiveParserCosts([{ ...representative.parserSlots[2], id: 'active' }].map(({ id, estimatedBytes }) => ({ id, estimatedBytes })));
  const independentRuns = [];
  if (options.file) {
    for (let index = 0; index < 3; index++) {
      const result = runProcess(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), 'probe-file', '--file', options.file], { timeout: 180_000 });
      if (result.status !== 0) throw new Error(`Independent parser probe ${index + 1} failed: ${result.stderr}`);
      let probe;
      try { probe = JSON.parse(result.stdout); } catch { throw new Error(`Independent parser probe ${index + 1} returned invalid JSON.`); }
      if (probe?.schema !== 1 || probe.status !== 'completed' || !Number.isSafeInteger(probe.observedParserHeapBytes)) {
        throw new Error(`Independent parser probe ${index + 1} returned incomplete measurements.`);
      }
      independentRuns.push(probe);
    }
  }
  const independent = independentRuns.length ? {
    fileName: independentRuns[0].fileName,
    fileSha256: independentRuns[0].fileSha256,
    probeRuns: independentRuns.length,
    allDistinctProcesses: true,
    mode: independentRuns[0].metadata.mode,
    metadata: independentRuns[0].metadata,
    mp4boxSampleCount: independentRuns[0].mp4boxSampleCount,
    observedParserHeapBytes: summarize(independentRuns.map((item) => item.observedParserHeapBytes)),
    modelEstimateBytes: estimateParserMemory(models[independentRuns[0].metadata.mode], independentRuns[0].metadata),
    scope: independentRuns[0].scope,
  } : null;
  if (independent && independentRuns.some((run) => run.fileSha256 !== independent.fileSha256 || run.metadata.status !== 'characterized' || run.mp4boxSampleCount !== run.metadata.declaredSamples)) {
    throw new Error('Independent fixture parser/preflight metadata did not agree.');
  }
  const currentVersion = resolveMp4BoxVersion();
  const originalIntegrityPreserved = createHash('sha256').update(fs.readFileSync(summaryPath)).digest('hex') === summaryHash;
  const ratified = perCase.length === 16 && perCase.every((item) => item.conservativeForObservation) &&
    Object.values(modelValidation).every((item) => item.status === 'validated-on-supplied-corpus') &&
    independent !== null && independent.modelEstimateBytes >= independent.observedParserHeapBytes.max && originalIntegrityPreserved;
  const report = {
    schema: 1,
    round: options.round ?? 'B.89-R1.M1',
    modelImplementationLineage: 'B.89-R1.M1 estimator, revalidated against the explicitly supplied corpus and current scanner.',
    ap01IndependentlyRatified: false,
    b89Status: 'OPEN',
    b90Status: 'NOT STARTED',
    status: ratified ? 'resource-model-ratified-on-measured-corpus' : 'not-ratified',
    productionGuardImplemented: true,
    historicalSummary: {
      path: path.relative(REPOSITORY_ROOT, summaryPath).replaceAll(path.sep, '/'),
      sha256: summaryHash,
      status: historical.status,
      fixtureCount: historical.cases.length,
      originalIntegrityPreserved,
    },
    installedMp4Box: currentVersion,
    legacyVideoOnlyClassicModel: historical.models.classic.fit,
    legacyUnderprediction: ['classic-av-v30-10k', 'classic-av-v30-50k', 'classic-multitrack-v30-10k'].map((caseId) => {
      const item = rows.find((row) => row.caseId === caseId);
      const legacyEstimate = historical.models.classic.fit.interceptBytes + historical.models.classic.fit.slopeBytesPerSample * item.sampleCount;
      return { caseId, legacyEstimateBytes: Math.round(legacyEstimate), observedParserHeapBytes: item.parserIndexHeapBytes.max, underpredictionBytes: Math.max(0, Math.ceil(item.parserIndexHeapBytes.max - legacyEstimate)) };
    }),
    selectedEstimator: {
      model: 'mode-specific maximum-secants upper envelope over all valid media tracks; training excludes one classic and one fragmented A/V fixture; validate against held-out cases',
      safetyFactor: 1.1,
      auxiliaryUnitBytes: 64,
      auxiliaryChargeBasis: '64 bytes per modeled auxiliary unit, with explicit per-family extra units from the MP4Box 2.4.1 isolated auxiliary probes, plus 1 byte per declared moov/moof metadata byte; the 1.1 safety factor is applied to the estimate.',
      modelScope: 'installed MP4Box version and structurally characterized 64x64 corpus; not a universal memory or total-player-memory guarantee',
      models,
    },
    modelValidation,
    modelRedEvidence: {
      preImplementationRun: { passed: 12, failed: 5, productionSourceChanged: false },
      failingContracts: [
        'B89-R1M1-MODEL-001: classic video-only fit cannot be considered conservative for A/V when its estimate is below observed heap',
        'B89-R1M1-MODEL-002: acceptance must not use only post-parse heap when the production authority must be pre-expansion metadata',
        'B89-R1M1-MODEL-003: reject when pre-expansion estimate exceeds budget even if observed post-parse heap is below budget',
        'B89-R1M1-MODEL-004: expose a conservative-property violation when prediction is below observed maximum',
        'B89-R1M1-MODEL-005: identical-parser aggregate measurement does not validate arbitrary heterogeneous live-parser combinations',
      ],
      observedFailure: 'The five new model-contract tests failed against the pre-implementation tooling because the pre-expansion estimator, validation, acceptance, and unique-parser aggregation contracts were absent.',
    },
    fixtures: perCase,
    policies: { legacy: historical.policies, revised: tiers },
    liveParserAccounting: {
      aggregationRule: 'sum the estimate of every uniquely identified parser still reachable by active/candidate callbacks; release/removal only after ownership is terminal',
      heterogeneousExample: representative,
      historicalMaximumSameFixtureAggregateHeapBytes: Math.max(...rows.flatMap((row) => row.multipleCandidates.map((measurement) => measurement.combinedParserHeapBytes))),
      historicalAggregateLimitation: 'R1 measured the active parser and multiple candidates using the same fixture size; this does not validate heterogeneous mixes, which are covered by pure arithmetic contract tests only.',
    },
    memoryMetricSeparation: {
      observedNodeParserHeap: 'post-parse heap delta after explicit GC; measured value only, not a preflight decision input',
      estimatedStructuralCost: 'computed from pre-parse track/sample/table/trun/metadata structure and model',
      inputBootstrapBuffers: 'reported separately in historical external/ArrayBuffer measurements and candidate bootstrap sizes; not summed into parser heap',
      totalPlayerMemory: 'not measured; includes browser, MSE, decoder, GPU and native allocations outside this probe',
    },
    independentOutOfSample: independent,
    scanner: {
      input: 'complete test fixture bytes; top-level mdat payloads are skipped by box size, never searched or traversed',
      supportedSampleDeclarations: ['stsz', 'stz2', 'trun'],
      supportedTrackHandlers: ['vide', 'soun'],
      supportedMeasuredSampleEntries: ['avc1', 'mp4a'],
      supportedAuxiliaryTables: ['stts', 'ctts', 'stsc', 'stco', 'co64', 'stss', 'sbgp', 'sgpd', 'elst', 'tfra', 'sidx', 'stsd'],
      limits: { maxVisitedBoxes: 200_000, maxDepth: 16, maxTracks: 128, maxTableEntries: 1_000_000, maxSampleDescriptions: 64, maxMetadataBytes: 67_108_864 },
      unknownOrUnsupportedPolicy: 'uncharacterized => no numeric estimate and fail closed; no unknown structural cost is treated as zero',
      feasibility: {
        faststartMoov: 'available in leading file bytes when contained by the bootstrap range; R2 must inspect before first appendBuffer',
        tailMoov: 'requires fetching/decrypting the declared moov range before parser expansion; cannot be inferred from the first chunk alone',
        fragmentedMoov: 'initial moov describes tracks; each arriving moof/trun must be inspected and cumulatively budgeted before that chunk appendBuffer',
        arbitraryChunkBoundary: 'scanner consumes a contiguous metadata range in this tooling; production chunk accumulation/replay is not implemented here',
      },
    },
    seekInterpretation: {
      api: 'MP4Box file.seek(time, true)',
      measuredOperation: 'synchronous parser seek call after the complete fixture was already supplied to the parser',
      reportedOffsetName: 'reportedNextBufferOffset',
      functionalSeekCharacterized: false,
      limitation: 'offset may be EOF after the whole file was fed; this benchmark is not evidence that playback can resume or fetch the correct range',
    },
    processScope: { backendChanged: false, ratificationToolMutatesProduction: false, ap02Changed: false, ap01IndependentlyRatified: false, b89Closed: false, b90Started: false },
  };
  writeJsonAtomic(path.join(reportDir, 'resource-model.json'), report);
  if (reportOutput) writeJsonAtomic(reportOutput, report);
  console.log(JSON.stringify({ status: report.status, report: path.relative(REPOSITORY_ROOT, path.join(reportDir, 'resource-model.json')).replaceAll(path.sep, '/'), historicalSummarySha256: summaryHash, fixtureCount: perCase.length, independentOutOfSample: independent !== null }));
  return ratified ? 0 : 1;
}

async function runIndependentProbe(filename) {
  const result = await runFileProbe(filename);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  if (mode === 'child') {
    const fixtureDir = options.fixtureDir ? resolveQualityOutput(options.fixtureDir, 'Fixture directory') : FIXTURE_ROOT;
    const result = await runNodeChild(options.caseId, fixtureDir);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (mode === 'browser-child') {
    const result = await runBrowserProfile(options.caseId);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (mode === 'probe-file') {
    await runIndependentProbe(options.file);
    return;
  }
  if (mode === 'ratify') {
    process.exitCode = await runModelRatification(options);
    return;
  }
  if (mode === 'smoke' || mode === 'run') {
    process.exitCode = await runCalibration(mode, options);
    return;
  }
  throw new Error('Usage: node --expose-gc tools/mp4-resource-calibration.mjs <smoke|run|ratify|probe-file> [options]');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${sanitize(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
