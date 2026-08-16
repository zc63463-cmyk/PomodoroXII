import {
  AxiosHeaders,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type RawAxiosHeaders,
} from 'axios'

import { API_V1_PREFIX } from '@/lib/platform'

import type {
  ApiSyncV2AckResponse,
  ApiSyncV2OperationQueryResponse,
  ApiSyncV2PullResponse,
  ApiSyncV2PushResponse,
  ApiSyncV2RecoveryResponse,
  ApiSyncV2StatusResponse,
} from './types'
import {
  parseSyncV2AckResponse,
  parseSyncV2OperationQueryResponse,
  parseSyncV2PullResponse,
  parseSyncV2PushResponse,
  parseSyncV2RecoveryResponse,
  parseSyncV2StatusResponse,
} from './response-schema'

export const SYNC_V2_ERROR_ACCEPT =
  'application/vnd.pomodoroxii.error+json;version=2' as const
export const SYNC_V2_PATHS = {
  queryOperations: '/sync/v2/operations/query',
  push: '/sync/v2/push',
  pull: '/sync/v2/pull',
  recover: '/sync/v2/recover',
  ack: '/sync/v2/ack',
  status: '/sync/v2/status',
} as const

export const SYNC_V2_PUSH_REQUEST_PATH =
  `${API_V1_PREFIX}${SYNC_V2_PATHS.push}` as const

function syncV2RequestConfig(config: AxiosRequestConfig = {}): AxiosRequestConfig {
  // AxiosRequestConfig permits optional header values, while AxiosHeaders.from
  // accepts the same runtime shape through its narrower RawAxiosHeaders type.
  const headers = AxiosHeaders.from(config.headers as RawAxiosHeaders | undefined)
  headers.set('Accept', SYNC_V2_ERROR_ACCEPT)
  return { ...config, headers }
}

function parsedResponse<T>(response: AxiosResponse, data: T): AxiosResponse<T> {
  return { ...response, data }
}

export async function syncV2QueryOperations(
  api: AxiosInstance,
  body: { client_id: string; operation_ids: readonly string[] },
  config: AxiosRequestConfig = {},
): Promise<AxiosResponse<ApiSyncV2OperationQueryResponse>> {
  const response = await api.post(
    SYNC_V2_PATHS.queryOperations,
    { client_id: body.client_id, operation_ids: [...body.operation_ids] },
    syncV2RequestConfig(config),
  )
  return parsedResponse(
    response,
    parseSyncV2OperationQueryResponse(response.data, body.operation_ids),
  )
}

export async function syncV2Push(
  api: AxiosInstance,
  body: { client_id: string; batch_id: string; events: readonly unknown[] },
  config: AxiosRequestConfig = {},
): Promise<AxiosResponse<ApiSyncV2PushResponse>> {
  const response = await api.post(
    SYNC_V2_PATHS.push, body, syncV2RequestConfig(config),
  )
  return parsedResponse(response, parseSyncV2PushResponse(response.data))
}

export async function syncV2PushCanonical(
  api: AxiosInstance,
  canonicalBody: string,
  config: AxiosRequestConfig = {},
): Promise<AxiosResponse<ApiSyncV2PushResponse>> {
  const response = await api.post(
    SYNC_V2_PATHS.push,
    canonicalBody,
    syncV2RequestConfig({
      ...config,
      headers: { ...config.headers, 'Content-Type': 'application/json' },
      transformRequest: [(data) => data],
    }),
  )
  return parsedResponse(response, parseSyncV2PushResponse(response.data))
}

export async function syncV2Pull(
  api: AxiosInstance,
  params: { client_id: string; cursor: string | null; limit?: number },
  config: AxiosRequestConfig = {},
): Promise<AxiosResponse<ApiSyncV2PullResponse>> {
  const response = await api.get(SYNC_V2_PATHS.pull, syncV2RequestConfig({
    ...config,
    params: { ...(config.params as object | undefined), ...params },
  }))
  return parsedResponse(response, parseSyncV2PullResponse(response.data))
}

export async function syncV2Recover(
  api: AxiosInstance,
  params: { client_id: string; page_token: string | null },
  config: AxiosRequestConfig = {},
): Promise<AxiosResponse<ApiSyncV2RecoveryResponse>> {
  const response = await api.get(SYNC_V2_PATHS.recover, syncV2RequestConfig({
    ...config,
    params: { ...(config.params as object | undefined), ...params },
  }))
  return parsedResponse(response, parseSyncV2RecoveryResponse(response.data))
}

export async function syncV2Ack(
  api: AxiosInstance,
  body: { client_id: string; cursor: string },
  config: AxiosRequestConfig = {},
): Promise<AxiosResponse<ApiSyncV2AckResponse>> {
  const response = await api.post(
    SYNC_V2_PATHS.ack, body, syncV2RequestConfig(config),
  )
  return parsedResponse(response, parseSyncV2AckResponse(response.data))
}

export async function syncV2Status(
  api: AxiosInstance,
  params: { client_id?: string } = {},
  config: AxiosRequestConfig = {},
): Promise<AxiosResponse<ApiSyncV2StatusResponse>> {
  const response = await api.get(SYNC_V2_PATHS.status, syncV2RequestConfig({
    ...config,
    params: { ...(config.params as object | undefined), ...params },
  }))
  return parsedResponse(response, parseSyncV2StatusResponse(response.data))
}
