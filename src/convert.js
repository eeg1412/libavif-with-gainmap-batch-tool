const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { convertJpegGainMap } = require('libavif-with-gainmap');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULTS = {
  maxResolution: 1920,
  quality: 80,
  gainMapQuality: 70,
  stripMetadata: true,
  speed: 6,
  inputDir: 'input',
  outputDir: 'output',
  threads: 'all'
};

const FAILURE_FILE_NAME = 'failed-files.txt';
const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);

loadDotEnv(path.join(PROJECT_ROOT, '.env'));

main().catch((error) => {
  console.error(`Fatal error: ${formatError(error)}`);
  process.exitCode = 1;
});

async function main() {
  const config = readConfig();

  await fs.mkdir(config.inputDir, { recursive: true });
  await fs.mkdir(config.outputDir, { recursive: true });

  const files = await listJpegFiles(config.inputDir);
  const failureFile = path.join(config.outputDir, FAILURE_FILE_NAME);

  printConfig(config, files.length);

  if (files.length === 0) {
    await removeIfExists(failureFile);
    console.log('Success: 0');
    console.log('Failed: 0');
    return;
  }

  let successCount = 0;
  const failedFiles = [];

  for (const [index, inputFile] of files.entries()) {
    const relativeInput = path.relative(config.inputDir, inputFile);
    const outputFile = getOutputFilePath(config, relativeInput);

    console.log(`[${index + 1}/${files.length}] ${relativeInput} -> ${path.relative(config.outputDir, outputFile)}`);

    try {
      await fs.mkdir(path.dirname(outputFile), { recursive: true });

      // maxWidth/maxHeight 会等比缩小图片，让长边不超过 MAX_RESOLUTION。
      await convertJpegGainMap(inputFile, outputFile, {
        quality: config.quality,
        gainMapQuality: config.gainMapQuality,
        stripMetadata: config.stripMetadata,
        maxWidth: config.maxResolution,
        maxHeight: config.maxResolution,
        speed: config.speed,
        jobs: config.threads
      });

      successCount += 1;
    } catch (error) {
      failedFiles.push(relativeInput);
      console.error(`  Failed: ${formatError(error)}`);
    }
  }

  if (failedFiles.length > 0) {
    await fs.writeFile(failureFile, `${failedFiles.join(os.EOL)}${os.EOL}`, 'utf8');
    console.log(`Failed file list: ${failureFile}`);
  } else {
    await removeIfExists(failureFile);
  }

  console.log('Done.');
  console.log(`Success: ${successCount}`);
  console.log(`Failed: ${failedFiles.length}`);

  if (failedFiles.length > 0) {
    process.exitCode = 1;
  }
}

function readConfig() {
  const maxResolution = readPositiveInteger('MAX_RESOLUTION', DEFAULTS.maxResolution);
  const quality = readIntegerInRange('QUALITY', DEFAULTS.quality, 0, 100);
  const gainMapQuality = readIntegerInRange(
    'GAIN_MAP_QUALITY',
    DEFAULTS.gainMapQuality,
    0,
    100
  );
  const stripMetadata = readBoolean('STRIP_METADATA', DEFAULTS.stripMetadata);
  const speed = readIntegerInRange('SPEED', DEFAULTS.speed, 0, 10);

  return {
    maxResolution,
    quality,
    gainMapQuality,
    stripMetadata,
    speed,
    inputDir: resolveProjectPath(process.env.INPUT_DIR, DEFAULTS.inputDir),
    outputDir: resolveProjectPath(process.env.OUTPUT_DIR, DEFAULTS.outputDir),
    threads: readThreads()
  };
}

function readPositiveInteger(name, defaultValue) {
  const value = readEnv(name);

  if (!value) {
    return defaultValue;
  }

  const numberValue = Number(value);

  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return numberValue;
}

function readIntegerInRange(name, defaultValue, min, max) {
  const value = readEnv(name);

  if (!value) {
    return defaultValue;
  }

  const numberValue = Number(value);

  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }

  return numberValue;
}

function readBoolean(name, defaultValue) {
  const value = readEnv(name);

  if (!value) {
    return defaultValue;
  }

  const normalized = value.toLowerCase();

  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  throw new Error(`${name} must be true or false.`);
}

function readThreads() {
  const value = readEnv('THREADS') || DEFAULTS.threads;

  if (value.toLowerCase() === 'all') {
    return 'all';
  }

  const numberValue = Number(value);

  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error('THREADS must be all or a positive integer.');
  }

  return numberValue;
}

function resolveProjectPath(value, fallback) {
  const rawPath = value && value.trim() ? value.trim() : fallback;

  if (path.isAbsolute(rawPath)) {
    return path.normalize(rawPath);
  }

  return path.resolve(PROJECT_ROOT, rawPath);
}

function readEnv(name) {
  const value = process.env[name];
  return value === undefined ? '' : value.trim();
}

function loadDotEnv(filePath) {
  if (!fsSync.existsSync(filePath)) {
    return;
  }

  const content = fsSync.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = unquoteEnvValue(trimmed.slice(separatorIndex + 1).trim());

    // 系统环境变量优先级高于 .env，方便在 CI 或命令行里临时覆盖配置。
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function unquoteEnvValue(value) {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];

  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }

  return value;
}

async function listJpegFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await listJpegFiles(fullPath));
      continue;
    }

    if (entry.isFile() && JPEG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function getOutputFilePath(config, relativeInput) {
  const parsed = path.parse(relativeInput);
  return path.join(config.outputDir, parsed.dir, `${parsed.name}.avif`);
}

async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function printConfig(config, fileCount) {
  console.log('libavif-with-gainmap batch convert');
  console.log(`Input dir: ${config.inputDir}`);
  console.log(`Output dir: ${config.outputDir}`);
  console.log(`Max resolution: ${config.maxResolution}`);
  console.log(`Quality: ${config.quality}`);
  console.log(`GainMap quality: ${config.gainMapQuality}`);
  console.log(`Strip metadata: ${config.stripMetadata}`);
  console.log(`Speed: ${config.speed}`);
  console.log(`Threads: ${config.threads}`);
  console.log(`JPG files: ${fileCount}`);
  console.log('');
}

function formatError(error) {
  if (!error) {
    return 'Unknown error';
  }

  if (error.stderr) {
    return String(error.stderr).trim();
  }

  if (error.message) {
    return error.message;
  }

  return String(error);
}
