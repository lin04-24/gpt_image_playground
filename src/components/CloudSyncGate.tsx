import { useEffect } from 'react'
import { startCloudSync, stopCloudSync, synchronizeCloudData } from '../lib/cloudSync'

interface CloudSyncGateProps {
  localReady: boolean
  enabled: boolean
}

export default function CloudSyncGate({ localReady, enabled }: CloudSyncGateProps) {
  useEffect(() => {
    if (!localReady || !enabled) return
    let active = true
    void synchronizeCloudData()
      .then(() => {
        if (active) startCloudSync()
      })
      .catch((error) => console.warn('Cloud sync failed:', error))
    return () => {
      active = false
      stopCloudSync()
    }
  }, [enabled, localReady])

  return null
}
