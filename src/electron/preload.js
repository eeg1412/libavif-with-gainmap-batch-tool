'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  selectDirectory(options) {
    return ipcRenderer.invoke('dialog:select-directory', options);
  },
  loadSettings() {
    return ipcRenderer.invoke('settings:load');
  },
  watchInputDirectory(options) {
    return ipcRenderer.invoke('input:watch', options);
  },
  stopWatchingInputDirectory() {
    return ipcRenderer.invoke('input:unwatch');
  },
  startConversion(config) {
    return ipcRenderer.invoke('conversion:start', config);
  },
  cancelConversion() {
    return ipcRenderer.invoke('conversion:cancel');
  },
  openOutput(directory) {
    return ipcRenderer.invoke('shell:open-output', directory);
  },
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  onProgress(callback) {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('conversion:progress', listener);
    return () => ipcRenderer.removeListener('conversion:progress', listener);
  },
  onInputCount(callback) {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('input:count', listener);
    return () => ipcRenderer.removeListener('input:count', listener);
  }
});
