# 博客图片压缩工具

一个面向博客和网站图片的 Windows 批量压缩工具，提供桌面界面和命令行两种使用方式。选择输入、输出文件夹后，程序会扫描所有子文件夹，自动判断图片类型并采用对应的压缩方式。

当前版本：`3.0.0`

## 支持的图片

| 图片类型 | 可识别的输入 | 输出格式 | 默认设置 |
| --- | --- | --- | --- |
| 普通图片 | JPG、PNG、WebP、单帧 GIF、AVIF、TIFF | WebP 或 AVIF | WebP、质量 80、最长边 1920 px |
| GIF 动画 | 多帧 GIF | 动画 WebP | 质量 80、最长边 1920 px |
| HDR 照片 | 包含 Gain Map 的 JPG | AVIF | 画面质量 80、HDR 效果质量 85、最长边 1920 px |

程序会读取图片的真实格式再决定处理方式，而不是只依赖文件扩展名。普通 JPG 不会进入 HDR 流程；不会动的 GIF 会作为普通图片压缩。

## 桌面界面使用方法

### 1. 启动程序

从源码运行需要 Windows 10/11 x64 和 Node.js 20.9.0 或更高版本：

```powershell
npm install
npm start
```

### 2. 选择文件夹

- 输入文件夹：存放需要压缩的图片，可以直接把文件夹拖入界面。
- 输出文件夹：存放压缩后的图片。
- 选择输入文件夹后会立即显示可压缩图片数量；目录中的文件发生变化时，数量会自动更新。
- 没有找到图片、正在更新数量或目录不可用时，“开始压缩”按钮会保持不可点击状态。
- 输入与输出文件夹不能是同一个文件夹。
- 输出文件夹可以放在输入文件夹里面，程序会自动跳过它，避免重复处理已经压缩的图片。

输出目录会保留输入目录原有的子文件夹结构。

### 3. 调整设置

普通图片、GIF 动画和 HDR 照片分别使用独立设置：

- 输出格式：普通图片可选 WebP 或 AVIF；GIF 动画固定输出 WebP；HDR 照片固定输出 AVIF。
- 质量：数值越高，画面细节越多，文件通常也越大。
- 最长边限制：图片会等比例缩小，宽和高中较长的一边不会超过此值；小图片不会被放大。
- 保留照片拍摄信息：开启后保留可能包含拍摄设备、时间和位置的信息，默认关闭。
- 处理速度和性能模式：仅用于 HDR 照片。一般保持“均衡”和“自动”即可。

所有图片都会先按照拍摄方向自动摆正，再进行压缩。

### 4. 查看结果

界面会显示总数、成功数、失败数和当前进度。失败文件可以在界面中展开查看，详细记录也会写入输出目录的 `failed-files.txt`。下一次全部处理成功时，旧的失败记录会自动删除。

## 动画 GIF 的处理规则

- 只有包含多帧画面的 GIF 才会进入动画压缩流程。
- 保留原动画的播放次数，包括单次播放、有限循环和无限循环。
- 保留每一帧的显示时长。
- 最长边限制按单帧画面计算，不会把所有帧的总高度当作图片高度。
- 透明画面会继续作为动画透明画面输出。

## 文件安全

- 每张图片先写入临时文件，完整压缩成功后才替换目标文件。
- 压缩失败或取消任务时会清理临时文件，不会用半成品覆盖已有结果。
- 如果同一文件夹中存在 `cover.jpg` 和 `cover.png` 这类同名图片，程序会自动为冲突文件追加来源格式，例如 `cover-png.webp`。
- 原图片只会被读取，不会修改或删除。

## 命令行使用

复制配置示例：

```powershell
Copy-Item .env.example .env
```

根据需要编辑 `.env`，然后运行：

```powershell
npm run convert
```

可用配置：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `INPUT_DIR` | `input` | 输入文件夹 |
| `OUTPUT_DIR` | `output` | 输出文件夹 |
| `STATIC_FORMAT` | `webp` | 普通图片输出格式，可选 `webp`、`avif` |
| `STATIC_QUALITY` | `80` | 普通图片质量，范围 1–100 |
| `STATIC_MAX_RESOLUTION` | `1920` | 普通图片最长边限制 |
| `ANIMATED_FORMAT` | `webp` | GIF 动画输出格式，目前仅支持 `webp` |
| `ANIMATED_QUALITY` | `80` | GIF 动画质量，范围 1–100 |
| `ANIMATED_MAX_RESOLUTION` | `1920` | GIF 动画单帧最长边限制 |
| `GAIN_MAP_FORMAT` | `avif` | HDR 照片输出格式，目前仅支持 `avif` |
| `GAIN_MAP_BASE_QUALITY` | `80` | HDR 照片基础画面质量，范围 0–100 |
| `GAIN_MAP_QUALITY` | `85` | HDR 增强层质量，范围 0–100 |
| `GAIN_MAP_MAX_RESOLUTION` | `1920` | HDR 照片最长边限制 |
| `PRESERVE_METADATA` | `false` | 是否保留照片拍摄信息 |
| `SPEED` | `6` | HDR 处理速度，0 最精细、10 最快 |
| `THREADS` | `all` | HDR 处理使用的线程数，可填 `all` 或正整数 |

相对路径以项目根目录为基准。完整示例见 [`.env.example`](.env.example)。

## 开发与构建

主要依赖：

- `sharp`：处理普通图片和 GIF 动画。
- `libavif-with-gainmap`：识别并转换 JPG Gain Map。
- `electron`：提供 Windows 桌面界面。

运行项目自带的测试：

```powershell
npm test
```

构建 Windows 安装版和便携版：

```powershell
npm run build:win
```

构建结果位于 `dist/`。桌面包会包含 HDR 图片识别和转换所需的原生程序，最终用户不需要单独安装这些依赖。

## 项目结构

```text
src/
  core/converter.js     # 图片扫描、识别、压缩和输出安全处理
  cli.js                # 命令行入口
  electron/
    main.js             # 桌面主进程和系统功能
    preload.js          # 页面与桌面功能之间的安全接口
  renderer/
    index.html          # 桌面界面
    app.js              # 界面交互和进度展示
    style.css           # 界面样式
test/
  converter.test.js     # 压缩分流和边界行为测试
```
