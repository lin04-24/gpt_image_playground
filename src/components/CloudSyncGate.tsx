import { useEffect } from 'react'
import { startCloudSync, stopCloudSync, synchronizeCloudData } from '../lib/cloudSync'

interface CloudSyncGateProps {
  localReady: boolean
  enabled: boolean
}

export default function CloudSyncGate({ localReady, enabled }: CloudSyncGateProps) {
  useEffect(() => {
    if (!localReady || !enabled) return
    startCloudSync()
    void synchronizeCloudData()
      .catch((error) => console.warn('Cloud sync failed:', error))
    return () => {
      stopCloudSync()
    }
  }, [enabled, localReady])

  return null
}
