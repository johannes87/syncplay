import { describe, expect, it } from 'vitest'
import { isOver, makeSession, parseSession, sessionLink, timelinePosition } from './session.ts'

const BASE = 'https://example.org/syncplay/'

describe('session links', () => {
  it('round-trips through a link', () => {
    const s = makeSession({ url: 'https://music.example/a b/Track_01.mp3?x=1&y=2', start: 1790807343000, pos: 12.5, loop: true })
    const link = sessionLink(s, BASE)
    expect(link.startsWith(`${BASE}#`)).toBe(true)
    expect(parseSession(new URL(link).hash)).toEqual(s)
  })

  it('omits default options', () => {
    const s = makeSession({ url: 'https://m.example/t.mp3', start: 1000, pos: 0, loop: false })
    expect(sessionLink(s, BASE)).toBe(`${BASE}#u=https%3A%2F%2Fm.example%2Ft.mp3&t=1000`)
  })

  it('rejects incomplete links', () => {
    expect(parseSession('')).toBeNull()
    expect(parseSession('#u=https%3A%2F%2Fm.example%2Ft.mp3')).toBeNull()
    expect(parseSession('#t=1000')).toBeNull()
    expect(parseSession('#u=x&t=abc')).toBeNull()
  })
})

describe('timelinePosition', () => {
  const s = { start: 100_000, pos: 10, loop: false }

  it('adds elapsed time to the start position', () => {
    expect(timelinePosition(s, 100_000, 60)).toBe(10)
    expect(timelinePosition(s, 105_500, 60)).toBe(15.5)
  })

  it('shifts earlier by the latency nudge', () => {
    expect(timelinePosition(s, 105_000, 60, 200)).toBeCloseTo(15.2)
  })

  it('returns null once a non-looping song is over', () => {
    expect(timelinePosition(s, 149_999, 60)).toBeCloseTo(59.999)
    expect(timelinePosition(s, 150_000, 60)).toBeNull()
  })

  it('wraps around when looping', () => {
    expect(timelinePosition({ ...s, loop: true }, 175_000, 60)).toBeCloseTo(25)
  })
})

describe('isOver', () => {
  const s = makeSession({ url: 'https://m.example/t.mp3', start: 0, pos: 0, loop: false })

  it('needs a known duration', () => {
    expect(isOver(s, 1e9, null)).toBe(false)
  })

  it('is true after the end, never when looping', () => {
    expect(isOver(s, 59_000, 60)).toBe(false)
    expect(isOver(s, 60_000, 60)).toBe(true)
    expect(isOver({ ...s, loop: true }, 60_000, 60)).toBe(false)
  })
})
