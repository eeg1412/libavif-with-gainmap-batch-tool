# libavif-with-gainmap 批量转换工具

使用 [`libavif-with-gainmap`](https://www.npmjs.com/package/libavif-with-gainmap) 将 JPEG gain map 图片批量转换成 AVIF gain map 图片。

## 环境要求

- Node.js 18 或更高版本
- `libavif-with-gainmap` 支持的 Windows x64、macOS x64/arm64 或 Linux x64/arm64

## 安装依赖

```sh
npm install
```

## 配置环境变量

复制 `.env.example` 为 `.env`，然后按需要修改配置。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MAX_RESOLUTION` | `1920` | 最大输出宽高。图片会等比缩小，永远不会放大。 |
| `QUALITY` | `80` | AVIF 主图质量，范围是 `0` 到 `100`。 |
| `GAIN_MAP_QUALITY` | `70` | Gain Map 质量，范围是 `0` 到 `100`。 |
| `STRIP_METADATA` | `true` | 是否去掉 Exif/XMP 等 metadata 信息。`true` 去掉，`false` 保留。 |
| `SPEED` | `6` | libavif 编码速度，范围是 `0` 到 `10`。数值越小越慢，通常质量越好。 |
| `INPUT_DIR` | `input` | 输入目录，放置源 `.jpg` 或 `.jpeg` 文件。相对路径从项目根目录解析。 |
| `OUTPUT_DIR` | `output` | 输出目录，写入 `.avif` 文件和失败清单。 |
| `THREADS` | `all` | 传给 libavif 的 `jobs` 参数。可以是 `all` 或 `4` 这样的正整数。 |

系统环境变量优先级高于 `.env`，适合在命令行或 CI 中临时覆盖配置。

## 开始转换

把 gain map JPG/JPEG 文件放入 `input` 目录，然后执行：

```sh
npm run convert
```

工具会递归扫描 `INPUT_DIR`，并在 `OUTPUT_DIR` 中保持相同的相对目录结构。

示例：

```text
input/photo.jpg
input/nested/image.jpeg
```

转换后会生成：

```text
output/photo.avif
output/nested/image.avif
```

## 输出结果

命令结束时会输出成功和失败数量：

```text
Success: 2
Failed: 0
```

如果有文件转换失败，失败文件名会按相对路径写入：

```text
output/failed-files.txt
```

如果全部成功，`failed-files.txt` 不会保留。

## 注意事项

- 只转换 `.jpg` 和 `.jpeg` 文件。
- 没有可解析 gain map 的文件会转换失败，并出现在 `failed-files.txt` 中。
- 输出文件会保留原始文件名主体，并使用 `.avif` 后缀。
