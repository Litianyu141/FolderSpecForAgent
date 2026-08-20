import type { WireError } from '@folderspec/core/api'

/**
 * 宿主回过来的失败（`WireError`，定义在 core/src/api.ts）在 UI 侧还原成的 Error。
 *
 * **为什么仍然是 Error 而不是一个纯数据对象**：整条调用链——两个 bridge 的 reject、
 * App 里十几处 `catch (e)`、translateError 的兜底——今天都按 Error 处理。换成非 Error
 * 会让所有既有路径退化成 `String(e)`（界面上是 "[object Object]"）。带上 code 是
 * **加法**，不是替换。
 *
 * **为什么翻译那一侧不用 `instanceof BridgeError` 判断**：这个类只在两个 bridge 里被
 * 构造，但 translateError 要能认出"任何带着 code 的错误"。core 导出的 `isSpecError()`
 * 在这里同样不能用——它是 `instanceof SpecError`，而错误跨过 bridge 是走 JSON 的，
 * 原型早就没了；那个函数只对与 core 同进程的宿主成立。UI 侧只能按**形状**判断。
 */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

/**
 * 宿主说"失败了"却没说为什么时的兜底。刻意留中文原文、不进 i18n 字典：
 * 它发生在 bridge 层，那里拿不到当前语言（bridge 在 React 之外被创建，见 main.tsx），
 * 而且这一格只可能由宿主自己的缺陷触发——与它同类的还有 ws-bridge.ts 的
 * CONNECTION_LOST_MESSAGE。两条都记在本轮报告的"未覆盖"一节里。
 */
const UNKNOWN_ERROR_MESSAGE = '未知错误：宿主回了一次失败，但没有给出原因'

/**
 * 把宿主回过来的 `error` 字段还原成一个 Error。**读取端容错**：这里是进程边界，
 * 收到的是 `JSON.parse` 的产物，类型系统一个字都保证不了。
 *
 * 三种形状各有各的来路，都得能显示出一句人话：
 *
 * - `WireError` 对象——今天两个宿主回的都是这个（cli/src/server.ts、vscode/src/editor.ts）；
 * - 裸字符串——接线之前的旧格式。宿主与这份 UI 其实是一起打包出去的（CLI 把 ui 产物
 *   塞进自己的 dist，扩展塞进 media/ui），照理不会新旧混搭；留着这一格是因为**代价是
 *   两行，而代价的另一头是横幅上出现 "[object Object]"**——那是用户彻底没有出路的一种
 *   失败，比多两行难看得多；
 * - 什么都没有 / 形状不认识——宿主回了 ok:false 却没给出理由。这时候必须自己造一句话，
 *   否则横幅上是一片空白，用户连"操作失败了"都不知道。
 */
export function errorFromWire(raw: unknown): Error {
  if (typeof raw === 'string') return new BridgeError(raw)
  if (typeof raw === 'object' && raw !== null) {
    const w = raw as Partial<WireError>
    if (typeof w.message === 'string') {
      return new BridgeError(
        w.message,
        typeof w.code === 'string' ? w.code : undefined,
        typeof w.params === 'object' && w.params !== null ? w.params : undefined,
      )
    }
  }
  return new BridgeError(UNKNOWN_ERROR_MESSAGE)
}
