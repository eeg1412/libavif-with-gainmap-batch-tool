'use strict';

const DEFAULTS = Object.freeze({
  maxResolution: 1920,
  quality: 80,
  gainMapQuality: 85,
  stripMetadata: true,
  speed: 6,
  threads: 'all'
});

const elements = Object.fromEntries([
  'inputDir', 'outputDir', 'maxResolution', 'quality', 'qualityValue',
  'gainMapQuality', 'gainMapQualityValue', 'stripMetadata', 'speed', 'threads',
  'selectInput', 'selectOutput', 'resetSettings', 'startConversion',
  'cancelConversion', 'openOutput', 'progressCard', 'statusDot', 'statusText',
  'currentFile', 'progressPercent', 'progressBar', 'totalCount', 'successCount',
  'failedCount', 'errorDetails', 'errorList', 'toast', 'inputDropZone', 'outputDropZone'
].map((id) => [id, document.getElementById(id)]));

let isRunning = false;
let toastTimer;

initialize();

async function initialize() {
  bindEvents();
  window.desktopApi.onProgress(handleProgress);
  try {
    applySettings(await window.desktopApi.loadSettings());
  } catch (error) {
    applySettings(DEFAULTS);
    showToast(messageFrom(error), true);
  }
}

function bindEvents() {
  elements.selectInput.addEventListener('click', () => selectDirectory('input'));
  elements.selectOutput.addEventListener('click', () => selectDirectory('output'));
  elements.startConversion.addEventListener('click', startConversion);
  elements.cancelConversion.addEventListener('click', cancelConversion);
  elements.openOutput.addEventListener('click', openOutput);
  elements.resetSettings.addEventListener('click', () => applySettings({
    ...readSettings(),
    ...DEFAULTS
  }));

  elements.quality.addEventListener('input', updateRangeLabels);
  elements.gainMapQuality.addEventListener('input', updateRangeLabels);
  setupDropZone(elements.inputDropZone, elements.inputDir);
  setupDropZone(elements.outputDropZone, elements.outputDir);
}

async function selectDirectory(kind) {
  const field = kind === 'input' ? elements.inputDir : elements.outputDir;
  const selected = await window.desktopApi.selectDirectory({
    kind,
    defaultPath: field.value.trim()
  });
  if (selected) field.value = selected;
}

function setupDropZone(zone, field) {
  for (const eventName of ['dragenter', 'dragover']) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (!isRunning) zone.classList.add('drag-over');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove('drag-over');
    });
  }
  zone.addEventListener('drop', (event) => {
    if (isRunning || event.dataTransfer.files.length === 0) return;
    const droppedPath = window.desktopApi.getPathForFile(event.dataTransfer.files[0]);
    if (droppedPath) field.value = droppedPath;
  });
}

async function startConversion() {
  if (isRunning) return;
  const settings = readSettings();
  const validationError = validateSettings(settings);
  if (validationError) {
    showToast(validationError, true);
    return;
  }

  resetProgress();
  setRunning(true);
  setStatus('正在扫描图片…', 'running');

  try {
    const result = await window.desktopApi.startConversion(settings);
    if (result.cancelled) {
      setStatus('转换已取消', 'error');
      elements.currentFile.textContent = `已处理 ${result.processed} / ${result.total} 个文件`;
      showToast('转换任务已取消。');
    } else if (result.failedCount > 0) {
      setStatus('转换完成，但有文件失败', 'error');
      showToast(`转换完成：成功 ${result.successCount}，失败 ${result.failedCount}`, true);
    } else {
      setStatus('全部转换完成', 'success');
      elements.currentFile.textContent = result.total === 0
        ? '输入文件夹中没有找到 JPG / JPEG 文件'
        : `已成功转换 ${result.successCount} 个文件`;
      showToast(result.total === 0 ? '没有找到可转换的图片。' : '转换完成。');
    }
  } catch (error) {
    setStatus('转换未能完成', 'error');
    elements.currentFile.textContent = messageFrom(error);
    showToast(messageFrom(error), true);
  } finally {
    setRunning(false);
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

function handleProgress(event) {
  if (event.type === 'ready') {
    elements.totalCount.textContent = event.total;
    if (event.total === 0) updateProgress(0, 0);
    return;
  }

  if (event.type === 'file-start') {
    setStatus('正在转换', 'running');
    elements.currentFile.textContent = `${event.index} / ${event.total} · ${event.relativeInput}`;
    return;
  }

  if (event.type === 'file-success' || event.type === 'file-error') {
    elements.successCount.textContent = event.successCount;
    elements.failedCount.textContent = event.failedCount;
    updateProgress(event.processed, event.total);
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
  elements.currentFile.textContent = '正在准备转换任务';
  elements.errorList.replaceChildren();
  elements.errorDetails.removeAttribute('open');
  elements.errorDetails.style.display = '';
  updateProgress(0, 0);
}

function setStatus(text, state) {
  elements.statusText.textContent = text;
  elements.statusDot.className = `status-dot ${state || ''}`.trim();
}

function setRunning(running) {
  isRunning = running;
  const controls = document.querySelectorAll('input, select, #selectInput, #selectOutput, #resetSettings');
  for (const control of controls) control.disabled = running;
  elements.startConversion.disabled = running;
  elements.cancelConversion.disabled = false;
  elements.cancelConversion.classList.toggle('hidden', !running);
  elements.startConversion.classList.toggle('hidden', running);
}

function readSettings() {
  return {
    inputDir: elements.inputDir.value.trim(),
    outputDir: elements.outputDir.value.trim(),
    maxResolution: Number(elements.maxResolution.value),
    quality: Number(elements.quality.value),
    gainMapQuality: Number(elements.gainMapQuality.value),
    stripMetadata: elements.stripMetadata.checked,
    speed: Number(elements.speed.value),
    threads: elements.threads.value === 'all' ? 'all' : Number(elements.threads.value)
  };
}

function applySettings(settings = {}) {
  elements.inputDir.value = settings.inputDir || '';
  elements.outputDir.value = settings.outputDir || '';
  elements.maxResolution.value = settings.maxResolution ?? DEFAULTS.maxResolution;
  elements.quality.value = settings.quality ?? DEFAULTS.quality;
  elements.gainMapQuality.value = settings.gainMapQuality ?? DEFAULTS.gainMapQuality;
  elements.stripMetadata.checked = settings.stripMetadata ?? DEFAULTS.stripMetadata;
  setSelectValue(elements.speed, String(settings.speed ?? DEFAULTS.speed), String(DEFAULTS.speed));
  setSelectValue(elements.threads, String(settings.threads ?? DEFAULTS.threads), 'all');
  updateRangeLabels();
}

function setSelectValue(select, value, fallback) {
  const exists = Array.from(select.options).some((option) => option.value === value);
  select.value = exists ? value : fallback;
}

function updateRangeLabels() {
  elements.qualityValue.textContent = elements.quality.value;
  elements.gainMapQualityValue.textContent = elements.gainMapQuality.value;
}

function validateSettings(settings) {
  if (!settings.inputDir) return '请选择输入文件夹。';
  if (!settings.outputDir) return '请选择输出文件夹。';
  if (!Number.isInteger(settings.maxResolution) || settings.maxResolution < 1 || settings.maxResolution > 65535) {
    return '最大边长必须是 1–65535 之间的整数。';
  }
  return '';
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
