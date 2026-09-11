/**
 * Port of `androidx.compose.ui.input.pointer.util.VelocityTracker`
 * (least-squares quadratic fit over a 100 ms horizon).
 */

const HORIZON_MS = 100
const HISTORY_SIZE = 20

interface Sample {
  time: number
  value: number
}

class VelocityTracker1D {
  private samples: Sample[] = []

  reset(): void {
    this.samples.length = 0
  }

  addDataPoint(time: number, value: number): void {
    this.samples.push({ time, value })
    if (this.samples.length > HISTORY_SIZE) this.samples.shift()
  }

  /** Returns px/second. */
  calculateVelocity(): number {
    const samples = this.samples
    if (samples.length < 2) return 0

    const newestTime = samples[samples.length - 1].time
    const horizonStart = newestTime - HORIZON_MS

    const inHorizon: Sample[] = []
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].time >= horizonStart) inHorizon.unshift(samples[i])
      else break
    }
    if (inHorizon.length < 2) return 0

    // Normalise time around the newest sample (in seconds) to keep the normal equations
    // well conditioned, then fit value = a*t^2 + b*t + c.
    const t0 = newestTime
    let s1 = 0
    let s2 = 0
    let s3 = 0
    let s4 = 0
    let v1 = 0
    let v2 = 0
    let v3 = 0
    for (const sample of inHorizon) {
      const t = (sample.time - t0) / 1000
      const t2 = t * t
      s1 += t
      s2 += t2
      s3 += t2 * t
      s4 += t2 * t2
      v1 += sample.value
      v2 += sample.value * t
      v3 += sample.value * t2
    }
    const n = inHorizon.length
    // Solve the 3x3 normal equations for [c, b, a].
    const m = [
      [n, s1, s2],
      [s1, s2, s3],
      [s2, s3, s4]
    ]
    const rhs = [v1, v2, v3]
    const solution = solve3(m, rhs)
    if (!solution) return 0
    // Derivative at t = 0 is `b`.
    return solution[1]
  }
}

function solve3(m: number[][], rhs: number[]): [number, number, number] | null {
  const a = m.map((row, i) => [...row, rhs[i]])
  for (let col = 0; col < 3; col++) {
    let pivot = col
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null
    if (pivot !== col) {
      const tmp = a[pivot]
      a[pivot] = a[col]
      a[col] = tmp
    }
    for (let row = 0; row < 3; row++) {
      if (row === col) continue
      const factor = a[row][col] / a[col][col]
      for (let k = col; k < 4; k++) a[row][k] -= factor * a[col][k]
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]]
}

export class VelocityTracker {
  private x = new VelocityTracker1D()
  private y = new VelocityTracker1D()

  resetTracking(): void {
    this.x.reset()
    this.y.reset()
  }

  addPosition(timeMillis: number, position: { x: number; y: number }): void {
    this.x.addDataPoint(timeMillis, position.x)
    this.y.addDataPoint(timeMillis, position.y)
  }

  calculateVelocity(): { x: number; y: number } {
    return { x: this.x.calculateVelocity(), y: this.y.calculateVelocity() }
  }
}
