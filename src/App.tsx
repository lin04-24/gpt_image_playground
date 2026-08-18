import { useEffect, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { activateFirstImportedProfile, buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { isDefaultConfigOnlyEnabled, mergeImportedSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, loadCustomProviderSettingsFromUrl } from './lib/customProviderConfigUrl'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import type { AppSettings } from './types'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import SupportPromptModal from './components/SupportPromptModal'
import { FavoriteCollectionPickerModal, FavoriteCollectionsView, ManageCollectionsModal } from './components/FavoriteCollections'
import { useGlobalClickSuppression } from './lib/clickSuppression'
import CloudSyncGate from './components/CloudSyncGate'
import { getCloudSessionStatus, loginCloudSync, type CloudSessionStatus } from './lib/cloudSync'

let customProviderConfigUrlImportStarted = false

export default function App() {
  const [sessionStatus, setSessionStatus] = useState<CloudSessionStatus | 'checking'>('checking')
  const [sessionError, setSessionError] = useState('')
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [password, setPassword] = useState('')

  useEffect(() => {
    let active = true
    void getCloudSessionStatus().then((status) => {
      if (!active) return
      setSessionStatus(status)
    })
    return () => {
      active = false
    }
  }, [])

  if (sessionStatus === 'checking') return <CloudLoginPage message="正在检查登录状态..." />
  if (sessionStatus === 'unavailable') return <CloudLoginPage message="暂时无法验证工作区访问权限，请检查服务连接后刷新页面重试。" />
  if (sessionStatus === 'login-required') {
    const submit = async (event: React.FormEvent) => {
      event.preventDefault()
      if (!password || isLoggingIn) return
      setIsLoggingIn(true)
      setSessionError('')
      try {
        await loginCloudSync(password)
        setPassword('')
        setSessionStatus('authenticated')
      } catch (error) {
        setSessionError(error instanceof Error ? error.message : '登录失败')
      } finally {
        setIsLoggingIn(false)
      }
    }
    return <CloudLoginPage password={password} onPasswordChange={setPassword} onSubmit={submit} error={sessionError} isLoggingIn={isLoggingIn} />
  }

  return <WorkspaceApp cloudEnabled={sessionStatus === 'authenticated'} />
}

interface CloudLoginPageProps {
  message?: string
  password?: string
  onPasswordChange?: (value: string) => void
  onSubmit?: (event: React.FormEvent) => void
  error?: string
  isLoggingIn?: boolean
}

function CloudLoginPage({ message, password = '', onPasswordChange, onSubmit, error = '', isLoggingIn = false }: CloudLoginPageProps) {
  return (
    <main className="safe-area-top safe-area-bottom min-h-screen bg-gray-50 px-4 py-8 text-gray-900 dark:bg-gray-950 dark:text-gray-100 sm:flex sm:items-center sm:justify-center sm:px-6">
      <section className="mx-auto flex w-full max-w-md flex-col justify-center rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-800 dark:bg-gray-900 sm:p-8">
        <div className="mb-8">
          <p className="text-sm font-medium text-blue-600 dark:text-blue-400">GPT Image Playground</p>
          <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">登录工作区</h1>
          <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">请输入唯一访问令牌，验证通过后才能读取工作区数据。</p>
        </div>
        {message ? <p className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600 dark:bg-gray-800 dark:text-gray-300">{message}</p> : (
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200" htmlFor="workspace-token">访问令牌</label>
            <input
              id="workspace-token"
              type="password"
              value={password}
              onChange={(event) => onPasswordChange?.(event.target.value)}
              autoComplete="current-password"
              autoFocus
              required
              placeholder="输入令牌"
              className="h-12 w-full rounded-xl border border-gray-300 bg-white px-4 text-base text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
            />
            {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <button type="submit" disabled={!password || isLoggingIn} className="h-12 w-full rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white transition hover:bg-blue-700 active:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50">
              {isLoggingIn ? '验证中...' : '进入工作区'}
            </button>
          </form>
        )}
      </section>
    </main>
  )
}

function WorkspaceApp({ cloudEnabled }: { cloudEnabled: boolean }) {
  const setSettings = useStore((s) => s.setSettings)
  const appMode = useStore((s) => s.appMode)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const [localReady, setLocalReady] = useState(false)
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  useEffect(() => {
    let active = true
    void Promise.resolve(useStore.persist.rehydrate()).then(() => {
      if (!active) return
      const searchParams = new URLSearchParams(window.location.search)
      const customProviderConfigUrl = getCustomProviderConfigUrl()
      const defaultConfigOnly = isDefaultConfigOnlyEnabled()

      const applyUrlSettings = (baseSettings: Partial<AppSettings>) => {
        const nextSettings = buildSettingsFromUrlParams(baseSettings, searchParams)
        return Object.keys(nextSettings).length ? nextSettings : baseSettings
      }

      const clearAppliedUrlSettings = () => {
        if (!hasUrlSettingParams(searchParams)) return

        clearUrlSettingParams(searchParams)

        const nextSearch = searchParams.toString()
        const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
        window.history.replaceState(null, '', nextUrl)
      }

      if (customProviderConfigUrl && defaultConfigOnly && !customProviderConfigUrlImportStarted) {
        customProviderConfigUrlImportStarted = true
        void loadCustomProviderSettingsFromUrl(customProviderConfigUrl)
          .then((importedSettings) => {
            if (!active) return
            const state = useStore.getState()
            const baseSettings = importedSettings
              ? activateFirstImportedProfile(mergeImportedSettings(state.settings, importedSettings), importedSettings)
              : state.settings
            state.setSettings(applyUrlSettings(baseSettings))
            clearAppliedUrlSettings()
          })
          .catch((error) => {
            console.warn('Failed to import custom provider config URL:', error)
            if (!active) return
            const state = useStore.getState()
            state.setSettings(applyUrlSettings(state.settings))
            clearAppliedUrlSettings()
          })

        void initStore().finally(() => {
          if (active) setLocalReady(true)
        })
        return
      }

      const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

      setSettings(nextSettings)

      clearAppliedUrlSettings()

      if (customProviderConfigUrl && !customProviderConfigUrlImportStarted) {
        customProviderConfigUrlImportStarted = true
        void loadCustomProviderSettingsFromUrl(customProviderConfigUrl)
          .then((importedSettings) => {
            if (!active || !importedSettings) return
            const state = useStore.getState()
            state.setSettings(mergeImportedSettings(state.settings, importedSettings))
          })
          .catch((error) => {
            console.warn('Failed to import custom provider config URL:', error)
          })
      }

      void initStore().finally(() => {
        if (active) setLocalReady(true)
      })
    })
    return () => {
      active = false
    }
  }, [setSettings])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  return (
    <>
      <Header />
      {appMode === 'agent' ? (
        <AgentWorkspace />
      ) : (
        <main data-home-main data-drag-select-surface className="pb-48">
          <div className="safe-area-x max-w-7xl mx-auto">
            <SearchBar />
            {filterFavorite && !activeFavoriteCollectionId ? <FavoriteCollectionsView /> : <TaskGrid />}
          </div>
        </main>
      )}
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <SupportPromptModal />
      <FavoriteCollectionPickerModal />
      <ManageCollectionsModal />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
      <CloudSyncGate localReady={localReady} enabled={cloudEnabled} />
    </>
  )
}
