import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  KeyRound,
  Loader2,
  LockKeyhole,
  Mail,
  MailWarning,
  Send,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { useToast } from "../components/Toast";
import { Avatar } from "../components/Avatar";
import { hashRoute } from "../lib/utils";
import type { EmailCodeRequestResponse } from "../types";
import "./LoginPage.css";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function roleText(isDeviceAdmin: boolean, isSuperAdmin: boolean, userRole: string | null): string {
  // The device status is explained by a dedicated note/badge on this page, so the
  // role itself stays the plain "超级管理员" to avoid repeating the same information.
  if (isDeviceAdmin || isSuperAdmin) return "超级管理员";
  if (userRole === "team_admin") return "团队管理员";
  if (userRole === "group_admin") return "开发组管理员";
  return "成员";
}

function asMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "操作失败，请稍后重试。";
}

export default function LoginPage() {
  const { config, data, navigate, reload } = useApp();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [requestInfo, setRequestInfo] = useState<EmailCodeRequestResponse | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [deviceLoggingIn, setDeviceLoggingIn] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState("");

  const emailLogin = config?.auth.emailLogin;
  const emailConfigured = Boolean(config?.email.configured);
  const emailLoginEnabled = Boolean(emailLogin?.enabled);
  const emailReady = emailLoginEnabled && emailConfigured;
  const ssoConfigured = Boolean(config?.auth.sso.configured);
  const guestBrowsing = Boolean(config?.auth.guestMode || config?.auth.allowGuestRead);
  const codeLength = emailLogin?.codeLength ?? 6;
  const resendSeconds = emailLogin?.resendSeconds ?? 60;
  const expiryMinutes = emailLogin?.codeExpiryMinutes ?? 10;
  const me = data?.me;
  const authenticated = Boolean(me?.authenticated);
  const deployDevice = Boolean(me?.deployDevice);
  const deviceAdminActive = Boolean(me?.isDeviceAdmin);

  const emailValid = useMemo(() => EMAIL_PATTERN.test(email.trim()), [email]);

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = window.setTimeout(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  useEffect(() => {
    const status = hashRoute().params.get("activation");
    if (!status) return;
    const message =
      status === "expired"
        ? "激活链接已过期，请联系超级管理员重新生成激活链接。"
        : status === "used"
          ? "该激活链接已被使用；如账号已激活，请直接使用邮箱验证码登录。"
          : "激活链接无效，请确认链接完整或联系超级管理员。";
    setError(message);
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${window.location.search}#/login`,
    );
  }, []);

  if (!config || !data || !me) return null;

  const resetForm = () => {
    setStage("email");
    setCode("");
    setRequestInfo(null);
    setCountdown(0);
    setError("");
  };

  const resetToEmail = () => {
    setStage("email");
    setCode("");
    setRequestInfo(null);
    setError("");
  };

  const handleSend = async () => {
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalized)) {
      setError("请输入有效的邮箱地址，例如 name@company.com");
      return;
    }
    setSending(true);
    setError("");
    try {
      const result = await api.requestEmailCode(normalized);
      setEmail(normalized);
      setRequestInfo(result);
      setStage("code");
      setCode("");
      setCountdown(result.resendAfterSeconds || resendSeconds);
      toast(
        result.registered ? "验证码已发送，请查收邮箱" : "验证码已发送，验证通过后将自动注册成员账号",
        "success",
      );
    } catch (err) {
      const details = err instanceof ApiError ? (err.details as { retryAfterSeconds?: number } | undefined) : undefined;
      if (typeof details?.retryAfterSeconds === "number") {
        setCountdown(Math.max(1, Math.ceil(details.retryAfterSeconds)));
      }
      setError(asMessage(err));
    } finally {
      setSending(false);
    }
  };

  const handleVerify = async () => {
    const value = code.replace(/\D/g, "");
    if (value.length !== codeLength) {
      setError(`请输入 ${codeLength} 位数字验证码`);
      return;
    }
    setVerifying(true);
    setError("");
    try {
      await api.verifyEmailCode(email.trim().toLowerCase(), value);
      toast("登录成功，正在进入团队工作室…", "success");
      window.location.hash = "/overview";
      window.location.reload();
    } catch (err) {
      setError(asMessage(err));
      setCode("");
    } finally {
      setVerifying(false);
    }
  };

  const handleSwitchAccount = async () => {
    setSwitching(true);
    try {
      const result = await api.logout();
      if (result.endSessionUrl) {
        window.location.href = result.endSessionUrl;
        return;
      }
      resetForm();
      await reload(true);
      toast("已退出当前账号，可登录其他邮箱账号", "info");
    } catch (err) {
      setError(asMessage(err));
    } finally {
      setSwitching(false);
    }
  };

  const handleDeviceAdminLogin = async () => {
    setDeviceLoggingIn(true);
    setError("");
    try {
      await api.deviceLogin();
      window.location.hash = "/overview";
      window.location.reload();
    } catch (err) {
      setError(asMessage(err));
    } finally {
      setDeviceLoggingIn(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (stage === "email") void handleSend();
    else void handleVerify();
  };

  const ssoLink = (
    <a className="login-sso-link" href={api.ssoLoginHref("/")}>
      <ShieldCheck size={15} /> 使用企业 SSO 登录
    </a>
  );

  const guestAction = guestBrowsing ? (
    <button className="btn btn-ghost btn-lg login-guest" type="button" onClick={() => navigate("overview")}>
      以访客身份浏览
    </button>
  ) : (
    <p className="login-guest-disabled">访客模式已关闭，登录后即可浏览团队内容。</p>
  );

  const deviceAdminAction =
    deployDevice && !deviceAdminActive ? (
      <div className="login-device-entry">
        <button
          className="btn btn-secondary btn-lg"
          type="button"
          onClick={() => void handleDeviceAdminLogin()}
          disabled={deviceLoggingIn}
        >
          <ShieldCheck size={17} />
          {deviceLoggingIn ? "正在切换…" : "以系统内置管理员身份登录"}
        </button>
        <span className="login-device-hint">
          已检测到系统内置管理员：本机可直接使用该身份登录，无需邮箱。退出后可使用其他账号登录，其他账号不会获得管理权限。
        </span>
      </div>
    ) : null;

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
              <strong>邮箱验证码 · 免密登录</strong>
              <span>无需记忆密码，六位验证码即可登录或注册成员账号。</span>
            </div>
          </div>
          <div>
            <span className="feature-orb amber">
              <ShieldCheck size={18} />
            </span>
            <div>
              <strong>清晰的分级权限</strong>
              <span>超级管理员、团队管理员与开发组管理员各司其职。</span>
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
            {emailReady ? <Mail size={24} /> : <LockKeyhole size={24} />}
          </span>
          <p className="eyebrow">EMAIL SIGN-IN</p>
          <h2>{authenticated ? "你已登录团队工作室" : "登录团队工作室"}</h2>

          {authenticated ? (
            <>
              <div className="login-current">
                <Avatar
                  name={me.name}
                  src={me.avatar}
                  color={me.isDeviceAdmin ? "#0ea5e9" : me.avatarColor || "#7c3aed"}
                  size="lg"
                />
                <div>
                  <strong>{me.name}</strong>
                  <span>
                    {me.email || "已通过身份验证"} ·{" "}
                    {roleText(me.isDeviceAdmin, me.isSuperAdmin, me.userRole)}
                  </span>
                </div>
              </div>
              <button className="btn btn-primary btn-lg" onClick={() => navigate("overview")}>
                进入工作室
              </button>
              <button
                className="btn btn-ghost btn-lg login-switch"
                onClick={() => void handleSwitchAccount()}
                disabled={switching}
              >
                {switching ? <Loader2 size={16} className="spin" /> : null}
                {switching ? "正在退出…" : "退出登录 / 切换账号"}
              </button>
              {me.isDeviceAdmin ? (
                <div className="login-device-note">
                  <ShieldCheck size={15} />
                  当前使用系统内置管理员身份；退出后可使用其他账号登录，其他账号不会获得管理权限。
                </div>
              ) : null}
              {deviceAdminAction}
            </>
          ) : (
            <>
              <p className="login-desc">
                {emailReady
                  ? "使用邮箱验证码免密登录。首次登录会自动创建成员账号，无需设置密码。"
                  : "邮箱验证码登录当前不可用，你仍可以以访客身份浏览公开内容。"}
              </p>

              {error ? (
                <div className="login-error" role="alert">
                  {error}
                </div>
              ) : null}

              {emailReady ? (
                <form className="login-form" onSubmit={submit}>
                  {stage === "email" ? (
                    <>
                      <div className="field">
                        <label htmlFor="login-email">邮箱地址</label>
                        <input
                          id="login-email"
                          className="input"
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          placeholder="name@company.com"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                          disabled={sending}
                          autoFocus
                        />
                        <span className="field-hint">验证码将发送到该邮箱，请确保可以正常收信。</span>
                      </div>
                      <button
                        className="btn btn-primary btn-lg"
                        type="submit"
                        disabled={sending || !emailValid}
                      >
                        {sending ? <Loader2 size={17} className="spin" /> : <Send size={17} />}
                        {sending ? "正在发送验证码…" : "发送验证码"}
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="login-code-target">
                        <Mail size={15} />
                        <span>
                          验证码已发送至 <strong>{requestInfo?.email ?? email}</strong>
                        </span>
                        <button type="button" className="text-button" onClick={resetToEmail}>
                          修改邮箱
                        </button>
                      </div>
                      <div className="login-purpose">
                        {requestInfo?.registered
                          ? "该邮箱已有账号，验证通过后直接登录。"
                          : "该邮箱尚未注册，验证通过后将自动创建成员账号。"}
                      </div>
                      <div className="field">
                        <label htmlFor="login-code">邮箱验证码</label>
                        <input
                          id="login-code"
                          className="input login-code-input"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={codeLength}
                          placeholder={`请输入 ${codeLength} 位数字验证码`}
                          value={code}
                          onChange={(event) =>
                            setCode(event.target.value.replace(/\D/g, "").slice(0, codeLength))
                          }
                          disabled={verifying}
                          autoFocus
                        />
                        <span className="field-hint">
                          验证码 {expiryMinutes} 分钟内有效，请勿泄露给他人。
                        </span>
                      </div>
                      <button
                        className="btn btn-primary btn-lg"
                        type="submit"
                        disabled={verifying || code.length !== codeLength}
                      >
                        {verifying ? <Loader2 size={17} className="spin" /> : <KeyRound size={17} />}
                        {verifying ? "正在验证…" : requestInfo?.registered ? "登录" : "注册并登录"}
                      </button>
                      <div className="login-resend">
                        {countdown > 0 ? (
                          <span>{countdown} 秒后可重新发送</span>
                        ) : (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => void handleSend()}
                            disabled={sending}
                          >
                            {sending ? "正在发送…" : "重新发送验证码"}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </form>
              ) : (
                <div className="login-notice">
                  <MailWarning size={18} />
                  <div>
                    <strong>
                      {!emailLoginEnabled ? "邮箱验证码登录未启用" : "邮件服务尚未配置"}
                    </strong>
                    <span>
                      {!emailLoginEnabled
                        ? "当前站点暂未开放邮箱验证码登录，请联系超级管理员在系统设置中开启。"
                        : "SMTP 邮件服务尚未配置，暂时无法发送验证码。请联系超级管理员在系统设置 → 邮件服务中完成配置。"}
                    </span>
                    {!emailLoginEnabled && !emailConfigured ? (
                      <span>当前同时缺少邮件服务配置，管理员配置完成后即可使用免密登录。</span>
                    ) : null}
                  </div>
                </div>
              )}

              {deviceAdminAction}
              {ssoConfigured ? ssoLink : null}
              {guestAction}
            </>
          )}

          {authenticated ? null : (
            <p className="login-security">
              <ShieldCheck size={13} /> 会话使用 HMAC-SHA256 签名的 HttpOnly Cookie，验证码不会以明文存储。
            </p>
          )}
        </div>
        <p className="login-footer">{config.site.footerText}</p>
      </section>
    </div>
  );
}
