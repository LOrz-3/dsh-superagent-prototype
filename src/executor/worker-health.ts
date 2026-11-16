/** Bounded worker failure details and recovery scoped to the operation that was reverified. */
import type { HealthEntry } from '../infra/health.ts'

export function workerError(error: unknown): string {
  const seen = new Set<unknown>()
  let remaining = 12
  const visit = (value: unknown, depth: number): string => {
    if (remaining-- <= 0 || depth > 4) return '[more causes omitted]'
    if (seen.has(value)) return '[repeated cause]'
    seen.add(value)
    if (!(value instanceof Error)) return String(value).slice(0, 300)
    const nested: unknown[] = value instanceof AggregateError && Array.isArray(value.errors) ? value.errors.slice(0, 6) : []
    if (value.cause !== undefined) nested.push(value.cause)
    return `${value.name}: ${String(value.message).slice(0, 500)}${nested.length ? ` [${nested.map(item => visit(item, depth + 1)).join('; ')}]` : ''}`
  }
  return visit(error, 0)
    .replace(/\bBearer\s+[^\s,;)\]]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[-_]?key|access[-_]?token|token|password|secret)\s*[=:]\s*[^\s,;)\]]+/gi, '$1=[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .slice(0, 2000)
}

/** Keeps worker cleanup failures visible until a corresponding successful retry verifies recovery. */
export class WorkerHealth {
  private readonly eventFailure = Symbol('worker events')
  private readonly failures = new Map<string | symbol, string>()
  private readonly attempts = new Map<string | symbol, symbol>()
  constructor(private readonly health: HealthEntry) {}

  /** Clear only the operation a caller synchronously reverified, invalidating older pending attempts. */
  recover(key: string): void {
    this.attempts.delete(key)
    if (this.failures.delete(key)) this.publish()
  }

  /** Only a successful retry of the same named operation clears its failure; unrelated event success clears nothing. */
  watch(work: Promise<void>, key?: string): Promise<void> {
    const scope = key ?? this.eventFailure
    const attempt = Symbol('attempt')
    if (key !== undefined) this.attempts.set(scope, attempt)
    return work.then(() => {
      if (key === undefined || this.attempts.get(scope) !== attempt) return
      this.attempts.delete(scope)
      const recovered = this.failures.delete(scope)
      if (recovered) this.publish()
    }, (error: unknown) => {
      if (key !== undefined && this.attempts.get(scope) !== attempt) return
      this.attempts.delete(scope)
      this.failures.set(scope, `${key !== undefined ? `${key}: ` : ''}${workerError(error)}`)
      this.publish()
    })
  }

  private publish(): void {
    const failures = [...this.failures.values()]
    this.health.set(failures.length
      ? { state: 'error', detail: failures.slice(0, 5).join('\n').slice(0, 4000), at: new Date().toISOString() }
      : { state: 'ready', detail: 'Previously failed worker operations were reverified', at: new Date().toISOString() })
  }
}
