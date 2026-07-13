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
  inspectImage,
  isPathInside,
  normalizeAnimationDelays,
  normalizeAnimationLoop,
  normalizeConfig
} = require('../src/core/converter');

test('normalizeConfig applies workflow defaults and resolves directories', () => {
  const config = normalizeConfig({ inputDir: 'input', outputDir: 'output' });
  assert.equal(config.staticFormat, 'webp');
  assert.equal(config.staticQuality, 80);
  assert.equal(config.staticMaxResolution, 1920);
  assert.equal(config.animatedFormat, 'webp');
  assert.equal(config.gainMapFormat, 'avif');
  assert.equal(config.gainMapBaseQuality, 80);
  assert.equal(config.gainMapQuality, 85);
  assert.equal(config.preserveMetadata, false);
  assert.ok(path.isAbsolute(config.inputDir));
  assert.ok(path.isAbsolute(config.outputDir));
});

test('normalizeConfig rejects invalid values and unsupported formats', () => {
  assert.throws(
    () => normalizeConfig({ inputDir: 'input', outputDir: 'output', animatedQuality: 0 }),
    /animatedQuality must be an integer from 1 to 100/
  );
  assert.throws(
    () => normalizeConfig({ inputDir: 'input', outputDir: 'output', staticQuality: 101 }),
    /staticQuality must be an integer from 0 to 100/
  );
  assert.throws(
    () => normalizeConfig({ inputDir: 'input', outputDir: 'output', animatedFormat: 'avif' }),
    /animatedFormat must be one of: webp/
  );
});

test('animation settings preserve finite, infinite and single-play semantics', () => {
  assert.equal(normalizeAnimationLoop(0), 0);
  assert.equal(normalizeAnimationLoop(4), 4);
  assert.equal(normalizeAnimationLoop(undefined), 1);
  assert.deepEqual(normalizeAnimationDelays([40, 80, 120], 3), [40, 80, 120]);
  assert.equal(normalizeAnimationDelays([40, 80], 3), undefined);
  assert.equal(normalizeAnimationDelays([40, -1, 80], 3), undefined);
});

test('path safety detects nested output directories', () => {
  assert.equal(isPathInside(path.join('C:', 'images', 'output'), path.join('C:', 'images')), true);
  assert.equal(isPathInside(path.join('C:', 'other'), path.join('C:', 'images')), false);
});

test('getOutputFilePath preserves nested directories and uses selected extension', () => {
  assert.equal(
    getOutputFilePath(path.join('C:', 'out'), path.join('nested', 'photo.jpeg'), 'webp'),
    path.join('C:', 'out', 'nested', 'photo.webp')
  );
});

test('inspectImage prioritizes JPEG gain map and detects animated GIF frames', async () => {
  const config = normalizeConfig({ inputDir: 'input', outputDir: 'output' });
  const gainmap = await inspectImage('hdr.jpg', config, {
    probeGainMap: async () => ({ hasGainMap: true }),
    sharpFactory: () => ({ metadata: async () => ({ format: 'jpeg', width: 1600, height: 900 }) })
  });
  assert.equal(gainmap.type, 'gainmap');

  const animated = await inspectImage('motion.gif', config, {
    probeGainMap: async () => ({ hasGainMap: false }),
    sharpFactory: () => ({ metadata: async () => ({ format: 'gif', width: 320, pageHeight: 240, pages: 4 }) })
  });
  assert.equal(animated.type, 'animated');

  const singleFrame = await inspectImage('still.gif', config, {
    probeGainMap: async () => ({ hasGainMap: false }),
    sharpFactory: () => ({ metadata: async () => ({ format: 'gif', width: 320, height: 240, pages: 1 }) })
  });
  assert.equal(singleFrame.type, 'static');
});

test('convertBatch routes each image type and preserves nested directories', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-compression-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  await fs.mkdir(path.join(inputDir, 'nested'), { recursive: true });
  await fs.writeFile(path.join(inputDir, 'photo.png'), 'png');
  await fs.writeFile(path.join(inputDir, 'motion.gif'), 'gif');
  await fs.writeFile(path.join(inputDir, 'nested', 'hdr.jpg'), 'jpeg');

  const result = await convertBatch(
    { inputDir, outputDir },
    {
      probeGainMap: async (input) => ({ hasGainMap: input.endsWith('hdr.jpg') }),
      convertGainMap: async (_input, output) => fs.writeFile(output, 'gainmap'),
      sharpFactory: fakeSharpFactory
    }
  );

  assert.equal(result.total, 3);
  assert.equal(result.successCount, 3);
  assert.deepEqual(result.typeCounts, { static: 1, animated: 1, gainmap: 1 });
  assert.equal(await fs.readFile(path.join(outputDir, 'photo.webp'), 'utf8'), 'sharp');
  assert.equal(await fs.readFile(path.join(outputDir, 'motion.webp'), 'utf8'), 'sharp');
  assert.equal(await fs.readFile(path.join(outputDir, 'nested', 'hdr.avif'), 'utf8'), 'gainmap');
});

test('convertBatch preserves GIF loop and frame delays in WebP options', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'animation-semantics-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(path.join(inputDir, 'motion.gif'), 'gif');
  let capturedOptions;

  await convertBatch(
    { inputDir, outputDir },
    {
      sharpFactory(input) {
        const pipeline = fakeSharpFactory(input);
        pipeline.metadata = async () => ({
          format: 'gif',
          width: 320,
          pageHeight: 240,
          pages: 3,
          loop: 2,
          delay: [40, 80, 120]
        });
        pipeline.webp = function webp(options) {
          capturedOptions = options;
          return this;
        };
        return pipeline;
      }
    }
  );

  assert.deepEqual(capturedOptions, {
    quality: 80,
    loop: 2,
    delay: [40, 80, 120]
  });
});

test('convertBatch avoids same-name output collisions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'output-collision-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(path.join(inputDir, 'cover.jpg'), 'jpeg');
  await fs.writeFile(path.join(inputDir, 'cover.png'), 'png');

  const result = await convertBatch(
    { inputDir, outputDir },
    { probeGainMap: async () => ({ hasGainMap: false }), sharpFactory: fakeSharpFactory }
  );

  assert.equal(result.successCount, 2);
  assert.equal(result.collisionCount, 1);
  assert.equal(await fs.readFile(path.join(outputDir, 'cover.webp'), 'utf8'), 'sharp');
  assert.equal(await fs.readFile(path.join(outputDir, 'cover-png.webp'), 'utf8'), 'sharp');
});

test('convertBatch excludes a nested output directory from scanning', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nested-output-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(inputDir, 'compressed');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(inputDir, 'source.png'), 'png');
  await fs.writeFile(path.join(outputDir, 'old.webp'), 'old output');

  const result = await convertBatch(
    { inputDir, outputDir },
    { sharpFactory: fakeSharpFactory }
  );

  assert.equal(result.total, 1);
  assert.equal(result.successCount, 1);
});

test('convertBatch rejects identical input and output directories', async () => {
  await assert.rejects(
    convertBatch({ inputDir: 'images', outputDir: 'images' }),
    /输入文件夹和输出文件夹不能相同/
  );
});

test('convertBatch continues after a failed image and writes failure details', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-compression-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(path.join(inputDir, 'broken.jpg'), 'jpeg');

  const result = await convertBatch(
    { inputDir, outputDir },
    { probeGainMap: async () => { throw new Error('invalid JPEG'); } }
  );

  assert.equal(result.failedCount, 1);
  assert.match(
    await fs.readFile(path.join(outputDir, FAILURE_FILE_NAME), 'utf8'),
    /broken\.jpg\tinvalid JPEG/
  );
});

test('failed conversion keeps an existing output and removes temporary files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-output-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(inputDir, 'photo.png'), 'png');
  await fs.writeFile(path.join(outputDir, 'photo.webp'), 'previous output');

  const result = await convertBatch(
    { inputDir, outputDir },
    {
      sharpFactory(input) {
        const pipeline = fakeSharpFactory(input);
        pipeline.toFile = async function toFile(output) {
          await fs.writeFile(output, 'partial output');
          throw new Error('encoder failed');
        };
        return pipeline;
      }
    }
  );

  assert.equal(result.failedCount, 1);
  assert.equal(await fs.readFile(path.join(outputDir, 'photo.webp'), 'utf8'), 'previous output');
  assert.deepEqual(
    (await fs.readdir(outputDir)).filter((name) => name.includes('.tmp.')),
    []
  );
});

function fakeSharpFactory(input) {
  const pipeline = {
    metadata: async () => path.extname(input).toLowerCase() === '.gif'
      ? { format: 'gif', width: 320, pageHeight: 240, pages: 3, loop: 0, delay: [80, 80, 80] }
      : { format: path.extname(input).toLowerCase() === '.jpg' ? 'jpeg' : 'png', width: 1200, height: 800, pages: 1 },
    autoOrient() { return this; },
    resize() { return this; },
    keepMetadata() { return this; },
    webp() { return this; },
    avif() { return this; },
    async toFile(output) { await fs.writeFile(output, 'sharp'); }
  };
  return pipeline;
}
