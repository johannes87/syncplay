import { useEffect, useState } from 'react'
import { Header } from './components/Header.tsx'
import { SessionView } from './components/SessionView.tsx'
import { SetupView } from './components/SetupView.tsx'
import { useHashSession } from './hooks/useHashSession.ts'
import { engine } from './lib/instances.ts'
import { sessionKey } from './lib/session.ts'

export default function App() {
  const session = useHashSession()
  const key = sessionKey(session)
  const title = session?.title
  const [detailsOpen, setDetailsOpen] = useState(false)

  // Stop playing when navigating away from a session. Buttons that start a new
  // session join it before navigating, so that one is left alone.
  useEffect(() => {
    if (engine.sessionKey !== key) engine.leave()
  }, [key])

  useEffect(() => {
    document.title = title ? `${title} · SyncPlay` : 'SyncPlay'
    window.scrollTo(0, 0)
  }, [key, title])

  const showDetails = () => {
    if (!session) return
    setDetailsOpen(true)
    requestAnimationFrame(() =>
      document.getElementById('sync-details')?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    )
  }

  return (
    <div className="app">
      <Header onClockClick={showDetails} />
      {session ? (
        <SessionView key={key} session={session} detailsOpen={detailsOpen} onDetailsOpenChange={setDetailsOpen} />
      ) : (
        <SetupView />
      )}
    </div>
  )
}
