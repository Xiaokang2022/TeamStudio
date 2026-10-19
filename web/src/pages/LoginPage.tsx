import { ArrowLeft, KeyRound, LockKeyhole, ShieldCheck, Sparkles, UserRoundCheck } from "lucide-react";
import { api } from "../api";
import { useApp } from "../store";
import { useToast } from "../components/Toast";
import { Avatar } from "../components/Avatar";

export default function LoginPage() {
  const { config, data, navigate } = useApp();
  const { toast } = useToast();
  if (!config || !data) return null;
  const sso = config.auth.sso;
  const me = data.me;

  const startLogin = () => {
    if (!sso.configured) {
      toast("企业 SSO 尚未配置，已自动回退到访客模式", "info");
      navigate("overview");
      return;
    }
    window.location.href = api.loginHref(`${window.location.pathname}${window.location.hash}`);
  };

  return (
    <div className="login-page">
      <section className="login-showcase">
        <div className="login-showcase-grid" />
        <div className="login-brand">
          <span className="brand-mark large">
            <Sparkles size={24} />
          </span>
          <div>
            <strong>{config.site.name}</strong>
            <span>TEAM STUDIO PLATFORM</span>
          </div>
        </div>
        <div className="login-hero-copy">
          <span className="eyebrow">A PLACE FOR TEAMS TO GROW</span>
          <h1>
            让协作被看见，
            <br />
            让成长有回声。
          </h1>
          <p>{config.site.tagline}</p>
        </div>
        <div className="login-feature-list">
          <div>
            <span className="feature-orb violet">
              <UserRoundCheck size={18} />
            </span>
            <div>
              <strong>成员概览与成长轨迹</strong>
              <span>当前在做什么、做过什么，一目了然。</span>
            </div>
          </div>
          <div>
            <span className="feature-orb cyan">
              <KeyRound size={18} />
            </span>
            <div>
              <strong>细粒度权限与安全边界</strong>
              <span>团队 / 开发组双管理员，设备内置 Admin。</span>
            </div>
          </div>
          <div>
            <span className="feature-orb amber">
              <ShieldCheck size={18} />
            </span>
            <div>
              <strong>可回退的访客体验</strong>
              <span>SSO 未就绪时自动降级，不影响浏览。</span>
            </div>
          </div>
        </div>
        <div className="login-orbit orbit-one" />
        <div className="login-orbit orbit-two" />
      </section>

      <section className="login-panel">
        <button className="login-back" onClick={() => navigate("overview")}>
          <ArrowLeft size={16} /> 返回工作室
        </button>
        <div className="login-card">
          <span className="login-lock">
            {sso.configured ? <ShieldCheck size={24} /> : <LockKeyhole size={24} />}
          </span>
          <p className="eyebrow">SECURE ACCESS</p>
          <h2>{me.authenticated ? "你已拥有访问身份" : sso.configured ? `使用 ${sso.providerName} 登录` : "当前为访客模式"}</h2>
          {me.authenticated ? (
            <>
              <div className="login-current">
                <Avatar name={me.name} color={me.isDeviceAdmin ? "#0ea5e9" : "#7c3aed"} size="lg" />
                <div>
                  <strong>{me.name}</strong>
                  <span>
                    {me.isDeviceAdmin ? "部署设备内置 Admin · 完整管理权限" : me.email || "已通过企业身份验证"}
                  </span>
                </div>
              </div>
              <button className="btn btn-primary btn-lg" onClick={() => navigate("overview")}>
                进入工作室
              </button>
            </>
          ) : (
            <>
              <p className="login-desc">
                {sso.configured
                  ? "系统使用 OIDC 授权码 + PKCE 完成身份验证，仅同步姓名、邮箱与唯一标识。"
                  : "企业 SSO 尚未配置。根据安全策略，系统已自动回退到只读访客模式，你仍可浏览全部公开内容。"}
              </p>
              {sso.configured ? (
                <button className="btn btn-primary btn-lg" onClick={startLogin}>
                  <ShieldCheck size={18} /> 使用 {sso.providerName} 登录
                </button>
              ) : (
                <div className="login-fallback">
                  <span>
                    <LockKeyhole size={16} /> SSO 未配置，已启用访客回退
                  </span>
                  <button className="btn btn-primary btn-lg" onClick={() => navigate("overview")}>
                    以访客身份继续
                  </button>
                </div>
              )}
              <p className="login-security">
                <ShieldCheck size={13} /> 会话使用 HMAC-SHA256 签名 HttpOnly Cookie，不存储第三方密码。
              </p>
            </>
          )}
          {me.isDeviceAdmin ? (
            <div className="login-device-note">
              <ShieldCheck size={15} />
              当前请求来自部署设备，已自动获得内置 Admin 身份。该身份不会写入配置文件。
            </div>
          ) : null}
        </div>
        <p className="login-footer">{config.site.footerText}</p>
      </section>
    </div>
  );
}
