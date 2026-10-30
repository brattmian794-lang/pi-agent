import { describe, expect, test } from 'bun:test'
import { friendlyErrorMessage, mapAgentErrorToTypedError } from './agent-error-utils'

describe('pi-agent 渠道错误提示', () => {
  test('Given 不支持的供应商 When 映射错误 Then 提供重新选择模型入口', () => {
    const result = mapAgentErrorToTypedError('unknown_error', '不支持的供应商: retired-provider', '')

    expect(result.actions[0]).toEqual({ key: 'm', label: '重新选择模型', action: 'select_model' })
  })

  test('Given 无关错误 When 映射错误 Then 仍提供设置入口', () => {
    const result = mapAgentErrorToTypedError('unknown_error', 'network connection failed', '')

    expect(result.actions[0]).toEqual({ key: 's', label: '设置', action: 'settings' })
  })

  test('Given 需要登录的错误 When 生成人类可读提示 Then 使用当前应用名称', () => {
    expect(friendlyErrorMessage('Please run /login')).toBe('请检查是否选择了正确的 pi-agent 供应渠道和模型')
  })

  test('Given model_not_found When 定时任务执行失败 Then 明确提示模型不可用且不可重试', () => {
    const result = mapAgentErrorToTypedError(
      'model_not_found',
      'gpt-6.1-terra 在当前渠道不可用',
      'model_not_found',
    )

    expect(result.code).toBe('invalid_model')
    expect(result.title).toBe('模型不可用')
    expect(result.canRetry).toBe(false)
  })
})
