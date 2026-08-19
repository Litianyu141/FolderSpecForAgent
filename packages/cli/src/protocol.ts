import type { ApiMethod } from '@folderspec/core'

export interface RpcRequest {
  id: number
  method: ApiMethod
  params: unknown
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

export interface RpcEvent {
  event: string
  payload: unknown
}
