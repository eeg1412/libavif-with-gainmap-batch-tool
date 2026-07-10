'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { DEFAULTS, convertBatch, formatError } = require('../core/converter');

let mainWindow;
let activeConversion = null;

const DEFAULT_GUI_SETTINGS = Object.freeze({
  inputDir: '',
  outputDir: '',
  ...DEFAULTS
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    registerIpcHandlers();
    createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => activeConversion?.controller.abort());

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 865,
    minWidth: 820,
    minHeight: 650,
    backgroundColor: '#f4f7fb',
    show: false,
    autoHideMenuBar: true,
    title: 'AVIF Gain Map Converter',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers() {
  ipcMain.handle('dialog:select-directory', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.kind === 'output' ? '选择输出文件夹' : '选择 JPEG 输入文件夹',
      defaultPath: options.defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('settings:load', async () => loadSettings());

  ipcMain.handle('conversion:start', async (event, rawConfig) => {
    if (activeConversion) throw new Error('已有转换任务正在运行。');

    const controller = new AbortController();
    const sender = event.sender;
    activeConversion = { controller, sender };

    try {
      const settings = sanitizeSettings(rawConfig);
      await saveSettings(settings);

      return await convertBatch(
        {
          ...settings,
          binDir: app.isPackaged ? path.join(process.resourcesPath, 'native') : undefined
        },
        {
          signal: controller.signal,
          onProgress(progress) {
            if (!sender.isDestroyed()) sender.send('conversion:progress', progress);
          }
        }
      );
    } catch (error) {
      throw new Error(formatError(error));
    } finally {
      activeConversion = null;
    }
  });

  ipcMain.handle('conversion:cancel', () => {
    if (!activeConversion) return false;
    activeConversion.controller.abort();
    return true;
  });

  ipcMain.handle('shell:open-output', async (_event, directory) => {
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new Error('请先选择输出文件夹。');
    }
    const error = await shell.openPath(path.resolve(directory));
    if (error) throw new Error(error);
    return true;
  });
}

function sanitizeSettings(raw = {}) {
  return {
    inputDir: stringSetting(raw.inputDir),
    outputDir: stringSetting(raw.outputDir),
    maxResolution: raw.maxResolution ?? DEFAULTS.maxResolution,
    quality: raw.quality ?? DEFAULTS.quality,
    gainMapQuality: raw.gainMapQuality ?? DEFAULTS.gainMapQuality,
    stripMetadata: raw.stripMetadata ?? DEFAULTS.stripMetadata,
    speed: raw.speed ?? DEFAULTS.speed,
    threads: raw.threads ?? DEFAULTS.threads
  };
}

function stringSetting(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadSettings() {
  try {
    const stored = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    return { ...DEFAULT_GUI_SETTINGS, ...sanitizeSettings(stored) };
  } catch (error) {
    if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') {
      console.error(`Failed to load settings: ${error.message}`);
    }
    return { ...DEFAULT_GUI_SETTINGS };
  }
}

async function saveSettings(settings) {
  const filePath = settingsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf8');
}
