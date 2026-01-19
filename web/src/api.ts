export type ApiError = {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type ApiException = Error & {
  code?: string
  details?: unknown
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = data as ApiError
    const code = err.error?.code ?? 'HTTP_ERROR'
    const message = err.error?.message ?? res.statusText
    const error: ApiException = new Error(message)
    error.code = code
    error.details = err.error?.details
    throw error
  }
  return data as T
}
