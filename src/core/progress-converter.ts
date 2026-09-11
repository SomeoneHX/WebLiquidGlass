/** Port of `ProgressConverter` — `(1f - exp(-abs(progress))) * progress.sign`. */
export interface ProgressConverter {
  convert(progress: number): number
}

export const DefaultProgressConverter: ProgressConverter = {
  convert(progress: number): number {
    return (1 - Math.exp(-Math.abs(progress))) * Math.sign(progress)
  }
}
