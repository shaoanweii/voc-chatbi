'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { apiProfileToUserProfile, saveUserProfileCache } from '@/components/auth-provider';
import styles from './page.module.css';

type LoginTab = 'account' | 'phone';
type FormMode = 'login' | 'register';

const captchaChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function createCaptcha() {
  return Array.from({ length: 4 }, () => captchaChars[Math.floor(Math.random() * captchaChars.length)]).join('');
}

function getSafeRedirectPath() {
  if (typeof window === 'undefined') return '/chatbi';

  const redirect = new URLSearchParams(window.location.search).get('redirect');
  if (!redirect || !redirect.startsWith('/') || redirect.startsWith('/login')) {
    return '/chatbi';
  }

  return redirect;
}

export default function LoginPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<LoginTab>('account');
  const [formMode, setFormMode] = useState<FormMode>('login');
  const [accountId, setAccountId] = useState('');
  const [accountName, setAccountName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [smsCountdown, setSmsCountdown] = useState(0);
  const [captchaCode, setCaptchaCode] = useState('');
  const [captchaValue, setCaptchaValue] = useState('');
  const [hasTriedLogin, setHasTriedLogin] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [isLoginLoading, setIsLoginLoading] = useState(false);
  const [isRegisterLoading, setIsRegisterLoading] = useState(false);
  const [isSmsSending, setIsSmsSending] = useState(false);
  const [showLoginPwd, setShowLoginPwd] = useState(false);
  const [showRegPwd, setShowRegPwd] = useState(false);
  const [showConfirmPwd, setShowConfirmPwd] = useState(false);
  const isAccountLogin = activeTab === 'account';
  const showAccountError = hasTriedLogin && accountId.trim().length === 0;
  const showCaptchaError = hasTriedLogin && captchaValue.trim().length > 0 && captchaValue.trim() !== captchaCode;

  useEffect(() => {
    let cancelled = false;

    fetch('/api/users/me')
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) return;

        const json = await response.json();
        if (json.success) {
          saveUserProfileCache(apiProfileToUserProfile(json.data));
          router.replace(getSafeRedirectPath());
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (smsCountdown <= 0) return;

    const timer = setTimeout(() => setSmsCountdown((prev) => Math.max(prev - 1, 0)), 1000);
    return () => clearTimeout(timer);
  }, [smsCountdown]);

  useEffect(() => {
    setCaptchaCode(createCaptcha());
  }, []);

  const handleAccountLogin = async () => {
    setHasTriedLogin(true);
    setLoginError('');

    const normalizedAccountId = accountId.trim();
    const normalizedPassword = password.trim();
    const normalizedCaptcha = captchaValue.trim();

    if (!normalizedAccountId) return;
    if (!normalizedPassword) {
      setLoginError('密码必填');
      return;
    }
    if (!normalizedCaptcha) {
      setLoginError('验证码必填');
      return;
    }
    if (normalizedCaptcha !== captchaCode) {
      setLoginError('验证码不正确，请重新输入');
      setCaptchaCode(createCaptcha());
      setCaptchaValue('');
      return;
    }

    setIsLoginLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: normalizedAccountId,
          password: normalizedPassword,
        }),
      });

      let json: { success?: boolean; error?: string; data?: unknown };
      try {
        json = await response.json();
      } catch {
        setLoginError('服务器响应异常，请稍后重试');
        setCaptchaCode(createCaptcha());
        setCaptchaValue('');
        return;
      }

      if (!json.success) {
        setLoginError(json.error || '登录失败');
        setCaptchaCode(createCaptcha());
        setCaptchaValue('');
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      saveUserProfileCache(apiProfileToUserProfile(json.data as any));
      router.replace(getSafeRedirectPath());
    } catch (err) {
      const message = err instanceof Error ? err.message : '登录失败，请稍后重试';
      setLoginError(message);
      setCaptchaCode(createCaptcha());
      setCaptchaValue('');
    } finally {
      setIsLoginLoading(false);
    }
  };

  const handleRegister = async () => {
    setLoginError('');

    const normalizedAccountId = accountId.trim();
    const normalizedAccountName = accountName.trim();
    const normalizedPassword = password.trim();
    const normalizedConfirmPassword = confirmPassword.trim();

    if (!normalizedAccountId) {
      setLoginError('账号ID 必填');
      return;
    }
    if (!normalizedPassword) {
      setLoginError('密码 必填');
      return;
    }
    if (normalizedPassword.length < 6) {
      setLoginError('密码至少需要6位');
      return;
    }
    if (!normalizedConfirmPassword) {
      setLoginError('确认密码 必填');
      return;
    }
    if (normalizedPassword !== normalizedConfirmPassword) {
      setLoginError('两次输入的密码不一致');
      return;
    }

    setIsRegisterLoading(true);
    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: normalizedAccountId,
          accountName: normalizedAccountName,
          password: normalizedPassword,
        }),
      });
      const json = await response.json();

      if (!json.success) {
        setLoginError(json.error || '注册失败');
        return;
      }

      setFormMode('login');
      setConfirmPassword('');
      setLoginError('注册成功，请登录');
    } catch {
      setLoginError('注册失败，请稍后重试');
    } finally {
      setIsRegisterLoading(false);
    }
  };

  const handleSendSmsCode = async () => {
    setLoginError('');
    const normalizedPhone = phone.trim();
    if (!/^1[3-9]\d{9}$/.test(normalizedPhone)) {
      setLoginError('请输入正确的手机号');
      return;
    }

    setIsSmsSending(true);
    try {
      const response = await fetch('/api/auth/phone/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: normalizedPhone }),
      });
      const json = await response.json();

      if (!json.success) {
        setLoginError(json.error || '验证码发送失败');
        return;
      }

      setSmsCountdown(60);
      setLoginError('验证码已发送');
    } catch {
      setLoginError('验证码发送失败，请稍后重试');
    } finally {
      setIsSmsSending(false);
    }
  };

  const handlePhoneLogin = async () => {
    setLoginError('');
    const normalizedPhone = phone.trim();
    const normalizedCode = smsCode.trim();

    if (!/^1[3-9]\d{9}$/.test(normalizedPhone)) {
      setLoginError('请输入正确的手机号');
      return;
    }
    if (!normalizedCode) {
      setLoginError('请输入短信验证码');
      return;
    }

    setIsLoginLoading(true);
    try {
      const response = await fetch('/api/auth/phone/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: normalizedPhone,
          code: normalizedCode,
        }),
      });
      const json = await response.json();

      if (!json.success) {
        setLoginError(json.error || '登录失败');
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      saveUserProfileCache(apiProfileToUserProfile(json.data as any));
      router.replace(getSafeRedirectPath());
    } catch {
      setLoginError('登录失败，请稍后重试');
    } finally {
      setIsLoginLoading(false);
    }
  };

  return (
    <main className={styles.page}>
      <div className={styles.topLogo}>
        <Image
          src="/assets/futonglogo.png"
          alt="富通科技"
          width={98}
          height={32}
          priority
        />
      </div>

      <section className={styles.left}>
        <div className={styles.hero}>
          <h1>
            <span>VOC</span> 智能问数
          </h1>
          <p>7×24 小时在线的数据洞察伙伴</p>

          <div className={styles.glassCardGrid}>
            <article className={styles.glassCard}>
              <div className={styles.glassIcon}>▣</div>
              <strong>自然语言问数</strong>
              <span>业务人员直接提问，自动生成 SQL、图表与分析结论。</span>
            </article>
            <article className={styles.glassCard}>
              <div className={styles.glassIcon}>⌬</div>
              <strong>多源数据协同</strong>
              <span>支持数据库、Excel/CSV 与业务定义数据统一接入。</span>
            </article>
            <article className={styles.glassCard}>
              <div className={styles.glassIcon}>◇</div>
              <strong>安全权限继承</strong>
              <span>只读连接、字段脱敏、查询审计，保障企业数据安全。</span>
            </article>
            <article className={styles.glassCard}>
              <div className={styles.glassIcon}>✦</div>
              <strong>VOC 业务增强</strong>
              <span>内置汽车行业模型、标签、情感意图与客户声音分析能力。</span>
            </article>
          </div>
        </div>
      </section>

      <section className={styles.loginSide}>
        <div className={styles.loginPanel}>
          <h2>欢迎登录 <span>智能问数</span></h2>

          <div className={styles.loginTabs}>
            <button
              className={`${styles.loginTab} ${isAccountLogin ? styles.active : ''}`}
              type="button"
              onClick={() => setActiveTab('account')}
            >
              账号登录
            </button>
            <button
              className={`${styles.loginTab} ${!isAccountLogin ? styles.active : ''}`}
              type="button"
              onClick={() => {
                setActiveTab('phone');
                setFormMode('login');
                setLoginError('');
              }}
            >
              手机号登录
            </button>
          </div>

          {formMode === 'login' ? (
            <form className={`${styles.form} ${isAccountLogin ? styles.active : ''}`}>
              <div className={styles.field}>
                <input
                  className={`${styles.input} ${showAccountError ? styles.error : ''}`}
                  value={accountId}
                  onChange={(event) => {
                    setAccountId(event.target.value);
                    setLoginError('');
                  }}
                  placeholder="请输入账号名称"
                />
                {showAccountError && <span className={styles.errorText}>账号名称 必填</span>}
              </div>
              <div className={styles.field}>
                <div className={styles.inputWrap}>
                  <input
                    className={styles.input}
                    type={showLoginPwd ? 'text' : 'password'}
                    placeholder="请输入登录密码"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setLoginError('');
                    }}
                  />
                  <button type="button" className={styles.eye} onClick={() => setShowLoginPwd(!showLoginPwd)}>
                    {showLoginPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className={styles.field}>
                <div className={styles.captchaRow}>
                  <input
                    className={`${styles.input} ${showCaptchaError ? styles.error : ''}`}
                    value={captchaValue}
                    onChange={(event) => {
                      setCaptchaValue(event.target.value);
                      setLoginError('');
                    }}
                    placeholder="请输入验证码"
                  />
                  <div className={styles.captchaImg}>{captchaCode}</div>
                </div>
              </div>
              {loginError && (
                <div className={loginError.includes('成功') ? styles.successText : styles.feedbackText}>
                  {loginError}
                </div>
              )}
              <p className={styles.agree}>
                登录视为您已阅读并同意 VOC <a href="#">服务条款</a> 和 <a href="#">隐私政策</a>
              </p>
              <button className={styles.loginButton} type="button" onClick={handleAccountLogin} disabled={isLoginLoading}>
                {isLoginLoading ? '登录中...' : '登录'}
              </button>
            </form>
          ) : (
            <form className={`${styles.form} ${isAccountLogin ? styles.active : ''}`}>
              <div className={styles.field}>
                <input
                  className={styles.input}
                  value={accountId}
                  onChange={(event) => {
                    setAccountId(event.target.value);
                    setLoginError('');
                  }}
                  placeholder="请输入账号ID"
                />
              </div>
              <div className={styles.field}>
                <input
                  className={styles.input}
                  value={accountName}
                  onChange={(event) => {
                    setAccountName(event.target.value);
                    setLoginError('');
                  }}
                  placeholder="请输入姓名"
                />
              </div>
              <div className={styles.field}>
                <div className={styles.inputWrap}>
                  <input
                    className={styles.input}
                    type={showRegPwd ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setLoginError('');
                    }}
                    placeholder="请输入密码"
                  />
                  <button type="button" className={styles.eye} onClick={() => setShowRegPwd(!showRegPwd)}>
                    {showRegPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className={styles.field}>
                <div className={styles.inputWrap}>
                  <input
                    className={styles.input}
                    type={showConfirmPwd ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(event) => {
                      setConfirmPassword(event.target.value);
                      setLoginError('');
                    }}
                    placeholder="请确认密码"
                  />
                  <button type="button" className={styles.eye} onClick={() => setShowConfirmPwd(!showConfirmPwd)}>
                    {showConfirmPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              {loginError && (
                <div className={loginError.includes('成功') ? styles.successText : styles.feedbackText}>
                  {loginError}
                </div>
              )}
              <p className={styles.agree}>
                注册视为您已阅读并同意 VOC <a href="#">服务条款</a> 和 <a href="#">隐私政策</a>
              </p>
              <button className={styles.loginButton} type="button" onClick={handleRegister} disabled={isRegisterLoading}>
                {isRegisterLoading ? '注册中...' : '注册并验证'}
              </button>
            </form>
          )}

          <form className={`${styles.form} ${!isAccountLogin ? styles.active : ''}`}>
            <div className={styles.field}>
              <input
                className={styles.input}
                value={phone}
                onChange={(event) => {
                  setPhone(event.target.value.replace(/\D/g, '').slice(0, 11));
                  setLoginError('');
                }}
                placeholder="请输入手机号"
              />
            </div>
            <div className={styles.field}>
              <div className={styles.captchaRow}>
                <input
                  className={styles.input}
                  value={smsCode}
                  onChange={(event) => {
                    setSmsCode(event.target.value.replace(/\D/g, '').slice(0, 8));
                    setLoginError('');
                  }}
                  placeholder="请输入短信验证码"
                />
                <button
                  className={`${styles.captchaImg} ${styles.smsCaptcha}`}
                  type="button"
                  onClick={handleSendSmsCode}
                  disabled={isSmsSending || smsCountdown > 0}
                >
                  {smsCountdown > 0 ? `${smsCountdown}s` : isSmsSending ? '发送中' : '获取验证码'}
                </button>
              </div>
            </div>
            {loginError && (
              <div className={loginError.includes('成功') || loginError.includes('已发送') ? styles.successText : styles.feedbackText}>
                {loginError}
              </div>
            )}
            <div className={styles.phoneSpacer} />
            <p className={styles.agree}>
              登录视为您已阅读并同意 VOC <a href="#">服务条款</a> 和 <a href="#">隐私政策</a>
            </p>
            <button className={styles.loginButton} type="button" onClick={handlePhoneLogin} disabled={isLoginLoading}>
              {isLoginLoading ? '登录中...' : '登录'}
            </button>
          </form>

          {isAccountLogin && (
            <div className={styles.formLinks}>
              <a href="#">忘记密码</a>
            </div>
          )}

          <div className={styles.divider}>其他登录方式</div>
          <div className={styles.otherLogin}>
            <button className={styles.emailLogin} type="button">
              ▣ 邮箱
            </button>
          </div>

          {isAccountLogin && (
            <div className={styles.register}>
              {formMode === 'login' ? (
                <>
                  没有账号？{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setFormMode('register');
                      setLoginError('');
                      setPassword('');
                      setConfirmPassword('');
                    }}
                  >
                    现在就注册
                  </button>
                </>
              ) : (
                <>
                  已有账号？{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setFormMode('login');
                      setLoginError('');
                      setPassword('');
                      setConfirmPassword('');
                    }}
                  >
                    返回登录
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      <footer className={styles.footer}>
        版权所有 © 富通科技 2026
      </footer>
    </main>
  );
}
