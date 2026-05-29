"use client"

import { useEffect, useState } from 'react';
import { User, Mail, Phone, Building2, FileText, Save, RotateCcw, LogOut } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiProfileToUserProfile, useAuthProfile } from '@/components/auth-provider';
import { usePinyinInitial } from '@/hooks/use-pinyin-initial';
import { GlassConfirmDialog } from './glass-confirm-dialog';

export interface UserProfile {
  id: string;
  avatar: string;
  accountName: string;
  account: string;
  email: string;
  phone: string;
  company: string;
  companyRole: string;
  bio: string;
}

interface ProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile?: UserProfile | null;
  onProfileChange?: (profile: UserProfile) => void;
  readonly?: boolean;
}

export function ProfileDialog({ open, onOpenChange, profile: externalProfile, onProfileChange, readonly = false }: ProfileDialogProps) {
  const { profile: cachedProfile, updateProfileCache, clearProfileCache } = useAuthProfile();
  const [profile, setProfile] = useState<UserProfile | null>(externalProfile ?? null);
  const [isEditing, setIsEditing] = useState(false);
  const [originalProfile, setOriginalProfile] = useState<UserProfile | null>(externalProfile ?? null);
  const [imageError, setImageError] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [showAlertMsg, setShowAlertMsg] = useState('');

  useEffect(() => {
    if (externalProfile === undefined) return;

    setProfile(externalProfile);
    setOriginalProfile(externalProfile);
    setImageError(false);
  }, [externalProfile]);

  useEffect(() => {
    if (externalProfile !== undefined || !cachedProfile) return;

    setProfile(cachedProfile);
    setOriginalProfile(cachedProfile);
    setImageError(false);
  }, [cachedProfile, externalProfile]);

  useEffect(() => {
    if (!open || externalProfile !== undefined) return;

    let cancelled = false;

    fetch('/api/users/me')
      .then(async (response) => {
        const json = await response.json();
        if (!cancelled && json.success) {
          const nextProfile = apiProfileToUserProfile(json.data);
          setProfile(nextProfile);
          setOriginalProfile(nextProfile);
          updateProfileCache(nextProfile);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [externalProfile, open]);

  const handleEditClick = () => {
    if (!profile) return;
    setIsEditing(true);
    setOriginalProfile({ ...profile });
    setSaveError('');
  };

  const handleLogout = async () => {
    try {
      const response = await fetch('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (response.ok) {
        clearProfileCache();
        window.location.href = '/login';
      }
    } catch {
      clearProfileCache();
      window.location.href = '/login';
    }
  };

  const handleSave = async () => {
    if (!profile) return;

    setIsSaving(true);
    setSaveError('');
    try {
      const response = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountName: profile.accountName,
          avatarUrl: profile.avatar || null,
          email: profile.email,
          phone: profile.phone,
          company: profile.company,
          companyRole: profile.companyRole,
          bio: profile.bio,
        }),
      });
      const json = await response.json();

      if (!json.success) {
        setSaveError(json.error || '保存失败');
        return;
      }

      const nextProfile = apiProfileToUserProfile(json.data);
      setProfile(nextProfile);
      setOriginalProfile(nextProfile);
      updateProfileCache(nextProfile);
      onProfileChange?.(nextProfile);
      setIsEditing(false);
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    } catch {
      setSaveError('保存失败，请稍后重试');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (originalProfile) {
      setProfile({ ...originalProfile });
    }
    setIsEditing(false);
    setSaveError('');
  };

  const handleChange = (field: keyof UserProfile, value: string) => {
    setProfile(prev => (prev ? { ...prev, [field]: value } : prev));
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 检查文件类型
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg'];
    if (!validTypes.includes(file.type)) {
      setShowAlertMsg('请选择PNG或JPG格式的图片');
      return;
    }

    // 检查文件大小 (2MB)
    const maxSize = 2 * 1024 * 1024;
    if (file.size > maxSize) {
      setSaveError('图片体积不得超过2MB');
      return;
    }

    // 先在前端显示预览
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      setProfile(prev => (prev ? { ...prev, avatar: result } : prev));
      setImageError(false);
    };
    reader.onerror = () => {
      setImageError(true);
    };
    reader.readAsDataURL(file);
  };

  const profileInitial = usePinyinInitial(profile?.accountName || profile?.account);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[510px] max-h-[calc(100vh-4rem)] overflow-y-auto bg-white/85 backdrop-blur-xl border-white/40 rounded-[20px] shadow-[0_24px_72px_rgba(15,23,42,0.14)]">
        {!profile ? (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-4">
              <div className="w-6 h-6 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"></div>
            </div>
            <p className="text-sm text-slate-500">加载中...</p>
          </div>
        ) : (
          <>
          <DialogHeader className="text-center pb-4">
          <div className="relative mx-auto mb-3">
            {isEditing && !readonly ? (
              <label className="relative block w-16 h-16 cursor-pointer group">
                {profile.avatar && !imageError ? (
                  <img
                    src={profile.avatar}
                    alt="用户头像"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      target.src = '';
                      setImageError(true);
                    }}
                    className="w-full h-full rounded-full object-cover shadow-md"
                  />
                ) : (
                  <div className="w-full h-full rounded-full bg-gradient-to-br from-slate-300 to-slate-400 flex items-center justify-center text-2xl font-bold text-white shadow-md">
                    {profileInitial}
                  </div>
                )}
                {/* 覆盖层 */}
                <div className="absolute inset-0 rounded-full bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <div className="w-8 h-8 rounded-full bg-white/90 flex items-center justify-center shadow-lg">
                    <User className="w-4 h-4 text-[#6366f1]" />
                  </div>
                </div>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/jpg"
                  onChange={handleAvatarChange}
                  className="hidden"
                />
              </label>
            ) : (
              <>
                {profile.avatar && !imageError ? (
                  <img
                    src={profile.avatar}
                    alt="用户头像"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      target.src = '';
                      setImageError(true);
                    }}
                    className="w-16 h-16 rounded-full object-cover shadow-md"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-full bg-gradient-to-br from-slate-300 to-slate-400 flex items-center justify-center text-2xl font-bold text-white shadow-md">
                    {profileInitial}
                  </div>
                )}
              </>
            )}
          </div>
          <DialogTitle className="text-lg font-extrabold text-[#0f172a] mx-auto">
            {profile.accountName}
          </DialogTitle>
          <p className="text-slate-400 text-xs mt-0.5 mx-auto">@{profile.account}</p>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4">
          {/* 账号（不可修改） */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
              <User className="w-3 h-3" />
              账号
            </label>
            {isEditing ? (
              <input
                type="text"
                value={profile.account}
                disabled
                className="h-9 w-full rounded-lg bg-slate-100/60 border border-slate-200/60 px-3 text-xs text-slate-400 font-mono cursor-not-allowed"
              />
            ) : (
              <div className="h-9 rounded-lg bg-slate-50/60 border border-slate-200/60 px-3 flex items-center text-slate-600 text-xs font-mono">
                {profile.account}
              </div>
            )}
          </div>

          {/* 账号名称 */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
              <User className="w-3 h-3" />
              账号名称
            </label>
            {isEditing ? (
              <input
                type="text"
                value={profile.accountName}
                onChange={(e) => handleChange('accountName', e.target.value)}
                className="h-9 w-full rounded-lg bg-white/80 border border-slate-200/60 px-3 text-xs text-slate-700 outline-none focus:border-[#6366f1] focus:ring-1.5 focus:ring-[#6366f1]/20 transition-all"
                placeholder="请输入账号名称"
              />
            ) : (
              <div className="h-9 rounded-lg bg-slate-50/60 border border-slate-200/60 px-3 flex items-center text-slate-700 text-xs">
                {profile.accountName}
              </div>
            )}
          </div>

          {/* 邮箱 */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
              <Mail className="w-3 h-3" />
              邮箱
            </label>
            {isEditing ? (
              <input
                type="email"
                value={profile.email}
                onChange={(e) => handleChange('email', e.target.value)}
                className="h-9 w-full rounded-lg bg-white/80 border border-slate-200/60 px-3 text-xs text-slate-700 outline-none focus:border-[#6366f1] focus:ring-1.5 focus:ring-[#6366f1]/20 transition-all"
                placeholder="请输入邮箱地址"
              />
            ) : (
              <div className="h-9 rounded-lg bg-slate-50/60 border border-slate-200/60 px-3 flex items-center text-slate-700 text-xs">
                {profile.email}
              </div>
            )}
          </div>

          {/* 电话 */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
              <Phone className="w-3 h-3" />
              电话
            </label>
            {isEditing ? (
              <input
                type="tel"
                value={profile.phone}
                onChange={(e) => handleChange('phone', e.target.value)}
                className="h-9 w-full rounded-lg bg-white/80 border border-slate-200/60 px-3 text-xs text-slate-700 outline-none focus:border-[#6366f1] focus:ring-1.5 focus:ring-[#6366f1]/20 transition-all"
                placeholder="请输入电话号码"
              />
            ) : (
              <div className="h-9 rounded-lg bg-slate-50/60 border border-slate-200/60 px-3 flex items-center text-slate-700 text-xs">
                {profile.phone}
              </div>
            )}
          </div>

          {/* 企业名称 */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
              <Building2 className="w-3 h-3" />
              企业名称
            </label>
            {isEditing ? (
              <input
                type="text"
                value={profile.company}
                onChange={(e) => handleChange('company', e.target.value)}
                className="h-9 w-full rounded-lg bg-white/80 border border-slate-200/60 px-3 text-xs text-slate-700 outline-none focus:border-[#6366f1] focus:ring-1.5 focus:ring-[#6366f1]/20 transition-all"
                placeholder="请输入企业名称"
              />
            ) : (
              <div className="h-9 rounded-lg bg-slate-50/60 border border-slate-200/60 px-3 flex items-center text-slate-700 text-xs">
                {profile.company}
              </div>
            )}
          </div>

          {/* 企业角色 */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
              <FileText className="w-3 h-3" />
              企业角色
            </label>
            {isEditing ? (
              <input
                type="text"
                value={profile.companyRole}
                onChange={(e) => handleChange('companyRole', e.target.value)}
                className="h-9 w-full rounded-lg bg-white/80 border border-slate-200/60 px-3 text-xs text-slate-700 outline-none focus:border-[#6366f1] focus:ring-1.5 focus:ring-[#6366f1]/20 transition-all"
                placeholder="请输入企业角色"
              />
            ) : (
              <div className="h-9 rounded-lg bg-slate-50/60 border border-slate-200/60 px-3 flex items-center text-slate-700 text-xs">
                {profile.companyRole}
              </div>
            )}
          </div>

          {/* 个人简介 - 跨两列 */}
          <div className="space-y-1.5 col-span-2">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
              <FileText className="w-3 h-3" />
              个人简介
            </label>
            {isEditing ? (
              <textarea
                value={profile.bio}
                onChange={(e) => handleChange('bio', e.target.value)}
                rows={2}
                className="w-full rounded-lg bg-white/80 border border-slate-200/60 px-3 py-2 text-xs text-slate-700 outline-none focus:border-[#6366f1] focus:ring-1.5 focus:ring-[#6366f1]/20 transition-all resize-none"
                placeholder="请输入个人简介"
              />
            ) : (
              <div className="rounded-lg bg-slate-50/60 border border-slate-200/60 px-3 py-2 text-slate-700 text-xs leading-relaxed">
                {profile.bio}
              </div>
            )}
          </div>
        </div>

        {/* 操作按钮 */}
        {!readonly && saveError && <p className="mt-4 text-center text-xs font-semibold text-red-500">{saveError}</p>}
        <div className="flex justify-center gap-2 mt-5">
          {readonly ? (
            <button
              onClick={() => onOpenChange(false)}
              className="h-9 px-4 rounded-lg border border-slate-200 bg-white/70 text-slate-600 text-xs font-semibold hover:bg-white/90 transition-all"
            >
              关闭
            </button>
          ) : !isEditing ? (
            <>
              <button
                onClick={handleEditClick}
                className="h-9 px-4 rounded-lg bg-[linear-gradient(135deg,#6366f1_0%,#8b5cf6_100%)] text-white text-xs font-semibold shadow-[0_4px_16px_rgba(99,102,241,0.24)] hover:shadow-[0_6px_20px_rgba(99,102,241,0.32)] transition-all"
              >
                修改资料
              </button>
              <button
                onClick={handleLogout}
                className="h-9 px-4 rounded-lg border border-red-200 bg-red-50/70 text-red-500 text-xs font-semibold hover:bg-red-100/90 hover:text-red-600 transition-all flex items-center gap-1.5"
              >
                <LogOut className="w-3 h-3" />
                退出登录
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleCancel}
                className="h-9 px-4 rounded-lg border border-slate-200 bg-white/70 text-slate-600 text-xs font-semibold hover:bg-white/90 transition-all"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="h-9 px-4 rounded-lg bg-[linear-gradient(135deg,#6366f1_0%,#8b5cf6_100%)] text-white text-xs font-semibold shadow-[0_4px_16px_rgba(99,102,241,0.24)] hover:shadow-[0_6px_20px_rgba(99,102,241,0.32)] transition-all flex items-center gap-1.5"
              >
                <Save className="w-3 h-3" />
                {isSaving ? '保存中...' : '保存'}
              </button>
            </>
          )}
          {!readonly && isEditing && (
            <button
              onClick={handleCancel}
              className="h-9 px-4 rounded-lg border border-slate-200 bg-white/70 text-slate-600 text-xs font-semibold hover:bg-white/90 transition-all flex items-center gap-1.5"
            >
              <RotateCcw className="w-3 h-3" />
              重置
            </button>
          )}
        </div>
          </>
        )}
      </DialogContent>

      <GlassConfirmDialog
        open={showAlertMsg !== ''}
        onOpenChange={() => setShowAlertMsg('')}
        title="提示"
        description={showAlertMsg}
        variant="alert"
        confirmText="知道了"
        onConfirm={() => setShowAlertMsg('')}
      />
    </Dialog>
  );
}
