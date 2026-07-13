'use strict';

const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const {
  convertJpegGainMap,
  probeJpegGainMap
} = require('libavif-with-gainmap');

const DEFAULTS = Object.freeze({
  staticFormat: 'webp',
  staticQuality: 80,
  staticMaxResolution: 1920,
  animatedFormat: 'webp',
  animatedQuality: 80,
  animatedMaxResolution: 1920,
  gainMapFormat: 'avif',
  gainMapBaseQuality: 80,
  gainMapQuality: 85,
  gainMapMaxResolution: 1920,
  preserveMetadata: false,
  speed: 6,
  threads: 'all'
});

const FAILURE_FILE_NAME = 'failed-files.txt';
const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);
const IMAGE_EXTENSIONS = new Set([
  ...JPEG_EXTENSIONS,
  '.png', '.webp', '.gif', '.avif', '.tif', '.tiff'
]);

function normalizeConfig(rawConfig = {}) {
  return {
    inputDir: requireDirectoryPath('inputDir', rawConfig.inputDir),
    outputDir: requireDirectoryPath('outputDir', rawConfig.outputDir),
    staticFormat: enumValue(
      'staticFormat',
      rawConfig.staticFormat ?? DEFAULTS.staticFormat,
      ['webp', 'avif']
    ),
    staticQuality: sharpQualityValue(
      'staticQuality',
      rawConfig.staticQuality ?? DEFAULTS.staticQuality
    ),
    staticMaxResolution: resolutionValue(
      'staticMaxResolution',
      rawConfig.staticMaxResolution ?? DEFAULTS.staticMaxResolution
    ),
    animatedFormat: enumValue(
      'animatedFormat',
      rawConfig.animatedFormat ?? DEFAULTS.animatedFormat,
      ['webp']
    ),
    animatedQuality: sharpQualityValue(
      'animatedQuality',
      rawConfig.animatedQuality ?? DEFAULTS.animatedQuality
    ),
    animatedMaxResolution: resolutionValue(
      'animatedMaxResolution',
      rawConfig.animatedMaxResolution ?? DEFAULTS.animatedMaxResolution
    ),
    gainMapFormat: enumValue(
      'gainMapFormat',
      rawConfig.gainMapFormat ?? DEFAULTS.gainMapFormat,
      ['avif']
    ),
    gainMapBaseQuality: qualityValue(
      'gainMapBaseQuality',
      rawConfig.gainMapBaseQuality ?? DEFAULTS.gainMapBaseQuality
    ),
    gainMapQuality: qualityValue(
      'gainMapQuality',
      rawConfig.gainMapQuality ?? DEFAULTS.gainMapQuality
    ),
    gainMapMaxResolution: resolutionValue(
      'gainMapMaxResolution',
      rawConfig.gainMapMaxResolution ?? DEFAULTS.gainMapMaxResolution
    ),
    preserveMetadata: booleanValue(
      'preserveMetadata',
      rawConfig.preserveMetadata ?? DEFAULTS.preserveMetadata
    ),
    speed: integerInRange('speed', rawConfig.speed ?? DEFAULTS.speed, 0, 10),
    threads: normalizeThreads(rawConfig.threads ?? DEFAULTS.threads),
    binDir: optionalPath(rawConfig.binDir)
  };
}

async function convertBatch(rawConfig, options = {}) {
  const config = normalizeConfig(rawConfig);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const dependencies = {
    sharpFactory: options.sharpFactory || sharp,
    probeGainMap: options.probeGainMap || probeJpegGainMap,
    convertGainMap: options.convertGainMap || options.convert || convertJpegGainMap
  };
  const signal = options.signal;

  throwIfAborted(signal);
  if (samePath(config.inputDir, config.outputDir)) {
    throw new Error('输入文件夹和输出文件夹不能相同。');
  }
  await fs.mkdir(config.inputDir, { recursive: true });
  await fs.mkdir(config.outputDir, { recursive: true });

  onProgress({ type: 'scanning' });
  const files = await listImageFiles(config.inputDir, signal, {
    excludeDirectory: isPathInside(config.outputDir, config.inputDir)
      ? config.outputDir
      : undefined
  });
  const failureFile = path.join(config.outputDir, FAILURE_FILE_NAME);
  const claimedOutputs = new Set();
  const result = {
    total: files.length,
    processed: 0,
    successCount: 0,
    failedCount: 0,
    cancelled: false,
    failures: [],
    collisionCount: 0,
    typeCounts: { static: 0, animated: 0, gainmap: 0 },
    outputDir: config.outputDir
  };

  onProgress({ type: 'ready', total: files.length });

  for (const [index, inputFile] of files.entries()) {
    if (signal?.aborted) {
      result.cancelled = true;
      break;
    }

    const relativeInput = path.relative(config.inputDir, inputFile);
    const baseEvent = {
      index: index + 1,
      total: files.length,
      inputFile,
      relativeInput
    };

    onProgress({ type: 'file-start', ...baseEvent });

    let temporaryFile;
    try {
      const image = await inspectImage(inputFile, config, dependencies, signal);
      const { outputFile, renamed } = claimOutputFilePath(
        config.outputDir,
        relativeInput,
        image.outputFormat,
        claimedOutputs
      );
      await fs.mkdir(path.dirname(outputFile), { recursive: true });
      temporaryFile = getTemporaryOutputFilePath(outputFile);

      if (image.type === 'gainmap') {
        await convertGainMapImage(inputFile, temporaryFile, config, dependencies, signal);
      } else if (image.type === 'animated') {
        await convertAnimatedImage(
          inputFile,
          temporaryFile,
          image.metadata,
          config,
          dependencies,
          signal
        );
      } else {
        await convertStaticImage(inputFile, temporaryFile, config, dependencies, signal);
      }

      throwIfAborted(signal);
      await commitOutputFile(temporaryFile, outputFile);
      temporaryFile = undefined;
      result.successCount += 1;
      if (renamed) result.collisionCount += 1;
      result.typeCounts[image.type] += 1;
      onProgress({
        type: 'file-success',
        ...baseEvent,
        outputFile,
        relativeOutput: path.relative(config.outputDir, outputFile),
        renamedOutput: renamed,
        imageType: image.type,
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
    } finally {
      if (temporaryFile) await removeIfExists(temporaryFile);
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

async function inspectImage(inputFile, config, dependencies, signal) {
  throwIfAborted(signal);
  const metadata = await dependencies.sharpFactory(inputFile).metadata();

  if (metadata.format === 'jpeg') {
    const probe = await dependencies.probeGainMap(inputFile, {
      jobs: config.threads,
      signal,
      binDir: config.binDir
    });
    if (probe.hasGainMap) {
      return { type: 'gainmap', outputFormat: config.gainMapFormat, metadata: probe };
    }
  }

  if (metadata.format === 'gif' && Number(metadata.pages) > 1) {
    return { type: 'animated', outputFormat: config.animatedFormat, metadata };
  }
  return { type: 'static', outputFormat: config.staticFormat, metadata };
}

async function convertStaticImage(inputFile, outputFile, config, dependencies, signal) {
  throwIfAborted(signal);
  let pipeline = dependencies.sharpFactory(inputFile)
    .autoOrient()
    .resize({
      width: config.staticMaxResolution,
      height: config.staticMaxResolution,
      fit: 'inside',
      withoutEnlargement: true
    });

  if (config.preserveMetadata) pipeline = pipeline.keepMetadata();
  pipeline = config.staticFormat === 'avif'
    ? pipeline.avif({ quality: config.staticQuality })
    : pipeline.webp({ quality: config.staticQuality });
  await pipeline.toFile(outputFile);
}

async function convertAnimatedImage(
  inputFile,
  outputFile,
  metadata,
  config,
  dependencies,
  signal
) {
  throwIfAborted(signal);
  let pipeline = dependencies.sharpFactory(inputFile, { animated: true }).autoOrient();
  const frameWidth = Number(metadata.width);
  const frameHeight = Number(metadata.pageHeight || metadata.height);
  if (!Number.isFinite(frameWidth) || frameWidth < 1 ||
      !Number.isFinite(frameHeight) || frameHeight < 1) {
    throw new Error('动画 GIF 的帧尺寸无效。');
  }
  const longestEdge = Math.max(frameWidth, frameHeight);

  if (Number.isFinite(longestEdge) && longestEdge > config.animatedMaxResolution) {
    const targetWidth = Math.max(
      1,
      Math.round(frameWidth * config.animatedMaxResolution / longestEdge)
    );
    pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: true });
  }

  if (config.preserveMetadata) pipeline = pipeline.keepMetadata();
  const webpOptions = {
    quality: config.animatedQuality,
    loop: normalizeAnimationLoop(metadata.loop)
  };
  const delays = normalizeAnimationDelays(metadata.delay, metadata.pages);
  if (delays) webpOptions.delay = delays;
  await pipeline.webp(webpOptions).toFile(outputFile);
}

async function convertGainMapImage(inputFile, outputFile, config, dependencies, signal) {
  throwIfAborted(signal);
  await dependencies.convertGainMap(inputFile, outputFile, {
    quality: config.gainMapBaseQuality,
    gainMapQuality: config.gainMapQuality,
    stripMetadata: !config.preserveMetadata,
    maxWidth: config.gainMapMaxResolution,
    maxHeight: config.gainMapMaxResolution,
    speed: config.speed,
    jobs: config.threads,
    signal,
    binDir: config.binDir
  });
}

async function listImageFiles(directory, signal, options = {}) {
  throwIfAborted(signal);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    throwIfAborted(signal);
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!samePath(fullPath, options.excludeDirectory)) {
        files.push(...await listImageFiles(fullPath, signal, options));
      }
    } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function getOutputFilePath(outputDir, relativeInput, outputFormat = 'avif') {
  const parsed = path.parse(relativeInput);
  return path.join(outputDir, parsed.dir, `${parsed.name}.${outputFormat}`);
}

function claimOutputFilePath(outputDir, relativeInput, outputFormat, claimedOutputs) {
  const parsed = path.parse(relativeInput);
  const preferred = getOutputFilePath(outputDir, relativeInput, outputFormat);
  if (claimPath(preferred, claimedOutputs)) {
    return { outputFile: preferred, renamed: false };
  }

  const sourceType = parsed.ext.slice(1).toLowerCase() || 'image';
  let suffix = sourceType;
  let attempt = 1;
  while (true) {
    const outputFile = path.join(
      outputDir,
      parsed.dir,
      `${parsed.name}-${suffix}.${outputFormat}`
    );
    if (claimPath(outputFile, claimedOutputs)) {
      return { outputFile, renamed: true };
    }
    attempt += 1;
    suffix = `${sourceType}-${attempt}`;
  }
}

function claimPath(filePath, claimedOutputs) {
  const key = comparablePath(filePath);
  if (claimedOutputs.has(key)) return false;
  claimedOutputs.add(key);
  return true;
}

function getTemporaryOutputFilePath(outputFile) {
  const parsed = path.parse(outputFile);
  return path.join(parsed.dir, `.${parsed.name}.${randomUUID()}.tmp${parsed.ext}`);
}

async function commitOutputFile(temporaryFile, outputFile) {
  try {
    await fs.rename(temporaryFile, outputFile);
    return;
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
  }

  const backupFile = `${outputFile}.${randomUUID()}.backup`;
  let hasBackup = false;
  try {
    await fs.rename(outputFile, backupFile);
    hasBackup = true;
    await fs.rename(temporaryFile, outputFile);
    await removeIfExists(backupFile);
  } catch (error) {
    if (hasBackup) {
      await removeIfExists(outputFile);
      await fs.rename(backupFile, outputFile);
    }
    throw error;
  }
}

function normalizeAnimationLoop(value) {
  const loop = Number(value);
  if (!Number.isInteger(loop) || loop < 0) return 1;
  return Math.min(loop, 65535);
}

function normalizeAnimationDelays(value, pages) {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const expectedPages = Number(pages);
  if (Number.isInteger(expectedPages) && expectedPages > 0 && value.length !== expectedPages) {
    return undefined;
  }
  const delays = value.map(Number);
  return delays.every((delay) => Number.isInteger(delay) && delay >= 0)
    ? delays
    : undefined;
}

function comparablePath(value) {
  if (!value) return '';
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(first, second) {
  return Boolean(first && second) && comparablePath(first) === comparablePath(second);
}

function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
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

function qualityValue(name, value) {
  return integerInRange(name, value, 0, 100);
}

function sharpQualityValue(name, value) {
  return integerInRange(name, value, 1, 100);
}

function resolutionValue(name, value) {
  return integerInRange(name, value, 1, 65535);
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

function enumValue(name, value, allowed) {
  const normalized = String(value).toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new RangeError(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return normalized;
}

function normalizeThreads(value) {
  if (String(value).toLowerCase() === 'all') return 'all';
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
  convertAnimatedImage,
  convertStaticImage,
  formatError,
  getOutputFilePath,
  claimOutputFilePath,
  inspectImage,
  isPathInside,
  listImageFiles,
  normalizeAnimationDelays,
  normalizeAnimationLoop,
  normalizeConfig
};
