import { isAxiosError } from 'axios'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const SESSION_ERROR_MESSAGES: Record<string, string> = {
  version_conflict: '该会话已被其他操作更新，请刷新后重试。',
  idempotency_conflict: '该操作已提交过，请勿重复提交。',
  stale_session_owner: '当前会话已被其他窗口接管，已切换为只读。',
  stale_active_session_response: '会话状态已更新，请稍候刷新。',
  active_session_exists: '当前空间已有进行中的会话，请先结束或等待其完成。',
  blocked_conflict: '存在未解决的激活冲突，当前会话只读。',
  activation_conflict: '存在未解决的激活冲突，请选择会话后继续。',
  not_found: '会话不存在或已被删除。',
  unauthorized: '登录状态已失效，请重新登录后重试。',
  forbidden: '当前操作没有权限。',
  network: '网络连接失败，请检查服务连接后重试。',
}

const GENERIC_TIMER_ERROR = '操作失败，请检查服务连接后重试。'

/**
 * Map a Focus Session / active-session failure to a stable error code and a
 * closed, user-safe message. Never surfaces raw Axios text, exception
 * messages, response objects, tokens, URLs, or stack traces. Handles
 * canonical ({code, ...}), legacy ({detail: string | {code, ...}}),
 * error-code header, HTTP 401/403, transport-level network failures, and the
 * task-space guard errors thrown as `active_session_exists:<space>:<space>`.
 */
export function resolveTimerError(error: unknown): { code: string; message: string } {
  if (isAxiosError(error) && error.response === undefined) {
    return { code: 'network', message: SESSION_ERROR_MESSAGES.network }
  }

  const response = isRecord(error) ? error.response : undefined
  const data = isRecord(response) ? response.data : undefined
  const headers = isRecord(response) ? response.headers : undefined

  let code: unknown = isRecord(data) ? data.code : undefined
  if (code === undefined && isRecord(data) && isRecord(data.detail)) code = data.detail.code
  if (code === undefined && isRecord(headers)) code = headers['x-pomodoroxii-error-code']
  if (typeof code !== 'string' || code.length === 0) {
    if (isRecord(response) && typeof response.status === 'number') {
      if (response.status === 401) code = 'unauthorized'
      else if (response.status === 403) code = 'forbidden'
    }
  }

  if (typeof code !== 'string' || code.length === 0) {
    const raw = isRecord(error) ? error.message : undefined
    if (typeof raw === 'string') {
      if (raw.startsWith('active_session_exists:')) code = 'active_session_exists'
      else if (raw.startsWith('stale_session_owner')) code = 'stale_session_owner'
      else if (raw.startsWith('stale_active_session_response')) code = 'stale_active_session_response'
    }
  }

  const stableCode = typeof code === 'string' && code.length > 0 ? code : 'unknown'
  return {
    code: stableCode,
    message: SESSION_ERROR_MESSAGES[stableCode] ?? GENERIC_TIMER_ERROR,
  }
}
