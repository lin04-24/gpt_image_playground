// lottie_light 子路径无类型定义，此处仅声明默认导出（实际 API 与 lottie-web 主入口一致）
declare module 'lottie-web/build/player/lottie_light' {
  import type { LottiePlayer } from 'lottie-web'
  const lottie: LottiePlayer
  export default lottie
}
