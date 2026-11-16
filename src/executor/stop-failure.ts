/** Separate runtime-confirmed result failures from unresolved background cleanup. */
interface StopFailures {
  readonly cleanup: readonly unknown[]
  readonly results: readonly unknown[]
}

/** An executor-owned aggregate retains the classification of each independent stop boundary. */
class BackgroundStopError extends AggregateError {
  readonly failures: StopFailures
  constructor(errors: readonly unknown[], message: string) {
    super(errors, message)
    const parts = errors.map(stopFailureParts)
    this.failures = { cleanup: parts.flatMap(part => part.cleanup), results: parts.flatMap(part => part.results) }
  }
}

/** Only the runtime's explicit result code confirms release; arbitrary wrappers and causes do not. */
export function stopFailureParts(error: unknown): StopFailures {
  if (error instanceof BackgroundStopError) return error.failures
  if (error instanceof Error && 'code' in error && error.code === 'ACTIVATION_RESULT_FAILED') return { cleanup: [], results: [error] }
  return { cleanup: [error], results: [] }
}

/** Preserve a sole result failure's runtime code while retaining mixed cleanup failures. */
export function combineStopFailures(errors: readonly unknown[], message: string): unknown {
  if (errors.length === 1 && stopFailureParts(errors[0]).cleanup.length === 0) return errors[0]
  return new BackgroundStopError(errors, message)
}
