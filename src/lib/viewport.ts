const VIEWPORT_CONTENT = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'

function isInsideLightbox(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('[data-lightbox-root]'))
}

// 页面级双指缩放由 index.css 的 body { touch-action: pan-x pan-y } 在合成器层拦截。
// 不要在这里注册 document 级 touchmove——非 passive 监听会关闭合成器快速滚动路径，主线程一忙滚动就掉帧。
// gesturestart/gesturechange 是 iOS Safari 专属手势事件，不参与滚动路径，可安全保留。
export function installMobileViewportGuards() {
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (viewport) viewport.content = VIEWPORT_CONTENT

  const preventPageGesture = (event: Event) => {
    if (!isInsideLightbox(event.target)) event.preventDefault()
  }

  document.addEventListener('gesturestart', preventPageGesture, { passive: false })
  document.addEventListener('gesturechange', preventPageGesture, { passive: false })
}
