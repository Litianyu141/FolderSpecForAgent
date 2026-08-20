import type { ApiMethod, WireError } from '@folderspec/core'

export interface RpcRequest {
  id: number
  method: ApiMethod
  params: unknown
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  /**
   * 失败回的是 `WireError`（core/src/api.ts），不是一句裸字符串：`message` 必填，
   * `code`/`params` 只在这是一条 core 定义过的、可翻译的错误时才有。UI 侧靠 code
   * 查中文表，查不到就显示 message——**英文只有一份，就在 core**。
   */
  | { id: number; ok: false; error: WireError }

export interface RpcEvent {
  event: string
  payload: unknown
}
