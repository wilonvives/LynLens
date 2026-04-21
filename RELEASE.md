# 发版流程

## 首次准备(只做一次)

1. **初始化 git + 推到 GitHub**

   如果你已经 `gh auth login` 登录过,一键搞定:
   ```bash
   cd ~/Desktop/LynLens/LynLens
   git init && git add . && git commit -m "init"
   gh repo create LynLens --private --source=. --push
   ```

   没登录过就先:
   ```bash
   gh auth login        # 选 GitHub.com → HTTPS → 按提示在浏览器授权
   ```

2. **仓库 Actions 权限**(如果用 `gh repo create` 上面那一行,默认就 OK;否则手动去 Settings → Actions → General → Workflow permissions → 勾 "Read and write permissions")。

完。

---

## 以后每次发新版

1. 改代码,本地跑 `pnpm --filter @lynlens/desktop dev` 验证。
2. 改版本号:
   ```bash
   cd packages/desktop && npm version patch   # 0.1.0 → 0.1.1
   cd -
   ```
3. 提交 + 打 tag + 推:
   ```bash
   git add -A && git commit -m "release v0.1.1"
   git tag v0.1.1
   git push && git push --tags
   ```
4. GitHub 仓库的 **Actions** 页看 workflow 跑(10-15 分钟,Mac 和 Win 并行)。
5. 跑完,**Releases** 页面自动出现:
   - `LynLens-0.1.1-arm64.dmg` (Apple Silicon Mac)
   - `LynLens Setup 0.1.1.exe` (Windows x64)

---

## 自动更新(已内置)

装好这个 app 之后,启动时会偷偷问 GitHub Releases 有没有新版。有就**后台下载**,下好弹一个原生对话框:
> LynLens 0.1.2 已下载完成 | [现在重启安装] [稍后]

用户点"稍后"也没关系,下次退出 app 时会自动装。完全不需要手动下载。

实现位置:[packages/desktop/src/main/auto-updater.ts](packages/desktop/src/main/auto-updater.ts)

**注意:** 自动更新只在**打包发布版**里生效,dev 模式(`pnpm dev`)不会检查更新。

---

## 代码签名

配置脚手架已经就位,**等你买了证书塞进 GitHub Secrets 就生效**,不用改代码。

### macOS(99 USD/年)

1. 加入 [Apple Developer Program](https://developer.apple.com/programs/) 并支付 99 美金
2. 在 Apple Developer 网站 → Certificates → 创建 "Developer ID Application" 证书
3. 下载证书,双击导入 Keychain,导出为 `.p12`(设密码)
4. 生成 app-specific password:[appleid.apple.com](https://appleid.apple.com) → 登录 → 安全 → App 专用密码
5. 把 `.p12` base64 编码:
   ```bash
   base64 -i your-cert.p12 -o cert.b64
   ```
6. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 加这些 secrets:
   | Secret 名 | 值 |
   |---|---|
   | `MAC_CSC_LINK` | `cert.b64` 文件内容 |
   | `MAC_CSC_KEY_PASSWORD` | `.p12` 的密码 |
   | `APPLE_ID` | 你的 Apple 开发者账号邮箱 |
   | `APPLE_APP_SPECIFIC_PASSWORD` | 第 4 步生成的密码 |
   | `APPLE_TEAM_ID` | Apple Developer 账号里的 Team ID |

下次发版自动签 + 公证。用户双击 .dmg 装完直接用,Gatekeeper 不弹警告。

### Windows(~300 USD/年 EV 证书,或 ~100 USD/年普通 OV 证书)

买证书推荐 [SSL.com](https://ssl.com) 或 [Sectigo](https://sectigo.com)。拿到 `.pfx` 后:

1. `base64 -i cert.pfx -o cert.b64`
2. 加 GitHub Secrets:
   | Secret 名 | 值 |
   |---|---|
   | `WIN_CSC_LINK` | `cert.b64` 内容 |
   | `WIN_CSC_KEY_PASSWORD` | `.pfx` 密码 |

EV 证书立即生效,SmartScreen 零警告。OV 证书需要"攒声誉"——前几十次下载会警告,之后好转。

**不急着签也能发**:电脑上装时用户多点一次"仍要运行"就能用,属于常规操作。早期内测阶段完全够用。

---

## 用户视角

- 首次装:下载 .dmg / .exe → 双击装 → (如果你没签名,用户会看到一次警告,点"仍然打开"即可)
- 以后升级:**完全自动**,启动 app 时自动下新版,弹个"现在重启安装"就行。不用手动去 GitHub 下载。
