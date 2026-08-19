import { describe, it, expect } from 'vitest'
import { CORE_VERSION } from './index.js'

describe('@folderspec/core', () => {
  it('导出版本号', () => {
    expect(CORE_VERSION).toBe('0.1.0')
  })
})
