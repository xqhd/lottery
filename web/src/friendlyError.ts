import type { ApiException } from './api'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function numberFromDetails(details: unknown, key: string): number | null {
  const rec = asRecord(details)
  if (!rec) return null
  const value = rec[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function friendlyErrorMessage(err: unknown): string {
  const e = err as ApiException | undefined
  const code = e?.code
  const message = (e && typeof e.message === 'string' ? e.message : '') || String(err)

  if (!code) return message

  if (code === 'INSUFFICIENT_CANDIDATES') {
    const requested = numberFromDetails(e.details, 'requested')
    const eligible = numberFromDetails(e.details, 'eligible')
    if (requested !== null && eligible !== null) {
      return `可抽人数不足：需要 ${requested} 人，但当前只有 ${eligible} 人。请先导入名单，或减少本次抽取人数。`
    }
    return '可抽人数不足：请先导入名单，或减少本次抽取人数。'
  }

  if (code === 'INSUFFICIENT_WEIGHTED_CANDIDATES') return '可抽人数不足：部分人员权重≤0 被跳过，请检查权重或减少抽取人数。'
  if (code === 'PRIZE_EXHAUSTED') return '该奖项名额已抽完：请选择下一个奖项。'
  if (code === 'PRIZE_INSUFFICIENT_REMAINING') {
    const requested = numberFromDetails(e.details, 'requested')
    const remaining = numberFromDetails(e.details, 'remaining')
    if (requested !== null && remaining !== null) {
      return `该奖项剩余名额不足：本次想抽 ${requested} 人，但只剩 ${remaining} 人。`
    }
    return '该奖项剩余名额不足：请减少本次抽取人数。'
  }
  if (code === 'EVENT_NOT_FOUND') return '活动不存在：可能被删除，或 eventId 不正确。'
  if (code === 'PRIZE_NOT_FOUND') return '奖项不存在：请刷新奖项列表后重试。'
  if (code === 'PRIZE_EVENT_MISMATCH') return '奖项不属于当前活动：请刷新后重试。'
  if (code === 'EMPTY_IMPORT') return '导入失败：文件里没有解析出任何人。'
  if (code === 'MISSING_FILE') return '请先选择要上传的文件。'
  if (code === 'PARTICIPANT_DUPLICATE') return '名单重复：姓名/工号/部门组合与现有记录冲突，请检查后重试。'
  if (code === 'PARTICIPANT_HAS_RESULTS') return '无法删除：该人员已有中奖/抽奖记录（为保证审计完整性）。'
  if (code === 'EVENT_HAS_DRAWS') return '无法清空：本活动已有抽奖记录（为保证审计完整性）。建议新建活动或先清空中奖结果。'
  if (code === 'INVALID_PARTICIPANT_NAME') return '姓名不能为空：请填写姓名后再保存。'
  if (code === 'INVALID_PARTICIPANT_WEIGHT') return '权重必须大于 0：请填写正确的权重值。'
  if (code === 'INVALID_BGM_SLOT') return '上传失败：无效的音乐槽位（只支持 ready/rolling/win）。'
  if (code === 'INVALID_FILE_TYPE') {
    const m = (message || '').toLowerCase()
    if (m.includes('audio')) return '上传失败：只允许音频文件（mp3/wav 等）。'
    if (m.includes('image') || m.includes('mp4')) return '上传失败：只允许图片或 MP4 视频。'
    return '上传失败：文件类型不受支持。'
  }

  return `${code}：${message}`
}
