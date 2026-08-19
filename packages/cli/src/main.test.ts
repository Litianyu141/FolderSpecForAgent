import { describe, it, expect } from 'vitest'
import * as nodePath from 'node:path'
import { parseArgs } from './main.js'

const CWD = '/home/user/project'

describe('parseArgs', () => {
  it('裸目录参数会相对 cwd 解析成 root', () => {
    const args = parseArgs(['sub/dir'], CWD)
    expect(args).toEqual({ root: nodePath.resolve(CWD, 'sub/dir'), port: undefined, noOpen: false, help: false })
  })

  it('没有位置参数时 root 默认为 cwd 本身', () => {
    const args = parseArgs([], CWD)
    expect(args.root).toBe(nodePath.resolve(CWD))
  })

  it('--port 8080 被解析为数字端口', () => {
    const args = parseArgs(['--port', '8080'], CWD)
    expect(args.port).toBe(8080)
  })

  it('--port 缺少值时抛出，而不是静默回退到随机端口', () => {
    expect(() => parseArgs(['--port'], CWD)).toThrow(/--port/)
  })

  it('--port abc 这种非数字值时抛出，而不是静默回退到随机端口', () => {
    expect(() => parseArgs(['--port', 'abc'], CWD)).toThrow(/--port/)
  })

  it('--no-open 被解析为 noOpen: true', () => {
    const args = parseArgs(['--no-open'], CWD)
    expect(args.noOpen).toBe(true)
  })

  it('--help 被解析为 help: true，且不要求给出合法的其余参数', () => {
    const args = parseArgs(['--help'], CWD)
    expect(args.help).toBe(true)
  })
})
