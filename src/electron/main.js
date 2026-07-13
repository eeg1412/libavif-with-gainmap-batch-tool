'use strict'

const nativeFs = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const {
  DEFAULTS,
  convertBatch,
  formatError,
  isPathInside,
  listImageFiles
} = require('../core/converter')

let mainWindow
let activeConversion = null
let activeInputWatch = null
let inputWatchGeneration = 0

const INPUT_WATCH_DEBOUNCE_MS = 400

const DEFAULT_GUI_SETTINGS = Object.freeze({
  inputDir: '',
  outputDir: '',
  ...DEFAULTS
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    registerIpcHandlers()
    createWindow()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('before-quit', () => {
  activeConversion?.controller.abort()
  stopInputDirectoryWatch()
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 980,
    minWidth: 820,
    minHeight: 650,
    backgroundColor: '#f4f7fb',
    show: false,
    autoHideMenuBar: true,
    title: '博客图片压缩工具',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => {
    stopInputDirectoryWatch()
    mainWindow = null
  })
}

function registerIpcHandlers() {
  ipcMain.handle('dialog:select-directory', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title:
        options.kind === 'output' ? '选择输出文件夹' : '选择图片输入文件夹',
      defaultPath: options.defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('settings:load', async () => loadSettings())

  ipcMain.handle('input:watch', async (event, options = {}) => {
    return startInputDirectoryWatch(event.sender, options)
  })

  ipcMain.handle('input:unwatch', (event) => {
    return stopInputDirectoryWatch(event.sender)
  })

  ipcMain.handle('conversion:start', async (event, rawConfig) => {
    if (activeConversion) throw new Error('已有转换任务正在运行。')

    const controller = new AbortController()
    const sender = event.sender
    stopInputDirectoryWatch(sender)
    activeConversion = { controller, sender }

    try {
      const settings = sanitizeSettings(rawConfig)
      await saveSettings(settings)

      return await convertBatch(
        {
          ...settings,
          binDir: app.isPackaged
            ? path.join(process.resourcesPath, 'native')
            : undefined
        },
        {
          signal: controller.signal,
          onProgress(progress) {
            if (!sender.isDestroyed())
              sender.send('conversion:progress', progress)
          }
        }
      )
    } catch (error) {
      throw new Error(formatError(error))
    } finally {
      activeConversion = null
    }
  })

  ipcMain.handle('conversion:cancel', () => {
    if (!activeConversion) return false
    activeConversion.controller.abort()
    return true
  })

  ipcMain.handle('shell:open-output', async (_event, directory) => {
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new Error('请先选择输出文件夹。')
    }
    const error = await shell.openPath(path.resolve(directory))
    if (error) throw new Error(error)
    return true
  })
}

async function startInputDirectoryWatch(sender, rawOptions = {}) {
  stopInputDirectoryWatch()
  const generation = ++inputWatchGeneration

  const inputValue = stringSetting(rawOptions.inputDir)
  const watchId = String(rawOptions.watchId ?? '')
  if (!inputValue) return inputCountResult('idle', 0, '请选择输入文件夹。', watchId)

  const inputDir = path.resolve(inputValue)
  const outputValue = stringSetting(rawOptions.outputDir)
  const outputDir = outputValue ? path.resolve(outputValue) : undefined

  try {
    const stats = await fs.stat(inputDir)
    if (!stats.isDirectory()) {
      return inputCountResult('error', 0, '选择的输入路径不是文件夹。', watchId)
    }
  } catch (error) {
    return inputCountResult(
      'error',
      0,
      error.code === 'ENOENT' ? '输入文件夹不存在。' : '无法读取输入文件夹。',
      watchId
    )
  }

  if (generation !== inputWatchGeneration) {
    return inputCountResult('idle', 0, '', watchId)
  }

  const session = {
    sender,
    watchId,
    inputDir,
    outputDir,
    watcher: null,
    timer: null,
    scanVersion: 0,
    lastCount: 0
  }

  try {
    session.watcher = nativeFs.watch(inputDir, { recursive: true }, () => {
      scheduleInputDirectoryScan(session)
    })
  } catch (error) {
    session.watcher = null
  }

  if (generation !== inputWatchGeneration) {
    session.watcher?.close()
    return inputCountResult('idle', 0, '', watchId)
  }

  session.watcher?.on('error', () => {
    if (activeInputWatch !== session) return
    session.watcher?.close()
    session.watcher = null
    scanInputDirectory(session, true)
  })
  sender.once('destroyed', () => stopInputDirectoryWatch(sender))
  activeInputWatch = session

  return scanInputDirectory(session, false)
}

function scheduleInputDirectoryScan(session) {
  if (activeInputWatch !== session) return
  clearTimeout(session.timer)
  sendInputCount(
    session,
    inputCountResult(
      'scanning',
      session.lastCount,
      '正在更新图片数量…',
      session.watchId,
      session.scanVersion + 1
    )
  )
  session.timer = setTimeout(() => {
    session.timer = null
    scanInputDirectory(session, true)
  }, INPUT_WATCH_DEBOUNCE_MS)
}

async function scanInputDirectory(session, emitResult) {
  const scanVersion = ++session.scanVersion
  try {
    const excludeDirectory = session.outputDir &&
      isPathInside(session.outputDir, session.inputDir)
      ? session.outputDir
      : undefined
    const files = await listImageFiles(session.inputDir, undefined, { excludeDirectory })
    const result = inputCountResult(
      'ready',
      files.length,
      session.watcher ? '' : '当前文件夹无法实时监听，重新选择可刷新数量。',
      session.watchId,
      scanVersion
    )

    if (activeInputWatch !== session || scanVersion !== session.scanVersion) {
      return inputCountResult(
        'scanning',
        session.lastCount,
        '正在更新图片数量…',
        session.watchId,
        scanVersion
      )
    }
    session.lastCount = files.length
    if (emitResult) sendInputCount(session, result)
    return result
  } catch (error) {
    const result = inputCountResult(
      'error',
      0,
      '无法统计输入文件夹中的图片。',
      session.watchId,
      scanVersion
    )
    if (activeInputWatch !== session || scanVersion !== session.scanVersion) {
      return inputCountResult(
        'scanning',
        session.lastCount,
        '正在更新图片数量…',
        session.watchId,
        scanVersion
      )
    }
    if (emitResult) sendInputCount(session, result)
    return result
  }
}

function inputCountResult(state, count, message = '', watchId = '', revision = 0) {
  return { state, count, message, watchId, revision }
}

function sendInputCount(session, result) {
  if (session.sender.isDestroyed()) {
    stopInputDirectoryWatch(session.sender)
    return
  }
  session.sender.send('input:count', result)
}

function stopInputDirectoryWatch(sender) {
  const session = activeInputWatch
  if (session && sender && session.sender !== sender) return false
  inputWatchGeneration += 1
  if (!session) return false
  activeInputWatch = null
  clearTimeout(session.timer)
  session.watcher?.close()
  return true
}

function sanitizeSettings(raw = {}) {
  return {
    inputDir: stringSetting(raw.inputDir),
    outputDir: stringSetting(raw.outputDir),
    staticFormat: raw.staticFormat ?? DEFAULTS.staticFormat,
    staticQuality: raw.staticQuality ?? raw.quality ?? DEFAULTS.staticQuality,
    staticMaxResolution:
      raw.staticMaxResolution ?? raw.maxResolution ?? DEFAULTS.staticMaxResolution,
    animatedFormat: raw.animatedFormat ?? DEFAULTS.animatedFormat,
    animatedQuality: raw.animatedQuality ?? raw.quality ?? DEFAULTS.animatedQuality,
    animatedMaxResolution:
      raw.animatedMaxResolution ?? raw.maxResolution ?? DEFAULTS.animatedMaxResolution,
    gainMapFormat: raw.gainMapFormat ?? DEFAULTS.gainMapFormat,
    gainMapBaseQuality:
      raw.gainMapBaseQuality ?? raw.quality ?? DEFAULTS.gainMapBaseQuality,
    gainMapQuality: raw.gainMapQuality ?? DEFAULTS.gainMapQuality,
    gainMapMaxResolution:
      raw.gainMapMaxResolution ?? raw.maxResolution ?? DEFAULTS.gainMapMaxResolution,
    preserveMetadata: raw.preserveMetadata ??
      (typeof raw.stripMetadata === 'boolean'
        ? !raw.stripMetadata
        : DEFAULTS.preserveMetadata),
    speed: raw.speed ?? DEFAULTS.speed,
    threads: raw.threads ?? DEFAULTS.threads
  }
}

function stringSetting(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

async function loadSettings() {
  try {
    const stored = JSON.parse(await fs.readFile(settingsPath(), 'utf8'))
    return { ...DEFAULT_GUI_SETTINGS, ...sanitizeSettings(stored) }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') {
      console.error(`Failed to load settings: ${error.message}`)
    }
    return { ...DEFAULT_GUI_SETTINGS }
  }
}

async function saveSettings(settings) {
  const filePath = settingsPath()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf8')
}
