/**
 * Dual JWT Axios clients: metaApi (master token) + spaceApi (space token).
 *
 * Design: F0 §2.4 (reissueMutex single-flight, CF retry)
 * S0-3: restored window.location redirect (routes now exist)
 * S0-2 modifications:
 *   B. Separate __retried (401 guard) from __cfRetryCount (CF counter)
 *   C. reissueMutex single-flight preserved
 * D8 reserved: has_password check omitted (backend always false)
 */

import axios, {
  type AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios'
import { tokenStorage } from '@/lib/token-storage'
import { API_V1_PREFIX } from '@/lib/platform'

// ---- Cloudflare retry constants (migrated from pomodoroxi api.ts) ----
const CF_ERROR_CODES = new Set([530, 521, 522, 523, 524])
const MAX_CF_RETRIES = 3
const RETRY_BASE_DELAY = 2000

// Modification B: separate __retried (401 guard) from __cfRetryCount (CF counter)
interface RetryConfig extends InternalAxiosRequestConfig {
  __retried?: boolean
  __cfRetryCount?: number
}

function isCloudflareError(status: number): boolean {
  return CF_ERROR_CODES.has(status)
}

// ---- metaApi (Master Token) ----
export const metaApi = axios.create({
  baseURL: API_V1_PREFIX,
  headers: { 'Content-Type': 'application/json' },
})

metaApi.interceptors.request.use((config) => {
  const token = tokenStorage.getMasterToken()
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

metaApi.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const status = error.response?.status
    // S0-3: redirect to /login (routes now exist)
    if (status === 401) {
      tokenStorage.clearAll()
      if (typeof window !== 'undefined') {
        window.location.href = '/login'
      }
      return Promise.reject(error)
    }
    return handleCloudflareRetry(metaApi, error)
  },
)

// ---- spaceApi (Space Token) ----
export const spaceApi = axios.create({
  baseURL: API_V1_PREFIX,
  headers: { 'Content-Type': 'application/json' },
})

spaceApi.interceptors.request.use((config) => {
  const token = tokenStorage.getSpaceToken()
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

spaceApi.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const status = error.response?.status
    const originalConfig = error.config as RetryConfig | undefined

    if (status === 401 && originalConfig && !originalConfig.__retried) {
      originalConfig.__retried = true
      const reissued = await tryReissueSpaceToken()
      if (reissued) {
        originalConfig.headers!.Authorization = `Bearer ${reissued}`
        return spaceApi(originalConfig)
      }
      // S0-3: redirect to /select-space (routes now exist)
      tokenStorage.clearSpace()
      if (typeof window !== 'undefined') {
        window.location.href = '/select-space'
      }
      return Promise.reject(error)
    }

    // S0-3: redirect to /select-space (routes now exist)
    if (status === 403) {
      tokenStorage.clearSpace()
      if (typeof window !== 'undefined') {
        window.location.href = '/select-space'
      }
      return Promise.reject(error)
    }

    return handleCloudflareRetry(spaceApi, error)
  },
)

// ---- reissueMutex single-flight (F0 §2.4) ----
let reissuePromise: Promise<string | null> | null = null

/** Re-issue space token using master token (single-flight). */
async function tryReissueSpaceToken(): Promise<string | null> {
  // Single-flight: reuse in-flight reissue Promise
  if (reissuePromise) return reissuePromise

  reissuePromise = (async () => {
    const masterToken = tokenStorage.getMasterToken()
    const spaceId = tokenStorage.getCurrentSpaceId()
    if (!masterToken || !spaceId) return null
    try {
      // Use global axios.post (not metaApi) to avoid metaApi 401 interceptor
      const res = await axios.post(
        `${API_V1_PREFIX}/spaces/${spaceId}/token`,
        {},
        { headers: { Authorization: `Bearer ${masterToken}` } },
      )
      const newToken = res.data.space_token as string
      tokenStorage.setSpaceToken(newToken)
      return newToken
    } catch {
      return null
    } finally {
      reissuePromise = null // Clear single-flight lock
    }
  })()

  return reissuePromise
}

// ---- Cloudflare 5xx retry (exponential backoff) ----
async function handleCloudflareRetry(
  instance: AxiosInstance,
  error: AxiosError,
): Promise<unknown> {
  const status = error.response?.status
  if (!status || !isCloudflareError(status)) return Promise.reject(error)
  const config = error.config as RetryConfig | undefined
  if (!config) return Promise.reject(error)
  const retryCount = config.__cfRetryCount ?? 0
  if (retryCount >= MAX_CF_RETRIES) return Promise.reject(error)
  config.__cfRetryCount = retryCount + 1
  const delay = RETRY_BASE_DELAY * Math.pow(2, retryCount)
  await new Promise((r) => setTimeout(r, delay))
  return instance(config)
}
