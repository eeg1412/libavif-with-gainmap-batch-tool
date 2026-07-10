'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  FAILURE_FILE_NAME,
  convertBatch,
  getOutputFilePath,
  normalizeConfig
} = require('../src/core/converter');

test('normalizeConfig applies defaults and resolves directories', () => {
  const config = normalizeConfig({ inputDir: 'input', outputDir: 'output' });
  assert.equal(config.quality, 80);
  assert.equal(config.gainMapQuality, 85);
  assert.equal(config.maxResolution, 1920);
  assert.equal(config.threads, 'all');
  assert.ok(path.isAbsolute(config.inputDir));
  assert.ok(path.isAbsolute(config.outputDir));
});

test('normalizeConfig rejects invalid values', () => {
  assert.throws(
    () => normalizeConfig({ inputDir: 'input', outputDir: 'output', quality: 101 }),
    /quality must be an integer from 0 to 100/
  );
  assert.throws(
    () => normalizeConfig({ inputDir: '', outputDir: 'output' }),
    /inputDir is required/
  );
});

test('getOutputFilePath preserves nested directories and changes extension', () => {
  assert.equal(
    getOutputFilePath(path.join('C:', 'out'), path.join('nested', 'photo.jpeg')),
    path.join('C:', 'out', 'nested', 'photo.avif')
  );
});

test('convertBatch converts nested JPEG files and reports progress', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avif-batch-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  await fs.mkdir(path.join(inputDir, 'nested'), { recursive: true });
  await fs.writeFile(path.join(inputDir, 'one.jpg'), 'jpeg');
  await fs.writeFile(path.join(inputDir, 'nested', 'two.JPEG'), 'jpeg');
  await fs.writeFile(path.join(inputDir, 'ignore.png'), 'png');

  const events = [];
  const result = await convertBatch(
    { inputDir, outputDir },
    {
      onProgress: (event) => events.push(event.type),
      convert: async (_input, output) => fs.writeFile(output, 'avif')
    }
  );

  assert.equal(result.total, 2);
  assert.equal(result.successCount, 2);
  assert.equal(result.failedCount, 0);
  assert.equal(await fs.readFile(path.join(outputDir, 'one.avif'), 'utf8'), 'avif');
  assert.equal(await fs.readFile(path.join(outputDir, 'nested', 'two.avif'), 'utf8'), 'avif');
  assert.deepEqual(events, [
    'scanning', 'ready', 'file-start', 'file-success',
    'file-start', 'file-success', 'complete'
  ]);
});

test('convertBatch continues after a failed file and writes failure details', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avif-batch-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(path.join(inputDir, 'broken.jpg'), 'jpeg');

  const result = await convertBatch(
    { inputDir, outputDir },
    { convert: async () => { throw new Error('invalid gain map'); } }
  );

  assert.equal(result.failedCount, 1);
  assert.match(
    await fs.readFile(path.join(outputDir, FAILURE_FILE_NAME), 'utf8'),
    /broken\.jpg\tinvalid gain map/
  );
});
