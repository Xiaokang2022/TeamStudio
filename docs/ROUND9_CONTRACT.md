# Round 9 Contract — 设置入口、个人设置与侧边栏团队切换

> 本文件是第 9 轮界面 / 权限改版的**唯一权威契约**。所有实现者（前端、测试、文档）以本文件为准；
> 与旧 README / ROUND8_CONTRACT / 旧 e2e 冲突时，以本文件为准。本轮不改数据模型与 API 基址，外壳、设置入口与模块规则以外的行为继续沿用第 8 轮。

## 0. 背景

第 9 轮调整界面入口的归属：

1. **工作室 / 团队设置入口回到左侧边栏「管理」分组**：仍只对对应权限的管理员可见，且不能被「模块与展示」的开关隐藏；
2. **个人设置并入个人主页**：在个人主页中以类似设置页的形式展示，左侧多个选项，第一项「个人信息」、第二项「个性化设置」，后续可继续增加；
3. **团队切换保留在侧边栏底部（左下角）**：通过向上展开的下拉切换团队，面包屑显示「团队名 / 页面名」；
4. 右上角头像下拉**不再**放置设置入口（保留个人主页、工作区管理、关于、退出登录）。

## 1. 本轮验收口径

| # | 需求 | 验收口径 |
|---|------|----------|
| 1 | 设置入口只由权限决定，位于侧边栏 | 侧边栏存在「管理」分组与设置入口：超级管理员（含系统内置 Admin）显示「工作室设置」，团队管理员显示「团队设置」，普通成员与访客不显示。头像下拉 `.user-popover` 中不再有设置入口。`#/settings` 对非管理员仍显示「仅管理员可访问」的 AccessDenied。 |
| 2 | 个人设置位于个人主页并分栏展示 | 个人主页（`#/profile`）的 `.profile-settings-panel` 使用类似设置页的布局：左侧 `.profile-settings-tabs` 至少包含第一项「个人信息」与第二项「个性化设置」，右侧 `.profile-settings-main` 显示对应内容；后续设置项可按相同结构追加。 |
| 3 | 团队切换保持在侧边栏底部 | `.sidebar-team-switcher .team-switcher-button` 展示团队徽标、团队名、成员数与 ChevronsUpDown 图标；点击出现向上展开的 `.popover.team-popover.team-popover-up`；当前团队带 `.team-current` 徽标，底部提示「数据按团队隔离」。顶栏不出现团队切换器。 |
| 4 | 设置入口不可被模块开关隐藏 | 「模块与展示」卡片只有 8 个普通模块开关，不含设置；后端 `modules.settings` 恒为 `true`、`guestModules.settings` 恒为 `false`。 |

## 2. DOM / 交互契约

```text
.sidebar
  .main-nav
    ...普通业务模块...
    .nav-group「管理」                       # 仅管理员渲染
      button.nav-item「工作室设置」          # 超级管理员（含系统内置 Admin），带 .nav-shield
      button.nav-item「团队设置」            # 团队管理员
  .sidebar-footer
    .sidebar-team-switcher
      button.team-switcher-button            # 团队徽标 + 团队名 + 成员数
      点击 → .popover.team-popover.team-popover-up（向上展开）
               .team-option（当前团队带 .team-current）
               .popover-note「数据按团队隔离」
    .identity-mini + .about-trigger + 页脚文案

.topbar .topbar-left
  .breadcrumb                                # 「团队名 / 页面名」；设置页显示「/ 工作室设置」或「/ 团队设置」
  # 无团队切换器

.topbar .user-chip → .user-popover
  个人主页 / 工作区管理 / 关于团队工作室 / 退出登录
  # 无工作室设置、团队设置、系统设置入口

#/profile
  .profile-settings-panel（仅本人可见）
    .profile-settings-tabs
      button.profile-settings-tab「个人信息」（默认）
      button.profile-settings-tab「个性化设置」
      .profile-settings-tabs-note「更多个人设置将在后续版本加入」
    .profile-settings-main
      「个人信息」：头像、头像颜色、用户名、登录邮箱、技能标签、个人简介 + 保存/重置
      「个性化设置」：主题偏好（跟随系统 / 浅色 / 深色，仅保存在当前浏览器）
```

## 3. 设置模块规则

- 后端 `Settings.modules.settings` 恒为 `true`：加载与保存时强制为真，旧配置里的 `false` 被忽略。
- 后端 `Settings.guestModules.settings` 恒为 `false`：访客永远不能访问设置模块。
- 「模块展示」卡片只渲染 8 个普通模块（概览 / 任务 / 洞察 / 日历 / 红黑榜 / 公告 / 矩阵 / 链接）的 `.settings-module-toggle`，不再有设置开关，改为说明文字。
- 「访客可访问模块」卡片继续保持 8 个普通模块，不含设置（本轮不变）。
- 设置接口鉴权与 `#/settings` 路由守卫不变：非管理员仍得到 AccessDenied / 403。

## 4. 涉及文件

- 实现：`web/src/components/AppShell.tsx`（侧边栏「管理」分组设置入口、头像下拉移除设置入口、面包屑）、`web/src/pages/ProfilePage.tsx`（个人设置分栏面板）、`web/src/pages/ProfilePage.css`（分栏布局与响应式）、`web/src/pages/SettingsPage.tsx`（团队管理员页标题「团队设置」、模块卡片说明）、`web/src/App.tsx`（设置路由按权限放行）、`backend/app/config.py`（`modules.settings` 恒真、`guestModules.settings` 恒假）。
- 验收：`web/e2e/smoke.mjs`、`web/e2e/sidebar-about.mjs`、`web/e2e/lead-docs-shots.mjs`。
- 文档：`README.md`、本文件。
- 不改 API 路径、数据模型、`package.json` 与 `scripts/`。

## 5. 验证命令

```powershell
npm run typecheck --prefix web
npm run build --prefix web
npm run e2e:smoke --prefix web        # 需先构建 web/dist 并启动后端
npm run e2e:sidebar --prefix web
```

验收必须覆盖：

1. 侧边栏「管理」分组的设置入口按权限显示，头像下拉没有设置入口；
2. 个人主页的「个人设置」以左侧分栏展示「个人信息」「个性化设置」两个选项，并可切换；
3. 侧边栏底部团队切换正常、成员数随之更新，面包屑显示「团队名 / 页面名」；
4. 「模块展示」只有 8 个模块开关，设置入口无法被关闭；
5. 非管理员访问 `#/settings` 仍被拒绝。
