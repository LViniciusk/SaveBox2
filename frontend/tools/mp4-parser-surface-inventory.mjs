import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertExpectedMp4BoxVersion,
  FRONTEND_ROOT,
  REPOSITORY_ROOT,
  resolveMp4BoxVersion,
  writeJsonAtomic,
} from './mp4-resource-calibration-lib.mjs';

const require = createRequire(path.join(FRONTEND_ROOT, 'package.json'));
const OUTPUT_ROOT = path.join(REPOSITORY_ROOT, '.quality', 'b89-r3m2-ap01');
const FIXTURE_ROOT = path.join(REPOSITORY_ROOT, '.quality', 'mp4-resource-calibration', 'fixtures');
const FIXTURES = [
  'classic-faststart-v30-10k.mp4', 'classic-tail-v30-10k.mp4', 'classic-av-v30-10k.mp4',
  'classic-multitrack-v30-10k.mp4', 'fragmented-v30-10k.mp4', 'fragmented-av-v30-10k.mp4',
  'probe.mp4', 'fragment-probe.mp4',
];
const CONTAINERS = new Set(['trak', 'mdia', 'minf', 'stbl', 'traf', 'mvex', 'edts', 'dinf', 'udta', 'meta', 'ilst']);
const CONTAINER_PARENTS = {
  trak: 'moov', mdia: 'trak', minf: 'mdia', stbl: 'minf', traf: 'moof', mvex: 'moov',
  edts: 'trak', dinf: 'minf', udta: 'moov', meta: 'udta', ilst: 'meta',
};
const TOP_LEVEL_METADATA = new Set(['moov', 'moof', 'mfra']);
const TABLES = new Set(['stts', 'ctts', 'stsc', 'stco', 'co64', 'stss', 'sbgp', 'sgpd', 'elst', 'tfra', 'sidx']);
const MODELED = new Set([
  ...TABLES, 'stsz', 'stz2', 'trun', 'stsd', 'avcC', 'esds', 'elng', 'ftyp', 'styp', 'dref', 'hdlr',
]);
const SAFE_BOUNDED = new Set([
  'mvhd', 'tkhd', 'mdhd', 'vmhd', 'smhd', 'mfhd', 'tfhd', 'tfdt', 'trex', 'mfro',
  'btrt', 'pasp', 'data', 'url ',
]);
const SAFE_PARENTS = {
  mvhd: ['moov'], tkhd: ['trak'], mdhd: ['mdia'], vmhd: ['minf'],
  smhd: ['minf'], mfhd: ['moof'], tfhd: ['traf'], tfdt: ['traf'], trex: ['mvex'],
  mfro: ['mfra'], btrt: ['avc1', 'mp4a'], pasp: ['avc1'], data: ['©too'], 'url ': ['dref'],
};
const SAMPLE_ENTRIES_SUPPORTED = new Set(['avc1', 'mp4a']);
const SAMPLE_GROUPS_SUPPORTED = new Set(['roll']);
const OPAQUE_SAMPLE_ENTRY_PARENTS = new Set(['avc1', 'mp4a']);
const MODELED_PARENTS = {
  stts: ['stbl'], ctts: ['stbl'], stsc: ['stbl'], stco: ['stbl'], co64: ['stbl'], stss: ['stbl'],
  sbgp: ['stbl'], sgpd: ['stbl'], elst: ['edts'], tfra: ['mfra'], sidx: ['<root>'],
  stsz: ['stbl'], stz2: ['stbl'], trun: ['traf'], stsd: ['stbl'], avcC: ['avc1'],
  esds: ['mp4a'], elng: ['mdia'], ftyp: ['<root>'], styp: ['<root>'], dref: ['dinf'],
  hdlr: ['mdia', 'meta'],
};

export function decision(type, parent = undefined) {
  const topLevel = parent === undefined || parent === null || parent === '<root>';
  if (topLevel) {
    if (type === 'mdat') return 'media-payload-outside-metadata-guard';
    if (TOP_LEVEL_METADATA.has(type)) return 'supported-top-level-metadata';
  }
  if (CONTAINERS.has(type) && (topLevel || CONTAINER_PARENTS[type] === parent)) return 'supported-container';
  if (TOP_LEVEL_METADATA.has(type) && topLevel) return 'supported-top-level-metadata';
  if (parent === undefined && SAMPLE_ENTRIES_SUPPORTED.has(type)) return 'supported-H264/AAC-sample-entry';
  if (parent === 'stsd' && SAMPLE_ENTRIES_SUPPORTED.has(type)) return 'supported-H264/AAC-sample-entry';
  if (type === 'free' && (topLevel || CONTAINERS.has(parent) || OPAQUE_SAMPLE_ENTRY_PARENTS.has(parent))) return 'opaque-size-bounded';
  if (type === 'hdlr' && MODELED_PARENTS.hdlr.includes(parent)) return 'modeled-handler-string';
  if (MODELED.has(type) && (parent === undefined || !MODELED_PARENTS[type] || MODELED_PARENTS[type].includes(parent))) return 'modeled-expanding';
  if (SAFE_BOUNDED.has(type) && (parent === undefined || SAFE_PARENTS[type]?.includes(parent))) return 'safe-fixed-or-size-bounded';
  return 'unsupported';
}

function expansion(type, productionDecision) {
  if (productionDecision === 'supported-container') return 'recursive-container-with-depth-and-box-count-limits';
  if (productionDecision === 'supported-top-level-metadata') return 'top-level-metadata-handled-by-the-preflight-walker';
  if (productionDecision === 'supported-H264/AAC-sample-entry') return 'fixed-sample-entry-layout-with-explicit-child-policy';
  if (productionDecision === 'opaque-size-bounded') return 'opaque-payload-charged-to-metadata-byte-budget';
  if (productionDecision === 'modeled-handler-string') return 'fixed-handler-fields-and-in-child-NUL-terminator-checked-and-name-memory-charged-before-MP4Box';
  if (productionDecision === 'safe-fixed-or-size-bounded') return 'fixed-fields-or-box-size-bounded';
  if (productionDecision === 'media-payload-outside-metadata-guard') return 'media-payload-not-materialized-by-metadata-preflight';
  if (productionDecision === 'unsupported') return 'not-relied-on-production-rejects';
  if (TABLES.has(type) || ['stsz', 'stz2', 'trun'].includes(type)) return 'entry-or-sample-proportional-count-validated-before-parse';
  if (type === 'stsd') return 'sample-description-proportional-with-description-cap';
  if (type === 'esds') return 'descriptor-proportional-with-descriptor-cap';
  if (type === 'dref') return 'single-self-contained-url-reference-with-fixed-entry-count';
  if (type === 'avcC') return 'parameter-set-proportional-with-byte-and-count-bounds';
  if (['ftyp', 'styp'].includes(type)) return 'brand-array-proportional-with-brand-cap';
  return 'byte-or-box-size-bounded-by-metadata-limits';
}

function sourceModuleFor(className, sourceMap) {
  const token = `class ${className}`;
  const index = sourceMap.sourcesContent?.findIndex((source) => source.includes(token)) ?? -1;
  return index >= 0 ? sourceMap.sources[index] : null;
}

function parserRecord(type, Constructor, registry, sourceMap) {
  const productionDecision = decision(type);
  const prototype = Constructor?.prototype;
  return {
    type,
    parser: Constructor?.name ?? null,
    parserRegistry: registry,
    sourceModule: sourceModuleFor(Constructor?.name ?? '', sourceMap),
    prototypeMethods: prototype ? Object.getOwnPropertyNames(prototype).filter((name) => name !== 'constructor').sort() : [],
    productionDecision,
    expansion: expansion(type, productionDecision),
    reachableFromSupportedProfile: productionDecision !== 'unsupported',
    evidence: 'MP4Box 2.4.1 runtime BoxParser registry; source module is mapped only when present in the installed bundle source map.',
  };
}

function boxTree(file, fixture, records) {
  const visit = (box, parent = '<root>') => {
    if (typeof box?.type !== 'string') return;
    const key = `${parent}/${box.type}`;
    let record = records.get(key);
    if (!record) records.set(key, record = { box: box.type, parent, classification: decision(box.type, parent), countsByFixture: {} });
    record.countsByFixture[fixture] = (record.countsByFixture[fixture] ?? 0) + 1;
    for (const child of box.boxes ?? []) visit(child, box.type);
    if (['stsd', 'dref'].includes(box.type)) {
      for (const entry of box.entries ?? []) visit(entry, box.type);
    }
  };
  for (const box of file.boxes ?? []) visit(box);
}

async function parseFixture(MP4Box, filename) {
  const bytes = readFileSync(filename);
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  input.fileStart = 0;
  const file = MP4Box.createFile();
  await new Promise((resolve, reject) => {
    file.onReady = resolve;
    file.onError = (error) => reject(new Error(`MP4Box fixture parse failed: ${String(error)}`));
    file.appendBuffer(input, true);
    file.flush();
  });
  return { file, bytes: bytes.byteLength };
}

async function main() {
  const resolved = assertExpectedMp4BoxVersion(resolveMp4BoxVersion());
  const manifest = JSON.parse(readFileSync(path.join(FRONTEND_ROOT, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(readFileSync(path.join(FRONTEND_ROOT, 'package-lock.json'), 'utf8'));
  const lockedPackage = lockfile.packages?.['node_modules/mp4box'];
  if (manifest.dependencies?.mp4box !== '2.4.1') throw new Error('package.json must pin MP4Box exactly to 2.4.1.');
  if (lockedPackage?.version !== '2.4.1') throw new Error('package-lock.json must resolve MP4Box exactly to 2.4.1.');
  const entry = path.resolve(FRONTEND_ROOT, resolved.entry);
  const bundleSha256 = createHash('sha256').update(readFileSync(entry)).digest('hex');
  const sourceMap = JSON.parse(readFileSync(`${entry}.map`, 'utf8'));
  const MP4Box = require('mp4box');
  const registry = MP4Box.BoxParser;
  if (!registry?.box || !registry.sampleEntry || !registry.sampleGroupEntry) throw new Error('MP4Box parser registries are unavailable.');

  const boxes = Object.entries(registry.box).map(([type, Constructor]) => parserRecord(type, Constructor, 'BoxParser.box', sourceMap)).sort((a, b) => a.type.localeCompare(b.type));
  const sampleEntries = Object.entries(registry.sampleEntry).map(([type, Constructor]) => ({
    type, parser: Constructor.name, productionDecision: SAMPLE_ENTRIES_SUPPORTED.has(type) ? 'supported-H264/AAC-sample-entry' : 'unsupported',
  })).sort((a, b) => a.type.localeCompare(b.type));
  const sampleGroupEntries = Object.entries(registry.sampleGroupEntry).map(([type, Constructor]) => ({
    type, parser: Constructor.name, productionDecision: SAMPLE_GROUPS_SUPPORTED.has(type) ? 'supported-roll-only' : 'unsupported',
  })).sort((a, b) => a.type.localeCompare(b.type));
  const corpus = new Map();
  const fixtures = [];
  for (const name of FIXTURES) {
    const filename = path.join(FIXTURE_ROOT, name);
    const { file, bytes } = await parseFixture(MP4Box, filename);
    boxTree(file, name, corpus);
    fixtures.push({ file: name, bytes, trackCount: file.moov?.traks?.length ?? 0, sampleEntries: (file.moov?.traks ?? []).flatMap((track) => track.mdia?.minf?.stbl?.stsd?.entries?.map((entry) => entry.type) ?? []) });
  }
  const corpusInventory = [...corpus.values()].sort((a, b) => `${a.box}/${a.parent}`.localeCompare(`${b.box}/${b.parent}`));
  const corpusTypes = new Set(corpusInventory.map((item) => item.box));
  for (const item of boxes) item.corpusObserved = corpusTypes.has(item.type);

  const modeledExpanding = boxes.filter((item) => item.productionDecision === 'modeled-expanding').map((item) => item.type);
  const modeledHandlerStrings = boxes.filter((item) => item.productionDecision === 'modeled-handler-string').map((item) => item.type);
  const safeFixedOrSizeBounded = boxes.filter((item) => ['safe-fixed-or-size-bounded', 'opaque-size-bounded'].includes(item.productionDecision)).map((item) => item.type);
  const supportedContainers = boxes.filter((item) => item.productionDecision === 'supported-container').map((item) => item.type);
  const explicitlyUnsupported = boxes.filter((item) => item.productionDecision === 'unsupported').map((item) => item.type);
  writeJsonAtomic(path.join(OUTPUT_ROOT, 'mp4box-parser-surface.json'), {
    schema: 1, round: 'B.89-R3.M2', mp4box: { version: resolved.version, entry: resolved.entry, sha256: bundleSha256 },
    registryCounts: { boxes: boxes.length, sampleEntries: sampleEntries.length, sampleGroupEntries: sampleGroupEntries.length, uuidParsers: Object.keys(registry.uuid ?? {}).length },
    boxes, sampleEntries, sampleGroupEntries, uuidTypes: Object.keys(registry.uuid ?? {}).sort(),
    dynamicDispatch: ['BoxParser.box by fourcc', 'BoxParser.sampleEntry by stsd entry type', 'BoxParser.sampleGroupEntry by sgpd grouping type'],
  });
  writeJsonAtomic(path.join(OUTPUT_ROOT, 'supported-box-inventory.json'), {
    schema: 1, round: 'B.89-R3.M2', mp4boxVersion: resolved.version, mp4boxEntrySha256: bundleSha256,
    fixtureParser: 'MP4Box 2.4.1 runtime file.boxes tree; stsd and dref entries are traversed as typed child records.',
    fixtures, boxes: corpusInventory,
  });
  writeJsonAtomic(path.join(OUTPUT_ROOT, 'surface-classification.json'), {
    schema: 1, round: 'B.89-R3.M2', policy: 'fail-closed', mp4boxVersion: resolved.version,
    modeledExpanding, modeledHandlerStrings, safeFixedOrSizeBounded, supportedContainers,
    explicitlyUnsupported: [...explicitlyUnsupported, ...sampleEntries.filter((item) => item.productionDecision === 'unsupported').map((item) => `sampleEntry:${item.type}`), ...sampleGroupEntries.filter((item) => item.productionDecision === 'unsupported').map((item) => `sampleGroup:${item.type}`)].sort(),
    unknownAccepted: [],
    contextRules: { sampleEntries: [...SAMPLE_ENTRIES_SUPPORTED], sampleGroups: [...SAMPLE_GROUPS_SUPPORTED], modeledParents: MODELED_PARENTS, safeLeafParents: SAFE_PARENTS, containers: CONTAINER_PARENTS },
  });
  writeJsonAtomic(path.join(OUTPUT_ROOT, 'mp4box-version-contract.json'), {
    schema: 1,
    round: 'B.89-R3.M2',
    expectedVersion: '2.4.1',
    packageJsonRequirement: manifest.dependencies.mp4box,
    lockResolvedVersion: lockedPackage.version,
    lockResolvedTarball: lockedPackage.resolved,
    lockIntegrity: lockedPackage.integrity,
    runtimeResolvedVersion: resolved.version,
    entry: resolved.entry,
    entrySha256: bundleSha256,
    automatedEnforcement: {
      assertion: 'assertExpectedMp4BoxVersion',
      testFile: 'frontend/tools/mp4-resource-calibration.test.mjs',
      testName: 'resolved frontend MP4Box version is present and discoverable',
      ciWorkflow: '.github/workflows/frontend-ci.yml',
      ciStep: 'Verify MP4Box resource contract',
      ciCommand: 'npm run quality:mp4-resource:test',
    },
    verified: manifest.dependencies.mp4box === '2.4.1'
      && lockedPackage.version === '2.4.1'
      && resolved.version === '2.4.1',
  });
  process.stdout.write(`${JSON.stringify({ version: resolved.version, bundleSha256, boxCount: boxes.length, sampleEntryCount: sampleEntries.length, sampleGroupCount: sampleGroupEntries.length, corpusBoxContexts: corpusInventory.length, fixtures: fixtures.length, unknownAccepted: 0 })}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
}
