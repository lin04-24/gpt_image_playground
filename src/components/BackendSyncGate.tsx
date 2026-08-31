import { useEffect } from 'react'
import { startBackendSync, stopBackendSync, synchronizeBackendData } from '../lib/backendSync'

interface BackendSyncGateProps {
  localReady: boolean
}

export default function BackendSyncGate({ localReady }: BackendSyncGateProps) {
  useEffect(() => {
    if (!localReady) return
    startBackendSync()
    void synchronizeBackendData().catch((error) => console.warn('Backend sync failed:', error))
    return () => stopBackendSync()
  }, [localReady])

  return null
}
