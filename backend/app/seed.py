"""Idempotent demo seed data for TeamStudio (round 8, team-only model).

The FastAPI application never creates demo data on startup: a fresh or factory-reset
deployment stays empty until an operator explicitly runs ``scripts/seed-demo.ps1``
(``python -m backend.app.seed``), which calls :func:`seed_demo_data`.

Round 8 removed development groups, so every demo business row is keyed by ``team_id``
only. The old per-group member lists are merged into two teams (``team-aurora`` with 12
members, ``team-voyage`` with 6), member ids / e-mails / names are unchanged, every
member owns one verified demo account, and no ``groups`` row is written. Members keep
their ``avatar_color`` and an empty avatar URL (no image files ship with the repo), which
exercises the fallback colour avatar path.
"""

from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta

from .db import DB_PATH, db, get_meta, init_db, json_dumps, now_iso, rows, scalar

TEAMS = [
    {
        "id": "team-aurora",
        "name": "极光产品团队",
        "short_name": "极光",
        "description": "面向创作者与协作场景的产品研发团队",
        "color": "#5865f2",
        "sort_order": 1,
    },
    {
        "id": "team-voyage",
        "name": "远航数据团队",
        "short_name": "远航",
        "description": "让数据成为每一次决策的导航仪",
        "color": "#0ea5e9",
        "sort_order": 2,
    },
]

# (member_id, team_id, external_id/email, name, title, role, avatar_color, bio, skills,
#  sort_order, joined_days_ago) — one archive row per demo account, no status column.
MEMBERS = [
    ("m-lin", "team-aurora", "lin.zhixia@corp.example", "林知夏", "前端负责人", "团队负责人",
     "#7c3aed", "把复杂留给自己，把顺滑留给用户。", ["React", "设计系统", "性能优化"], 1, 16),
    ("m-chen", "team-aurora", "chen.yu@corp.example", "陈屿", "高级前端工程师", "核心成员",
     "#2563eb", "可视化与交互细节控，正在研究协作日历的时间语义。", ["TypeScript", "可视化", "日历"], 2, 34),
    ("m-su", "team-aurora", "su.wan@corp.example", "苏晚", "前端工程师", "成员",
     "#db2777", "喜欢把权限流程做得像呼吸一样自然。", ["React", "Node.js", "SSO"], 3, 27),
    ("m-he", "team-aurora", "he.chuan@corp.example", "何川", "全栈工程师", "成员",
     "#0891b2", "实时协作与消息推送的长期实践者。", ["WebSocket", "Python", "架构"], 4, 9),
    ("m-tang", "team-aurora", "tang.li@corp.example", "唐梨", "设计工程师", "成员",
     "#f59e0b", "在代码和插画之间寻找团队的共同语言。", ["Figma", "插画", "动效"], 5, 21),
    ("m-zhou", "team-aurora", "zhou.ye@corp.example", "周野", "服务端负责人", "团队负责人",
     "#0e7490", "稳定的系统是团队最安静的底气。", ["FastAPI", "PostgreSQL", "系统设计"], 6, 12),
    ("m-wu", "team-aurora", "wu.qi@corp.example", "吴启", "平台工程师", "核心成员",
     "#4f46e5", "专注可观测性和消息基础设施。", ["Python", "Redis", "消息队列"], 7, 46),
    ("m-xu", "team-aurora", "xu.cheng@corp.example", "徐澄", "SRE", "成员",
     "#059669", "让每一次发布都可回滚、可解释。", ["Kubernetes", "CI/CD", "监控"], 8, 18),
    ("m-luo", "team-aurora", "luo.yi@corp.example", "罗一", "后端工程师", "成员",
     "#b45309", "正在打磨多租户数据隔离。", ["SQLite", "Go", "API"], 9, 7),
    ("m-yu", "team-aurora", "yu.an@corp.example", "余安", "设计负责人", "团队负责人",
     "#be123c", "好设计是被理解，而不是被解释。", ["体验策略", "设计系统", "研究"], 10, 30),
    ("m-qin", "team-aurora", "qin.ke@corp.example", "秦可", "用户研究员", "成员",
     "#0d9488", "每周访谈三位用户，保持对真实问题的敏感。", ["用户研究", "访谈", "洞察"], 11, 24),
    ("m-shen", "team-aurora", "shen.mo@corp.example", "沈墨", "增长运营", "成员",
     "#d97706", "把增长拆成可验证的小实验。", ["增长实验", "内容", "数据分析"], 12, 11),
    ("m-gu", "team-voyage", "gu.xing@corp.example", "顾行", "数据负责人", "团队负责人",
     "#047857", "指标不是终点，决策才是。", ["指标平台", "数据架构", "分析"], 1, 15),
    ("m-li", "team-voyage", "li.mu@corp.example", "李沐", "数据工程师", "核心成员",
     "#2563eb", "在实时链路里追每一个异常。", ["Flink", "SQL", "数仓"], 2, 37),
    ("m-fang", "team-voyage", "fang.jue@corp.example", "方觉", "算法工程师", "成员",
     "#7e22ce", "让推荐结果有解释、可评估。", ["推荐", "Python", "评估"], 3, 22),
    ("m-jia", "team-voyage", "jia.ning@corp.example", "贾宁", "分析工程师", "成员",
     "#c2410c", "把业务问题翻译成数据问题。", ["指标体系", "BI", "实验分析"], 4, 8),
    ("m-pei", "team-voyage", "pei.ran@corp.example", "裴然", "数据平台负责人", "团队负责人",
     "#6d28d9", "平台的价值是让业务忘记平台的存在。", ["数据治理", "Spark", "平台"], 5, 20),
    ("m-han", "team-voyage", "han.xiao@corp.example", "韩晓", "数据工程师", "成员",
     "#0284c7", "关注数据的时效与血缘。", ["Spark", "调度", "元数据"], 6, 5),
]

MEMBER_TEAM: dict[str, str] = {member[0]: member[1] for member in MEMBERS}

WORKS = {
    "m-lin": [
        ("work-lin-1", "团队工作室 2.0 前端架构", "重构工作台信息架构与主题系统，完成团队级导航。", "current", "2026 Q4", "体验工程", 72),
        ("work-lin-2", "设计系统无障碍专项", "补齐高对比度、键盘导航和读屏标签。", "done", "2026 Q3", "质量", 100),
        ("work-lin-3", "前端性能预算", "建立首屏 1.8s 的性能预算与周报。", "done", "2026 Q2", "性能", 100),
    ],
    "m-chen": [
        ("work-chen-1", "协作日历与待办联动", "设计多时区日程模型，打通到期视图与日历待办。", "current", "2026 Q4", "协作日历", 62),
        ("work-chen-2", "周视图拖拽改期", "支持跨日拖拽与批量改期，交互稿已完成。", "planned", "2026 Q4", "交互", 15),
        ("work-chen-3", "数据看板图表规范", "沉淀 12 个图表组件与可访问配色。", "done", "2026 Q3", "可视化", 100),
    ],
    "m-su": [
        ("work-su-1", "企业 SSO 与访客回退", "实现 OIDC 授权码 + PKCE、会话签名和访客模式。", "current", "2026 Q4", "身份权限", 78),
        ("work-su-2", "管理员白名单配置器", "IP/ID 双维度白名单与团队权限范围选择。", "current", "2026 Q4", "身份权限", 45),
        ("work-su-3", "登录回归测试", "覆盖 9 种登录边界与过期会话。", "done", "2026 Q3", "质量", 100),
    ],
    "m-he": [
        ("work-he-1", "公告栏实时刷新", "基于 SSE 的公告更新与未读提示。", "current", "2026 Q4", "实时协作", 55),
        ("work-he-2", "任务写入幂等队列", "以 (待办, 操作人, 时间窗口) 作为幂等键。", "current", "2026 Q4", "消息", 68),
        ("work-he-3", "开放 API 设计", "完成 3 个只读接口的契约评审。", "planned", "2026 Q4", "平台", 20),
    ],
    "m-tang": [
        ("work-tang-1", "工作室视觉焕新", "从极光概念出发重做品牌色与空状态插画。", "current", "2026 Q4", "品牌", 80),
        ("work-tang-2", "组件文档插图", "为首批 20 个组件补充使用场景图。", "done", "2026 Q3", "设计系统", 100),
    ],
    "m-zhou": [
        ("work-zhou-1", "多租户权限模型", "团队/成员两级范围与操作审计。", "current", "2026 Q4", "权限平台", 74),
        ("work-zhou-2", "服务健康度看板", "SLO、错误预算和告警收敛。", "done", "2026 Q3", "可观测性", 100),
    ],
    "m-wu": [
        ("work-wu-1", "可定制通知模板引擎", "支持变量、模板复用与内容校验。", "current", "2026 Q4", "消息", 66),
        ("work-wu-2", "服务连接池", "降低批量请求的握手开销。", "planned", "2026 Q4", "消息", 25),
        ("work-wu-3", "通知去重服务", "保证重试与重启后不重复处理。", "done", "2026 Q3", "消息", 100),
    ],
    "m-xu": [
        ("work-xu-1", "单机部署一键化", "Windows/Linux 双平台启动与数据备份脚本。", "current", "2026 Q4", "交付", 58),
        ("work-xu-2", "日志脱敏审计", "避免 SMTP 密钥进入日志。", "done", "2026 Q3", "安全", 100),
    ],
    "m-luo": [
        ("work-luo-1", "JSON 配置校验器", "提供 JSON Schema、路径级错误定位和原子写入。", "current", "2026 Q4", "配置中心", 81),
        ("work-luo-2", "SQLite 备份与恢复", "在线备份、完整性校验和恢复演练。", "current", "2026 Q4", "存储", 35),
    ],
    "m-yu": [
        ("work-yu-1", "多团队体验一致性", "建立跨团队的设计语言与组件治理机制。", "current", "2026 Q4", "体验策略", 60),
        ("work-yu-2", "红黑榜叙事设计", "让激励有温度，让改进有方向。", "done", "2026 Q3", "文化", 100),
    ],
    "m-qin": [
        ("work-qin-1", "协作日历可用性测试", "完成 8 位成员的任务式访谈。", "current", "2026 Q4", "用户研究", 70),
        ("work-qin-2", "新人上手体验地图", "梳理加入团队前 14 天的关键触点。", "planned", "2026 Q4", "体验度量", 12),
    ],
    "m-shen": [
        ("work-shen-1", "团队品牌月", "围绕「极光」组织 4 期内容与内部分享。", "current", "2026 Q4", "增长实验", 50),
        ("work-shen-2", "公告阅读率实验", "置顶策略与标题风格 A/B 测试。", "done", "2026 Q3", "增长实验", 100),
    ],
    "m-gu": [
        ("work-gu-1", "统一指标中台", "打通 3 条业务线的指标口径与权限。", "current", "2026 Q4", "指标平台", 65),
        ("work-gu-2", "数据产品体验评估", "建立可复用的产品评估框架。", "done", "2026 Q3", "数据产品", 100),
    ],
    "m-li": [
        ("work-li-1", "实时数仓 2.0", "将核心链路延迟压缩到 30 秒内。", "current", "2026 Q4", "实时计算", 47),
        ("work-li-2", "数据质量告警", "覆盖 40 个核心表的新鲜度与分布监控。", "done", "2026 Q3", "数据质量", 100),
    ],
    "m-fang": [
        ("work-fang-1", "可解释推荐策略", "上线特征归因与离线评估报告。", "current", "2026 Q4", "算法", 38),
    ],
    "m-jia": [
        ("work-jia-1", "经营分析月报自动化", "从取数到洞察摘要的全链路自动化。", "current", "2026 Q4", "分析", 72),
        ("work-jia-2", "实验平台指标体系", "统一实验组的北极星与护栏指标。", "planned", "2026 Q4", "实验", 18),
    ],
    "m-pei": [
        ("work-pei-1", "数据治理章程", "数据分级、血缘与生命周期管理制度。", "current", "2026 Q4", "数据治理", 56),
    ],
    "m-han": [
        ("work-han-1", "元数据血缘图", "支持字段级血缘与影响分析。", "current", "2026 Q4", "平台", 64),
        ("work-han-2", "调度失败自愈", "常见失败类型的自动重试与通知。", "done", "2026 Q3", "稳定性", 100),
    ],
}


def _month_shift(day: date, offset: int) -> str:
    month = day.month + offset
    year = day.year + (month - 1) // 12
    month = (month - 1) % 12 + 1
    return f"{year:04d}-{month:02d}"


def _future_day(base: date, offset: int) -> str:
    return (base + timedelta(days=offset)).isoformat()


def _period_end_date(period: str) -> str:
    """Convert a legacy quarter label ("2026 Q4") into its last calendar day."""
    parts = (period or "").split()
    if len(parts) != 2 or not parts[0].isdigit():
        return ""
    quarter = parts[1].upper()
    if quarter not in {"Q1", "Q2", "Q3", "Q4"}:
        return ""
    end_months = {"Q1": (3, 31), "Q2": (6, 30), "Q3": (9, 30), "Q4": (12, 31)}
    month, day = end_months[quarter]
    return f"{int(parts[0]):04d}-{month:02d}-{day:02d}"


def seed_if_empty(force: bool = False) -> bool:
    """Populate the demo workspace once for a brand-new database.

    An intentional factory reset (``POST /api/system/reset``) empties every table and
    writes the ``factoryResetAt`` marker to ``app_meta``. That reset is a product
    decision: the deployment must stay totally empty (default settings, no demo teams,
    members or accounts) until its operator creates real data again, so the seeder
    refuses to run while the marker exists — including after every restart.

    ``force=True`` deliberately bypasses that ``factoryResetAt`` guard. It is reserved
    for the explicit operator entrypoint (:func:`seed_demo_data`, i.e.
    ``scripts/seed-demo.ps1``): process startup never calls this function, so a normal
    restart can never refill an intentionally reset deployment.
    """
    with db() as conn:
        if not force and get_meta(conn, "factoryResetAt") is not None:
            return False
        if scalar(conn, "SELECT COUNT(*) FROM teams", default=0):
            return False
        now = now_iso()
        for team in TEAMS:
            conn.execute(
                "INSERT INTO teams (id,name,short_name,description,color,sort_order,created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (
                    team["id"],
                    team["name"],
                    team["short_name"],
                    team["description"],
                    team["color"],
                    team["sort_order"],
                    now,
                ),
            )
        for member in MEMBERS:
            (member_id, team_id, external_id, name, title, role, color, bio, skills,
             sort_order, joined_days_ago) = member
            conn.execute(
                "INSERT INTO members (id,team_id,external_id,name,email,avatar_url,title,role,"
                "avatar_color,bio,tags,skills,joined_at,sort_order,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    member_id,
                    team_id,
                    external_id,
                    name,
                    external_id,
                    "",
                    title,
                    role,
                    color,
                    bio,
                    "[]",
                    json_dumps(skills),
                    (date.today() - timedelta(days=joined_days_ago)).isoformat(),
                    sort_order,
                    now,
                    now,
                ),
            )
        # Demo accounts: one verified e-mail account per seeded member. Real deployments
        # create accounts via registration or super-admin pre-creation.
        from .services import accounts as account_service

        for member in MEMBERS:
            external_id, name = member[2], member[3]
            try:
                account_service.create_user(
                    conn,
                    email=external_id,
                    name=name,
                    role="member",
                    email_verified=True,
                    created_by="seed",
                )
            except account_service.AccountError:
                continue
        for member_id, items in WORKS.items():
            team_id = MEMBER_TEAM[member_id]
            for index, item in enumerate(items):
                work_id, title, description, status, period, category, progress = item
                # Round 9: works carry a planned date instead of the legacy quarter label.
                planned_date = _period_end_date(period)
                conn.execute(
                    "INSERT INTO works (id,member_id,team_id,title,description,status,period,"
                    "planned_date,category,progress,sort_order,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        work_id,
                        member_id,
                        team_id,
                        title,
                        description,
                        status,
                        "",
                        planned_date,
                        category,
                        progress,
                        index,
                        now,
                        now,
                    ),
                )
        _seed_todos(conn, date.today(), now)
        _seed_redblack(conn, date.today(), now)
        _seed_links(conn, now)
        _seed_matrix(conn, now)
        _seed_announcements(conn, now)
        conn.execute(
            "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('seededAt', ?)", (now,)
        )
        return True


def seed_users_if_empty() -> int:
    """Backfill demo e-mail accounts for deployments seeded before round 5.

    Fresh databases create accounts inside :func:`seed_if_empty`; an existing
    ``teamstudio.db`` only gains the new ``users`` table, so this idempotent helper
    creates one verified demo account per member e-mail.
    """
    from .services import accounts as account_service

    with db() as conn:
        if scalar(conn, "SELECT COUNT(*) FROM users", default=0):
            return 0
        members = rows(
            conn,
            "SELECT external_id, name, email FROM members WHERE email<>'' "
            "ORDER BY sort_order, id",
        )
        created = 0
        for member in members:
            try:
                account_service.create_user(
                    conn,
                    email=member["email"],
                    name=member["name"],
                    role="member",
                    email_verified=True,
                    created_by="seed",
                )
                created += 1
            except account_service.AccountError:
                continue
        return created


def _seed_todos(conn, today: date, now: str) -> None:
    rows_data = [
        ("team-aurora", "完成团队工作室 2.0 首屏信息架构评审", "与设计负责人对齐首页卡片层级与密度。", "m-lin", 2, "10:30", "high", "todo"),
        ("team-aurora", "协作日历视图联调", "验证月视图切换、跨月排期与到期高亮。", "m-chen", 3, "18:00", "urgent", "todo"),
        ("team-aurora", "SSO 管理员白名单回归", "覆盖 IP、ID、团队管理员三种组合。", "m-su", 5, "16:00", "high", "todo"),
        ("team-aurora", "设计系统高对比度色板验收", "检查所有语义色在 WCAG AA 下的表现。", "m-tang", 1, "15:00", "normal", "todo"),
        ("team-aurora", "公告栏三条置顶压力测试", "并发创建与置顶上限校验。", "m-he", 7, "11:00", "normal", "todo"),
        ("team-aurora", "首屏性能预算周报", "LCP 已降至 1.6s，补充移动端数据。", "m-lin", -2, "18:00", "normal", "done"),
        ("team-aurora", "成员卡片空状态插画上线", "已随 1.8.0 发布。", "m-tang", -5, "12:00", "low", "done"),
        ("team-aurora", "成员权限边界审计", "检查团队管理员与成员的自助编辑范围。", "m-wu", 2, "14:00", "high", "todo"),
        ("team-aurora", "多租户权限矩阵回归", "团队管理员不能越权修改全局设置。", "m-zhou", 4, "17:30", "urgent", "todo"),
        ("team-aurora", "发布流水线 Windows 兼容", "确保 PowerShell 启动脚本可直接运行。", "m-xu", 6, "10:00", "normal", "todo"),
        ("team-aurora", "JSON 配置 schema v1 冻结", "已发布并归档。", "m-luo", -3, "18:00", "normal", "done"),
        ("team-aurora", "协作日历可用性访谈（第 3 场）", "重点观察跨月与拖拽操作。", "m-qin", 1, "14:00", "high", "todo"),
        ("team-aurora", "红黑榜视觉叙事走查", "确认红榜与黑榜的语气差异。", "m-yu", 3, "16:30", "normal", "todo"),
        ("team-aurora", "团队品牌月内容排期", "完成 4 期内容主题与嘉宾确认。", "m-shen", 5, "12:00", "normal", "todo"),
        ("team-voyage", "指标口径评审：活跃与留存", "对齐 3 条业务线的活跃定义。", "m-gu", 2, "15:00", "high", "todo"),
        ("team-voyage", "实时链路压测报告", "目标 P99 延迟小于 30 秒。", "m-li", 4, "18:00", "urgent", "todo"),
        ("team-voyage", "推荐解释性评估", "补充离线评估与人工抽检。", "m-fang", 6, "11:30", "normal", "todo"),
        ("team-voyage", "字段级血缘验收", "覆盖 12 张核心表。", "m-han", 3, "17:00", "high", "todo"),
        ("team-voyage", "数据分级章程评审", "完成法务与安全团队会签。", "m-pei", 8, "10:00", "normal", "todo"),
        ("team-voyage", "元数据血缘图性能优化", "字段级查询响应时间优化。", "m-han", -1, "16:00", "normal", "done"),
    ]
    for index, row in enumerate(rows_data):
        team_id, title, description, assignee, offset, due_time, priority, status = row
        due = _future_day(today, offset)
        created = now
        conn.execute(
            "INSERT INTO todos (id,team_id,title,description,due_date,due_time,"
            "assignee_member_id,priority,status,created_by,created_at,updated_at,"
            "completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                f"todo-seed-{index + 1:02d}",
                team_id,
                title,
                description,
                due,
                due_time,
                assignee,
                priority,
                status,
                "Admin",
                created,
                created,
                created if status == "done" else None,
            ),
        )


def _seed_redblack(conn, today: date, now: str) -> None:
    """One red/black board per team per month (the old per-group boards are merged)."""
    member_names = {member[0]: member[3] for member in MEMBERS}
    entries = {
        "team-aurora": {
            "theme": "把体验做深，把协作做轻",
            "red": [
                ("m-su", "SSO 授权码流程提前交付", "主动补齐 PKCE 与状态校验，安全评审一次通过。", 96),
                ("m-tang", "设计系统文档焕新", "20 个组件的使用场景插图全部补齐，新人上手时间减半。", 92),
                ("m-he", "任务幂等队列上线", "连续三次故障演练均未出现重复发送。", 88),
                ("m-xu", "发布回滚演练零失误", "将平均回滚时间从 12 分钟压缩到 4 分钟。", 95),
                ("m-wu", "通知模板引擎可配置化", "运营无需发版即可调整通知文案。", 90),
                ("m-qin", "用户访谈洞察闭环", "连续三周跟踪同一批用户，形成 9 条可执行建议。", 94),
                ("m-shen", "公告阅读率提升 27%", "标题与置顶策略实验取得显著效果。", 87),
            ],
            "black": [
                ("m-chen", "日历改期交互延期", "拖拽边界场景评估不足，需要补 2 天联调时间。", 62),
                ("m-lin", "评审会议超时", "信息架构评审超出预约 25 分钟，下次请提前分发材料。", 68),
                ("m-luo", "配置迁移文档缺失", "本地缓存机制未写入交付文档，补充后关闭。", 65),
                ("m-yu", "设计稿版本管理混乱", "建议统一命名与交付入口。", 70),
            ],
        },
        "team-voyage": {
            "theme": "让数据更快抵达决策",
            "red": [
                ("m-li", "实时链路延迟下降 42%", "通过算子合并与状态优化达成目标。", 97),
                ("m-jia", "经营月报自动化", "每月节省约 12 人时。", 89),
                ("m-han", "调度失败自愈上线", "常见失败恢复率提升到 81%。", 93),
            ],
            "black": [
                ("m-fang", "推荐评估口径未对齐", "离线指标与在线指标差异原因待补充说明。", 63),
                ("m-pei", "数据治理评审延期", "跨团队会签时间预留不足。", 66),
            ],
        },
    }
    for team_id, payload in entries.items():
        for month_offset in (0, -1):
            month = _month_shift(today, month_offset)
            board_id = f"board-{team_id}-{month}"
            theme = payload["theme"] if month_offset == 0 else "复盘 · 沉淀 · 再出发"
            conn.execute(
                "INSERT INTO redblack_boards (id,team_id,month,theme,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?)",
                (board_id, team_id, month, theme, now, now),
            )
            for side in ("red", "black"):
                for index, (member_id, title, reason, score) in enumerate(payload[side]):
                    conn.execute(
                        "INSERT INTO redblack_entries (id,board_id,side,member_id,member_name,"
                        "title,reason,score,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (
                            f"{board_id}-{side}-{index}",
                            board_id,
                            side,
                            member_id,
                            member_names.get(member_id, ""),
                            title,
                            reason,
                            score,
                            index,
                            now,
                        ),
                    )


def _seed_links(conn, now: str) -> None:
    common = [
        ("产品需求池", "https://example.com/roadmap", "需求收集、优先级与迭代规划", "产品", "#5865f2"),
        ("设计资源库", "https://example.com/design", "Figma 组件、品牌资源与设计规范", "设计", "#ec4899"),
        ("发布看板", "https://example.com/releases", "各环境部署状态与版本记录", "工程", "#0ea5e9"),
        ("团队知识库", "https://example.com/wiki", "会议纪要、决策记录与最佳实践", "知识", "#10b981"),
        ("值班与告警", "https://example.com/oncall", "本周值班表和告警处理入口", "运维", "#f59e0b"),
    ]
    team_extra = {
        "team-aurora": [
            ("组件 Storybook", "https://example.com/storybook", "交互式组件文档与视觉回归", "工程", "#8b5cf6"),
            ("体验指标大屏", "https://example.com/web-vitals", "Core Web Vitals 与真实用户监控", "数据", "#06b6d4"),
            ("API 文档", "https://example.com/api-docs", "OpenAPI 契约与联调沙箱", "工程", "#2563eb"),
        ],
        "team-voyage": [
            ("指标字典", "https://example.com/metrics", "指标口径、负责人和数据血缘", "数据", "#10b981"),
            ("实验平台", "https://example.com/experiments", "实验创建、分流与结果解读", "实验", "#8b5cf6"),
            ("数据地图", "https://example.com/data-map", "表、任务与血缘关系检索", "数据", "#0ea5e9"),
        ],
    }
    for team in TEAMS:
        team_id = team["id"]
        for index, (title, url, description, category, color) in enumerate(
            common + team_extra.get(team_id, [])
        ):
            conn.execute(
                "INSERT INTO links (id,team_id,title,url,description,category,color,sort_order,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (f"link-{team_id}-{index}", team_id, title, url, description, category, color, index, now, now),
            )


def _seed_matrix(conn, now: str) -> None:
    # (area, description, owner, backups, channel, contact) — several areas deliberately
    # have more than one backup so the multi-backup UI is demonstrable out of the box.
    areas = {
        "team-aurora": [
            ("Web 工作台", "团队主页、导航与全局搜索", "m-lin", ["m-chen", "m-he"], "企业微信", "#aurora-workbench"),
            ("协作日历", "日历、待办与到期联动", "m-chen", ["m-su", "m-he"], "企业微信", "#aurora-calendar"),
            ("身份与权限", "SSO、访客模式与管理员白名单", "m-su", ["m-he"], "飞书", "#aurora-auth"),
            ("实时通知", "公告、站内消息与 SSE", "m-he", ["m-chen", "m-lin"], "企业微信", "#aurora-realtime"),
            ("设计系统", "组件、视觉规范与无障碍", "m-tang", ["m-lin"], "飞书", "#aurora-design-system"),
            ("权限平台", "多租户范围与操作审计", "m-zhou", ["m-luo", "m-xu"], "企业微信", "#aurora-platform-auth"),
            ("消息基础设施", "消息通道、模板与投递队列", "m-wu", ["m-xu"], "企业微信", "#aurora-email"),
            ("发布与稳定性", "CI/CD、回滚与 SLO", "m-xu", ["m-zhou", "m-luo"], "电话", "oncall@corp.example"),
            ("开放 API", "接口契约与第三方接入", "m-luo", ["m-wu"], "飞书", "#aurora-api"),
            ("品牌体验", "品牌语言、视觉与内容", "m-yu", ["m-shen"], "飞书", "#aurora-brand"),
            ("用户研究", "访谈、可用性测试与洞察", "m-qin", ["m-yu"], "企业微信", "#aurora-research"),
            ("增长实验", "实验设计、内容与复盘", "m-shen", ["m-qin"], "企业微信", "#aurora-growth"),
        ],
        "team-voyage": [
            ("指标中台", "指标口径、认证与字典", "m-gu", ["m-jia", "m-li"], "企业微信", "#voyage-metrics"),
            ("实时数仓", "实时链路、数据质量", "m-li", ["m-jia"], "企业微信", "#voyage-realtime"),
            ("智能推荐", "推荐策略与可解释性", "m-fang", ["m-gu"], "飞书", "#voyage-recommend"),
            ("经营分析", "月报、专题与决策支持", "m-jia", ["m-gu"], "飞书", "#voyage-insights"),
            ("数据治理", "分级、血缘与生命周期", "m-pei", ["m-han"], "企业微信", "#voyage-governance"),
            ("调度平台", "任务编排、自愈与告警", "m-han", ["m-pei"], "电话", "oncall@corp.example"),
        ],
    }
    for team_id, items in areas.items():
        for index, (area, description, owner, backups, channel, contact) in enumerate(items):
            backup_ids = list(backups)
            conn.execute(
                "INSERT INTO matrix_areas (id,team_id,area,description,owner_member_id,"
                "backup_member_id,backup_member_ids,channel,contact,sort_order,created_at,"
                "updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    f"matrix-{team_id}-{index}",
                    team_id,
                    area,
                    description,
                    owner,
                    backup_ids[0] if backup_ids else None,
                    json_dumps(backup_ids),
                    channel,
                    contact,
                    index,
                    now,
                    now,
                ),
            )


def _seed_announcements(conn, now: str) -> None:
    # ``created_by`` is the author's account id where possible so ``authorAvatar`` can
    # resolve the real account avatar (falls back to matching the display name).
    # Never write more pinned announcements than the site setting allows
    # (``announcements.maxPinned``, default 3): the API rejects a further pin, so an
    # over-pinned seed would produce state the UI/API consider invalid.
    from .config import settings_service

    max_pinned = max(0, int(settings_service.get().announcements.maxPinned))
    items = {
        "team-aurora": [
            ("团队工作室 2.0 内测开启", "新的团队级导航、协作日历和红黑榜已经上线。请在「设置 → 高级 JSON」中体验配置能力，遇到问题直接 @ 林知夏。", 1, "celebration", "林知夏", "lin.zhixia", 0),
            ("本周五 16:00 体验评审", "请各模块负责人提前 10 分钟上传演示材料。评审聚焦：日历待办闭环、公告置顶、SSO 回退体验。", 1, "important", "苏晚", "su.wan", 1),
            ("邮箱验证码登录切换窗口", "本周三 10:00-12:00 为邮箱验证码登录联调窗口，测试账号请使用个人邮箱。生产 SMTP 由超级管理员在系统设置中统一维护。", 1, "info", "何川", "he.chuan", 2),
            ("设计系统周会改期", "原定周四的设计系统周会调整至周五 14:30，地点不变。", 0, "info", "唐梨", "tang.li", 3),
            ("权限模型冻结通知", "多租户权限模型 v1 已冻结，后续变更需走架构评审。", 1, "important", "周野", "zhou.ye", 1),
            ("账号体系升级", "周六 02:00-04:00 进行账号体系升级，期间登录可能短暂不可用。", 1, "info", "吴启", "wu.qi", 2),
            ("发布窗口调整", "本周发布窗口调整至周四晚，请提前合并代码。", 0, "info", "徐澄", "xu.cheng", 3),
            ("用户访谈招募", "本轮招募 8 位协作场景深度用户，报名截止周三。", 1, "important", "秦可", "qin.ke", 1),
            ("品牌月启动", "「极光」品牌月正式启动，欢迎贡献故事与素材。", 1, "celebration", "沈墨", "shen.mo", 2),
        ],
        "team-voyage": [
            ("指标口径评审安排", "活跃与留存口径评审定于本周四，请各业务线代表参加。", 1, "important", "顾行", "gu.xing", 1),
            ("实时链路压测", "周五晚进行全链路压测，期间看板数据可能延迟。", 1, "info", "李沐", "li.mu", 2),
            ("数据分级章程公示", "公示期 5 个工作日，意见请提交至数据治理委员会。", 1, "important", "裴然", "pei.ran", 1),
            ("血缘平台升级", "周日凌晨升级，期间血缘检索不可用。", 0, "info", "韩晓", "han.xiao", 2),
        ],
    }
    for team_id, entries in items.items():
        pinned_used = 0
        for index, (title, content, pinned, level, author, created_by, days_ago) in enumerate(entries):
            # Clamp pins to the configured cap; later entries become regular announcements.
            pinned_flag = 1 if pinned and pinned_used < max_pinned else 0
            if pinned_flag:
                pinned_used += 1
            created = (datetime.now() - timedelta(days=days_ago)).isoformat(timespec="seconds")
            conn.execute(
                "INSERT INTO announcements (id,team_id,title,content,pinned,level,author_name,"
                "created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    f"ann-{team_id}-{index}",
                    team_id,
                    title,
                    content,
                    pinned_flag,
                    level,
                    author,
                    created_by,
                    created,
                    created,
                ),
            )


# --------------------------------------------------------------------------- member tasks
#
# Seeded ledger rows are additive and only inserted when ``member_tasks`` is empty, so an
# existing deployment (already seeded teams/members) is backfilled exactly once without
# touching any existing row. Each tuple describes:
# (title, description, progress_status, health_status, expected_offset_days,
#  effort_hours, created_days_ago, completed_days_ago | None)
#
# ``effort_hours`` is kept only for DB compatibility; the v2 workload model uses the explicit
# (priority, difficulty) scoring in ``TASK_SCORING``. Entries not present there (fallback
# tasks for newly created members) derive a deterministic score from the tuple values.

TASK_TEMPLATES: dict[str, list[tuple]] = {
    "m-lin": [
        ("工作台 2.0 信息架构评审", "完成团队级导航的评审结论与落地排期。",
         "in_progress", "normal", 4, 16, 12, None),
        ("设计系统无障碍专项收尾", "高对比度色板与键盘导航回归已上线。",
         "completed", "normal", -6, 12, 24, 5),
        ("首屏性能预算周报", "汇总 LCP/INP 数据，输出下周优化建议。",
         "pending", "delayed", -2, 4, 20, None),
    ],
    "m-chen": [
        ("协作日历多时区模型", "完成时区换算与跨日拖拽的设计联调。",
         "in_progress", "normal", 3, 14, 9, None),
        ("周视图批量改期", "补齐跨月拖拽与批量改期的边界用例。",
         "pending", "blocked", 1, 10, 15, None),
        ("图表组件可访问配色", "12 个图表组件的配色规范已完成。",
         "completed", "normal", -8, 8, 26, 11),
    ],
    "m-su": [
        ("SSO 授权码 + PKCE 联调", "与身份提供方联调登录流程与状态校验。",
         "in_progress", "normal", 2, 12, 7, None),
        ("管理员白名单配置器", "IP/ID 双维度白名单的权限范围选择。",
         "in_progress", "delayed", 5, 10, 18, None),
        ("登录回归测试补齐", "覆盖 9 种登录边界与过期会话。",
         "completed", "normal", -4, 6, 23, 3),
    ],
    "m-he": [
        ("公告栏 SSE 实时刷新", "公告更新与未读提示的推送链路。",
         "in_progress", "normal", 6, 12, 11, None),
        ("任务写入幂等队列", "以 (待办, 操作人, 时间窗口) 作为幂等键。",
         "pending", "normal", 8, 8, 4, None),
        ("开放 API 契约评审", "完成 3 个只读接口的契约评审。",
         "completed", "normal", -10, 10, 27, 14),
    ],
    "m-tang": [
        ("工作室视觉焕新落地", "品牌色与空状态插画进入开发验收。",
         "in_progress", "normal", 4, 14, 13, None),
        ("组件文档插图验收", "首批 20 个组件使用场景图已交付。",
         "completed", "normal", -7, 8, 25, 8),
    ],
    "m-zhou": [
        ("多租户权限模型评审", "团队/成员两级范围与操作审计。",
         "in_progress", "normal", 3, 16, 10, None),
        ("服务健康度看板 SLO 校准", "SLO、错误预算与告警收敛策略。",
         "pending", "blocked", 0, 12, 16, None),
        ("权限模型 v1 冻结", "架构评审通过并冻结。",
         "completed", "normal", -5, 8, 22, 6),
    ],
    "m-wu": [
        ("通知模板变量引擎", "支持变量、模板复用与内容校验。",
         "in_progress", "normal", 5, 14, 8, None),
        ("服务连接池压测", "降低批量请求的握手开销。",
         "pending", "delayed", 2, 6, 19, None),
        ("通知去重服务验收", "保证重试与重启后不重复处理。",
         "completed", "normal", -9, 10, 26, 12),
    ],
    "m-xu": [
        ("单机部署一键化", "Windows/Linux 双平台启动脚本与数据备份。",
         "in_progress", "normal", 7, 12, 6, None),
        ("发布回滚演练", "平均回滚时间从 12 分钟压缩到 4 分钟。",
         "completed", "normal", -3, 8, 21, 2),
        ("日志脱敏审计复核", "确认 SMTP 密钥等敏感信息不进入日志。",
         "pending", "normal", 1, 4, 17, None),
    ],
    "m-luo": [
        ("JSON 配置校验器", "路径级错误定位与原子写入。",
         "in_progress", "normal", 2, 16, 12, None),
        ("SQLite 在线备份", "完整性校验与恢复演练。",
         "pending", "normal", 9, 8, 5, None),
        ("配置迁移文档补齐", "补充本地缓存机制说明。",
         "completed", "normal", -4, 4, 24, 4),
    ],
    "m-yu": [
        ("多团队体验一致性治理", "建立跨团队设计语言与组件治理机制。",
         "in_progress", "normal", 6, 14, 14, None),
        ("红黑榜叙事走查", "让激励有温度，让改进有方向。",
         "completed", "normal", -6, 6, 24, 7),
    ],
    "m-qin": [
        ("协作日历可用性测试", "完成 8 位成员的任务式访谈。",
         "in_progress", "normal", 2, 14, 9, None),
        ("新人上手体验地图", "梳理加入团队前 14 天的关键触点。",
         "pending", "blocked", -1, 10, 17, None),
        ("洞察卡片归档", "9 条可执行建议已入库。",
         "completed", "normal", -11, 4, 27, 15),
    ],
    "m-shen": [
        ("团队品牌月排期", "4 期内容与内部分享确认。",
         "in_progress", "normal", 3, 10, 7, None),
        ("公告阅读率 A/B 实验", "置顶策略与标题风格实验复盘。",
         "completed", "normal", -2, 6, 20, 1),
    ],
    "m-gu": [
        ("统一指标中台口径", "打通 3 条业务线指标与权限。",
         "in_progress", "normal", 5, 16, 13, None),
        ("指标口径评审材料", "活跃与留存定义对齐。",
         "pending", "delayed", 0, 6, 18, None),
        ("数据产品体验评估框架", "形成可复用的评估模板。",
         "completed", "normal", -8, 8, 25, 9),
    ],
    "m-li": [
        ("实时数仓 2.0 链路优化", "核心链路延迟压缩到 30 秒内。",
         "in_progress", "normal", 4, 18, 11, None),
        ("数据质量告警覆盖", "40 张核心表新鲜度与分布监控。",
         "in_progress", "normal", 8, 12, 3, None),
        ("压测报告输出", "P99 延迟达标并输出压测报告。",
         "completed", "normal", -5, 8, 22, 5),
    ],
    "m-fang": [
        ("可解释推荐策略", "特征归因与离线评估报告。",
         "in_progress", "delayed", 3, 14, 16, None),
        ("推荐评估口径对齐", "补充离线与在线指标差异说明。",
         "pending", "blocked", -3, 10, 21, None),
    ],
    "m-jia": [
        ("经营分析月报自动化", "从取数到洞察摘要全链路自动化。",
         "in_progress", "normal", 6, 12, 12, None),
        ("实验平台指标体系", "统一实验组北极星与护栏指标。",
         "completed", "normal", -7, 8, 26, 10),
    ],
    "m-pei": [
        ("数据治理章程评审", "完成法务与安全团队会签。",
         "in_progress", "delayed", 2, 14, 15, None),
        ("数据分级落地检查", "12 张核心表分级标注完成。",
         "completed", "normal", -9, 10, 27, 13),
        ("血缘平台升级方案", "评估升级窗口与回滚策略。",
         "pending", "normal", 5, 8, 5, None),
    ],
    "m-han": [
        ("字段级血缘验收", "覆盖 12 张核心表。",
         "in_progress", "normal", 4, 12, 10, None),
        ("调度失败自愈上线", "常见失败恢复率提升到 81%。",
         "completed", "normal", -4, 8, 23, 4),
        ("血缘图性能优化", "字段级查询响应时间优化。",
         "pending", "blocked", 1, 6, 19, None),
    ],
}

# Explicit round-9 scoring for seeded tasks: (priority, difficulty). Every priority x
# difficulty combination (3 x 3) appears at least once across the two teams so the UI and
# workload aggregation are exercised with the full 1-9 point range.
TASK_SCORING: dict[tuple[str, int], tuple[str, str]] = {
    ("m-lin", 0): ("high", "hard"),
    ("m-lin", 1): ("normal", "hard"),
    ("m-lin", 2): ("high", "easy"),
    ("m-chen", 0): ("high", "hard"),
    ("m-chen", 1): ("high", "medium"),
    ("m-chen", 2): ("normal", "medium"),
    ("m-su", 0): ("high", "hard"),
    ("m-su", 1): ("high", "medium"),
    ("m-su", 2): ("normal", "medium"),
    ("m-he", 0): ("low", "hard"),
    ("m-he", 1): ("normal", "medium"),
    ("m-he", 2): ("normal", "medium"),
    ("m-tang", 0): ("high", "hard"),
    ("m-tang", 1): ("low", "medium"),
    ("m-zhou", 0): ("high", "hard"),
    ("m-zhou", 1): ("high", "hard"),
    ("m-zhou", 2): ("normal", "medium"),
    ("m-wu", 0): ("high", "hard"),
    ("m-wu", 1): ("high", "medium"),
    ("m-wu", 2): ("normal", "medium"),
    ("m-xu", 0): ("high", "hard"),
    ("m-xu", 1): ("normal", "medium"),
    ("m-xu", 2): ("high", "easy"),
    ("m-luo", 0): ("high", "hard"),
    ("m-luo", 1): ("normal", "medium"),
    ("m-luo", 2): ("normal", "easy"),
    ("m-yu", 0): ("high", "hard"),
    ("m-yu", 1): ("low", "medium"),
    ("m-qin", 0): ("high", "hard"),
    ("m-qin", 1): ("high", "medium"),
    ("m-qin", 2): ("low", "easy"),
    ("m-shen", 0): ("high", "medium"),
    ("m-shen", 1): ("low", "medium"),
    ("m-gu", 0): ("high", "hard"),
    ("m-gu", 1): ("high", "medium"),
    ("m-gu", 2): ("normal", "medium"),
    ("m-li", 0): ("high", "hard"),
    ("m-li", 1): ("high", "hard"),
    ("m-li", 2): ("normal", "medium"),
    ("m-fang", 0): ("high", "hard"),
    ("m-fang", 1): ("high", "medium"),
    ("m-jia", 0): ("high", "hard"),
    ("m-jia", 1): ("normal", "medium"),
    ("m-pei", 0): ("high", "hard"),
    ("m-pei", 1): ("normal", "medium"),
    ("m-pei", 2): ("normal", "medium"),
    ("m-han", 0): ("high", "hard"),
    ("m-han", 1): ("normal", "medium"),
    ("m-han", 2): ("high", "medium"),
}


def _derive_scoring(
    progress_status: str,
    health_status: str,
    effort_hours: float,
    expected_offset: int | None,
) -> tuple[str, str]:
    """Deterministic fallback scoring mirroring the v1 -> v2 migration backfill rules."""
    if effort_hours < 6:
        difficulty = "easy"
    elif effort_hours < 12:
        difficulty = "medium"
    else:
        difficulty = "hard"
    if health_status == "blocked":
        priority = "high"
    elif health_status == "delayed":
        priority = "high"
    elif progress_status != "completed" and expected_offset is not None and expected_offset < 0:
        priority = "high"
    elif effort_hours < 6:
        priority = "low"
    else:
        priority = "normal"
    return priority, difficulty


def _seed_timestamp(days_ago: float) -> str:
    moment = datetime.now().astimezone() - timedelta(days=days_ago)
    return moment.isoformat(timespec="seconds")


def _fallback_member_tasks(conn, member: dict) -> list[tuple]:
    """Templates for members created after deployment; derived from their works/title."""
    current_works = rows(
        conn,
        "SELECT title FROM works WHERE member_id=? AND team_id=? AND status='current' "
        "ORDER BY sort_order, created_at LIMIT 1",
        (member["id"], member["team_id"]),
    )
    focus = current_works[0]["title"] if current_works else (member.get("title") or "本周工作")
    role = member.get("title") or "岗位"
    return [
        (f"{focus}阶段推进", "按计划推进并同步风险与依赖。",
         "in_progress", "normal", 5, 12, 12, None),
        (f"{role}月度复盘", "整理本月产出、问题与下月计划。",
         "pending", "normal", 12, 8, 3, None),
    ]


def seed_member_tasks_if_empty() -> int:
    """Backfill the member task ledger for existing members; never mutates existing rows.

    Returns the number of tasks inserted (0 when the table is already populated or there
    are no members yet). Safe to call on every startup.
    """
    with db() as conn:
        if scalar(conn, "SELECT COUNT(*) FROM member_tasks", default=0):
            return 0
        members = rows(
            conn,
            "SELECT id, team_id, name, title FROM members "
            "ORDER BY team_id, sort_order, created_at, id",
        )
        if not members:
            return 0
        today = date.today()
        inserted = 0
        for member in members:
            templates = TASK_TEMPLATES.get(member["id"]) or _fallback_member_tasks(conn, member)
            for index, template in enumerate(templates):
                (
                    title,
                    description,
                    progress_status,
                    health_status,
                    expected_offset,
                    effort_hours,
                    created_days_ago,
                    completed_days_ago,
                ) = template
                created_at = _seed_timestamp(created_days_ago)
                completed_at = (
                    _seed_timestamp(completed_days_ago)
                    if completed_days_ago is not None
                    else None
                )
                expected_date = (
                    (today + timedelta(days=expected_offset)).isoformat()
                    if expected_offset is not None
                    else ""
                )
                priority, difficulty = TASK_SCORING.get(
                    (member["id"], index)
                ) or _derive_scoring(
                    progress_status, health_status, float(effort_hours), expected_offset
                )
                conn.execute(
                    "INSERT INTO member_tasks (id,team_id,member_id,title,description,"
                    "progress_status,health_status,priority,difficulty,expected_date,"
                    "effort_hours,created_by,created_at,updated_at,completed_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        f"task-seed-{member['id']}-{index + 1:02d}",
                        member["team_id"],
                        member["id"],
                        title,
                        description,
                        progress_status,
                        health_status,
                        priority,
                        difficulty,
                        expected_date,
                        float(effort_hours),
                        "Admin",
                        created_at,
                        completed_at or created_at,
                        completed_at,
                    ),
                )
                inserted += 1
        return inserted


# --------------------------------------------------------------------------- explicit seed entry
#
# Demo data is no longer created by the FastAPI lifespan. These helpers are the only
# supported way to (re)create it, and they are intentionally operator-facing: the
# deployment starts empty, stays empty across restarts, and only gains demo content
# when somebody explicitly runs the seed script.

_DEMO_COUNT_TABLES: tuple[tuple[str, str], ...] = (
    ("teams", "teams"),
    ("members", "members"),
    ("works", "works"),
    ("todos", "todos"),
    ("memberTasks", "member_tasks"),
    ("boards", "redblack_boards"),
    ("links", "links"),
    ("matrix", "matrix_areas"),
    ("announcements", "announcements"),
    ("accounts", "users"),
)

_COUNT_LABELS: dict[str, str] = {
    "teams": "团队",
    "members": "成员",
    "works": "工作条目",
    "todos": "待办",
    "memberTasks": "成员任务",
    "boards": "红黑榜看板",
    "links": "常用链接",
    "matrix": "责任田",
    "announcements": "公告",
    "accounts": "账号",
}


def _demo_counts() -> dict[str, int]:
    """Current row counts of the demo-data tables, keyed for :func:`seed_demo_data`."""
    with db() as conn:
        return {
            key: int(scalar(conn, f"SELECT COUNT(*) FROM {table}", default=0) or 0)
            for key, table in _DEMO_COUNT_TABLES
        }


def seed_demo_data(*, force: bool = True) -> dict:
    """Explicitly create the demo workspace, member task ledger and demo accounts.

    This is the only supported way to (re)create demo data: the application lifespan
    calls :func:`init_db` but never seeds, so a fresh or factory-reset deployment stays
    empty after a restart until an operator runs this (via ``scripts/seed-demo.ps1`` or
    ``python -m backend.app.seed``).

    ``force`` defaults to ``True`` because calling this function is itself an explicit
    operator decision; pass ``force=False`` (CLI: ``--no-force``) to respect the
    ``factoryResetAt`` marker written by the factory reset. The function is idempotent:
    on an already populated database every step no-ops, no duplicate row is inserted and
    ``seeded`` / ``memberTasks`` / ``accounts`` are ``False`` / ``0`` / ``0``.

    Returns ``{"seeded": bool, "memberTasks": int, "accounts": int, "counts": {...}}``
    where the two integers are the rows added by *this* call.
    """
    init_db()
    with db() as conn:
        accounts_before = int(scalar(conn, "SELECT COUNT(*) FROM users", default=0) or 0)
    seeded = seed_if_empty(force=force)
    member_tasks = seed_member_tasks_if_empty()
    # Backfill demo accounts for deployments whose users table is still empty. On a
    # brand-new database seed_if_empty() already created them, so this is a no-op.
    seed_users_if_empty()
    counts = _demo_counts()
    return {
        "seeded": seeded,
        "memberTasks": member_tasks,
        "accounts": counts["accounts"] - accounts_before,
        "counts": counts,
    }


def main(argv: list[str] | None = None) -> int:
    """CLI: ``python -m backend.app.seed [--no-force]``.

    Writes the demo data explicitly and prints a Chinese summary. Always exits 0 on a
    successful (possibly no-op) run, 1 when the database cannot be written.
    """
    parser = argparse.ArgumentParser(
        prog="python -m backend.app.seed",
        description="为 TeamStudio 显式写入演示数据（服务启动不会自动写入）。",
    )
    parser.add_argument(
        "--no-force",
        action="store_true",
        help="尊重系统重置标记：数据库存在 factoryResetAt 时不写入演示数据。",
    )
    args = parser.parse_args(argv)
    force = not args.no_force

    print("TeamStudio 演示数据脚本")
    print(f"  数据库：{DB_PATH}")
    print(f"  模式：  {'强制写入（忽略重置标记）' if force else '尊重系统重置标记（--no-force）'}")
    print("  提示：  请先停止正在运行的服务再执行本脚本；脚本可重复运行（幂等）。")
    print("")

    try:
        summary = seed_demo_data(force=force)
    except Exception as exc:  # pragma: no cover - operator-facing failure path
        print(f"[失败] 演示数据写入失败：{exc}")
        return 1

    counts = summary["counts"]
    if summary["seeded"]:
        print("[完成] 已写入 TeamStudio 演示数据。")
    elif summary["memberTasks"] or summary["accounts"]:
        print("[完成] 演示数据已存在，本次只补齐了缺失的数据（未重复写入）。")
    else:
        if counts["teams"]:
            print("[提示] 演示数据已存在，本次没有做任何变更（脚本幂等）。")
        else:
            with db() as conn:
                reset_at = get_meta(conn, "factoryResetAt")
            if reset_at is not None and not force:
                print("[跳过] 检测到系统重置标记 factoryResetAt，--no-force 模式不会写入演示数据。")
                print("       如需恢复演示数据，请去掉 --no-force 后重新运行。")
            else:
                print("[提示] 没有需要写入的演示数据，本次未做变更。")

    print("")
    print("当前数据量：")
    for key, label in _COUNT_LABELS.items():
        print(f"  {label}：{counts[key]}")
    print("")
    print(f"本次新增：成员任务 {summary['memberTasks']} 条，演示账号 {summary['accounts']} 个。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
