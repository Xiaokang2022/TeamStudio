import {
  Boxes,
  Braces,
  CalendarDays,
  Cpu,
  ExternalLink,
  Layers3,
  ListTodo,
  Palette,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { useApp } from "../store";
import { Modal } from "./Modal";
import "./AboutDialog.css";

const BUILD_INFO = {
  version: "1.0.0",
  buildDate: "2026-10-19",
  modelName: "DeepSeek Flash",
  modelId: "deepseek-flash",
  reasoning: "high",
  harnessVersion: "0.2.1-rc.2",
  provider: "deepseek-account",
  collaboration: "DeepSeek Harness Agent Team",
};

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { config } = useApp();
  if (!config) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="关于团队工作室"
      description="项目信息、技术构成与模型声明"
      size="lg"
      footer={
        <>
          <a className="btn btn-secondary" href="/api/docs" target="_blank" rel="noreferrer">
            <ExternalLink size={15} /> API 文档
          </a>
          <button className="btn btn-primary" onClick={onClose}>
            知道了
          </button>
        </>
      }
    >
      <div className="about-dialog">
        <header className="about-hero">
          <span className="about-logo">
            <Sparkles size={26} />
          </span>
          <div className="about-hero-copy">
            <span className="eyebrow">ABOUT TEAMSTUDIO</span>
            <h3>{config.site.name}</h3>
            <p>{config.site.tagline}</p>
          </div>
          <span className="about-version">v{BUILD_INFO.version}</span>
        </header>

        <section className="about-creator">
          <div className="about-creator-icon">
            <Cpu size={20} />
          </div>
          <div>
            <span className="about-kicker">MODEL ATTRIBUTION</span>
            <h4>
              本项目由 <strong>{BUILD_INFO.modelName}</strong> 模型构建
            </h4>
            <p>
              模型版本标识 <code>{BUILD_INFO.modelId}</code>（推理强度 {BUILD_INFO.reasoning}），
              通过 <strong>DeepSeek Harness {BUILD_INFO.harnessVersion}</strong> 的 Agent Team
              协作完成：产品实现、界面设计、前后端开发、联调与自动化验收均由模型代理执行。
            </p>
          </div>
        </section>

        <div className="about-grid">
          <section className="about-card">
            <div className="about-card-head">
              <Cpu size={16} />
              <h4>构建信息</h4>
            </div>
            <dl className="about-meta">
              <div>
                <dt>模型</dt>
                <dd>{BUILD_INFO.modelName}</dd>
              </div>
              <div>
                <dt>模型版本</dt>
                <dd><code>{BUILD_INFO.modelId}</code></dd>
              </div>
              <div>
                <dt>推理强度</dt>
                <dd>{BUILD_INFO.reasoning}</dd>
              </div>
              <div>
                <dt>开发框架</dt>
                <dd>DeepSeek Harness {BUILD_INFO.harnessVersion}</dd>
              </div>
              <div>
                <dt>模型提供方</dt>
                <dd>{BUILD_INFO.provider}</dd>
              </div>
              <div>
                <dt>项目版本</dt>
                <dd>{BUILD_INFO.version}</dd>
              </div>
              <div>
                <dt>构建日期</dt>
                <dd>{BUILD_INFO.buildDate}</dd>
              </div>
              <div>
                <dt>协作方式</dt>
                <dd>{BUILD_INFO.collaboration}</dd>
              </div>
            </dl>
          </section>

          <section className="about-card">
            <div className="about-card-head">
              <Layers3 size={16} />
              <h4>项目能力</h4>
            </div>
            <div className="about-feature-list">
              <span><UsersRound size={14} /> 团队 / 开发组双层协作</span>
              <span><ListTodo size={14} /> 成员任务台账、健康状态与工作量负载</span>
              <span><CalendarDays size={14} /> 协作日历与到期管理</span>
              <span><UsersRound size={14} /> 邮箱验证码登录与个人主页</span>
              <span><Layers3 size={14} /> 红黑榜、公告、链接与责任田矩阵</span>
              <span><Braces size={14} /> JSON + GUI 双模式设置</span>
              <span><Boxes size={14} /> SSO、IP/ID 白名单与模块开关</span>
              <span><Palette size={14} /> 鸿蒙风纸白 / 暗黑双主题</span>
            </div>
            <div className="about-stack">
              <span>React 19</span>
              <span>TypeScript</span>
              <span>FastAPI</span>
              <span>SQLite</span>
              <span>Vite</span>
            </div>
          </section>
        </div>

        <section className="about-notes">
          <div>
            <span>项目定位</span>
            <p>可本地部署的团队协作平台，内置演示数据；生产部署前请配置 SMTP 邮件服务、超级管理员与备份策略。</p>
          </div>
          <div>
            <span>数据与隐私</span>
            <p>业务数据保存在本机 SQLite 与 data/settings.json；服务不会主动上传项目数据。</p>
          </div>
        </section>

        <footer className="about-footer">
          <span>Built with DeepSeek Harness · {config.site.footerText}</span>
          <span>© 2026 TeamStudio</span>
        </footer>
      </div>
    </Modal>
  );
}
