export const BORDER_BEAM_DURATION_MS = 3000

export function getBeamPhaseSeed(taskId: string) {
  let phase = 0
  for (const char of taskId) phase = (phase * 31 + char.charCodeAt(0)) % BORDER_BEAM_DURATION_MS
  return phase
}

export function getBeamAnimationDelay(phaseSeed: number, now = Date.now()) {
  const phase = ((now + phaseSeed) % BORDER_BEAM_DURATION_MS + BORDER_BEAM_DURATION_MS) % BORDER_BEAM_DURATION_MS
  return `${-phase}ms`
}
