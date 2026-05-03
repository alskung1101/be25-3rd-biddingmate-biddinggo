import { clearSession, getAccessToken, setSession, shouldRefreshAccessToken } from '../lib/authSession'
import { useToast } from '../composables/useToast'

function deriveApiBaseUrl() {
  const explicitApiBaseUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()

  if (explicitApiBaseUrl) {
    return explicitApiBaseUrl.replace(/\/$/, '')
  }

  const proxyTarget = String(import.meta.env.VITE_DEV_PROXY_TARGET || '').trim()

  if (proxyTarget) {
    return proxyTarget.replace(/\/$/, '')
  }

  return ''
}

export const API_BASE_URL = deriveApiBaseUrl()

function normalizePath(path = '') {
  const value = String(path || '').trim()
  return value.startsWith('/') ? value : `/${value}`
}

export function buildApiUrl(path) {
  const rawPath = String(path || '').trim()

  if (/^https?:\/\//i.test(rawPath)) {
    return rawPath
  }

  const targetPath = normalizePath(rawPath)

  if (!API_BASE_URL) {
    return targetPath
  }

  try {
    const baseUrl = new URL(API_BASE_URL)
    const basePath = baseUrl.pathname.replace(/\/$/, '')

    if (basePath && targetPath.startsWith(`${basePath}/`)) {
      return `${baseUrl.origin}${targetPath}`
    }

    return `${API_BASE_URL}${targetPath}`
  } catch {
    if (targetPath.startsWith(`${API_BASE_URL}/`) || targetPath === API_BASE_URL) {
      return targetPath
    }

    return `${API_BASE_URL}${targetPath}`
  }
}

export function buildBackendUrl(path) {
  const targetPath = normalizePath(path)

  if (!API_BASE_URL) {
    return targetPath
  }

  try {
    return `${new URL(API_BASE_URL).origin}${targetPath}`
  } catch {
    return targetPath
  }
}

let refreshPromise = null
const { showToast } = useToast()

function redirectToLogin() {
  if (typeof window === 'undefined') {
    return
  }

  const currentPath = `${window.location.pathname}${window.location.search || ''}`
  const isAdminRoute = window.location.pathname.startsWith('/admin')
  const loginPath = isAdminRoute ? '/admin/login' : '/login'
  const redirectQuery = currentPath ? `?redirect=${encodeURIComponent(currentPath)}` : ''

  if (window.location.pathname === loginPath) {
    return
  }

  window.location.assign(`${loginPath}${redirectQuery}`)
}

function notifyRequestError(message, options = {}) {
  if (options?.suppressErrorToast) {
    return
  }

  showToast(message, { color: 'error' })
}

export function buildQueryString(params = {}) {
  const query = new URLSearchParams()

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value))
    }
  })

  const suffix = query.toString()

  return suffix ? `?${suffix}` : ''
}

async function readBody(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()

  if (contentType.includes('application/json')) {
    return response.json().catch(() => null)
  }

  return response.text().catch(() => null)
}

function withAuthorizationHeader(headers = {}, auth = false) {
  if (!auth) {
    return headers
  }

  const accessToken = getAccessToken()

  if (!accessToken) {
    return headers
  }

  const hasAuthorizationHeader = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')

  if (hasAuthorizationHeader) {
    return headers
  }

  return {
    ...headers,
    Authorization: `Bearer ${accessToken}`,
  }
}

async function attemptRefreshToken() {
  if (!API_BASE_URL) {
    return false
  }

  if (!refreshPromise) {
    refreshPromise = (async () => {
      let response

      try {
        response = await fetch(buildApiUrl('/api/v1/auth/refresh'), {
          method: 'POST',
          credentials: 'include',
        })
      } catch {
        clearSession()
        return false
      }

      const body = await readBody(response)

      if (!response.ok || typeof body !== 'object' || !body?.result?.accessToken) {
        clearSession()
        return false
      }

      setSession(body.result)
      return true
    })().finally(() => {
      refreshPromise = null
    })
  }

  return refreshPromise
}

function needsCookie(path) {

  return path === '/api/v1/auth/refresh'
    || path === '/api/v1/auth/logout'
    || path === '/api/v1/auth/check'
    || path === '/api/v1/admin/auth/login'
}

async function performRequest(path, options = {}, allowRefresh = true) {
  const { auth = false, ...fetchOptions } = options
  const target = buildApiUrl(path)
  let response

  if (auth && allowRefresh && path !== '/api/v1/auth/refresh' && shouldRefreshAccessToken()) {
    await attemptRefreshToken()
  }

  try {
    response = await fetch(target, {
      credentials: needsCookie(path) ? 'include' : 'omit',
      ...fetchOptions,
      headers: withAuthorizationHeader(fetchOptions.headers || {}, auth),
    })
  } catch {
    const error = new Error(`요청 실패: ${target} 에 연결하지 못했습니다.`)
    notifyRequestError(error.message, options)
    throw error
  }

  if (auth && response.status === 401 && allowRefresh && path !== '/api/v1/auth/refresh') {
    const refreshed = await attemptRefreshToken()

    if (refreshed) {
      return performRequest(path, options, false)
    }
  }

  const body = await readBody(response)
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()

  if (response.ok && contentType.includes('text/html')) {
    const error = new Error('API 대신 HTML이 반환되었습니다. VITE_API_BASE_URL 설정을 확인해주세요.')
    notifyRequestError(error.message, options)
    throw error
  }

  if (!response.ok) {
    if (auth && (response.status === 401 || response.status === 403)) {
      clearSession()
      redirectToLogin()
    }

    if (typeof body === 'object' && body?.message) {
      const error = new Error(body.message)
      if (!(auth && (response.status === 401 || response.status === 403))) {
        notifyRequestError(error.message, options)
      }
      throw error
    }

    const error = new Error('요청 처리 중 오류가 발생했습니다.')
    if (!(auth && (response.status === 401 || response.status === 403))) {
      notifyRequestError(error.message, options)
    }
    throw error
  }

  return body
}

export async function request(path, options = {}) {
  return performRequest(path, options)
}

export function unwrap(data) {
  return data?.result
}
