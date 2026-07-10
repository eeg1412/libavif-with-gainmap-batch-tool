'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { convertJpegGainMap } = require('libavif-with-gainmap');

const DEFAULTS = Object.freeze({
  maxResolution: 1920,
  quality: 80,
  gainMapQuality: 85,
  stripMetadata: true,
  speed: 6,
  threads: 'all'
});

const FAILURE_FILE_NAME = 'failed-files.txt';
const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);

function normalizeConfig(rawConfig = {}) {
  return {
    inputDir: requireDirectoryPath('inputDir', rawConfig.inputDir),
    outputDir: requireDirectoryPath('outputDir', rawConfig.outputDir),
    maxResolution: integerInRange(
      'maxResolution',
      rawConfig.maxResolution ?? DEFAULTS.maxResolution,
      1,
      65535
    ),
    quality: integerInRange('quality', rawConfig.quality ?? DEFAULTS.quality, 0, 100),
    gainMapQuality: integerInRange(
      'gainMapQuality',
      rawConfig.gainMapQuality ?? DEFAULTS.gainMapQuality,
      0,
      100
    ),
    stripMetadata: booleanValue(
      'stripMetadata',
      rawConfig.stripMetadata ?? DEFAULTS.stripMetadata
    ),
    speed: integerInRange('speed', rawConfig.speed ?? DEFAULTS.speed, 0, 10),
    threads: normalizeThreads(rawConfig.threads ?? DEFAULTS.threads),
    binDir: optionalPath(rawConfig.binDir)
  };
}

async function convertBatch(rawConfig, options = {}) {
  const config = normalizeConfig(rawConfig);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const convert = options.convert || convertJpegGainMap;
  const signal = options.signal;

  throwIfAborted(signal);
  await fs.mkdir(config.inputDir, { recursive: true });
  await fs.mkdir(config.outputDir, { recursive: true });

  onProgress({ type: 'scanning' });
  const files = await listJpegFiles(config.inputDir, signal);
  const failureFile = path.join(config.outputDir, FAILURE_FILE_NAME);
  const result = {
    total: files.length,
    processed: 0,
    successCount: 0,
    failedCount: 0,
    cancelled: false,
    failures: [],
    outputDir: config.outputDir
  };

  onProgress({ type: 'ready', total: files.length });

  for (const [index, inputFile] of files.entries()) {
    if (signal?.aborted) {
      result.cancelled = true;
      break;
    }

    const relativeInput = path.relative(config.inputDir, inputFile);
    const outputFile = getOutputFilePath(config.outputDir, relativeInput);
    const baseEvent = {
      index: index + 1,
      total: files.length,
      inputFile,
      outputFile,
      relativeInput
    };

    onProgress({ type: 'file-start', ...baseEvent });

    try {
      await fs.mkdir(path.dirname(outputFile), { recursive: true });
      await convert(inputFile, outputFile, {
        quality: config.quality,
        gainMapQuality: config.gainMapQuality,
        stripMetadata: config.stripMetadata,
        maxWidth: config.maxResolution,
        maxHeight: config.maxResolution,
        speed: config.speed,
        jobs: config.threads,
        signal,
        binDir: config.binDir
      });

      result.successCount += 1;
      onProgress({
        type: 'file-success',
        ...baseEvent,
        processed: index + 1,
        successCount: result.successCount,
        failedCount: result.failedCount
      });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        result.cancelled = true;
        break;
      }

      const failure = { file: relativeInput, error: formatError(error) };
      result.failures.push(failure);
      result.failedCount += 1;
      onProgress({
        type: 'file-error',
        ...baseEvent,
        processed: index + 1,
        successCount: result.successCount,
        failedCount: result.failedCount,
        error: failure.error
      });
    }

    result.processed = index + 1;
  }

  if (result.failures.length > 0) {
    const content = result.failures
      .map(({ file, error }) => `${file}\t${error}`)
      .join(os.EOL);
    await fs.writeFile(failureFile, `${content}${os.EOL}`, 'utf8');
  } else {
    await removeIfExists(failureFile);
  }

  onProgress({ type: 'complete', ...result });
  return result;
}

async function listJpegFiles(directory, signal) {
  throwIfAborted(signal);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    throwIfAborted(signal);
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await listJpegFiles(fullPath, signal));
    } else if (entry.isFile() && JPEG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function getOutputFilePath(outputDir, relativeInput) {
  const parsed = path.parse(relativeInput);
  return path.join(outputDir, parsed.dir, `${parsed.name}.avif`);
}

function requireDirectoryPath(name, value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} is required.`);
  }
  return path.resolve(value.trim());
}

function optionalPath(value) {
  return typeof value === 'string' && value.trim() ? path.resolve(value.trim()) : undefined;
}

function integerInRange(name, value, min, max) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function booleanValue(name, value) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be true or false.`);
  }
  return value;
}

function normalizeThreads(value) {
  if (String(value).toLowerCase() === 'all') {
    return 'all';
  }
  return integerInRange('threads', value, 1, 1024);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Conversion cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function formatError(error) {
  if (!error) return 'Unknown error';
  if (error.stderr && String(error.stderr).trim()) return String(error.stderr).trim();
  if (error.message) return error.message;
  return String(error);
}

async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

module.exports = {
  DEFAULTS,
  FAILURE_FILE_NAME,
  convertBatch,
  formatError,
  getOutputFilePath,
  listJpegFiles,
  normalizeConfig
};
