# AVIF Gain Map 批量转换器

将 JPEG Gain Map 图片批量转换为 AVIF Gain Map 图片，提供 Windows 桌面 GUI 和命令行两种使用方式。转换能力由 [`libavif-with-gainmap`](https://www.npmjs.com/package/libavif-with-gainmap) 提供。

## Windows 桌面版

桌面版支持：

- 选择或拖入输入、输出文件夹
- 递归扫描 `.jpg` 和 `.jpeg` 文件
- 设置最大边长、主图质量、Gain Map 质量、编码速度和线程数
- 显示逐文件进度、成功数、失败数及错误详情
- 取消当前任务、打开输出目录
- 自动保存上次使用的设置
- 保持输入文件夹的子目录结构

### 本地开发

要求 Windows 10/11 x64、Node.js 18 或更高版本。

```powershell
npm install
npm start
```

### 运行测试

```powershell
npm test
```

### 构建 Windows EXE

```powershell
npm run build:win
```

构建结果位于 `dist/`：

- `*-Setup.exe`：安装版，可选择安装目录并创建快捷方式
- `*-Portable.exe`：免安装便携版，直接双击运行

最终用户不需要安装 Node.js、npm 或 libavif。目前预编译的底层程序支持 Windows x64。

## 命令行版

复制 `.env.example` 为 `.env` 并按需修改，把图片放入 `input/`，然后运行：

```powershell
npm run convert
```

默认参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `MAX_RESOLUTION` | `1920` | 最大边长，等比例缩小且不放大 |
| `QUALITY` | `80` | AVIF 主图质量，范围 0-100 |
| `GAIN_MAP_QUALITY` | `85` | Gain Map 质量，范围 0-100 |
| `STRIP_METADATA` | `true` | 是否移除 Exif/XMP 等元数据 |
| `SPEED` | `6` | 编码速度，0 最慢且质量最好，10 最快 |
| `INPUT_DIR` | `input` | 输入目录，递归扫描 JPG/JPEG |
| `OUTPUT_DIR` | `output` | 输出目录 |
| `THREADS` | `all` | 使用全部线程或指定正整数 |

失败信息会写入输出目录中的 `failed-files.txt`。全部成功时会自动删除旧的失败记录。

## 项目结构

```text
src/
  core/converter.js     # GUI 与 CLI 共用的批量转换核心
  cli.js                # 命令行入口
  electron/
    main.js             # Electron 主进程和系统能力
    preload.js          # 安全的页面桥接接口
  renderer/
    index.html          # 桌面界面
    app.js
    style.css
test/
  converter.test.js
```

## 打包说明

底层 `avifgainmapconvert.exe` 作为独立资源复制到应用的 `resources/native/`，而不是放入 Electron 的 `asar`。这是因为打包在 `asar` 内的原生 EXE 无法被系统直接执行。

公开分发时建议对安装包进行 Windows 代码签名，否则 SmartScreen 可能显示“未知发布者”。
