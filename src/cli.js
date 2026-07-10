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
      if (event.type === 'ready') console.log(`JPG files: ${event.total}\n`);
      if (event.type === 'file-start') {
        console.log(`[${event.index}/${event.total}] ${event.relativeInput}`);
      }
      if (event.type === 'file-error') console.error(`  Failed: ${event.error}`);
    }
  });

  console.log('Done.');
  console.log(`Success: ${result.successCount}`);
  console.log(`Failed: ${result.failedCount}`);
  if (result.failedCount > 0) process.exitCode = 1;
}

function readConfig() {
  return normalizeConfig({
    maxResolution: readEnv('MAX_RESOLUTION') || DEFAULTS.maxResolution,
    quality: readEnv('QUALITY') || DEFAULTS.quality,
    gainMapQuality: readEnv('GAIN_MAP_QUALITY') || DEFAULTS.gainMapQuality,
    stripMetadata: readBoolean('STRIP_METADATA', DEFAULTS.stripMetadata),
    speed: readEnv('SPEED') || DEFAULTS.speed,
    inputDir: resolveProjectPath(readEnv('INPUT_DIR') || 'input'),
    outputDir: resolveProjectPath(readEnv('OUTPUT_DIR') || 'output'),
    threads: readEnv('THREADS') || DEFAULTS.threads,
    binDir: readEnv('AVIF_GAINMAP_BIN_DIR') || undefined
  });
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
  console.log('libavif-with-gainmap batch converter');
  console.log(`Input dir: ${config.inputDir}`);
  console.log(`Output dir: ${config.outputDir}`);
  console.log(`Max resolution: ${config.maxResolution}`);
  console.log(`Quality: ${config.quality}`);
  console.log(`Gain map quality: ${config.gainMapQuality}`);
  console.log(`Strip metadata: ${config.stripMetadata}`);
  console.log(`Speed: ${config.speed}`);
  console.log(`Threads: ${config.threads}`);
}
