'use client'

import { ShaderGradientCanvas, ShaderGradient } from '@shadergradient/react'

export default function ShaderGradientBg() {
  return (
    <ShaderGradientCanvas
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      pointerEvents="none"
      pixelDensity={1}
      fov={45}
    >
      <ShaderGradient
        animate="on"
        brightness={0.9}
        cAzimuthAngle={180}
        cDistance={3.61}
        cPolarAngle={90}
        cameraZoom={1}
        color1="#00007e"
        color2="#ae6788"
        color3="#add7fc"
        envPreset="lobby"
        grain="on"
        lightType="3d"
        positionX={-1.4}
        positionY={0}
        positionZ={0}
        range="disabled"
        rangeEnd={40}
        rangeStart={0}
        reflection={0.1}
        rotationX={0}
        rotationY={10}
        rotationZ={50}
        shader="defaults"
        type="plane"
        uAmplitude={1}
        uDensity={1.3}
        uFrequency={5.5}
        uSpeed={0.1}
        uStrength={4}
        uTime={0}
        wireframe={false}
      />
    </ShaderGradientCanvas>
  )
}
