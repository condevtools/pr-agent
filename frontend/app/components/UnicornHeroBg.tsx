'use client'

import UnicornScene from 'unicornstudio-react/next'

const UNICORN_PROJECT_ID = 'D6URabRd5dX0xawbn2F9'
const UNICORN_WIDTH = '1920px'
const UNICORN_HEIGHT = '1080px'
const UNICORN_SCALE = 0.8
const UNICORN_DPI = 1
const UNICORN_FPS = 60

export default function UnicornHeroBg() {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-auto">
      <div className="absolute left-1/2 top-1/2 h-[1080px] w-[1920px] -translate-x-1/2 -translate-y-1/2 opacity-[0.85]">
        <UnicornScene
          projectId={UNICORN_PROJECT_ID}
          width={UNICORN_WIDTH}
          height={UNICORN_HEIGHT}
          scale={UNICORN_SCALE}
          dpi={UNICORN_DPI}
          fps={UNICORN_FPS}
          lazyLoad={false}
          placeholder="/hero.webp"
          showPlaceholderWhileLoading={false}
        />
      </div>
    </div>
  )
}
