'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS, convertBatch, formatError, normalizeConfig } = require('./core/converter');

const PROJECT_ROOT = path.resolve(__dirname, '..');
loadDotEnv(path.join(PROJECT_ROOT, '.env'));

main().catch((error) => {
  console.error(`Fatal error: ${formatError(error)}`);
  process.exitCode = 1;
});

async function main() {
  const config = readConfig();
  printConfig(config);

  const result = await convertBatch(config, {
    onProgress(event) {
      if (event.type === 'ready') console.log(`Image files: ${event.total}\n`);
      if (event.type === 'file-start') {
        console.log(`[${event.index}/${event.total}] ${event.relativeInput}`);
      }
      if (event.type === 'file-error') console.error(`  Failed: ${event.error}`);
    }
  });

  console.log('Done.');
  console.log(`Success: ${result.successCount}`);
  console.log(`Failed: ${result.failedCount}`);
  if (result.collisionCount > 0) {
    console.log(`Safely renamed outputs: ${result.collisionCount}`);
  }
  if (result.failedCount > 0) process.exitCode = 1;
}

function readConfig() {
  return normalizeConfig({
    staticFormat: readEnv('STATIC_FORMAT') || DEFAULTS.staticFormat,
    staticQuality: readEnv('STATIC_QUALITY') || readEnv('QUALITY') || DEFAULTS.staticQuality,
    staticMaxResolution:
      readEnv('STATIC_MAX_RESOLUTION') || readEnv('MAX_RESOLUTION') || DEFAULTS.staticMaxResolution,
    animatedFormat: readEnv('ANIMATED_FORMAT') || DEFAULTS.animatedFormat,
    animatedQuality:
      readEnv('ANIMATED_QUALITY') || readEnv('QUALITY') || DEFAULTS.animatedQuality,
    animatedMaxResolution:
      readEnv('ANIMATED_MAX_RESOLUTION') || readEnv('MAX_RESOLUTION') || DEFAULTS.animatedMaxResolution,
    gainMapFormat: readEnv('GAIN_MAP_FORMAT') || DEFAULTS.gainMapFormat,
    gainMapBaseQuality:
      readEnv('GAIN_MAP_BASE_QUALITY') || readEnv('QUALITY') || DEFAULTS.gainMapBaseQuality,
    gainMapQuality: readEnv('GAIN_MAP_QUALITY') || DEFAULTS.gainMapQuality,
    gainMapMaxResolution:
      readEnv('GAIN_MAP_MAX_RESOLUTION') || readEnv('MAX_RESOLUTION') || DEFAULTS.gainMapMaxResolution,
    preserveMetadata: readMetadataSetting(),
    speed: readEnv('SPEED') || DEFAULTS.speed,
    inputDir: resolveProjectPath(readEnv('INPUT_DIR') || 'input'),
    outputDir: resolveProjectPath(readEnv('OUTPUT_DIR') || 'output'),
    threads: readEnv('THREADS') || DEFAULTS.threads,
    binDir: readEnv('AVIF_GAINMAP_BIN_DIR') || undefined
  });
}

function readMetadataSetting() {
  if (readEnv('PRESERVE_METADATA')) {
    return readBoolean('PRESERVE_METADATA', DEFAULTS.preserveMetadata);
  }
  if (readEnv('STRIP_METADATA')) {
    return !readBoolean('STRIP_METADATA', !DEFAULTS.preserveMetadata);
  }
  return DEFAULTS.preserveMetadata;
}

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(PROJECT_ROOT, value);
}

function readEnv(name) {
  return process.env[name]?.trim() || '';
}

function readBoolean(name, fallback) {
  const value = readEnv(name).toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function printConfig(config) {
  console.log('博客图片压缩工具');
  console.log(`Input dir: ${config.inputDir}`);
  console.log(`Output dir: ${config.outputDir}`);
  console.log(`Static: ${config.staticFormat}, quality ${config.staticQuality}, max ${config.staticMaxResolution}px`);
  console.log(`Animated: ${config.animatedFormat}, quality ${config.animatedQuality}, max ${config.animatedMaxResolution}px`);
  console.log(`Gain map: ${config.gainMapFormat}, base quality ${config.gainMapBaseQuality}, max ${config.gainMapMaxResolution}px`);
  console.log(`Gain map quality: ${config.gainMapQuality}`);
  console.log(`Preserve metadata: ${config.preserveMetadata}`);
  console.log(`Speed: ${config.speed}`);
  console.log(`Threads: ${config.threads}`);
}
