"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { UserProfile } from '@/components/profile-dialog';

interface ApiUserProfile {
  id: string;
  accountId: string;
  accountName: string;
  avatarUrl: string | null;
  email: string;
  phone: string;
  company: string;
  companyRole: string;
  bio: string;
  userType?: string;
}

interface CachedProfile {
  user: Omit<UserProfile, 'avatar'> & { avatar?: string };
  expiresAt: number;
}

interface AuthProfileContextValue {
  profile: UserProfile | null;
  isProfileLoading: boolean;
  refreshProfile: () => Promise<UserProfile | null>;
  updateProfileCache: (profile: UserProfile) => void;
  clearProfileCache: () => void;
}

const profileCacheKey = 'voc:user-profile:v1';
const profileCacheTtlMs = 7 * 24 * 60 * 60 * 1000;
const AuthProfileContext = createContext<AuthProfileContextValue | null>(null);

export function apiProfileToUserProfile(profile: ApiUserProfile): UserProfile {
  return {
    id: profile.id,
    avatar: profile.avatarUrl || '',
    accountName: profile.accountName,
    account: profile.accountId,
    email: profile.email,
    phone: profile.phone,
    company: profile.company,
    companyRole: profile.companyRole,
    bio: profile.bio,
  };
}

/** Open or create the avatar IndexedDB */
function openAvatarDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('voc_avatar_cache', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('avatars')) {
        db.createObjectStore('avatars');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Save avatar base64 to IndexedDB */
async function saveAvatarToIDB(userId: string, avatar: string): Promise<void> {
  try {
    const db = await openAvatarDB();
    const tx = db.transaction('avatars', 'readwrite');
    const store = tx.objectStore('avatars');
    store.put({ data: avatar, expiresAt: Date.now() + profileCacheTtlMs }, userId);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // IndexedDB unavailable
  }
}

/** Read avatar base64 from IndexedDB */
async function readAvatarFromIDB(userId: string): Promise<string | null> {
  try {
    const db = await openAvatarDB();
    const tx = db.transaction('avatars', 'readonly');
    const store = tx.objectStore('avatars');
    const request = store.get(userId);
    const result = await new Promise<{ data: string; expiresAt: number } | undefined>(
      (resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    if (!result || !result.expiresAt || result.expiresAt <= Date.now()) {
      return null;
    }
    return result.data || null;
  } catch {
    return null;
  }
}

/** Delete avatar from IndexedDB */
async function deleteAvatarFromIDB(userId: string): Promise<void> {
  try {
    const db = await openAvatarDB();
    const tx = db.transaction('avatars', 'readwrite');
    tx.objectStore('avatars').delete(userId);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

/** Save profile (without avatar) to localStorage, avatar to IndexedDB */
export function saveUserProfileCache(profile: UserProfile) {
  if (typeof window === 'undefined') return;

  const { avatar, ...profileWithoutAvatar } = profile;
  const cachedProfile: CachedProfile = {
    user: profileWithoutAvatar,
    expiresAt: Date.now() + profileCacheTtlMs,
  };

  try {
    localStorage.setItem(profileCacheKey, JSON.stringify(cachedProfile));
  } catch {
    clearUserProfileCache();
    return;
  }

  if (avatar) {
    void saveAvatarToIDB(profile.id, avatar);
  } else {
    void deleteAvatarFromIDB(profile.id);
  }

  window.dispatchEvent(new CustomEvent('voc:profile-updated', { detail: profile }));
}

export function clearUserProfileCache() {
  if (typeof window === 'undefined') return;

  localStorage.removeItem(profileCacheKey);
  window.dispatchEvent(new CustomEvent('voc:profile-cleared'));
}

/** Read profile from localStorage */
function readUserProfileCache(): UserProfile | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = localStorage.getItem(profileCacheKey);
    if (!raw) return null;

    const cachedProfile = JSON.parse(raw) as Partial<CachedProfile>;
    if (!cachedProfile.user || !cachedProfile.expiresAt || cachedProfile.expiresAt <= Date.now()) {
      clearUserProfileCache();
      return null;
    }

    return {
      ...cachedProfile.user,
      avatar: cachedProfile.user.avatar || '',
    };
  } catch {
    clearUserProfileCache();
    return null;
  }
}

/** Load avatar from IndexedDB and merge into profile */
async function loadCachedAvatar(profile: UserProfile): Promise<UserProfile> {
  const cachedAvatar = await readAvatarFromIDB(profile.id);
  if (cachedAvatar) {
    return { ...profile, avatar: cachedAvatar };
  }
  return profile;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isProfileLoading, setIsProfileLoading] = useState(true);
  const profileIdRef = useRef<string | null>(null);

  const updateProfileCache = useCallback((nextProfile: UserProfile) => {
    setProfile(nextProfile);
    profileIdRef.current = nextProfile.id;
    saveUserProfileCache(nextProfile);
  }, []);

  const clearProfileCache = useCallback(() => {
    const currentId = profileIdRef.current;
    if (currentId) {
      void deleteAvatarFromIDB(currentId);
    }
    setProfile(null);
    profileIdRef.current = null;
    clearUserProfileCache();
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const response = await fetch('/api/users/me');
      if (response.status === 401 || response.status === 404) {
        clearProfileCache();
        return null;
      }

      const json = await response.json();
      if (!json.success) return null;

      const nextProfile = apiProfileToUserProfile(json.data);
      updateProfileCache(nextProfile);
      return nextProfile;
    } catch {
      return null;
    } finally {
      setIsProfileLoading(false);
    }
  }, [clearProfileCache, updateProfileCache]);

  useEffect(() => {
    const cachedProfile = readUserProfileCache();
    if (cachedProfile) {
      setProfile(cachedProfile);
      profileIdRef.current = cachedProfile.id;
      setIsProfileLoading(false);
      void loadCachedAvatar(cachedProfile).then((withAvatar) => {
        setProfile(withAvatar);
      });
    }

    void refreshProfile();

    const handleProfileUpdated = (e: Event) => {
      const detail = (e as CustomEvent<UserProfile>).detail;
      setProfile(detail);
      profileIdRef.current = detail.id;
      setIsProfileLoading(false);
    };

    const handleProfileCleared = () => {
      setProfile(null);
      profileIdRef.current = null;
    };

    window.addEventListener('voc:profile-updated', handleProfileUpdated);
    window.addEventListener('voc:profile-cleared', handleProfileCleared);

    return () => {
      window.removeEventListener('voc:profile-updated', handleProfileUpdated);
      window.removeEventListener('voc:profile-cleared', handleProfileCleared);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const contextValue = useMemo<AuthProfileContextValue>(
    () => ({
      profile,
      isProfileLoading,
      refreshProfile,
      updateProfileCache,
      clearProfileCache,
    }),
    [clearProfileCache, isProfileLoading, profile, refreshProfile, updateProfileCache],
  );

  return (
    <AuthProfileContext.Provider value={contextValue}>
      {children}
    </AuthProfileContext.Provider>
  );
}

export function useAuthProfile() {
  const context = useContext(AuthProfileContext);
  if (!context) {
    throw new Error('useAuthProfile must be used inside AuthProvider');
  }
  return context;
}
