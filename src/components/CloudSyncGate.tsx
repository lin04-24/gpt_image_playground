import { useEffect } from 'react'
import { startCloudSync, stopCloudSync, synchronizeCloudData } from '../lib/cloudSync'
import { startBackendSync, stopBackendSync, synchronizeBackendData } from '../lib/backendSync'

interface CloudSyncGateProps {
  localReady: boolean
  enabled: boolean
}

export default function CloudSyncGate({ localReady, enabled }: CloudSyncGateProps) {
  useEffect(() => {
    if (!localReady || !enabled) return
    if (import.meta.env.VITE_BACKEND_API === 'true') {
      startBackendSync()
      void synchronizeBackendData().catch((error) => console.warn('Backend sync failed:', error))
      return () => stopBackendSync()
    }
    startCloudSync()
    void synchronizeCloudData()
      .catch((error) => console.warn('Cloud sync failed:', error))
    return () => {
      stopCloudSync()
    }
  }, [enabled, localReady])

  return null
}
