# X Account Location Tagger（X 账号归属地标注）

用于 X（原 Twitter）网页端的账号归属地标注用户脚本。通过调用 X 官方 GraphQL 接口获取账号公开的属地元数据，在用户悬浮资料卡与时间线推文中展示归属地徽章与异常提示。

[![GitHub Repo stars](https://img.shields.io/github/stars/Noctyn/x-location?style=flat-square)](https://github.com/Noctyn/x-location) [![GitHub repo size](https://img.shields.io/github/repo-size/Noctyn/x-location?style=flat-square)](https://github.com/Noctyn/x-location) [![GitHub last commit](https://img.shields.io/github/last-commit/Noctyn/x-location?style=flat-square)](https://github.com/Noctyn/x-location) [![GitHub license](https://img.shields.io/github/license/Noctyn/x-location?style=flat-square)](https://github.com/Noctyn/x-location/blob/main/LICENSE) [![GitHub top language](https://img.shields.io/github/languages/top/Noctyn/x-location?style=flat-square)](https://github.com/Noctyn/x-location)

---

## 功能特性

- **双位置展示**：
  - **悬浮资料卡（HoverCard）**：鼠标悬停于用户头像或用户名时，在资料卡昵称下方展示完整的账号所在地与客户端接入来源（默认开启）。
  - **推文时间戳右侧**：在时间线主推文与引用推文的时间戳旁显示紧凑型国旗与归属地徽章（默认关闭，可按需开启）。
- **属地识别与异常标记**：
  - **账号所在地**：解析官方 `AboutAccountQuery` 接口返回的地理区域并匹配对应国旗图标。
  - **接入来源标注**：标注账号通过移动端（如对应区域的 App Store）或网页端接入。
  - **区域不一致提示**：当客户端应用商店区域与账号所在地不一致时高亮提示。
  - **代理状态标记**：当官方接口标记该账号所在地可能受代理或 VPN 影响而不准确时，展示预警标识。
- **动态 Query ID 自愈**：
  - 内置前端资源（Bundle）扫描机制。当 X 更新 GraphQL `queryId` 导致请求返回 `400` / `404` 时，脚本自动从页面已加载的 JS 资源中提取最新 ID，无需等待脚本发版更新。
- **缓存与请求限流**：
  - **本地持久化缓存**：查询结果本地缓存 24 小时（容量上限 1000 条），避免对同一账号重复发起请求。
  - **并发控制与退避**：内置请求队列调度与针对 `429` 状态码的自动退避机制，降低触发接口频率限制的风险。
- **最小权限与多语言**：
  - 仅声明菜单注册所需的脚本权限（`GM_registerMenuCommand`、`GM_unregisterMenuCommand`、`unsafeWindow`），不发起跨域请求。
  - 界面文案自动适配网页端语言环境（中文 / 英文）。

---

## 界面预览

| 悬浮资料卡（HoverCard） | 时间线推文时间戳 |
| :---: | :---: |
| ![悬浮名片预览](assets/preview-hovercard.png) | ![推文时间戳徽章预览](assets/preview-tweet.png) |

---

## 安装与配置

### 安装

请先在浏览器中安装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/)（推荐）或 [Violentmonkey](https://violentmonkey.github.io/)，随后通过以下任一渠道安装：

- [Greasy Fork 安装地址](https://greasyfork.org/zh-CN/scripts/602309)（推荐）
- [GitHub Raw 直链安装](https://raw.githubusercontent.com/Noctyn/x-location/main/x-location.user.js)

### 配置开关

点击浏览器工具栏中的脚本管理器图标，可在扩展菜单中直接切换以下开关（配置持久化保存在浏览器本地）：

- **悬浮卡属地：开 / 关**（默认开启）
- **时间线属地：开 / 关**（默认关闭）

也可在 X 页面打开浏览器开发者工具控制台（Console），通过命令手动切换状态：

```javascript
xLocSetHover(false)     // 关闭悬浮资料卡属地展示
xLocSetTimeline(true)   // 开启时间线推文属地展示
```

---

## 许可证

[MIT](LICENSE)
