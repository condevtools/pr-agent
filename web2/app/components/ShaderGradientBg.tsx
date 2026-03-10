'use client'

import type { ComponentProps } from 'react'
import { ShaderGradientCanvas, ShaderGradient } from '@shadergradient/react'

export default function ShaderGradientBg() {
  const shaderProps = {
    animate: 'on',
    axesHelper: 'off',
    bgColor1: '#000000',
    bgColor2: '#000000',
    brightness: 0.8,
    cAzimuthAngle: 270,
    cDistance: 0.5,
    cPolarAngle: 180,
    cameraZoom: 15.09,
    color1: '#001dec',
    color2: '#4a4453',
    color3: '#afa8ba',
    destination: 'onCanvas',
    embedMode: 'off',
    envPreset: 'city',
    format: 'gif',
    fov: 45,
    frameRate: 10,
    gizmoHelper: 'hide',
    grain: 'on',
    lightType: 'env',
    pixelDensity: 1,
    positionX: -0.1,
    positionY: 0,
    positionZ: 0,
    range: 'disabled',
    rangeEnd: 40,
    rangeStart: 0,
    reflection: 0.4,
    rotationX: 0,
    rotationY: 130,
    rotationZ: 70,
    shader: 'defaults',
    type: 'sphere',
    uAmplitude: 3.2,
    uDensity: 0.8,
    uFrequency: 5.5,
    uSpeed: 0.3,
    uStrength: 0.1,
    uTime: 0,
    wireframe: false,
  } as unknown as ComponentProps<typeof ShaderGradient>

  return (
    <ShaderGradientCanvas
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      pointerEvents="none"
      lazyLoad={false}
    >
      <ShaderGradient {...shaderProps} />
    </ShaderGradientCanvas>
  )
}
