import { computed } from 'vue'
import { buildSocialLoginUrl, checkAuthStatus, logoutAuth, refreshAccessToken } from '../api/auth'
import {
  authState,
  clearSession,
  getAccessToken,
  markInitialized,
  setSession,
  setUserInfo,
} from '../lib/authSession'

let initializePromise = null

async function syncCurrentUser() {
  const userInfo = await checkAuthStatus()
  setUserInfo(userInfo)

  return userInfo
}

async function restoreSessionFromRefresh() {
  const loginResponse = await refreshAccessToken({ suppressErrorToast: true })
  setSession(loginResponse)
  await syncCurrentUser()

  return true
}

export function useAuth() {
  const displayName = computed(() => authState.nickname || authState.name || authState.username || '회원')

  async function initializeAuth() {
    if (authState.initialized) {
      return authState.isAuthenticated
    }

    if (initializePromise) {
      return initializePromise
    }

    initializePromise = (async () => {
      try {
        if (getAccessToken()) {
          try {
            await syncCurrentUser()
            return true
          } catch {
            await restoreSessionFromRefresh()
            return true
          }
        }

        await restoreSessionFromRefresh()
        return true
      } catch {
        clearSession()
        markInitialized()
        return false
      } finally {
        initializePromise = null
      }
    })()

    return initializePromise
  }

  async function completeLoginFromCallback() {
    try {
      const loginResponse = await refreshAccessToken()
      setSession(loginResponse)

      await syncCurrentUser()

      return authState
    } catch (error) {
      clearSession()
      throw error
    }
  }

  function startLogin(provider = 'kakao') {
    window.location.assign(buildSocialLoginUrl(provider))
  }

  async function logout() {
    try {
      await logoutAuth()
    } finally {
      clearSession()
      markInitialized()
    }
  }

  return {
    auth: authState,
    displayName,
    initializeAuth,
    completeLoginFromCallback,
    startLogin,
    logout,
  }
}
