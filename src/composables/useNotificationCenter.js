import { computed, reactive } from "vue"
import {fetchEventSource} from '@microsoft/fetch-event-source'
import { API_BASE_URL, buildApiUrl } from "../api/http"
import { 
    authState,
    clearSession, 
    getAccessToken,
    setSession,
    shouldRefreshAccessToken,
 } from "../lib/authSession"  
import { refreshAccessToken } from "../api/auth"
import { 
    fetchNotifications, 
    fetchUnreadNotificationCount, 
    readAllNotifications, 
    readNotification } from "../api/notifications"

const TYPE_LABEL = Object.freeze({

    DELIVERY: '배송 알림',
    WIN: '낙찰 알림',
    NEW_BID: '새 입찰',
    TOP_BID: '최고 입찰',
    AUCTION_UNSOLD: '경매 종료',
    ADMIN_NOTICE: '공지사항 등록',
    INSPECTION: '검수 알림',
    AUCTION_INQUIRY: '문의 알림',
    DIRECT_INQUIRY: '1:1 문의 알림'
    
})

const state = reactive({
    initialized: false,
    connecting: false,
    connected: false,
    notifications: [],
    unreadCount: 0,
    toasts: [],
})

let streamController = null
let initializePromise = null
const toastTimers = new Map()

let sseRefreshPromise = null

function formatRelativeTime(value) {
    if(!value) return ''
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''

    const diffSec = Math.max(1, Math.floor(Date.now() - date.getTime()) / 1000)

    if (diffSec < 60) return '방금전'
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}분 전`
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}시간 전`
    if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}일 전`
    return `${Math.floor(diffSec/ 604800)}주 전`
}

function resolveNotificationUrl(rawUrl = '', type = '') {
    const value = String(rawUrl || '').trim()
    if (!value) return ''

    // 백엔드 구 경로(/admins/*)와 프론트 라우터(/admin/*) 차이를 보정
    let url = value.replace(/^\/admins\//, '/admin/')

    // 문의 탭은 상세 라우트가 없어 경매 상세로 이동
    url = url.replace(/^\/auctions\/(\d+)\/inquiries$/, '/auctions/$1')

    // 현재 프론트 라우터에 없는 경로를 실제 화면 경로로 매핑
    if (/^\/winner-deals\/\d+$/.test(url)) return '/mypage/purchases'
    if (/^\/inspections\/\d+$/.test(url)) return '/inspection'
    if (/^\/notices\/\d+$/.test(url)) return '/'

    // 관리자 문의 알림은 실제 관리자 문의 목록으로 이동
    if (type === 'DIRECT_INQUIRY' && url === '/admin/direct-inquiries') return '/admin/inquiries'

    return url
}

function normalizeNotification(raw = {}) {
    const type = String(raw.type || '').trim().toUpperCase()
    const content = String(raw.content ?? raw.body ?? raw.message ?? '')
    const createdAt = raw.createdAt ?? raw.created_at ?? null
    const readAt = raw.readAt ?? raw.read_at ?? null
    const url = raw.url ?? raw.path ?? raw.link ?? ''
    const unread = !readAt
    

    return {
        id: Number(raw.id || Date.now()),
        type,
        title: TYPE_LABEL[type] || '알림',
        body: content,
        url: resolveNotificationUrl(url, type),
        readAt,
        createdAt,
        unread,
        time: formatRelativeTime(createdAt),
        image: '',
    }
}

function clearToastTimer(id) {
    const timer = toastTimers.get(id)
    if (timer) {
        clearTimeout(timer)
        toastTimers.delete(id)
    }
}

function removeToast(id) {
    clearToastTimer(id)
    state.toasts = state.toasts.filter((toast) => toast.id !== id)
}

function ellipsis(text = '', max =50) {
    const value = String(text || '')
    return value.length > max ? `${value.slice(0, max)}...` : value
}

function enqueueToast(notification) {
    const toast = {
        id: Date.now() + Math.random(),
        title: notification.title,
        body: ellipsis(notification.body, 50),
        url: notification.url,
    }
    

    state.toasts = [toast, ...state.toasts].slice(0,6)
    
    const timer = setTimeout(() => {
        removeToast(toast.id)
    }, 4500)

    toastTimers.set(toast.id, timer)
}

function mergeIncoming(raw) {
    const incoming = normalizeNotification(raw)
    const index = state.notifications.findIndex((item) => item.id === incoming.id)
    const prev = index >= 0 ? state.notifications[index] : null

    if (index >= 0) {
        state.notifications[index] = { ...prev, ...incoming}
    } else {
        state.notifications = [incoming, ...state.notifications].slice(0,100)
    }

    if (incoming.unread && (!prev || !prev.unread)) {
        state.unreadCount += 1
        enqueueToast(incoming)
    }
}

async function ensureSseAccessToken(forceRefresh = false) {
    if (!authState.isAuthenticated) {
        return null
    }

    const token = getAccessToken()
    if (!forceRefresh && token && !shouldRefreshAccessToken()) {
        return token
    }

    if (!sseRefreshPromise) {
        sseRefreshPromise = (async () => {
            const loginResponse = await refreshAccessToken()
            setSession(loginResponse)
            return getAccessToken()

        }) ()
        .catch(() => {
            clearSession()
            return null
        })
        .finally(() => {
            sseRefreshPromise = null
        })
    }

    return sseRefreshPromise
}



function closeSseStream() {
    if (streamController) {
        streamController.abort()
        streamController = null
    }
    state.connected = false
    state.connecting = false
}

async function openSseStream() {
    closeSseStream()

    if (!API_BASE_URL || !authState.isAuthenticated) return

    state.connecting = true;
    
    const accessToken = await ensureSseAccessToken()
    if (!accessToken) {
        
        state.connecting = false
        return
    }
    
    streamController = new AbortController()

    void fetchEventSource(buildApiUrl('/api/v1/notifications/subscribe'), {
        method: 'GET',
        openWhenHidden: true,
        signal: streamController.signal,
        headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${accessToken}`,
        },
        onopen(response) {
            const contentType = String(response.headers.get('content-type') || '')

            if (response.ok && contentType.includes('text/event-stream')) {
                state.connected = true
                state.connecting = false
                return
            }

            if (response.status === 401 || response.status === 403) {
                throw new Error(`SSE_UNAUTHORIZED`)
            }

            throw new Error(`SSE_CONNECT_FAILED_${response.status}`)
        },

        onmessage(event) {
            if (!event?.data || event.event === 'connect') return

            try{
                const parsed = JSON.parse(event.data)
                mergeIncoming(parsed)
            } catch {

            }
        },

        onclose() {
            state.connected = false
            throw new ErrorEvent('SSE_CLOSED')
        },

        onerror(error) {
            state.connected = false
            state.connecting = false


            if (String(error?.message || '').includes('SSE_UNAUTHORIZED')) {
                throw error
            }

            return 3000
        },
    }).catch(async(error) => {
        state.connected = false
        state.connecting = false

        const message = String(error?.message || '')

        if (message.includes('AbortError')){
            return
        }

        if (message.includes('SSE_UNAUTHORIZED')) {
            const refreshedToken = await ensureSseAccessToken(true)
            if (refreshedToken && authState.isAuthenticated) {
                void openSseStream()
            }
        }
    })
}

async function refreshUnreadCount() {
    if (!authState.isAuthenticated) {
        state.unreadCount = 0
        return
    }

    try {
        const result = await fetchUnreadNotificationCount()
        state.unreadCount = Number(result?.unreadCount || 0)
    } catch {

    }
}

async function loadNotifications(params = {}) {
    if (!authState.isAuthenticated) {
        state.notifications = []
        return
    }

    try {
        const page = await fetchNotifications({
            page: params.page ?? 1,
            size: params.size ?? 30,
            order: params.order ?? 'DESC',
        })

        const content = Array.isArray(page?.content) ? page.content : []
        state.notifications = content
        .map(normalizeNotification)
        .sort((a,b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    } catch(error) {
        console.error('[notifications] load failed:', {
        message: error?.message,
        name: error?.name,
        stack: error?.stack,

    })
    }
}

async function markAsRead(notificationId) {
    const target = state.notifications.find((item) => item.id === notificationId)
    if (!target || !target.unread) return

    target.unread = false
    target.readAt = new Date().toISOString()
    state.unreadCount = Math.max(0, state.unreadCount -1)

    try {
        await readNotification(notificationId)
    } catch {
        target.unread = true
        target.readAt = null
        state.unreadCount += 1
    }
}

async function markAllAsRead() {
    if (state.unreadCount <= 0) return

    const backup = state.notifications.map((item) => ({...item}))

    state.notifications = state.notifications.map((item) => ({
        ...item,
        unread: false,
        readAt: item.readAt || new Date().toISOString(),
    }))
    state.unreadCount = 0

    try {
        await readAllNotifications()
    } catch {
        state.notifications = backup
        state.unreadCount = backup.filter((item) => item.unread).length
    }
}

async function initializeNotificationCenter() {
    if (!authState.isAuthenticated) return

    if (initializePromise) return initializePromise
    
    initializePromise = (async () => {
        await Promise.allSettled([refreshUnreadCount(), loadNotifications()])
        void openSseStream()
        state.initialized = true
    })().finally(() => {
        initializePromise = null
    })

    return initializePromise
}

function shutdownNotificationCenter(options = {}) {
    const clear = Boolean(options.clear)

    closeSseStream()
    state.initialized = false
    
    if (clear) {
        state.notifications = []
        state.unreadCount = 0
        state.toasts.forEach((toast) => clearToastTimer(toast.id))
        state.toasts = []
    }
}

export function useNotificationCenter() {
    return {
        state,
        notifications: computed(() => state.notifications),
        unreadCount: computed(() => state.unreadCount),
        toasts: computed(() => state.toasts),
        connected: computed(() => state.connected),
        connecting: computed(() => state.connecting),
        initializeNotificationCenter,
        shutdownNotificationCenter,
        refreshUnreadCount,
        loadNotifications,
        markAsRead,
        markAllAsRead,
        removeToast,
    }
}
