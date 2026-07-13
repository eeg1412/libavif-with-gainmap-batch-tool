'use strict';

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

const elements = Object.fromEntries([
  'inputDir', 'outputDir', 'staticFormat', 'staticQuality', 'staticQualityValue',
  'staticMaxResolution', 'animatedFormat', 'animatedQuality', 'animatedQualityValue',
  'animatedMaxResolution', 'gainMapFormat', 'gainMapBaseQuality',
  'gainMapBaseQualityValue', 'gainMapQuality', 'gainMapQualityValue',
  'gainMapMaxResolution', 'preserveMetadata', 'speed', 'threads', 'actionBarInner',
  'inputSummary', 'inputCountMark', 'inputCountText', 'inputCountHint',
  'selectInput', 'selectOutput', 'resetSettings', 'startConversion',
  'cancelConversion', 'continueConversion', 'openOutput', 'progressCard', 'statusDot', 'statusText',
  'currentFile', 'progressPercent', 'progressBar', 'totalCount', 'successCount',
  'failedCount', 'errorDetails', 'errorList', 'toast', 'inputDropZone', 'outputDropZone'
].map((id) => [id, document.getElementById(id)]));

const IMAGE_TYPE_LABELS = Object.freeze({
  static: '普通图片',
  animated: 'GIF 动画',
  gainmap: 'HDR 照片'
});

let isRunning = false;
let toastTimer;
let inputMonitorTimer;
let inputMonitorRequestId = 0;
let activeInputWatchId = '';
let inputCountRevision = 0;
let inputCountStatus = { state: 'idle', count: 0, message: '' };

initialize();

async function initialize() {
  bindEvents();
  setFooterState('idle');
  window.desktopApi.onProgress(handleProgress);
  window.desktopApi.onInputCount(handleInputCount);
  try {
    applySettings(await window.desktopApi.loadSettings());
  } catch (error) {
    applySettings(DEFAULTS);
    showToast(messageFrom(error), true);
  }
  startInputMonitoring();
}

function bindEvents() {
  elements.selectInput.addEventListener('click', () => selectDirectory('input'));
  elements.selectOutput.addEventListener('click', () => selectDirectory('output'));
  elements.startConversion.addEventListener('click', startConversion);
  elements.cancelConversion.addEventListener('click', cancelConversion);
  elements.continueConversion.addEventListener('click', continueConversion);
  elements.openOutput.addEventListener('click', openOutput);
  elements.resetSettings.addEventListener('click', () => applySettings({
    inputDir: elements.inputDir.value,
    outputDir: elements.outputDir.value,
    ...DEFAULTS
  }));

  for (const range of [
    elements.staticQuality,
    elements.animatedQuality,
    elements.gainMapBaseQuality,
    elements.gainMapQuality
  ]) {
    range.addEventListener('input', updateRangeLabels);
  }
  for (const field of [
    elements.staticMaxResolution,
    elements.animatedMaxResolution,
    elements.gainMapMaxResolution
  ]) {
    field.addEventListener('input', updateStartButtonState);
  }
  elements.inputDir.addEventListener('input', scheduleInputMonitoring);
  elements.outputDir.addEventListener('input', scheduleInputMonitoring);
  setupDropZone(elements.inputDropZone, elements.inputDir);
  setupDropZone(elements.outputDropZone, elements.outputDir);
}

async function selectDirectory(kind) {
  const field = kind === 'input' ? elements.inputDir : elements.outputDir;
  const selected = await window.desktopApi.selectDirectory({
    kind,
    defaultPath: field.value.trim()
  });
  if (selected) {
    field.value = selected;
    startInputMonitoring();
  }
}

function setupDropZone(zone, field) {
  for (const eventName of ['dragenter', 'dragover']) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (elements.actionBarInner.dataset.state === 'idle') zone.classList.add('drag-over');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove('drag-over');
    });
  }
  zone.addEventListener('drop', (event) => {
    if (elements.actionBarInner.dataset.state !== 'idle' ||
        event.dataTransfer.files.length === 0) return;
    const droppedPath = window.desktopApi.getPathForFile(event.dataTransfer.files[0]);
    if (droppedPath) {
      field.value = droppedPath;
      startInputMonitoring();
    }
  });
}

async function startConversion() {
  if (isRunning) return;
  if (inputCountStatus.state !== 'ready' || inputCountStatus.count < 1) {
    showToast('输入文件夹中没有可压缩的图片。', true);
    return;
  }
  const settings = readSettings();
  const validationError = validateSettings(settings);
  if (validationError) {
    showToast(validationError, true);
    return;
  }

  elements.startConversion.disabled = true;
  await stopInputMonitoring();
  resetProgress();
  setFooterState('running');
  setStatus('正在扫描图片…', 'running');

  try {
    const result = await window.desktopApi.startConversion(settings);
    if (result.cancelled) {
      setStatus('压缩已取消', 'error');
      elements.currentFile.textContent = `已处理 ${result.processed} / ${result.total} 个文件`;
      showToast('压缩任务已取消。');
    } else if (result.failedCount > 0) {
      setStatus('压缩完成，但有文件失败', 'error');
      showToast(`压缩完成：成功 ${result.successCount}，失败 ${result.failedCount}`, true);
    } else {
      setStatus('全部压缩完成', 'success');
      elements.currentFile.textContent = result.total === 0
        ? '输入文件夹中没有找到支持的图片'
        : result.collisionCount > 0
          ? `已成功压缩 ${result.successCount} 个文件，并为 ${result.collisionCount} 个重名文件更换名称`
          : `已成功压缩 ${result.successCount} 个文件`;
      showToast(result.total === 0
        ? '没有找到可压缩的图片。'
        : result.collisionCount > 0
          ? `压缩完成，已避免 ${result.collisionCount} 个同名文件覆盖。`
          : '压缩完成。');
    }
  } catch (error) {
    setStatus('压缩未能完成', 'error');
    elements.currentFile.textContent = messageFrom(error);
    showToast(messageFrom(error), true);
  } finally {
    setFooterState('completed');
  }
}

async function cancelConversion() {
  elements.cancelConversion.disabled = true;
  setStatus('正在取消…', 'running');
  await window.desktopApi.cancelConversion();
}

async function openOutput() {
  try {
    await window.desktopApi.openOutput(elements.outputDir.value.trim());
  } catch (error) {
    showToast(messageFrom(error), true);
  }
}

function continueConversion() {
  resetProgress();
  setStatus('准备就绪');
  elements.currentFile.textContent = '选择输入和输出文件夹后开始压缩';
  setFooterState('idle');
  startInputMonitoring();
}

function scheduleInputMonitoring() {
  if (elements.actionBarInner.dataset.state !== 'idle') return;
  clearTimeout(inputMonitorTimer);
  applyInputCountStatus({ state: 'scanning', count: inputCountStatus.count, message: '' });
  inputMonitorTimer = setTimeout(startInputMonitoring, 400);
}

async function startInputMonitoring() {
  if (elements.actionBarInner.dataset.state !== 'idle') return;
  clearTimeout(inputMonitorTimer);
  const requestId = ++inputMonitorRequestId;
  const watchId = String(requestId);
  activeInputWatchId = watchId;
  inputCountRevision = 0;
  const inputDir = elements.inputDir.value.trim();

  if (!inputDir) {
    await window.desktopApi.stopWatchingInputDirectory();
    if (requestId === inputMonitorRequestId) {
      applyInputCountStatus({ state: 'idle', count: 0, message: '' });
    }
    return;
  }

  applyInputCountStatus({ state: 'scanning', count: inputCountStatus.count, message: '' });
  try {
    const result = await window.desktopApi.watchInputDirectory({
      inputDir,
      outputDir: elements.outputDir.value.trim(),
      watchId
    });
    if (requestId === inputMonitorRequestId &&
        elements.actionBarInner.dataset.state === 'idle') {
      applyInputCountStatus(result);
    }
  } catch (error) {
    if (requestId === inputMonitorRequestId) {
      applyInputCountStatus({
        state: 'error',
        count: 0,
        message: messageFrom(error)
      });
    }
  }
}

async function stopInputMonitoring() {
  clearTimeout(inputMonitorTimer);
  inputMonitorRequestId += 1;
  activeInputWatchId = '';
  inputCountRevision = 0;
  try {
    await window.desktopApi.stopWatchingInputDirectory();
  } catch (error) {
    console.error(`停止目录监听失败：${messageFrom(error)}`);
  }
}

function handleInputCount(result) {
  if (elements.actionBarInner.dataset.state !== 'idle') return;
  if (String(result?.watchId ?? '') !== activeInputWatchId) return;
  applyInputCountStatus(result);
}

function applyInputCountStatus(result = {}) {
  const resultWatchId = String(result.watchId ?? '');
  if (resultWatchId && resultWatchId !== activeInputWatchId) return;
  const revision = Number(result.revision);
  if (Number.isInteger(revision) && revision > 0) {
    if (revision < inputCountRevision) return;
    inputCountRevision = revision;
  }
  const state = ['idle', 'scanning', 'ready', 'error'].includes(result.state)
    ? result.state
    : 'error';
  const count = Number.isInteger(result.count) && result.count >= 0 ? result.count : 0;
  inputCountStatus = { state, count, message: result.message || '' };
  elements.inputCountMark.className = `input-summary-mark ${state}`.trim();

  if (state === 'scanning') {
    elements.inputCountMark.textContent = '…';
    elements.inputCountText.textContent = '正在统计图片…';
    elements.inputCountHint.textContent = '目录变化后会自动更新';
  } else if (state === 'ready' && count > 0) {
    elements.inputCountMark.textContent = String(count);
    elements.inputCountText.textContent = `找到 ${count} 张可压缩图片`;
    elements.inputCountHint.textContent = inputCountStatus.message || '目录变化后会自动更新';
  } else if (state === 'ready') {
    elements.inputCountMark.textContent = '0';
    elements.inputCountText.textContent = '没有找到可压缩的图片';
    elements.inputCountHint.textContent = '请检查输入文件夹中的图片';
  } else if (state === 'error') {
    elements.inputCountMark.textContent = '!';
    elements.inputCountText.textContent = '无法读取图片数量';
    elements.inputCountHint.textContent = inputCountStatus.message || '请重新选择输入文件夹';
  } else {
    elements.inputCountMark.textContent = '0';
    elements.inputCountText.textContent = '请选择输入文件夹';
    elements.inputCountHint.textContent = '选择后会自动统计可压缩的图片';
  }

  updateStartButtonState();
}

function updateStartButtonState() {
  if (elements.actionBarInner.dataset.state !== 'idle') return;
  const validationError = validateSettings(readSettings());
  const canStart = inputCountStatus.state === 'ready' &&
    inputCountStatus.count > 0 &&
    !validationError;
  elements.startConversion.disabled = !canStart;
  if (inputCountStatus.state === 'ready' && inputCountStatus.count > 0) {
    elements.inputCountHint.textContent = validationError ||
      inputCountStatus.message ||
      '目录变化后会自动更新';
  }
}

function handleProgress(event) {
  if (event.type === 'ready') {
    elements.totalCount.textContent = event.total;
    if (event.total === 0) updateProgress(0, 0);
    return;
  }

  if (event.type === 'file-start') {
    setStatus('正在检查并压缩', 'running');
    elements.currentFile.textContent = `${event.index} / ${event.total} · ${event.relativeInput}`;
    return;
  }

  if (event.type === 'file-success' || event.type === 'file-error') {
    elements.successCount.textContent = event.successCount;
    elements.failedCount.textContent = event.failedCount;
    updateProgress(event.processed, event.total);
  }

  if (event.type === 'file-success') {
    const label = IMAGE_TYPE_LABELS[event.imageType] || '图片';
    elements.currentFile.textContent = event.renamedOutput
      ? `${event.index} / ${event.total} · ${label} · ${event.relativeInput} → ${event.relativeOutput}（避免覆盖）`
      : `${event.index} / ${event.total} · ${label} · ${event.relativeInput}`;
  }

  if (event.type === 'file-error') {
    const item = document.createElement('li');
    item.textContent = `${event.relativeInput} — ${event.error}`;
    elements.errorList.append(item);
    elements.errorDetails.style.display = 'block';
  }
}

function updateProgress(processed, total) {
  const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressBar.style.width = `${percent}%`;
  elements.progressBar.parentElement.setAttribute('aria-valuenow', String(percent));
}

function resetProgress() {
  elements.totalCount.textContent = '0';
  elements.successCount.textContent = '0';
  elements.failedCount.textContent = '0';
  elements.currentFile.textContent = '正在准备压缩任务';
  elements.errorList.replaceChildren();
  elements.errorDetails.removeAttribute('open');
  elements.errorDetails.style.display = '';
  updateProgress(0, 0);
}

function setStatus(text, state) {
  elements.statusText.textContent = text;
  elements.statusDot.className = `status-dot ${state || ''}`.trim();
}

function setFooterState(state) {
  const isIdle = state === 'idle';
  const isRunningState = state === 'running';
  const isCompleted = state === 'completed';
  isRunning = isRunningState;
  document.body.dataset.footerState = state;
  elements.actionBarInner.dataset.state = state;
  const controls = document.querySelectorAll('input, select, #selectInput, #selectOutput, #resetSettings');
  for (const control of controls) control.disabled = !isIdle;
  elements.progressCard.classList.toggle('hidden', isIdle);
  elements.startConversion.classList.toggle('hidden', !isIdle);
  elements.cancelConversion.classList.toggle('hidden', !isRunningState);
  elements.openOutput.classList.toggle('hidden', !isCompleted);
  elements.continueConversion.classList.toggle('hidden', !isCompleted);
  elements.cancelConversion.disabled = false;
  updateStartButtonState();
}

function readSettings() {
  return {
    inputDir: elements.inputDir.value.trim(),
    outputDir: elements.outputDir.value.trim(),
    staticFormat: elements.staticFormat.value,
    staticQuality: Number(elements.staticQuality.value),
    staticMaxResolution: Number(elements.staticMaxResolution.value),
    animatedFormat: elements.animatedFormat.value,
    animatedQuality: Number(elements.animatedQuality.value),
    animatedMaxResolution: Number(elements.animatedMaxResolution.value),
    gainMapFormat: elements.gainMapFormat.value,
    gainMapBaseQuality: Number(elements.gainMapBaseQuality.value),
    gainMapQuality: Number(elements.gainMapQuality.value),
    gainMapMaxResolution: Number(elements.gainMapMaxResolution.value),
    preserveMetadata: elements.preserveMetadata.checked,
    speed: Number(elements.speed.value),
    threads: elements.threads.value === 'all' ? 'all' : Number(elements.threads.value)
  };
}

function applySettings(settings = {}) {
  elements.inputDir.value = settings.inputDir || '';
  elements.outputDir.value = settings.outputDir || '';
  setSelectValue(elements.staticFormat, settings.staticFormat ?? DEFAULTS.staticFormat, 'webp');
  elements.staticQuality.value = settings.staticQuality ?? DEFAULTS.staticQuality;
  elements.staticMaxResolution.value = settings.staticMaxResolution ?? DEFAULTS.staticMaxResolution;
  setSelectValue(elements.animatedFormat, settings.animatedFormat ?? DEFAULTS.animatedFormat, 'webp');
  elements.animatedQuality.value = settings.animatedQuality ?? DEFAULTS.animatedQuality;
  elements.animatedMaxResolution.value = settings.animatedMaxResolution ?? DEFAULTS.animatedMaxResolution;
  setSelectValue(elements.gainMapFormat, settings.gainMapFormat ?? DEFAULTS.gainMapFormat, 'avif');
  elements.gainMapBaseQuality.value = settings.gainMapBaseQuality ?? DEFAULTS.gainMapBaseQuality;
  elements.gainMapQuality.value = settings.gainMapQuality ?? DEFAULTS.gainMapQuality;
  elements.gainMapMaxResolution.value = settings.gainMapMaxResolution ?? DEFAULTS.gainMapMaxResolution;
  elements.preserveMetadata.checked = settings.preserveMetadata ?? DEFAULTS.preserveMetadata;
  setSelectValue(elements.speed, String(settings.speed ?? DEFAULTS.speed), String(DEFAULTS.speed));
  setSelectValue(elements.threads, String(settings.threads ?? DEFAULTS.threads), 'all');
  updateRangeLabels();
  updateStartButtonState();
}

function setSelectValue(select, value, fallback) {
  const normalized = String(value);
  const exists = Array.from(select.options).some((option) => option.value === normalized);
  select.value = exists ? normalized : fallback;
}

function updateRangeLabels() {
  elements.staticQualityValue.textContent = elements.staticQuality.value;
  elements.animatedQualityValue.textContent = elements.animatedQuality.value;
  elements.gainMapBaseQualityValue.textContent = elements.gainMapBaseQuality.value;
  elements.gainMapQualityValue.textContent = elements.gainMapQuality.value;
}

function validateSettings(settings) {
  if (!settings.inputDir) return '请选择输入文件夹。';
  if (!settings.outputDir) return '请选择输出文件夹。';
  if (comparableDirectory(settings.inputDir) === comparableDirectory(settings.outputDir)) {
    return '输入文件夹和输出文件夹不能相同。';
  }
  for (const [label, value] of [
    ['普通图片的最长边限制', settings.staticMaxResolution],
    ['GIF 动画的最长边限制', settings.animatedMaxResolution],
    ['HDR 照片的最长边限制', settings.gainMapMaxResolution]
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      return `${label}必须是 1–65535 之间的整数。`;
    }
  }
  return '';
}

function comparableDirectory(value) {
  return value.trim().replace(/[\\/]+$/, '').replaceAll('/', '\\').toLowerCase();
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show${isError ? ' error' : ''}`;
  toastTimer = setTimeout(() => {
    elements.toast.className = 'toast';
  }, 4200);
}

function messageFrom(error) {
  return error?.message || String(error || '未知错误');
}
