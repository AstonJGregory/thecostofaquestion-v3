// main.js (glowing pulse version)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LUTPass } from 'three/addons/postprocessing/LUTPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { BrightnessContrastShader } from 'three/addons/shaders/BrightnessContrastShader.js';
import { HueSaturationShader } from 'three/addons/shaders/HueSaturationShader.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { LUTCubeLoader } from 'three/addons/loaders/LUTCubeLoader.js';
import { sections, SECTION_TRANSITION, getSectionCount } from './js/sections.js';
import { gsap } from 'gsap';

/* ---------------- Renderer ---------------- */
const renderer = new THREE.WebGLRenderer({
  antialias: false,                 // faster
  logarithmicDepthBuffer: true,
  powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

/* ---------------- Postprocessing (Composer + Passes) ---------------- */
let composer, renderPass, fxaaPass, bcPass, hsPass, vignettePass, bloomPass, edgeBlurPass, lutPass;
const lutLoader = new LUTCubeLoader();
const LUT_PRESETS = {
  warm: { label: 'Warm Glow', path: 'luts/warm.cube' },
  green: { label: 'Green Lift', path: 'luts/LUT_green.cube' },
  mutedUrban: { label: 'Muted Urban', path: 'luts/LUT_muted-urban.cube' },
  forest: { label: 'Forest Boost', path: 'luts/LUT_forest.cube' },
  store: { label: 'Store Contrast', path: 'luts/LUT_PRESETSSTORE.cube' },
};
let activeLutKey = 'none';
let lutLoadMap = new Map(); // cache of loaded LUT textures
let lutIntensity = 1.0;

// Simple radial edge blur shader (blur increases toward screen edges)
const EdgeBlurShader = {
  uniforms: {
    tDiffuse:   { value: null },
    resolution: { value: new THREE.Vector2(innerWidth, innerHeight) },
    maxRadius:  { value: 8.0 },   // pixels at the very edge
    falloff:    { value: 1.6 },   // higher = blur starts closer to edge
    strength:   { value: 1.0 },   // mix amount of blur
    center:     { value: new THREE.Vector2(0.5, 0.5) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4( position, 1.0 );
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2  resolution;
    uniform float maxRadius;
    uniform float falloff;
    uniform float strength;
    uniform vec2  center;
    varying vec2  vUv;

    // 8-tap kernel (cross + diagonals)
    vec4 sampleBlur(vec2 uv, float radiusPx) {
      vec2 texel = radiusPx / resolution;
      vec4 c = texture2D(tDiffuse, uv) * 0.227027; // center weight (approx gaussian)
      c += texture2D(tDiffuse, uv + vec2(texel.x, 0.0)) * 0.1945946;
      c += texture2D(tDiffuse, uv - vec2(texel.x, 0.0)) * 0.1945946;
      c += texture2D(tDiffuse, uv + vec2(0.0, texel.y)) * 0.1216216;
      c += texture2D(tDiffuse, uv - vec2(0.0, texel.y)) * 0.1216216;
      // light diagonal contribution
      c += texture2D(tDiffuse, uv + vec2(texel.x, texel.y)) * 0.0702703;
      c += texture2D(tDiffuse, uv + vec2(-texel.x, texel.y)) * 0.0702703;
      c += texture2D(tDiffuse, uv + vec2(texel.x, -texel.y)) * 0.0702703;
      c += texture2D(tDiffuse, uv + vec2(-texel.x, -texel.y)) * 0.0702703;
      return c;
    }

    void main() {
      vec2 uv = vUv;
      // aspect-corrected distance from center
      vec2 d = uv - center;
      d.x *= resolution.x / resolution.y;
      float dist = length(d);              // 0 at center
      float edge = clamp(dist * 2.0, 0.0, 1.0); // ~1 near edges
      float mask = pow(edge, falloff);

      float radius = mask * maxRadius;
      vec4 sharp = texture2D(tDiffuse, uv);
      vec4 blurred = sampleBlur(uv, radius);
      gl_FragColor = mix(sharp, blurred, strength * mask);
    }
  `
};

function initPost() {
  composer = new EffectComposer(renderer);
  renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.4, 0.95);
  bloomPass.enabled = false;
  composer.addPass(bloomPass);


  bcPass = new ShaderPass(BrightnessContrastShader);
  bcPass.material.uniforms.brightness.value = 0.31; // -1..1
  bcPass.material.uniforms.contrast.value = 0.59;   // -1..1
  bcPass.enabled = true;
  composer.addPass(bcPass);

  hsPass = new ShaderPass(HueSaturationShader);
  hsPass.material.uniforms.hue.value = 0.0;        // -1..1 (radians/pi)
  hsPass.material.uniforms.saturation.value = 0.0; // -1..1
  hsPass.enabled = false;
  composer.addPass(hsPass);

  vignettePass = new ShaderPass(VignetteShader);
  vignettePass.material.uniforms.offset.value = 1.0;   // >=0
  vignettePass.material.uniforms.darkness.value = 0.6; // 0..1
  vignettePass.enabled = false;
  composer.addPass(vignettePass);

  // Edge blur (disabled by default)
  edgeBlurPass = new ShaderPass(EdgeBlurShader);
  edgeBlurPass.enabled = false;
  composer.addPass(edgeBlurPass);

  fxaaPass = new ShaderPass(FXAAShader);
  fxaaPass.enabled = false;
  composer.addPass(fxaaPass);

  lutPass = new LUTPass();
  lutPass.enabled = false;
  lutPass.intensity = 1.0;
  composer.addPass(lutPass);

  updatePostSizes();

  updateLutPass();
}

function updateLutPass() {
  if (!lutPass) return;
  lutPass.intensity = lutIntensity;
  const enabled = activeLutKey !== 'none' && lutPass.lut && lutIntensity > 0.0;
  lutPass.enabled = enabled;
}

function setLutPreset(key) {
  if (!lutPass) {
    activeLutKey = key;
    return;
  }

  const normalized = LUT_PRESETS[key] ? key : 'none';
  activeLutKey = normalized;

  if (normalized === 'none') {
    lutPass.lut = null;
    updateLutPass();
    return;
  }

  const preset = LUT_PRESETS[normalized];
  const { path } = preset;
  const cached = lutLoadMap.get(path);
  if (cached) {
    lutPass.lut = cached;
    updateLutPass();
    return;
  }

  lutLoader.load(
    path,
    (result) => {
      const tex = result.texture3D;
      lutLoadMap.set(path, tex);
      if (activeLutKey === normalized) {
        lutPass.lut = tex;
        updateLutPass();
      }
    },
    undefined,
    (err) => {
      console.error('[LUT] failed to load', path, err);
      if (activeLutKey === normalized) {
        activeLutKey = 'none';
        lutPass.lut = null;
        updateLutPass();
        try { window.dispatchEvent(new Event('ui-refresh')); } catch {}
      }
    }
  );
}

function updatePostSizes() {
  if (!composer) return;
  composer.setSize(innerWidth, innerHeight);
  if (bloomPass) bloomPass.setSize(innerWidth, innerHeight);
  if (edgeBlurPass?.material?.uniforms?.resolution) {
    edgeBlurPass.material.uniforms.resolution.value.set(innerWidth, innerHeight);
  }
  if (fxaaPass) {
    const px = Math.min(devicePixelRatio, 1.5);
    fxaaPass.material.uniforms[ 'resolution' ].value.set(1 / (innerWidth * px), 1 / (innerHeight * px));
  }
}

function setSectionCameraPose(section, { immediate = false } = {}) {
  if (!section?.camera) return;
  const cam = section.camera;
  if (typeof cam.pathT === 'number' && Number.isFinite(cam.pathT)) {
    const clamped = THREE.MathUtils.clamp(cam.pathT, 0, 1);
    cameraPathTarget = clamped;
    if (immediate) {
      cameraPathT = clamped;
    }
  }
  if (typeof cam.yaw === 'number' && Number.isFinite(cam.yaw)) {
    setCameraYawOffset(cam.yaw, { updateUI: false, reposition: false });
  }
  if (typeof cam.pitch === 'number' && Number.isFinite(cam.pitch)) {
    setCameraPitchOffset(cam.pitch, { updateUI: false, reposition: false });
  }
  positionCameraOnPath();
  controls.update();
}

const sectionState = {
  index: 0,
  phase: 'boot',
  phaseElapsed: 0,
  transitionElapsed: 0,
  rotationStart: 0,
  rotationTarget: 0,
  rotationDuration: SECTION_TRANSITION.spinDuration ?? 3.6,
  wheelAccumulator: 0,
  pendingIndex: 0,
  pendingPromise: null,
  scatterRest: SECTION_TRANSITION.scatterIn ?? 0.04,
  spinTurns: SECTION_TRANSITION.spinTurns ?? 1,
  isReady: false,
  direction: 1,
  nextIndex: 0,
  nextSection: null,
  transitionProgress: 0,
  pendingScrollCarry: 0,
  scatterOut: SECTION_TRANSITION.scatterOut ?? 0.32,
  nextScatterRest: SECTION_TRANSITION.scatterIn ?? 0.04,
  cameraStartPose: null,
  cameraEndPose: null,
};

const SCROLL_SCATTER_PEAK = SECTION_TRANSITION.scatterPeak ?? SECTION_TRANSITION.scatterOut ?? 0.85;
const SCROLL_TWEEN_DURATION = SECTION_TRANSITION.progressTween ?? 0.35;
const SCROLL_TWEEN_EASE = SECTION_TRANSITION.progressEaseName ?? 'power2.out';
const BACKGROUND_TWEEN_DURATION = SECTION_TRANSITION.backgroundTween ?? 0.45;
const BACKGROUND_TWEEN_EASE = SECTION_TRANSITION.backgroundEase ?? 'power2.out';

const scrollTweenState = {
  rotation: 0,
  scatter: 0,
  morph: 0,
  colorMix: 0,
  transformRotationX: 0,
  transformRotationY: 0,
  transformRotationZ: 0,
  transformScale: 1,
  transformOffsetX: 0,
  transformOffsetY: 0,
  transformOffsetZ: 0
};
const scrollTargetsCurrent = {
  rotation: 0,
  scatter: 0,
  morph: 0,
  colorMix: 0,
  transformRotationX: 0,
  transformRotationY: 0,
  transformRotationZ: 0,
  transformScale: 1,
  transformOffsetX: 0,
  transformOffsetY: 0,
  transformOffsetZ: 0
};
let scrollTween = null;

const backgroundTransition = {
  active: false,
  from: null,
  to: null,
  state: { progress: 0 },
  tween: null,
};

const _bgColorA = new THREE.Color();
const _bgColorB = new THREE.Color();
const _bgColorTmp = new THREE.Color();

function lerpHexColor(startHex, endHex, t) {
  const clamped = THREE.MathUtils.clamp(t, 0, 1);
  _bgColorA.set(startHex);
  _bgColorB.set(endHex);
  _bgColorTmp.copy(_bgColorA).lerp(_bgColorB, clamped);
  return `#${_bgColorTmp.getHexString()}`;
}

function applyScrollTweenState() {
  pointCloudGroup.rotation.y = scrollTweenState.rotation;
  setScatterAmplitude(scrollTweenState.scatter, { syncTarget: true });
  setMorphProgress(scrollTweenState.morph);
  
  // Apply color blend to shader
  const uniforms = points?.material?.uniforms;
  if (uniforms?.uColorMix) {
    uniforms.uColorMix.value = scrollTweenState.colorMix;
  }
  
  // Apply transform properties directly to the points geometry
  if (points) {
    // Set rotation order to avoid gimbal lock - use YXZ for more stable rotations
    points.rotation.order = 'YXZ';
    points.rotation.x = scrollTweenState.transformRotationX;
    points.rotation.y = scrollTweenState.transformRotationY;
    points.rotation.z = scrollTweenState.transformRotationZ;
    points.scale.setScalar(scrollTweenState.transformScale);
    points.position.set(scrollTweenState.transformOffsetX, scrollTweenState.transformOffsetY, scrollTweenState.transformOffsetZ);
  }
}

function tweenToScrollTargets(targets, { immediate = false } = {}) {
  if (!targets) return;
  const rotDiff = Math.abs(targets.rotation - scrollTargetsCurrent.rotation);
  const scatterDiff = Math.abs(targets.scatter - scrollTargetsCurrent.scatter);
  const morphDiff = Math.abs(targets.morph - scrollTargetsCurrent.morph);
  const colorMixDiff = Math.abs((targets.colorMix ?? 0) - scrollTargetsCurrent.colorMix);
  
  // Check transform differences
  let transformDiff = 0;
  if (targets.transform) {
    transformDiff += Math.abs(targets.transform.rotation.x - scrollTargetsCurrent.transformRotationX);
    transformDiff += Math.abs(targets.transform.rotation.y - scrollTargetsCurrent.transformRotationY);
    transformDiff += Math.abs(targets.transform.rotation.z - scrollTargetsCurrent.transformRotationZ);
    transformDiff += Math.abs(targets.transform.scale - scrollTargetsCurrent.transformScale);
    transformDiff += Math.abs(targets.transform.offset.x - scrollTargetsCurrent.transformOffsetX);
    transformDiff += Math.abs(targets.transform.offset.y - scrollTargetsCurrent.transformOffsetY);
    transformDiff += Math.abs(targets.transform.offset.z - scrollTargetsCurrent.transformOffsetZ);
  }
  
  if (rotDiff < 1e-4 && scatterDiff < 1e-4 && morphDiff < 1e-4 && colorMixDiff < 1e-4 && transformDiff < 1e-4) {
    return;
  }
  
  scrollTargetsCurrent.rotation = targets.rotation;
  scrollTargetsCurrent.scatter = targets.scatter;
  scrollTargetsCurrent.morph = targets.morph;
  scrollTargetsCurrent.colorMix = targets.colorMix ?? 0;
  
  // Update transform targets
  if (targets.transform) {
    scrollTargetsCurrent.transformRotationX = targets.transform.rotation.x;
    scrollTargetsCurrent.transformRotationY = targets.transform.rotation.y;
    scrollTargetsCurrent.transformRotationZ = targets.transform.rotation.z;
    scrollTargetsCurrent.transformScale = targets.transform.scale;
    scrollTargetsCurrent.transformOffsetX = targets.transform.offset.x;
    scrollTargetsCurrent.transformOffsetY = targets.transform.offset.y;
    scrollTargetsCurrent.transformOffsetZ = targets.transform.offset.z;
  }

  if (scrollTween) {
    scrollTween.kill();
    scrollTween = null;
  }

  if (immediate) {
    scrollTweenState.rotation = targets.rotation;
    scrollTweenState.scatter = targets.scatter;
    scrollTweenState.morph = targets.morph;
    scrollTweenState.colorMix = targets.colorMix ?? 0;
    if (targets.transform) {
      scrollTweenState.transformRotationX = targets.transform.rotation.x;
      scrollTweenState.transformRotationY = targets.transform.rotation.y;
      scrollTweenState.transformRotationZ = targets.transform.rotation.z;
      scrollTweenState.transformScale = targets.transform.scale;
      scrollTweenState.transformOffsetX = targets.transform.offset.x;
      scrollTweenState.transformOffsetY = targets.transform.offset.y;
      scrollTweenState.transformOffsetZ = targets.transform.offset.z;
    }
    applyScrollTweenState();
    return;
  }

  const tweenProps = {
    rotation: targets.rotation,
    scatter: targets.scatter,
    morph: targets.morph,
    colorMix: targets.colorMix ?? 0,
    duration: SCROLL_TWEEN_DURATION,
    ease: SCROLL_TWEEN_EASE,
    overwrite: 'auto',
    onUpdate: applyScrollTweenState,
  };
  
  // Add transform properties to tween if provided
  if (targets.transform) {
    tweenProps.transformRotationX = targets.transform.rotation.x;
    tweenProps.transformRotationY = targets.transform.rotation.y;
    tweenProps.transformRotationZ = targets.transform.rotation.z;
    tweenProps.transformScale = targets.transform.scale;
    tweenProps.transformOffsetX = targets.transform.offset.x;
    tweenProps.transformOffsetY = targets.transform.offset.y;
    tweenProps.transformOffsetZ = targets.transform.offset.z;
  }

  scrollTween = gsap.to(scrollTweenState, tweenProps);
}

function startBackgroundBlend(targetColors) {
  if (!targetColors) {
    finishBackgroundBlend({ commit: false });
    return;
  }
  backgroundTransition.active = true;
  backgroundTransition.from = {
    top: backgroundGradient.top,
    mid: backgroundGradient.mid,
    bottom: backgroundGradient.bottom,
  };
  backgroundTransition.to = { ...targetColors };
  backgroundTransition.state.progress = 0;
  if (backgroundTransition.tween) {
    backgroundTransition.tween.kill();
    backgroundTransition.tween = null;
  }
  applyBackgroundBlend(0);
}

function applyBackgroundBlend(value) {
  if (!backgroundTransition.active || !backgroundTransition.from || !backgroundTransition.to) return;
  const t = THREE.MathUtils.clamp(value, 0, 1);
  const blended = {
    top: lerpHexColor(backgroundTransition.from.top, backgroundTransition.to.top, t),
    mid: lerpHexColor(backgroundTransition.from.mid, backgroundTransition.to.mid, t),
    bottom: lerpHexColor(backgroundTransition.from.bottom, backgroundTransition.to.bottom, t),
  };
  setBackgroundGradient(blended);
}

function animateBackgroundBlend(target, { immediate = false } = {}) {
  if (!backgroundTransition.active) return;
  const clamped = THREE.MathUtils.clamp(target, 0, 1);
  if (Math.abs(backgroundTransition.state.progress - clamped) < 1e-4 && !immediate) {
    return;
  }
  if (backgroundTransition.tween) {
    backgroundTransition.tween.kill();
    backgroundTransition.tween = null;
  }
  if (immediate) {
    backgroundTransition.state.progress = clamped;
    applyBackgroundBlend(clamped);
    return;
  }
  backgroundTransition.tween = gsap.to(backgroundTransition.state, {
    progress: clamped,
    duration: BACKGROUND_TWEEN_DURATION,
    ease: BACKGROUND_TWEEN_EASE,
    overwrite: 'auto',
    onUpdate: () => applyBackgroundBlend(backgroundTransition.state.progress),
  });
}

function finishBackgroundBlend({ commit = true } = {}) {
  if (!backgroundTransition.active) return null;
  let appliedColors = null;
  if (backgroundTransition.tween) {
    backgroundTransition.tween.kill();
    backgroundTransition.tween = null;
  }
  if (commit && backgroundTransition.to) {
    appliedColors = { ...backgroundTransition.to };
    setBackgroundGradient(backgroundTransition.to);
  } else if (!commit && backgroundTransition.from) {
    appliedColors = { ...backgroundTransition.from };
    setBackgroundGradient(backgroundTransition.from);
  }
  backgroundTransition.active = false;
  backgroundTransition.from = null;
  backgroundTransition.to = null;
  backgroundTransition.state.progress = 0;
  return appliedColors;
}
const sectionAssets = new Map();
sections.forEach((section) => {
  sectionAssets.set(section.id, {
    section,
    path: section.modelPath,
    geometry: null,
    morphArray: null,
  });
});

let currentSectionId = null;
let baseSampleFractions = null;
let baseVertexCount = 0;

function normalizeSectionIndex(index) {
  const total = getSectionCount();
  if (total <= 0) return 0;
  const mod = index % total;
  return mod < 0 ? mod + total : mod;
}

function getSectionByIndex(index) {
  const total = getSectionCount();
  if (total === 0) return null;
  return sections[normalizeSectionIndex(index)];
}

function getDefaultTransform() {
  return {
    rotation: { x: 0, y: 0, z: 0 },
    scale: 1,
    offset: { x: 0, y: 0, z: 0 }
  };
}

function getSectionTransform(section) {
  return section?.transform || getDefaultTransform();
}

function getSectionAsset(section) {
  if (!section) return null;
  return sectionAssets.get(section.id) ?? null;
}

function ensureSectionGeometry(section) {
  const asset = getSectionAsset(section);
  if (!asset) return Promise.reject(new Error('Unknown section asset'));
  if (asset.geometry) return Promise.resolve(asset.geometry);
  const path = asset.path ?? section.modelPath;
  return new Promise((resolve, reject) => {
    loader.load(
      path,
      (geom) => {
        preprocessGeometry(geom, path);
        asset.geometry = geom;
        resolve(geom);
      },
      undefined,
      (err) => reject(err)
    );
  });
}

function computeSampleFractions(sourceGeom, keepCount) {
  const srcPos = sourceGeom?.getAttribute('position');
  if (!srcPos || !Number.isFinite(keepCount) || keepCount <= 0) return null;
  const sourceCount = srcPos.count;
  if (!Number.isFinite(sourceCount) || sourceCount <= 0) return null;
  const fractions = new Float32Array(keepCount);
  const step = sourceCount / keepCount;
  const srcDenom = Math.max(1, sourceCount - 1);
  for (let i = 0; i < keepCount; i++) {
    let index = Math.floor(i * step);
    if (i === keepCount - 1 || index >= sourceCount) {
      index = sourceCount - 1;
    }
    fractions[i] = srcDenom > 0 ? index / srcDenom : 0;
  }
  return fractions;
}

function generateMorphTargetArray(targetGeom) {
  if (!points) return null;
  const morphAttr = points.geometry?.getAttribute('morphTarget');
  if (!morphAttr) return null;
  const sampleFractions = baseSampleFractions;
  if (!sampleFractions || sampleFractions.length !== morphAttr.count) {
    return null;
  }

  return generateMorphTargetArrayWithFractions(targetGeom, sampleFractions);
}

function generateMorphTargetArrayWithFractions(targetGeom, sampleFractions) {
  if (!points) return null;
  const morphAttr = points.geometry?.getAttribute('morphTarget');
  if (!morphAttr) return null;
  
  if (!sampleFractions || sampleFractions.length !== morphAttr.count) {
    return null;
  }

  const tgtPos = targetGeom?.getAttribute('position');
  if (!tgtPos) return null;
  const tgtArray = tgtPos.array;
  const tgtStride = tgtPos.itemSize || 3;
  const tgtCount = tgtPos.count;
  if (!tgtArray || tgtCount <= 0) return null;

  const result = new Float32Array(sampleFractions.length * 3);
  for (let i = 0; i < sampleFractions.length; i++) {
    const fraction = THREE.MathUtils.clamp(sampleFractions[i] ?? 0, 0, 1);
    let targetIndex = Math.round(fraction * (tgtCount - 1));
    if (!Number.isFinite(targetIndex)) targetIndex = 0;
    if (targetIndex < 0) targetIndex = 0;
    if (targetIndex >= tgtCount) targetIndex = tgtCount - 1;
    const dst = i * 3;
    const srcOffset = targetIndex * tgtStride;
    result[dst + 0] = tgtArray[srcOffset + 0] ?? 0;
    result[dst + 1] = tgtStride > 1 ? (tgtArray[srcOffset + 1] ?? 0) : 0;
    result[dst + 2] = tgtStride > 2 ? (tgtArray[srcOffset + 2] ?? 0) : 0;
  }
  return result;
}

function generateMorphColorArrayWithFractions(targetGeom, sampleFractions) {
  if (!points) return null;
  const morphAttr = points.geometry?.getAttribute('morphTarget');
  if (!morphAttr) return null;
  
  if (!sampleFractions || sampleFractions.length !== morphAttr.count) {
    return null;
  }

  const tgtColAttr = targetGeom?.getAttribute('color');
  if (!tgtColAttr) return null;
  const tgtColorArray = tgtColAttr.array;
  const tgtColorStride = tgtColAttr.itemSize || 3;
  const tgtCount = tgtColAttr.count;
  if (!tgtColorArray || tgtCount <= 0) return null;

  const result = new tgtColorArray.constructor(sampleFractions.length * tgtColorStride);
  for (let i = 0; i < sampleFractions.length; i++) {
    const fraction = THREE.MathUtils.clamp(sampleFractions[i] ?? 0, 0, 1);
    let targetIndex = Math.round(fraction * (tgtCount - 1));
    if (!Number.isFinite(targetIndex)) targetIndex = 0;
    if (targetIndex < 0) targetIndex = 0;
    if (targetIndex >= tgtCount) targetIndex = tgtCount - 1;
    const dst = i * tgtColorStride;
    const srcOffset = targetIndex * tgtColorStride;
    for (let k = 0; k < tgtColorStride; k++) {
      result[dst + k] = tgtColorArray[srcOffset + k] ?? 0;
    }
  }
  return result;
}

function setPointsMorphTarget(array) {
  const attr = points?.geometry?.getAttribute('morphTarget');
  if (!attr || !array) return;
  if (array.length !== attr.array.length) return;
  attr.array.set(array);
  attr.needsUpdate = true;
}

function setPointsMorphColor(array) {
  const morphAttr = points?.geometry?.getAttribute('morphColor');
  if (!morphAttr || !array) return;
  if (array.length !== morphAttr.array.length) return;
  
  // Update morphColor with the NEW colors from the target geometry
  morphAttr.array.set(array);
  morphAttr.needsUpdate = true;
  
  // IMPORTANT: Also update the base color to the CURRENT displayed colors
  // This ensures that when we start blending, we're blending FROM the current visual state
  const colorAttr = points?.geometry?.getAttribute('color');
  if (colorAttr && colorAttr.array.length === array.length) {
    // At the start of a new transition, we want to blend from the current color state
    // Copy current colors to base color attribute so blend starts from visual state, not from previous section
    // Don't update base colors here - they should already be the current visual state
    console.log('[morph] Updated morphColor with new target colors');
  }
}

function setPointsPositionArray(array) {
  const attr = points?.geometry?.getAttribute('position');
  if (!attr || !array) return;
  if (array.length !== attr.array.length) return;
  attr.array.set(array);
  attr.needsUpdate = true;
  points.geometry.computeBoundingSphere?.();
  points.geometry.computeBoundingBox?.();
}

function ensureSectionMorphTarget(section) {
  const asset = getSectionAsset(section);
  if (!asset) return Promise.reject(new Error('Unknown section asset'));
  return ensureSectionGeometry(section).then((geom) => {
    if (!points) return Promise.reject(new Error('Points not initialized'));
    const morphAttr = points.geometry.getAttribute('morphTarget');
    if (!morphAttr) return Promise.reject(new Error('Missing morph target attribute'));
    const expectedLength = morphAttr.array.length;
    
    // Always regenerate sample fractions based on the target geometry to ensure proper point count restoration
    const targetSampleFractions = computeSampleFractions(geom, morphAttr.count);
    if (!targetSampleFractions) return Promise.reject(new Error('Failed to compute sample fractions for target geometry'));
    
    // Generate morph target array using the target geometry's sample fractions
    const array = generateMorphTargetArrayWithFractions(geom, targetSampleFractions);
    if (!array) throw new Error('Failed to generate morph target array');
    
    asset.morphArray = array;
    setPointsMorphTarget(asset.morphArray);
    
    // Also update morph colors if available
    const colorArray = generateMorphColorArrayWithFractions(geom, targetSampleFractions);
    if (colorArray) {
      // Update morphColor with new target colors
      setPointsMorphColor(colorArray);
      console.log('[morph] Updated morph colors for section:', section?.id);
    } else {
      console.log('[morph] No colors available for section:', section?.id);
    }
    
    currentModelPath = asset.path ?? section.modelPath;
    return asset.morphArray;
  });
}

function refreshAllMorphTargets() {
  baseSampleFractions = computeSampleFractions(originalGeom, baseVertexCount);
  sectionAssets.forEach((asset) => {
    asset.morphArray = null;
  });
}

function startSectionTransition(nextIndex, direction = 1, { initialProgress = 0 } = {}) {
  const total = getSectionCount();
  if (total <= 0) return;

  const targetIndex = normalizeSectionIndex(nextIndex);
  if (targetIndex === sectionState.index && sectionState.phase !== 'boot') {
    return;
  }

  const nextSection = getSectionByIndex(targetIndex);
  if (!nextSection) return;

  const directionSign = direction >= 0 ? 1 : -1;
  const baseTurns = nextSection.transition?.spinTurns ?? SECTION_TRANSITION.spinTurns ?? 1;
  const scatterOut = nextSection.transition?.scatterOut ?? SECTION_TRANSITION.scatterOut ?? 0.32;
  const scatterIn = nextSection.transition?.scatterIn ?? SECTION_TRANSITION.scatterIn ?? 0.04;

  sectionState.phase = 'fadeOut';
  sectionState.phaseElapsed = 0;
  sectionState.transitionElapsed = 0;
  sectionState.pendingIndex = targetIndex;
  sectionState.pendingPromise = null;
  sectionState.direction = directionSign;
  sectionState.nextIndex = targetIndex;
  sectionState.nextSection = nextSection;
  sectionState.spinTurns = baseTurns;
  sectionState.rotationStart = pointCloudGroup.rotation.y;
  sectionState.rotationMid = sectionState.rotationStart + directionSign * baseTurns * Math.PI;
  sectionState.rotationTarget = sectionState.rotationStart + directionSign * baseTurns * Math.PI * 2;
  sectionState.rotationDuration = nextSection.transition?.spinDuration ?? SECTION_TRANSITION.spinDuration ?? 3.6;
  sectionState.scatterOut = Math.max(scatterOut, SCROLL_SCATTER_PEAK);
  sectionState.nextScatterRest = scatterIn;
  sectionState.transitionProgress = THREE.MathUtils.clamp(initialProgress, 0, 1);
  sectionState.pendingScrollCarry = 0;
  sectionState.wheelAccumulator = 0;
  sectionState.morphReady = false;

  const currentPose = getCurrentCameraPose();
  const targetCamera = nextSection.camera || {};
  const endPathT = typeof targetCamera.pathT === 'number'
    ? THREE.MathUtils.clamp(targetCamera.pathT, 0, 1)
    : currentPose.pathT;
  const endYaw = Number.isFinite(targetCamera.yaw) ? targetCamera.yaw : currentPose.yaw;
  const endPitch = Number.isFinite(targetCamera.pitch) ? targetCamera.pitch : currentPose.pitch;
  sectionState.cameraStartPose = currentPose;
  sectionState.cameraEndPose = { pathT: endPathT, yaw: endYaw, pitch: endPitch };

  scrollTweenState.rotation = pointCloudGroup.rotation.y;
  scrollTweenState.scatter = scatterAmp;
  scrollTweenState.morph = morphProgress;
  scrollTweenState.colorMix = morphProgress;  // Initialize colorMix to match morph
  scrollTargetsCurrent.rotation = scrollTweenState.rotation;
  scrollTargetsCurrent.scatter = scrollTweenState.scatter;
  scrollTargetsCurrent.morph = scrollTweenState.morph;
  scrollTargetsCurrent.colorMix = scrollTweenState.colorMix;
  
  // Initialize transform state
  const currentSection = getSectionByIndex(sectionState.index);
  const currentTransform = getSectionTransform(currentSection);
  scrollTweenState.transformRotationX = points ? points.rotation.x : 0;
  scrollTweenState.transformRotationY = points ? points.rotation.y : 0;
  scrollTweenState.transformRotationZ = points ? points.rotation.z : 0;
  scrollTweenState.transformScale = points ? points.scale.x : 1;
  scrollTweenState.transformOffsetX = points ? points.position.x : 0;
  scrollTweenState.transformOffsetY = points ? points.position.y : 0;
  scrollTweenState.transformOffsetZ = points ? points.position.z : 0;
  
  scrollTargetsCurrent.transformRotationX = scrollTweenState.transformRotationX;
  scrollTargetsCurrent.transformRotationY = scrollTweenState.transformRotationY;
  scrollTargetsCurrent.transformRotationZ = scrollTweenState.transformRotationZ;
  scrollTargetsCurrent.transformScale = scrollTweenState.transformScale;
  scrollTargetsCurrent.transformOffsetX = scrollTweenState.transformOffsetX;
  scrollTargetsCurrent.transformOffsetY = scrollTweenState.transformOffsetY;
  scrollTargetsCurrent.transformOffsetZ = scrollTweenState.transformOffsetZ;

  const backgroundTarget = normalizeBackgroundInput(nextSection.settings?.background);
  if (backgroundTarget) {
    startBackgroundBlend(backgroundTarget);
  } else {
    finishBackgroundBlend({ commit: false });
  }

  // Preload the morph target (including colors) at the START of transition
  // This ensures colors are available for smooth interpolation during the entire morph
  const morphPromise = ensureSectionMorphTarget(nextSection)
    .then(() => {
      sectionState.morphReady = true;
      console.log('[morph] Morph colors ready for section:', nextSection?.id);
      return true;
    })
    .catch((err) => {
      console.error('[sections] morph preload failed', err);
      sectionState.morphReady = false;
      return false;
    });
  sectionState.pendingPromise = morphPromise;

  updateSectionTransition();
  if (sectionState.transitionProgress >= 1 - 1e-4) {
    beginSectionLoad();
  }
}

function easeInOutCubic(t) {
  const clamped = THREE.MathUtils.clamp(t, 0, 1);
  return clamped < 0.5
    ? 4 * clamped * clamped * clamped
    : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

function ensureTextOpacity(value, immediate = true) {
  const clamped = THREE.MathUtils.clamp(value, 0, 1);
  if (Math.abs(textOpacityValue - clamped) > 1e-3) {
    setTextOpacityTarget(clamped, { immediate });
  }
}

function updateSectionTransition() {
  const currentSection = getSectionByIndex(sectionState.index);
  const nextSection = sectionState.nextSection;
  
  switch (sectionState.phase) {
    case 'fadeOut': {
      const eased = easeInOutCubic(sectionState.transitionProgress);
      ensureTextOpacity(1 - eased);
      const scatterTarget = THREE.MathUtils.lerp(sectionState.scatterRest, SCROLL_SCATTER_PEAK, eased);
      const rotationTarget = THREE.MathUtils.lerp(sectionState.rotationStart, sectionState.rotationMid, eased);
      
      // Apply morph at midpoint when scatter is maximum (concentrated color transition)
      // Map progress 0->1 to morph progress 0->1 (but only if colors are ready)
      const morphTarget = sectionState.morphReady ? eased : 0;
      
      // Interpolate between current and next section transforms
      const currentTransform = getSectionTransform(currentSection);
      const nextTransform = getSectionTransform(nextSection);
      const interpolatedTransform = {
        rotation: {
          x: THREE.MathUtils.lerp(currentTransform.rotation.x, nextTransform.rotation.x, eased),
          y: THREE.MathUtils.lerp(currentTransform.rotation.y, nextTransform.rotation.y, eased),
          z: THREE.MathUtils.lerp(currentTransform.rotation.z, nextTransform.rotation.z, eased)
        },
        scale: THREE.MathUtils.lerp(currentTransform.scale, nextTransform.scale, eased),
        offset: {
          x: THREE.MathUtils.lerp(currentTransform.offset.x, nextTransform.offset.x, eased),
          y: THREE.MathUtils.lerp(currentTransform.offset.y, nextTransform.offset.y, eased),
          z: THREE.MathUtils.lerp(currentTransform.offset.z, nextTransform.offset.z, eased)
        }
      };
      
      tweenToScrollTargets({ 
        rotation: rotationTarget, 
        scatter: scatterTarget, 
        morph: morphTarget,
        colorMix: morphTarget,  // Color mix follows morph progress
        transform: interpolatedTransform
      });
      updateCameraPose(eased);
      animateBackgroundBlend(eased * 0.5);
      break;
    }
    case 'loading': {
      ensureTextOpacity(0);
      animateBackgroundBlend(0.5);
      
      // Keep morph at 1.0 during loading (at maximum scatter) to maintain color transition
      const morphTarget = sectionState.morphReady ? 1.0 : 0;
      
      // Use next section transform during loading
      const nextTransform = getSectionTransform(nextSection);
      
      tweenToScrollTargets({
        rotation: sectionState.rotationMid,
        scatter: SCROLL_SCATTER_PEAK,
        morph: morphTarget,
        colorMix: morphTarget,  // Color mix follows morph progress
        transform: nextTransform
      }, { immediate: true });
      updateCameraPose(1);
      break;
    }
    case 'fadeIn': {
      const eased = easeInOutCubic(sectionState.transitionProgress);
      ensureTextOpacity(eased);
      const scatterTarget = THREE.MathUtils.lerp(SCROLL_SCATTER_PEAK, sectionState.nextScatterRest, eased);
      const rotationTarget = THREE.MathUtils.lerp(sectionState.rotationMid, sectionState.rotationTarget, eased);
      
      // Keep morph at 1.0 during fadeIn (colors already transitioned at midpoint)
      // No need to reverse the color morph, we stay at the new colors
      const morphTarget = sectionState.morphReady ? 1.0 : 0;
      
      // Use next section transform during fade in
      const nextTransform = getSectionTransform(nextSection);
      
      tweenToScrollTargets({ 
        rotation: rotationTarget, 
        scatter: scatterTarget, 
        morph: morphTarget,
        colorMix: morphTarget,  // Color mix follows morph progress
        transform: nextTransform
      });
      updateCameraPose(1);
      animateBackgroundBlend(0.5 + eased * 0.5);
      break;
    }
    case 'idle':
    default: {
      ensureTextOpacity(1);
      
      // Use current section transform when idle
      const currentTransform = getSectionTransform(currentSection);
      
      tweenToScrollTargets({
        rotation: sectionState.rotationTarget,
        scatter: sectionState.scatterRest,
        morph: 0,
        colorMix: 0,  // Reset color mix when idle
        transform: currentTransform
      });
      updateCameraPose(1);
      if (!backgroundTransition.active) {
        // ensure gradient matches rest state
        animateBackgroundBlend(0, { immediate: true });
      }
      break;
    }
  }
}

function cancelTransition() {
  sectionState.phase = 'idle';
  sectionState.transitionProgress = 0;
  sectionState.pendingIndex = sectionState.index;
  sectionState.pendingPromise = null;
  sectionState.nextSection = null;
  sectionState.pendingScrollCarry = 0;
  pointCloudGroup.rotation.y = sectionState.rotationStart;
  sectionState.rotationTarget = sectionState.rotationStart;
  sectionState.rotationMid = sectionState.rotationStart;
  sectionState.cameraEndPose = sectionState.cameraStartPose;
  updateCameraPose(0);
  updateSectionTransition();
  sectionState.morphReady = false;
  finishBackgroundBlend({ commit: false });
}

function beginSectionLoad() {
  const nextSection = sectionState.nextSection;
  if (!nextSection) {
    cancelTransition();
    return;
  }
  sectionState.phase = 'loading';
  updateSectionTransition();

  const morphPromise = sectionState.pendingPromise ?? ensureSectionMorphTarget(nextSection);
  sectionState.pendingPromise = morphPromise;
  morphPromise
    .then(() => {
      const wasMorphReady = sectionState.morphReady;
      sectionState.morphReady = true;
      
      // Force update transition if colors were just loaded during any phase
      // This ensures smooth color interpolation even if loading happens mid-transition
      const currentProgress = sectionState.transitionProgress;
      if (!wasMorphReady && currentProgress > 0 && (sectionState.phase === 'fadeOut' || sectionState.phase === 'fadeIn')) {
        // Colors just became available mid-transition - immediately apply morph at current progress
        console.log('[morph] Colors loaded mid-transition, starting morph at progress:', currentProgress.toFixed(3));
        // Force immediate update to avoid tween delay
        const eased = easeInOutCubic(currentProgress);
        setMorphProgress(eased);
      }
      updateSectionTransition();
      applySectionOverrides(nextSection, { skipBackground: true });
      setBackgroundTextForSection(nextSection);
      sectionState.index = sectionState.nextIndex;
      setSectionTextContent(nextSection, sectionState.index);
      sectionState.scatterRest = sectionState.nextScatterRest;
      sectionState.transitionProgress = Math.min(1, sectionState.pendingScrollCarry);
      sectionState.pendingScrollCarry = Math.max(0, sectionState.pendingScrollCarry - sectionState.transitionProgress);
      sectionState.phase = 'fadeIn';
      ensureTextOpacity(0);
      updateSectionTransition();
      if (sectionState.transitionProgress >= 1 - 1e-4) {
        completeFadeIn();
      }
    })
    .catch((err) => {
      console.error('[sections] failed to load model for section', nextSection?.id, err);
      sectionState.phase = 'idle';
      sectionState.transitionProgress = 0;
      sectionState.pendingPromise = null;
      sectionState.pendingScrollCarry = 0;
      sectionState.morphReady = false;
      finishBackgroundBlend({ commit: false });
      updateSectionTransition();
    });
}

function completeFadeIn() {
  sectionState.phase = 'idle';
  sectionState.transitionProgress = 0;
  sectionState.pendingPromise = null;
  const activeSection = sectionState.nextSection || getSectionByIndex(sectionState.index);
  sectionState.nextSection = null;
  sectionState.rotationStart = pointCloudGroup.rotation.y;
  sectionState.rotationTarget = sectionState.rotationStart;
  sectionState.rotationMid = sectionState.rotationStart;
  const endPose = sectionState.cameraEndPose || getCurrentCameraPose();
  sectionState.cameraStartPose = { ...endPose };
  sectionState.cameraEndPose = { ...endPose };
  cameraPathTarget = THREE.MathUtils.clamp(endPose.pathT, 0, 1);
  cameraPathT = cameraPathTarget;
  cameraYawOffsetDeg = endPose.yaw;
  cameraPitchOffsetDeg = endPose.pitch;
  positionCameraOnPath();
  controls.update();
  setCameraYawOffset(endPose.yaw, { updateUI: true, reposition: false });
  setCameraPitchOffset(endPose.pitch, { updateUI: true, reposition: false });
  updateSectionTransition();

  const appliedColors = finishBackgroundBlend({ commit: true });
  if (appliedColors) {
    updateBackgroundControls(appliedColors);
  }

  if (activeSection) {
    const asset = getSectionAsset(activeSection);
    if (asset?.morphArray) {
      setPointsPositionArray(asset.morphArray);
      
      if (asset.geometry) {
        const posAttr = points.geometry.getAttribute('position');
        if (posAttr) baseVertexCount = posAttr.count;
        originalGeom = asset.geometry.clone();
        morphTargetOriginal = originalGeom.clone();
        refreshAllMorphTargets();
      }
      const updatedPosAttr = points.geometry.getAttribute('position');
      if (updatedPosAttr) {
        asset.morphArray = new Float32Array(updatedPosAttr.array);
        setPointsMorphTarget(asset.morphArray);
      }
      
      // Copy morph colors to base color attribute BEFORE resetting morph to 0
      // This ensures the new colors persist when colorMix resets to 0
      const morphColorAttr = points?.geometry?.getAttribute('morphColor');
      if (morphColorAttr) {
        const colorAttr = points?.geometry?.getAttribute('color');
        if (colorAttr && colorAttr.array.length === morphColorAttr.array.length) {
          colorAttr.array.set(morphColorAttr.array);
          colorAttr.needsUpdate = true;
          console.log('[morph] Transition complete - copied new colors to base color attribute');
        }
      }
      
      setMorphProgress(0);
      morphUniformValue = 0;
      const uniforms = points?.material?.uniforms;
      if (uniforms?.uMorphFactor) uniforms.uMorphFactor.value = 0;
    }
    currentSectionId = activeSection.id;
  }

  scrollTweenState.rotation = pointCloudGroup.rotation.y;
  scrollTweenState.scatter = sectionState.scatterRest;
  scrollTweenState.morph = 0;
  scrollTweenState.colorMix = 0;
  scrollTargetsCurrent.rotation = scrollTweenState.rotation;
  scrollTargetsCurrent.scatter = scrollTweenState.scatter;
  scrollTargetsCurrent.morph = scrollTweenState.morph;
  scrollTargetsCurrent.colorMix = scrollTweenState.colorMix;
  applyScrollTweenState();

  const leftover = sectionState.pendingScrollCarry;
  sectionState.pendingScrollCarry = 0;
  if (leftover > 1e-4) {
    const delta = leftover * SCROLL_PROGRESS_SCALE * sectionState.direction;
    applyScrollDelta(delta);
  }
}

function advanceTransitionProgress(stepRaw) {
  const phase = sectionState.phase;
  if (phase !== 'fadeOut' && phase !== 'fadeIn') return;
  const direction = sectionState.direction || 1;
  const signed = stepRaw * direction;
  if (signed === 0) {
    updateSectionTransition();
    return;
  }

  if (phase === 'fadeOut') {
    const next = sectionState.transitionProgress + signed;
    if (next <= 0) {
      cancelTransition();
      return;
    }
    if (next >= 1) {
      sectionState.pendingScrollCarry += Math.max(0, next - 1);
      sectionState.transitionProgress = 1;
      updateSectionTransition();
      beginSectionLoad();
      return;
    }
    sectionState.transitionProgress = THREE.MathUtils.clamp(next, 0, 1);
    updateSectionTransition();
    return;
  }

  if (phase === 'fadeIn') {
    const next = sectionState.transitionProgress + signed;
    if (next >= 1) {
      sectionState.pendingScrollCarry += Math.max(0, next - 1);
      sectionState.transitionProgress = 1;
      updateSectionTransition();
      completeFadeIn();
      return;
    }
    sectionState.transitionProgress = THREE.MathUtils.clamp(next, 0, 1);
    updateSectionTransition();
  }
}

function applyScrollDelta(delta, { isTouch = false } = {}) {
  if (!sectionState.isReady) return;
  const progressScale = isTouch ? TOUCH_PROGRESS_SCALE : SCROLL_PROGRESS_SCALE;
  const threshold = isTouch ? TOUCH_TRIGGER_THRESHOLD : SCROLL_TRIGGER_THRESHOLD;
  const normalized = delta / progressScale;

  if (sectionState.phase === 'fadeOut' || sectionState.phase === 'fadeIn') {
    advanceTransitionProgress(normalized);
    return;
  }

  if (sectionState.phase === 'loading') {
    const direction = sectionState.direction || 1;
    const carry = normalized * direction;
    if (carry > 0) {
      sectionState.pendingScrollCarry += carry;
    }
    return;
  }

  sectionState.wheelAccumulator += delta;
  if (Math.abs(sectionState.wheelAccumulator) >= threshold) {
    const direction = sectionState.wheelAccumulator > 0 ? 1 : -1;
    const overshoot = sectionState.wheelAccumulator - direction * threshold;
    const progressRaw = Math.abs(overshoot) / progressScale;
    const initialProgress = Math.min(1, progressRaw);
    const carry = Math.max(0, progressRaw - initialProgress);
    sectionState.wheelAccumulator = 0;
    startSectionTransition(normalizeSectionIndex(sectionState.index + direction), direction, { initialProgress });
    if (carry > 0) {
      sectionState.pendingScrollCarry = carry;
    }
  }
}

function bootstrapSections() {
  if (sectionCountEl) {
    sectionCountEl.textContent = formatSectionNumber(getSectionCount());
  }

  const initialSection = getSectionByIndex(0);
  if (!initialSection) {
    loadModel(DEFAULT_MODEL_PATH);
    updateFog();
    setTextOpacityTarget(1, { immediate: true });
    sectionState.phase = 'idle';
    sectionState.isReady = true;
    return;
  }

  sectionState.index = 0;
  sectionState.pendingIndex = 0;
  sectionState.phase = 'boot';
  sectionState.phaseElapsed = 0;
  sectionState.transitionElapsed = 0;
  sectionState.rotationStart = pointCloudGroup.rotation.y;
  sectionState.rotationTarget = sectionState.rotationStart;
  sectionState.scatterRest = initialSection.transition?.scatterIn ?? SECTION_TRANSITION.scatterIn ?? 0.04;
  currentSectionId = initialSection.id;
  setSectionTextContent(initialSection, 0);
  setBackgroundTextForSection(initialSection);
  setSectionCameraPose(initialSection, { immediate: true });
  setScatterTarget(sectionState.scatterRest);
  setScatterAmplitude(sectionState.scatterRest, { syncTarget: false });
  setTextOpacityTarget(0, { immediate: true });
  sectionState.cameraStartPose = getCurrentCameraPose();
  sectionState.cameraEndPose = { ...sectionState.cameraStartPose };

  loadModel(initialSection.modelPath, { resetPathProgress: true })
    .then(() => {
      applySectionOverrides(initialSection);
      setSectionCameraPose(initialSection, { immediate: true });
      sectionState.cameraStartPose = getCurrentCameraPose();
      sectionState.cameraEndPose = { ...sectionState.cameraStartPose };
      sectionState.phase = 'idle';
      sectionState.isReady = true;
      setTextOpacityTarget(1);
      setScatterTarget(sectionState.scatterRest);
      scrollTweenState.rotation = pointCloudGroup.rotation.y;
      scrollTweenState.scatter = sectionState.scatterRest;
      scrollTweenState.morph = 0;
      scrollTweenState.colorMix = 0;
      scrollTargetsCurrent.rotation = scrollTweenState.rotation;
      scrollTargetsCurrent.scatter = scrollTweenState.scatter;
      scrollTargetsCurrent.morph = scrollTweenState.morph;
      scrollTargetsCurrent.colorMix = scrollTweenState.colorMix;
      applyScrollTweenState();
    })
    .catch((err) => {
      console.error('[sections] failed to bootstrap initial section', err);
      sectionState.phase = 'idle';
      sectionState.isReady = true;
      setTextOpacityTarget(1);
      sectionState.cameraStartPose = getCurrentCameraPose();
      sectionState.cameraEndPose = { ...sectionState.cameraStartPose };
      scrollTweenState.rotation = pointCloudGroup.rotation.y;
      scrollTweenState.scatter = sectionState.scatterRest;
      scrollTweenState.morph = 0;
      scrollTweenState.colorMix = 0;
      scrollTargetsCurrent.rotation = scrollTweenState.rotation;
      scrollTargetsCurrent.scatter = scrollTweenState.scatter;
      scrollTargetsCurrent.morph = scrollTweenState.morph;
      scrollTargetsCurrent.colorMix = scrollTweenState.colorMix;
      applyScrollTweenState();
    })
    .finally(() => {
      updateFog();
    });
}

/* ---------------- Scene & Camera ---------------- */
const scene = new THREE.Scene();
scene.background = new THREE.Color(0);

// Scene hierarchy:
// scene
//   └── pointCloudGroup (handles main Y-axis spinning for transitions)
//       └── points (the actual point cloud with custom transforms applied directly)
const pointCloudGroup = new THREE.Group();
pointCloudGroup.name = 'PointCloudGroup';
scene.add(pointCloudGroup);

let points = null;       // point cloud (declared early for gradient helpers)

const HEX_PATTERN = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/;
// Approximation of the gradient used in Codrops' “Interactive Landscape” demo (index2).
let backgroundGradient = {
  top: '#4f6469',
  mid: '#162227',
  bottom: '#000000',
};
let gradientSky = null;
const BG_TEXT_OFFSET = 8.5;
const BG_TEXT_VIEWPORT_FRACTION = 0.78;
const BG_TEXT_CANVAS_WIDTH = 2048;
const BG_TEXT_CANVAS_HEIGHT = 1024;
const BG_TEXT_BASE_FONT_SIZE = 320;
const BG_TEXT_MIN_FONT_SIZE = 120;
const BG_TEXT_LINE_SPACING = 0.5;
const BG_TEXT_MAX_WIDTH_RATIO = 0.36;
const BG_TEXT_FONT_FAMILY = '"RadioGrotesk", sans-serif';
let bgTextLines = ['The Cost of', 'A Question'];
let backgroundTextMesh = null;
let bgTextCanvas = null;
let bgTextCtx = null;
let bgTextTexture = null;
let bgTextAspect = BG_TEXT_CANVAS_WIDTH / BG_TEXT_CANVAS_HEIGHT;
const _bgTempDir = new THREE.Vector3();

const GLOW_MODE_ENUM = {
  wave: 0.0,
  random: 1.0,
  rise: 2.0,
};

function encodeGlowMode(mode) {
  return GLOW_MODE_ENUM[mode] ?? GLOW_MODE_ENUM.wave;
}

function decodeGlowMode(value) {
  if (value >= 1.5) return 'rise';
  if (value >= 0.5) return 'random';
  return 'wave';
}

const gradientSkyMaterial = new THREE.ShaderMaterial({
  uniforms: {
    topColor:    { value: new THREE.Color(backgroundGradient.top) },
    midColor:    { value: new THREE.Color(backgroundGradient.mid) },
    bottomColor: { value: new THREE.Color(backgroundGradient.bottom) },
  },
  vertexShader: `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying vec3 vDir;
    uniform vec3 topColor;
    uniform vec3 midColor;
    uniform vec3 bottomColor;
    void main() {
      float t = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
      vec3 col = (t < 0.55)
        ? mix(bottomColor, midColor, smoothstep(0.0, 0.55, t))
        : mix(midColor, topColor, smoothstep(0.55, 1.0, t));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
  side: THREE.BackSide,
  depthWrite: false,
  depthTest: false,
  fog: false,
});

function ensureGradientSky() {
  if (gradientSky) return;
  const geometry = new THREE.SphereGeometry(500, 32, 32);
  gradientSky = new THREE.Mesh(geometry, gradientSkyMaterial);
  gradientSky.name = 'GradientSky';
  gradientSky.frustumCulled = false;
  gradientSky.renderOrder = -1;
  scene.add(gradientSky);
}

function updateGradientSkyColors() {
  scene.background.set(backgroundGradient.top);
  gradientSkyMaterial.uniforms.topColor.value.set(backgroundGradient.top);
  gradientSkyMaterial.uniforms.midColor.value.set(backgroundGradient.mid);
  gradientSkyMaterial.uniforms.bottomColor.value.set(backgroundGradient.bottom);
  updateFog();
}

function normalizeBackgroundInput(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = value.match(HEX_PATTERN);
    if (!match) return null;
    const normalized = `#${match[1].toLowerCase()}`;
    return { top: normalized, mid: normalized, bottom: normalized };
  }
  if (typeof value === 'object') {
    const top = typeof value.top === 'string' ? value.top : value.color || value.topColor;
    const mid = typeof value.mid === 'string' ? value.mid : value.middle || value.midColor;
    const bottom = typeof value.bottom === 'string' ? value.bottom : value.bottomColor;
    if (!top) return null;
    const topMatch = top.match(HEX_PATTERN);
    if (!topMatch) return null;
    const topHex = `#${topMatch[1].toLowerCase()}`;
    const midHex = mid && mid.match(HEX_PATTERN) ? `#${mid.match(HEX_PATTERN)[1].toLowerCase()}` : topHex;
    let bottomHex = topHex;
    if (bottom) {
      const bottomMatch = bottom.match(HEX_PATTERN);
      if (bottomMatch) bottomHex = `#${bottomMatch[1].toLowerCase()}`;
    }
    return { top: topHex, mid: midHex, bottom: bottomHex };
  }
  return null;
}

function updateBackgroundTextTexture() {
  if (!bgTextCtx || !bgTextTexture) return;

  const width = BG_TEXT_CANVAS_WIDTH;
  const height = BG_TEXT_CANVAS_HEIGHT;
  bgTextCtx.clearRect(0, 0, width, height);

  const lines = (bgTextLines || [])
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line.toUpperCase());
  if (!lines.length) {
    if (backgroundTextMesh) backgroundTextMesh.visible = false;
    bgTextTexture.needsUpdate = true;
    return;
  }

  if (backgroundTextMesh) backgroundTextMesh.visible = true;

  const composeFont = (sizePx) => `500 ${sizePx}px ${BG_TEXT_FONT_FAMILY}`;
  bgTextCtx.textAlign = 'center';
  bgTextCtx.textBaseline = 'middle';

  let fontSize = BG_TEXT_BASE_FONT_SIZE;
  bgTextCtx.font = composeFont(fontSize);
  const maxWidth = width * BG_TEXT_MAX_WIDTH_RATIO;
  let widest = 0;
  for (const line of lines) {
    const metrics = bgTextCtx.measureText(line);
    widest = Math.max(widest, metrics.width);
  }
  if (widest > maxWidth) {
    const scale = maxWidth / Math.max(widest, 1);
    fontSize = Math.max(BG_TEXT_MIN_FONT_SIZE, fontSize * scale);
    bgTextCtx.font = composeFont(fontSize);
  }

  const spacing = fontSize * (1 + BG_TEXT_LINE_SPACING);
  const totalHeight = spacing * (lines.length - 1);

  lines.forEach((line, index) => {
    const offset = (index - (lines.length - 1) / 2) * spacing;
    const y = height / 2 + offset;
    bgTextCtx.fillStyle = 'rgba(255, 255, 255, 0)';
    bgTextCtx.fillText(line, width / 2, y);
  });

  bgTextTexture.needsUpdate = true;
}

function buildBackgroundText() {
  if (backgroundTextMesh) {
    backgroundTextMesh.geometry?.dispose();
    backgroundTextMesh.material?.map?.dispose?.();
    backgroundTextMesh.material?.dispose?.();
    scene.remove(backgroundTextMesh);
    backgroundTextMesh = null;
  }

  bgTextCanvas = document.createElement('canvas');
  bgTextCanvas.width = BG_TEXT_CANVAS_WIDTH;
  bgTextCanvas.height = BG_TEXT_CANVAS_HEIGHT;
  bgTextCtx = bgTextCanvas.getContext('2d');
  if (!bgTextCtx) {
    console.warn('[background-text] 2D context unavailable');
    return;
  }

  bgTextTexture = new THREE.CanvasTexture(bgTextCanvas);
  bgTextTexture.colorSpace = THREE.SRGBColorSpace;
  if (renderer?.capabilities?.getMaxAnisotropy) {
    bgTextTexture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  }
  bgTextTexture.wrapS = THREE.ClampToEdgeWrapping;
  bgTextTexture.wrapT = THREE.ClampToEdgeWrapping;

  const material = new THREE.MeshBasicMaterial({
    map: bgTextTexture,
    transparent: true,
    depthWrite: false,
  });

  const geometry = new THREE.PlaneGeometry(1, 1);
  backgroundTextMesh = new THREE.Mesh(geometry, material);
  backgroundTextMesh.name = 'BackgroundText';
  backgroundTextMesh.frustumCulled = false;
  backgroundTextMesh.renderOrder = -5;
  bgTextAspect = BG_TEXT_CANVAS_WIDTH / BG_TEXT_CANVAS_HEIGHT;
  scene.add(backgroundTextMesh);

  const finalize = () => {
    updateBackgroundTextTexture();
    updateBackgroundTextScale();
    updateBackgroundTextPose();
  };

  finalize();
}

function updateBackgroundTextScale() {
  if (!backgroundTextMesh) return;
  const target = controls.target;
  const camDist = camera.position.distanceTo(target);
  const planeDist = camDist + BG_TEXT_OFFSET;
  const viewHeight = 2 * planeDist * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const targetWidth = viewHeight * camera.aspect * BG_TEXT_VIEWPORT_FRACTION;
  const targetHeight = targetWidth / bgTextAspect;
  backgroundTextMesh.scale.set(targetWidth, targetHeight, 1);
}

function updateBackgroundTextPose() {
  if (!backgroundTextMesh) return;
  const target = controls.target;
  _bgTempDir.subVectors(camera.position, target);
  if (_bgTempDir.lengthSq() < 1e-6) return;
  _bgTempDir.normalize().multiplyScalar(BG_TEXT_OFFSET);
  backgroundTextMesh.position.copy(target).sub(_bgTempDir);
  backgroundTextMesh.lookAt(camera.position);
}

function setBackgroundGradient({ top, mid, bottom }) {
  const topMatch = typeof top === 'string' ? top.match(HEX_PATTERN) : null;
  const midMatch = typeof mid === 'string' ? mid.match(HEX_PATTERN) : null;
  const bottomMatch = typeof bottom === 'string' ? bottom.match(HEX_PATTERN) : null;
  if (!topMatch) return;
  backgroundGradient.top = `#${topMatch[1].toLowerCase()}`;
  backgroundGradient.mid = midMatch ? `#${midMatch[1].toLowerCase()}` : backgroundGradient.top;
  backgroundGradient.bottom = bottomMatch ? `#${bottomMatch[1].toLowerCase()}` : backgroundGradient.mid;
  ensureGradientSky();
  updateGradientSkyColors();
  if (points?.material?.uniforms?.uFogColor) {
    points.material.uniforms.uFogColor.value.set(scene.background.r, scene.background.g, scene.background.b);
  }
}

ensureGradientSky();
updateGradientSkyColors();
let fogEnabled = false;
let fogDensity = 0.12; // thicker default
function updateFog() {
  // Use custom shader fog; do not use Three.js scene.fog to avoid uniform mismatch
  const u = points?.material?.uniforms;
  if (u) {
    u.uFogEnabled.value = fogEnabled ? 1.0 : 0.0;
    u.uFogDensity.value = fogDensity;
    const c = scene.background;
    if (c && u.uFogColor) u.uFogColor.value.set(c.r, c.g, c.b);
  }
}

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1e7);
camera.position.set(0, 0, 2);

/* ---------------- Controls ---------------- */
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.enableZoom = false;
controls.enableRotate = false;
controls.enablePan = false;

const SCROLL_PATH_SPEED = 0.00035;
const SCROLL_SCATTER_MAX = 1.0;
const SCROLL_SCATTER_DEADZONE = 0.28; // portion of the sine response we treat as "still together"
const CAMERA_PATH_HEIGHT_FACTOR = 0.45;
const TOUCH_PATH_SPEED = 0.00125; // sensitivity for vertical touch scrolling
const CAMERA_PATH_POINTS = [
  new THREE.Vector3(0.0, 0.18, 1.0),
  new THREE.Vector3(0.85, 0.3, 0.85),
  new THREE.Vector3(1.4, 0.42, 0.0),
  new THREE.Vector3(0.9, 0.26, -0.8),
  new THREE.Vector3(0.0, 0.4, -1.05),
  new THREE.Vector3(-0.9, 0.24, -0.85),
  new THREE.Vector3(-1.35, 0.16, 0.0),
  new THREE.Vector3(-0.8, 0.28, 0.85)
];
const CAMERA_PATH_DISTANCE_OVERRIDES = {
  'point/akl3.ply': 0.35,
  'point/akl3-blueorange.ply': 0.35,
  'point/akl3-bw.ply': 0.35,
  'point/akl3-purple.ply': 0.35,
  'point/akl3-orange.ply': 0.35,
  'point/nz2.ply': 1.25,
};
const MODEL_SCALE_OVERRIDES = {
  'point/nz2.ply': 0.42,
};
const MODEL_ROTATION_OVERRIDES = {
  'point/akl3.ply': -20,
  'point/akl3-blueorange.ply': -20,
  'point/akl3-bw.ply': -20,
  'point/akl3-purple.ply': -20,
  'point/akl3-orange.ply': -20,
  'point/nz2.ply': -20,
};
const MODEL_TARGET_OFFSETS = {
  'point/akl3.ply': new THREE.Vector3(0.22, -0.125, 0.0),
  'point/akl3-blueorange.ply': new THREE.Vector3(0.22, -0.125, 0.0),
  'point/akl3-bw.ply': new THREE.Vector3(0.22, -0.025, 0.0),
  'point/akl3-purple.ply': new THREE.Vector3(0.22, -0.125, 0.0),
  'point/akl3-orange.ply': new THREE.Vector3(0.22, -0.125, 0.0),
};

const DEFAULT_MODEL_SETTINGS = {
  bc: {
    enabled: true,
    contrast: 0.59,
    brightness: 0.31,
  },
  windAmp: 0.02,
  fog: {
    enabled: false,
    density: 0.0,
  },
  background: {
    top: '#4f6469',
    mid: '#162227',
    bottom: '#000000',
  },
  lut: {
    key: 'none',
    intensity: 1.0,
  },
  fxaa: false,
  highlightColor: '#b9e456',
};

const AKL3_BASE_SETTINGS = {
  bc: {
    enabled: true,
    contrast: 0.59,
    brightness: 0.31,
  },
  windAmp: 0.005,
  pointSizePx: 1.0,
  fog: {
    enabled: true,
    density: 0.4,
  },
  background: {
    top: '#4f6469',
    mid: '#162227',
    bottom: '#000000',
  },
  lut: {
    key: 'none',
    intensity: 1.0,
  },
  fxaa: true,
  highlightColor: '#b9e456',
};

function createAkl3Settings(overrides = {}) {
  const result = {
    ...AKL3_BASE_SETTINGS,
    bc: { ...AKL3_BASE_SETTINGS.bc },
    fog: { ...AKL3_BASE_SETTINGS.fog },
    lut: { ...AKL3_BASE_SETTINGS.lut },
    background: typeof AKL3_BASE_SETTINGS.background === 'object'
      ? { ...AKL3_BASE_SETTINGS.background }
      : AKL3_BASE_SETTINGS.background,
    ...overrides,
  };
  if (overrides.background && typeof overrides.background === 'object') {
    result.background = { ...overrides.background };
  }
  return result;
}

const MODEL_SETTINGS = {
  'point/akl3.ply': createAkl3Settings(),
  'point/akl3-blueorange.ply': createAkl3Settings({
    highlightColor: '#ffae42',
    background: { top: '#4f6469', mid: '#162227', bottom: '#000000' },
  }),
  'point/akl3-bw.ply': createAkl3Settings({
    background: { top: '#4f6469', mid: '#162227', bottom: '#000000' },
    highlightColor: '#b9e456'
  }),
  'point/akl3-purple.ply': createAkl3Settings({
    background: { top: '#4f6469', mid: '#162227', bottom: '#000000' },
    highlightColor: '#b573ff'
  }),
  'point/akl3-orange.ply': createAkl3Settings({
    background: { top: '#4f6469', mid: '#162227', bottom: '#000000' },
    highlightColor: '#ff7b1c'
  }),
};

const cameraPath = new THREE.CatmullRomCurve3(CAMERA_PATH_POINTS.map((p) => p.clone()), false, 'catmullrom', 0.65);
let cameraPathScale = camera.position.length() || 1;
let cameraPathT = 0;
let cameraPathTarget = 0;
const CAMERA_PATH_LERP_SPEED = 1.6;
const cameraPathPos = new THREE.Vector3();
let cameraYawOffsetDeg = -20;
let cameraPitchOffsetDeg = -10;

function positionCameraOnPath() {
  const t = THREE.MathUtils.clamp(cameraPathT, 0, 1);
  cameraPath.getPoint(t, cameraPathPos);
  const target = controls.target;
  const scale = cameraPathScale;

  const base = new THREE.Vector3(
    cameraPathPos.x,
    cameraPathPos.y * CAMERA_PATH_HEIGHT_FACTOR,
    cameraPathPos.z
  );

  const yawRad = THREE.MathUtils.degToRad(cameraYawOffsetDeg);
  const cosYaw = Math.cos(yawRad);
  const sinYaw = Math.sin(yawRad);
  const rotated = new THREE.Vector3(
    base.x * cosYaw - base.z * sinYaw,
    base.y,
    base.x * sinYaw + base.z * cosYaw
  );

  const pitchRad = THREE.MathUtils.degToRad(cameraPitchOffsetDeg);
  if (Math.abs(cameraPitchOffsetDeg) > 1e-5) {
    const up = new THREE.Vector3(0, 1, 0);
    const axis = new THREE.Vector3().copy(up).cross(rotated);
    if (axis.lengthSq() > 1e-6) {
      rotated.applyAxisAngle(axis.normalize(), -pitchRad);
    }
  }

  camera.position.set(
    target.x + rotated.x * scale,
    target.y + rotated.y * scale,
    target.z + rotated.z * scale
  );
  camera.lookAt(target);
  updateBackgroundTextScale();
  updateBackgroundTextPose();
}

function nudgeCameraAlongPath(deltaT) {
  if (!Number.isFinite(deltaT) || deltaT === 0) return;
  const prevT = cameraPathT;
  cameraPathT = THREE.MathUtils.clamp(cameraPathT + deltaT, 0, 1);
  if (Math.abs(cameraPathT - prevT) < 1e-6) return;
  positionCameraOnPath();
  updateScatterFromPath();
  controls.update();
}

function getCurrentCameraPose() {
  return {
    pathT: cameraPathTarget,
    yaw: cameraYawOffsetDeg,
    pitch: cameraPitchOffsetDeg,
  };
}

function updateCameraPose(progress, { immediate = false } = {}) {
  const start = sectionState.cameraStartPose || getCurrentCameraPose();
  const end = sectionState.cameraEndPose || start;
  const t = THREE.MathUtils.clamp(Number(progress) || 0, 0, 1);
  const newPathT = THREE.MathUtils.lerp(start.pathT, end.pathT, t);
  const newYaw = THREE.MathUtils.lerp(start.yaw, end.yaw, t);
  const newPitch = THREE.MathUtils.lerp(start.pitch, end.pitch, t);
  cameraPathTarget = THREE.MathUtils.clamp(newPathT, 0, 1);
  cameraPathT = cameraPathTarget;
  cameraYawOffsetDeg = newYaw;
  cameraPitchOffsetDeg = newPitch;
  positionCameraOnPath();
  controls.update();
}

function setScatterTarget(value) {
  scatterGoal = THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
}

function setScatterAmplitude(value, { syncTarget = true } = {}) {
  const clamped = Math.max(0, Math.min(1, value));
  scatterAmp = clamped;
  if (syncTarget) {
    scatterGoal = clamped;
  }
  const u = points?.material?.uniforms;
  if (u?.uScatterAmp) u.uScatterAmp.value = scatterAmp;
  const slider = document.getElementById('ui-scatter');
  if (slider) slider.value = scatterAmp.toFixed(3);
  const label = document.getElementById('ui-scatter-val');
  if (label) label.textContent = scatterAmp.toFixed(3);
}

function setMorphProgress(value) {
  const clamped = THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
  morphProgress = clamped;
}

// Helper function to calculate pixels-per-unit and update world size uniforms
function calculatePixelsPerUnit() {
  return innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
}

function updateWorldSizeUniforms(sizePx = null) {
  if (!points?.material?.uniforms) return;
  const uniforms = points.material.uniforms;
  
  if (sizePx === null) sizePx = pointSizePx;
  
  const pxPerUnit = calculatePixelsPerUnit();
  uniforms.uPxPerUnit.value = pxPerUnit;
  
  if (uniforms?.uUseWorldSize && uniforms.uUseWorldSize.value > 0.5) {
    const refDist = uniforms.uSizeAttenRef?.value || camera.position.distanceTo(controls.target);
    uniforms.uWorldSize.value = Math.max(1e-5, sizePx * refDist / pxPerUnit);
  }
}

function setPointSizePxValue(value, { rebuild = true, updateUI = true } = {}) {
  const parsed = Number(value);
  const clamped = Math.max(0.5, Math.min(12, Number.isFinite(parsed) ? parsed : pointSizePx));
  pointSizePx = clamped;

  if (updateUI) {
    const slider = document.getElementById('ui-psize');
    if (slider) slider.value = String(clamped);
    const label = document.getElementById('ui-psize-val');
    if (label) label.textContent = clamped.toFixed(2);
  }

  if (rebuild && originalGeom) {
    buildPoints();
  } else {
    const uniforms = points?.material?.uniforms;
    if (uniforms?.uBaseSize) uniforms.uBaseSize.value = clamped;
  }

  updateWorldSizeUniforms(clamped);
}

function setHighlightColor(hex, { updateUI = true } = {}) {
  if (typeof hex !== 'string') return;
  const trimmed = hex.trim();
  const match = trimmed.match(/^#?([0-9a-fA-F]{6})$/);
  if (!match) return;
  const normalized = `#${match[1].toLowerCase()}`;
  highlightColorHex = normalized;

  const uniforms = points?.material?.uniforms;
  if (uniforms?.uHighlightColor?.value) {
    uniforms.uHighlightColor.value.set(normalized);
  }

  if (!updateUI) return;
  const input = document.getElementById('ui-highlight-color');
  if (input) input.value = normalized;
  const label = document.getElementById('ui-highlight-color-val');
  if (label) label.textContent = normalized.toUpperCase();
}

function setCameraYawOffset(degrees, { updateUI = true, reposition = true } = {}) {
  const parsed = Number(degrees);
  const clamped = Number.isFinite(parsed) ? THREE.MathUtils.clamp(parsed, -360, 360) : cameraYawOffsetDeg;
  cameraYawOffsetDeg = clamped;

  if (updateUI) {
    const slider = document.getElementById('ui-camera-angle');
    if (slider) slider.value = String(clamped);
    const label = document.getElementById('ui-camera-angle-val');
    if (label) label.textContent = `${clamped.toFixed(0)}°`;
  }

  if (reposition) {
    positionCameraOnPath();
    controls.update();
  }
}

function setCameraPitchOffset(degrees, { updateUI = true, reposition = true } = {}) {
  const parsed = Number(degrees);
  const clamped = Number.isFinite(parsed) ? THREE.MathUtils.clamp(parsed, -60, 60) : cameraPitchOffsetDeg;
  cameraPitchOffsetDeg = clamped;

  if (updateUI) {
    const slider = document.getElementById('ui-camera-tilt');
    if (slider) slider.value = String(clamped);
    const label = document.getElementById('ui-camera-tilt-val');
    if (label) label.textContent = `${clamped.toFixed(0)}°`;
  }

  if (reposition) {
    positionCameraOnPath();
    controls.update();
  }
}

function updateScatterFromPath() {
  const phase = (cameraPathT % 1 + 1) % 1;
  const base = Math.max(0, Math.sin(phase * Math.PI));
  if (base <= SCROLL_SCATTER_DEADZONE) {
    setScatterAmplitude(0);
    return;
  }

  const normalized = (base - SCROLL_SCATTER_DEADZONE) / (1 - SCROLL_SCATTER_DEADZONE);
  const eased = Math.pow(THREE.MathUtils.clamp(normalized, 0, 1), 1.8);
  const scatterValue = eased * SCROLL_SCATTER_MAX;
  setScatterAmplitude(scatterValue);
}

function applyModelSettings(path) {
  const settings = MODEL_SETTINGS[path] || DEFAULT_MODEL_SETTINGS;
  const bc = settings.bc || DEFAULT_MODEL_SETTINGS.bc;
  const contrastValue = THREE.MathUtils.clamp(bc.contrast ?? 0, -1, 1);
  const brightnessValue = THREE.MathUtils.clamp(bc.brightness ?? 0, -1, 1);
  if (bcPass) {
    bcPass.enabled = !!bc.enabled;
    if (bcPass.material?.uniforms?.contrast) {
      bcPass.material.uniforms.contrast.value = contrastValue;
    }
    if (bcPass.material?.uniforms?.brightness) {
      bcPass.material.uniforms.brightness.value = brightnessValue;
    }
  }

  const windAmpValue = settings.windAmp ?? DEFAULT_MODEL_SETTINGS.windAmp;
  currentWindAmp = windAmpValue;
  const u = points?.material?.uniforms;
  if (u?.uWindAmp) {
    u.uWindAmp.value = windAmpValue;
  }

  const contrastInput = document.getElementById('ui-contrast');
  if (contrastInput) contrastInput.value = contrastValue.toFixed(2);
  const contrastLabel = document.getElementById('ui-contrast-val');
  if (contrastLabel) contrastLabel.textContent = contrastValue.toFixed(2);

  const brightInput = document.getElementById('ui-bright');
  if (brightInput) brightInput.value = brightnessValue.toFixed(2);
  const brightLabel = document.getElementById('ui-bright-val');
  if (brightLabel) brightLabel.textContent = brightnessValue.toFixed(2);

  const bcToggle = document.getElementById('ui-bc');
  if (bcToggle) bcToggle.checked = !!bc.enabled;

  if (settings.fog) {
    fogEnabled = !!settings.fog.enabled;
    fogDensity = THREE.MathUtils.clamp(settings.fog.density ?? fogDensity, 0, 2);
    updateFog();
    const fogToggle = document.getElementById('ui-fog');
    if (fogToggle) fogToggle.checked = fogEnabled;
    const fogDensityInput = document.getElementById('ui-fog-density');
    if (fogDensityInput) fogDensityInput.value = fogDensity.toFixed(3);
    const fogDensityLabel = document.getElementById('ui-fog-density-val');
    if (fogDensityLabel) fogDensityLabel.textContent = fogDensity.toFixed(3);
  }

  if (settings.background) {
    const normalized = normalizeBackgroundInput(settings.background);
    if (normalized) {
      setBackgroundGradient(normalized);
      const bgInput = document.getElementById('ui-bg');
      if (bgInput) bgInput.value = normalized.top;
      const bgLabel = document.getElementById('ui-bg-val');
      if (bgLabel) bgLabel.textContent = normalized.top.toUpperCase();
      const bgMidInput = document.getElementById('ui-bg-mid');
      if (bgMidInput) bgMidInput.value = normalized.mid;
      const bgMidLabel = document.getElementById('ui-bg-mid-val');
      if (bgMidLabel) bgMidLabel.textContent = normalized.mid.toUpperCase();
      const bgBottomInput = document.getElementById('ui-bg-bottom');
      if (bgBottomInput) bgBottomInput.value = normalized.bottom;
      const bgBottomLabel = document.getElementById('ui-bg-bottom-val');
      if (bgBottomLabel) bgBottomLabel.textContent = normalized.bottom.toUpperCase();
    } else {
      console.warn('Failed to normalize background color for section', section?.id, settings.background);
    }
  }

  const highlightFromSettings = typeof settings.highlightColor === 'string'
    ? settings.highlightColor
    : DEFAULT_MODEL_SETTINGS.highlightColor;
  if (typeof highlightFromSettings === 'string') {
    setHighlightColor(highlightFromSettings);
  }

  if (settings.lut) {
    setLutPreset(settings.lut.key ?? 'none');
    lutIntensity = THREE.MathUtils.clamp(settings.lut.intensity ?? lutIntensity, 0, 1);
    updateLutPass();
    const lutSelect = document.getElementById('ui-lut');
    if (lutSelect) lutSelect.value = settings.lut.key ?? 'none';
    const lutIntensityInput = document.getElementById('ui-lut-intensity');
    if (lutIntensityInput) lutIntensityInput.value = lutIntensity.toFixed(2);
    const lutIntensityLabel = document.getElementById('ui-lut-intensity-val');
    if (lutIntensityLabel) lutIntensityLabel.textContent = lutIntensity.toFixed(2);
  }

  if (typeof settings.fxaa === 'boolean' && fxaaPass) {
    fxaaPass.enabled = settings.fxaa;
    const fxaaToggle = document.getElementById('ui-fxaa');
    if (fxaaToggle) fxaaToggle.checked = settings.fxaa;
  }

  const windAmpInput = document.getElementById('ui-wind-amp');
  if (windAmpInput) windAmpInput.value = windAmpValue.toFixed(3);
  const windAmpLabel = document.getElementById('ui-wind-amp-val');
  if (windAmpLabel) windAmpLabel.textContent = windAmpValue.toFixed(3);

  if (typeof settings.pointSizePx === 'number') {
    setPointSizePxValue(settings.pointSizePx);
  }
}

positionCameraOnPath();

addEventListener('wheel', (event) => {
  if (event.defaultPrevented) return;
  if (event.ctrlKey) return;
  const delta = event.deltaY;
  if (delta === 0) return;
  event.preventDefault();
  applyScrollDelta(delta, { isTouch: false });
}, { passive: false });

function handleTouchStart(event) {
  if (event.touches.length !== 1) return;
  touchScrollActive = true;
  touchLastY = event.touches[0].clientY;
  sectionState.wheelAccumulator = 0;
}

function handleTouchMove(event) {
  if (!touchScrollActive || event.touches.length !== 1) return;
  event.preventDefault();
  const currentY = event.touches[0].clientY;
  const deltaY = touchLastY - currentY;
  touchLastY = currentY;
  applyScrollDelta(deltaY, { isTouch: true });
}

function handleTouchEnd() {
  touchScrollActive = false;
  sectionState.wheelAccumulator = 0;
}

renderer.domElement.addEventListener('touchstart', handleTouchStart, { passive: true });
renderer.domElement.addEventListener('touchmove', handleTouchMove, { passive: false });
renderer.domElement.addEventListener('touchend', handleTouchEnd, { passive: true });
renderer.domElement.addEventListener('touchcancel', handleTouchEnd, { passive: true });

/* ---------------- Helpers (optional) ---------------- */
scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const grid = new THREE.GridHelper(10, 10);
grid.material.transparent = true;
grid.material.opacity = 0.12;
scene.add(grid);
grid.visible = false;

buildBackgroundText();

// initialize composer after scene/camera exist
initPost();

/* ---------------- UI Panel ---------------- */
function setupUI() {
  const $ = (id) => document.getElementById(id);
  const panel = $('ui-panel');
  const toggleBtn = $('ui-toggle');
  if (!panel || !toggleBtn) return;

  const setVal = (id, v, fmt) => { const el = $(id); if (el) el.textContent = fmt ? fmt(v) : String(v); };
  const getU = () => points?.material?.uniforms;
  const updateGlowUIState = () => {
    if (el.randomSpeed) el.randomSpeed.disabled = glowMode !== 'random';
  };

  // Prevent UI interactions from moving the camera
  ['wheel','pointerdown','touchstart','touchmove','keydown'].forEach(ev => {
    panel.addEventListener(ev, (e) => e.stopPropagation());
  });

  const updateToggleLabel = () => {
    const open = !panel.classList.contains('hidden');
    toggleBtn.textContent = open ? 'Close Controls' : 'Open Controls';
    toggleBtn.setAttribute('aria-expanded', String(open));
  };
  toggleBtn.addEventListener('click', () => {
    panel.classList.toggle('hidden');
    updateToggleLabel();
  });
  // Ensure initial label matches initial state
  updateToggleLabel();

  // Grab elements
  const el = {
    modelBtn: $('ui-model-btn'),
    density: $('ui-density'), psize: $('ui-psize'), cameraAngle: $('ui-camera-angle'), cameraTilt: $('ui-camera-tilt'), worldsize: $('ui-worldsize'), atten: $('ui-atten'), grid: $('ui-grid'),
    scatter: $('ui-scatter'), square: $('ui-square'), highlightColor: $('ui-highlight-color'),
    glowMode: $('ui-glow-mode'),
    randomSpeed: $('ui-random-speed'),
    windEnabled: $('ui-wind-enabled'), windAmp: $('ui-wind-amp'), windFreq: $('ui-wind-freq'), windSpatial: $('ui-wind-spatial'),
    waveLength: $('ui-wave-length'), waveSpeed: $('ui-wave-speed'), waveWidth: $('ui-wave-width'), waveGamma: $('ui-wave-gamma'),
    edgeBlur: $('ui-edgeblur'), edgeBlurAmt: $('ui-edgeblur-amt'),
    fog: $('ui-fog'), fogDensity: $('ui-fog-density'),
    bg: $('ui-bg'),
    bgMid: $('ui-bg-mid'),
    bgBottom: $('ui-bg-bottom'),
    bloom: $('ui-bloom'), bloomStrength: $('ui-bloom-strength'), vignette: $('ui-vignette'), vignetteDark: $('ui-vignette-dark'),
    bc: $('ui-bc'), contrast: $('ui-contrast'), bright: $('ui-bright'), hs: $('ui-hs'), sat: $('ui-sat'), hue: $('ui-hue'),
    lut: $('ui-lut'), lutIntensity: $('ui-lut-intensity'),
    fxaa: $('ui-fxaa'),
  };
  if (el.modelBtn) {
    el.modelBtn.disabled = true;
    el.modelBtn.title = 'Model swapping disabled';
  }

  // Helpers
  function refreshUI() {
    // Points
    if (el.modelBtn) {
      try {
        const name = (currentModelPath || '').split('/').pop() || 'model';
        el.modelBtn.textContent = name;
      } catch {}
    }
    if (el.density) { el.density.value = String(keepRatio); setVal('ui-density-val', Number(keepRatio).toFixed(2)); }
    if (el.psize)   { el.psize.value = String(pointSizePx); setVal('ui-psize-val', Number(pointSizePx).toFixed(2)); }
    if (el.cameraAngle) {
      el.cameraAngle.value = String(cameraYawOffsetDeg);
      setVal('ui-camera-angle-val', `${cameraYawOffsetDeg.toFixed(0)}°`);
    }
    if (el.cameraTilt) {
      el.cameraTilt.value = String(cameraPitchOffsetDeg);
      setVal('ui-camera-tilt-val', `${cameraPitchOffsetDeg.toFixed(0)}°`);
    }
    if (el.grid)    { el.grid.checked = !!grid.visible; }
    if (el.highlightColor) {
      el.highlightColor.value = highlightColorHex;
      setVal('ui-highlight-color-val', highlightColorHex.toUpperCase());
    }

    const u = getU();
    if (u) {
      if (el.worldsize) el.worldsize.checked = u.uUseWorldSize.value > 0.5;
      if (el.atten)     el.atten.checked     = u.uSizeAttenEnabled.value > 0.5;
      if (el.scatter) {
        const scatterValue = u.uScatterAmp?.value ?? scatterAmp;
        setScatterAmplitude(scatterValue);
      }
      if (el.square) {
        if (u.uSquareMix) squareMix = u.uSquareMix.value ?? squareMix;
        el.square.value = String(squareMix);
        setVal('ui-square-val', (squareMix * 100).toFixed(0) + '%');
      }
      if (el.glowMode) {
        const rawMode = u.uGlowMode?.value;
        if (typeof rawMode === 'number' && Number.isFinite(rawMode)) {
          glowMode = decodeGlowMode(rawMode);
        }
        el.glowMode.value = glowMode;
      }
      if (el.randomSpeed && u.uRandomGlowSpeed) {
        const v = u.uRandomGlowSpeed.value ?? randomGlowSpeed;
        randomGlowSpeed = v;
        el.randomSpeed.value = String(v);
        setVal('ui-random-speed-val', v.toFixed(1));
      }
      // no base color controls in UI
      if (el.windEnabled) el.windEnabled.checked = u.uWindEnabled.value > 0.5;
      if (el.windAmp)   { el.windAmp.value   = String(u.uWindAmp.value);   setVal('ui-wind-amp-val', u.uWindAmp.value.toFixed(3)); }
      if (el.windFreq)  { el.windFreq.value  = String(u.uWindFreq.value);  setVal('ui-wind-freq-val', u.uWindFreq.value.toFixed(2)); }
      if (el.windSpatial){ el.windSpatial.value= String(u.uWindSpatial.value); setVal('ui-wind-spatial-val', u.uWindSpatial.value.toFixed(2)); }

      if (el.waveLength){ el.waveLength.value= String(u.uWaveLength.value); setVal('ui-wave-length-val', u.uWaveLength.value.toFixed(2)); }
      if (el.waveSpeed) { el.waveSpeed.value = String(u.uWaveSpeed.value);  setVal('ui-wave-speed-val', u.uWaveSpeed.value.toFixed(2)); }
      if (el.waveWidth) { el.waveWidth.value = String(u.uWaveWidth.value);  setVal('ui-wave-width-val', u.uWaveWidth.value.toFixed(2)); }
      if (el.waveGamma) { el.waveGamma.value = String(u.uBandGamma.value);  setVal('ui-wave-gamma-val', u.uBandGamma.value.toFixed(2)); }
    }
    else {
      if (el.scatter) setScatterAmplitude(scatterAmp);
      if (el.square) { el.square.value = String(squareMix); setVal('ui-square-val', (squareMix * 100).toFixed(0) + '%'); }
      if (el.glowMode) {
        el.glowMode.value = glowMode;
      }
      if (el.randomSpeed) {
        el.randomSpeed.value = String(randomGlowSpeed);
        setVal('ui-random-speed-val', randomGlowSpeed.toFixed(1));
      }
    }

    updateGlowUIState();

    // Fog
    if (el.fog) el.fog.checked = fogEnabled;
   if (el.fogDensity) { el.fogDensity.value = String(fogDensity); setVal('ui-fog-density-val', fogDensity.toFixed(3)); }
    if (el.bg) {
      el.bg.value = backgroundGradient.top;
      setVal('ui-bg-val', backgroundGradient.top.toUpperCase());
    }
    if (el.bgMid) {
      el.bgMid.value = backgroundGradient.mid;
      setVal('ui-bg-mid-val', backgroundGradient.mid.toUpperCase());
    }
    if (el.bgBottom) {
      el.bgBottom.value = backgroundGradient.bottom;
      setVal('ui-bg-bottom-val', backgroundGradient.bottom.toUpperCase());
    }

    // Post FX
   if (el.edgeBlur) { el.edgeBlur.checked = !!edgeBlurPass?.enabled; }
    if (el.edgeBlurAmt) {
      const v = edgeBlurPass?.material?.uniforms?.maxRadius?.value ?? 8.0;
      el.edgeBlurAmt.value = String(v);
      setVal('ui-edgeblur-amt-val', Number(v).toFixed(1));
    }
    if (el.bloom) { el.bloom.checked = !!bloomPass?.enabled; }
    if (el.bloomStrength) { const v = bloomPass?.strength ?? 0.6; el.bloomStrength.value = String(v); setVal('ui-bloom-strength-val', v.toFixed(2)); }
    if (el.vignette) { el.vignette.checked = !!vignettePass?.enabled; }
    if (el.vignetteDark) { const v = vignettePass?.material?.uniforms?.darkness?.value ?? 0.6; el.vignetteDark.value = String(v); setVal('ui-vignette-dark-val', v.toFixed(2)); }
    if (el.bc) { el.bc.checked = !!bcPass?.enabled; }
    if (el.contrast) { const v = bcPass?.material?.uniforms?.contrast?.value ?? 0.0; el.contrast.value = String(v); setVal('ui-contrast-val', v.toFixed(2)); }
    if (el.bright) { const v = bcPass?.material?.uniforms?.brightness?.value ?? 0.0; el.bright.value = String(v); setVal('ui-bright-val', v.toFixed(2)); }
    if (el.hs) { el.hs.checked = !!hsPass?.enabled; }
    if (el.sat) { const v = hsPass?.material?.uniforms?.saturation?.value ?? 0.0; el.sat.value = String(v); setVal('ui-sat-val', v.toFixed(2)); }
    if (el.hue) { const v = hsPass?.material?.uniforms?.hue?.value ?? 0.0; el.hue.value = String(v); setVal('ui-hue-val', v.toFixed(2)); }
    if (el.lut) { el.lut.value = activeLutKey; }
    if (el.lutIntensity) {
      el.lutIntensity.value = String(lutIntensity);
      el.lutIntensity.disabled = activeLutKey === 'none';
      setVal('ui-lut-intensity-val', lutIntensity.toFixed(2));
    }
    if (el.fxaa) { el.fxaa.checked = !!fxaaPass?.enabled; }
  }

  // Allow external triggers to refresh the panel
  window.addEventListener('ui-refresh', refreshUI);

  // Wiring events
  el.density?.addEventListener('input', () => {
    keepRatio = Math.max(0.02, Math.min(1, Number(el.density.value)));
    setVal('ui-density-val', keepRatio.toFixed(2));
    buildPoints();
  });
  el.psize?.addEventListener('input', () => {
    setPointSizePxValue(el.psize.value);
    setVal('ui-psize-val', pointSizePx.toFixed(2));
  });
  el.cameraAngle?.addEventListener('input', () => {
    const value = Number(el.cameraAngle.value);
    setCameraYawOffset(value, { updateUI: false });
    setVal('ui-camera-angle-val', `${cameraYawOffsetDeg.toFixed(0)}°`);
  });
  el.cameraTilt?.addEventListener('input', () => {
    const value = Number(el.cameraTilt.value);
    setCameraPitchOffset(value, { updateUI: false });
    setVal('ui-camera-tilt-val', `${cameraPitchOffsetDeg.toFixed(0)}°`);
  });

  el.worldsize?.addEventListener('change', () => {
    const u = getU(); if (!u) return;
    u.uUseWorldSize.value = el.worldsize.checked ? 1.0 : 0.0;
    if (u.uUseWorldSize.value > 0.5) {
      updateWorldSizeUniforms();
    }
  });
  el.atten?.addEventListener('change', () => {
    const u = getU(); if (!u) return; u.uSizeAttenEnabled.value = el.atten.checked ? 1.0 : 0.0;
  });
  el.grid?.addEventListener('change', () => { grid.visible = !!el.grid.checked; });

  // Scatter
  el.scatter?.addEventListener('input', () => {
    const value = Math.max(0, Math.min(1, Number(el.scatter.value)));
    setScatterAmplitude(value);
  });

  el.square?.addEventListener('input', () => {
    squareMix = Math.max(0, Math.min(1, Number(el.square.value)));
    setVal('ui-square-val', (squareMix * 100).toFixed(0) + '%');
    const u = getU(); if (u?.uSquareMix) u.uSquareMix.value = squareMix;
  });

  el.highlightColor?.addEventListener('input', () => {
    setHighlightColor(el.highlightColor.value);
  });

  el.glowMode?.addEventListener('change', () => {
    const selected = el.glowMode.value;
    glowMode = selected === 'random' ? 'random' : (selected === 'rise' ? 'rise' : 'wave');
    const u = getU();
    if (u?.uGlowMode) u.uGlowMode.value = encodeGlowMode(glowMode);
    if (el.randomSpeed) {
      el.randomSpeed.value = String(randomGlowSpeed);
      setVal('ui-random-speed-val', randomGlowSpeed.toFixed(1));
    }
    updateGlowUIState();
  });

  el.randomSpeed?.addEventListener('input', () => {
    randomGlowSpeed = Math.max(0.1, Math.min(5, Number(el.randomSpeed.value)));
    setVal('ui-random-speed-val', randomGlowSpeed.toFixed(1));
    const u = getU();
    if (u?.uRandomGlowSpeed) u.uRandomGlowSpeed.value = randomGlowSpeed;
  });

  // removed RGB/vertex color handlers

  // Wind
  el.windEnabled?.addEventListener('change', () => { const u = getU(); if (!u) return; u.uWindEnabled.value = el.windEnabled.checked ? 1.0 : 0.0; });
  el.windAmp?.addEventListener('input', () => {
    const u = getU(); if (!u) return;
    const val = Number(el.windAmp.value);
    currentWindAmp = val;
    u.uWindAmp.value = val;
    setVal('ui-wind-amp-val', u.uWindAmp.value.toFixed(3));
  });
  el.windFreq?.addEventListener('input', () => { const u = getU(); if (!u) return; u.uWindFreq.value = Number(el.windFreq.value); setVal('ui-wind-freq-val', u.uWindFreq.value.toFixed(2)); });
  el.windSpatial?.addEventListener('input', () => { const u = getU(); if (!u) return; u.uWindSpatial.value = Number(el.windSpatial.value); setVal('ui-wind-spatial-val', u.uWindSpatial.value.toFixed(2)); });

  // Wave
  el.waveLength?.addEventListener('input', () => { const u = getU(); if (!u) return; u.uWaveLength.value = Number(el.waveLength.value); setVal('ui-wave-length-val', u.uWaveLength.value.toFixed(2)); });
  el.waveSpeed?.addEventListener('input', () => { const u = getU(); if (!u) return; u.uWaveSpeed.value = Number(el.waveSpeed.value); setVal('ui-wave-speed-val', u.uWaveSpeed.value.toFixed(2)); });
  el.waveWidth?.addEventListener('input', () => { const u = getU(); if (!u) return; u.uWaveWidth.value = Number(el.waveWidth.value); setVal('ui-wave-width-val', u.uWaveWidth.value.toFixed(2)); });
  el.waveGamma?.addEventListener('input', () => { const u = getU(); if (!u) return; u.uBandGamma.value = Number(el.waveGamma.value); setVal('ui-wave-gamma-val', u.uBandGamma.value.toFixed(2)); });

  // Fog
  el.fog?.addEventListener('change', () => { fogEnabled = !!el.fog.checked; updateFog(); });
  el.fogDensity?.addEventListener('input', () => {
    fogDensity = Math.max(0, Math.min(2.0, Number(el.fogDensity.value)));
    updateFog();
    setVal('ui-fog-density-val', fogDensity.toFixed(3));
  });
  el.bg?.addEventListener('input', () => {
    try {
      const hex = el.bg.value || '#000000';
      const match = hex.match(HEX_PATTERN);
      if (!match) throw new Error('invalid hex');
      setBackgroundGradient({
        top: `#${match[1].toLowerCase()}`,
        mid: backgroundGradient.mid,
        bottom: backgroundGradient.bottom
      });
      setVal('ui-bg-val', backgroundGradient.top.toUpperCase());
    } catch (e) {
      console.warn('Invalid color:', e);
    }
  });
  el.bgMid?.addEventListener('input', () => {
    try {
      const hex = el.bgMid.value || '#000000';
      const match = hex.match(HEX_PATTERN);
      if (!match) throw new Error('invalid hex');
      setBackgroundGradient({
        top: backgroundGradient.top,
        mid: `#${match[1].toLowerCase()}`,
        bottom: backgroundGradient.bottom
      });
      setVal('ui-bg-mid-val', backgroundGradient.mid.toUpperCase());
    } catch (e) {
      console.warn('Invalid middle color:', e);
    }
  });
  el.bgBottom?.addEventListener('input', () => {
    try {
      const hex = el.bgBottom.value || '#000000';
      const match = hex.match(HEX_PATTERN);
      if (!match) throw new Error('invalid hex');
      setBackgroundGradient({
        top: backgroundGradient.top,
        mid: backgroundGradient.mid,
        bottom: `#${match[1].toLowerCase()}`
      });
      setVal('ui-bg-bottom-val', backgroundGradient.bottom.toUpperCase());
    } catch (e) {
      console.warn('Invalid bottom color:', e);
    }
  });

  // Post FX
  el.edgeBlur?.addEventListener('change', () => { if (edgeBlurPass) edgeBlurPass.enabled = el.edgeBlur.checked; });
  el.edgeBlurAmt?.addEventListener('input', () => {
    if (!edgeBlurPass) return; const v = Number(el.edgeBlurAmt.value);
    if (edgeBlurPass.material?.uniforms?.maxRadius) edgeBlurPass.material.uniforms.maxRadius.value = v;
    setVal('ui-edgeblur-amt-val', v.toFixed(1));
  });
  el.bloom?.addEventListener('change', () => { if (bloomPass) bloomPass.enabled = el.bloom.checked; });
  el.bloomStrength?.addEventListener('input', () => { if (!bloomPass) return; bloomPass.strength = Number(el.bloomStrength.value); setVal('ui-bloom-strength-val', bloomPass.strength.toFixed(2)); });
  el.vignette?.addEventListener('change', () => { if (vignettePass) vignettePass.enabled = el.vignette.checked; });
  el.vignetteDark?.addEventListener('input', () => { const u = vignettePass?.material?.uniforms?.darkness; if (!u) return; u.value = Number(el.vignetteDark.value); setVal('ui-vignette-dark-val', u.value.toFixed(2)); });
  el.bc?.addEventListener('change', () => { if (bcPass) bcPass.enabled = el.bc.checked; });
  el.contrast?.addEventListener('input', () => { const u = bcPass?.material?.uniforms?.contrast; if (!u) return; u.value = Number(el.contrast.value); setVal('ui-contrast-val', u.value.toFixed(2)); });
  el.bright?.addEventListener('input', () => { const u = bcPass?.material?.uniforms?.brightness; if (!u) return; u.value = Number(el.bright.value); setVal('ui-bright-val', u.value.toFixed(2)); });
  el.hs?.addEventListener('change', () => { if (hsPass) hsPass.enabled = el.hs.checked; });
  el.sat?.addEventListener('input', () => { const u = hsPass?.material?.uniforms?.saturation; if (!u) return; u.value = Number(el.sat.value); setVal('ui-sat-val', u.value.toFixed(2)); });
  el.hue?.addEventListener('input', () => { const u = hsPass?.material?.uniforms?.hue; if (!u) return; u.value = Number(el.hue.value); setVal('ui-hue-val', u.value.toFixed(2)); });
  el.lut?.addEventListener('change', () => {
    setLutPreset(el.lut.value);
    refreshUI();
  });
  el.lutIntensity?.addEventListener('input', () => {
    lutIntensity = Math.max(0.0, Math.min(1.0, Number(el.lutIntensity.value)));
    setVal('ui-lut-intensity-val', lutIntensity.toFixed(2));
    updateLutPass();
  });
  el.fxaa?.addEventListener('change', () => { if (fxaaPass) fxaaPass.enabled = el.fxaa.checked; });

  // Initial sync
  refreshUI();

  // Note: event handlers that call buildPoints also call refreshUI()
}

// (moved) UI initialization happens later after key vars are defined

/* ---------------- Utilities ---------------- */
function createPointGeometry(sourceGeom, targetGeom, keepRatio = 1) {
  if (!sourceGeom) return null;

  const srcPos = sourceGeom.getAttribute('position');
  if (!srcPos) return null;

  const sourceCount = srcPos.count;
  if (!Number.isFinite(sourceCount) || sourceCount <= 0) return null;

  const keepCount = keepRatio >= 0.999
    ? sourceCount
    : Math.max(1, Math.floor(sourceCount * keepRatio));

  const positions = new Float32Array(keepCount * 3);
  const sampleFractions = new Float32Array(keepCount);

  const srcStride = srcPos.itemSize || 3;
  const srcArray = srcPos.array;

  const colAttr = sourceGeom.getAttribute('color');
  const hasColor = !!colAttr;
  const colorStride = hasColor ? (colAttr.itemSize || 3) : 0;
  const srcColorArray = hasColor ? colAttr.array : null;
  const colors = hasColor ? new srcColorArray.constructor(keepCount * colorStride) : null;

  const step = sourceCount / keepCount;
  const srcDenom = Math.max(1, sourceCount - 1);

  for (let i = 0; i < keepCount; i++) {
    let index = Math.floor(i * step);
    if (i === keepCount - 1 || index >= sourceCount) {
      index = sourceCount - 1;
    }

    const dst = i * 3;
    const srcOffset = index * srcStride;
    positions[dst + 0] = srcArray[srcOffset + 0] ?? 0;
    positions[dst + 1] = srcStride > 1 ? (srcArray[srcOffset + 1] ?? 0) : 0;
    positions[dst + 2] = srcStride > 2 ? (srcArray[srcOffset + 2] ?? 0) : 0;

    if (hasColor && colors && srcColorArray) {
      const srcColorOffset = index * colorStride;
      const dstColorOffset = i * colorStride;
      for (let k = 0; k < colorStride; k++) {
        colors[dstColorOffset + k] = srcColorArray[srcColorOffset + k] ?? 0;
      }
    }

    sampleFractions[i] = srcDenom > 0 ? index / srcDenom : 0;
  }

  let morphArray = null;
  let morphColorArray = null;
  if (targetGeom) {
    const tgtPos = targetGeom.getAttribute('position');
    if (tgtPos && tgtPos.count > 0) {
      const tgtArray = tgtPos.array;
      const tgtStride = tgtPos.itemSize || 3;
      const tgtCount = tgtPos.count;
      morphArray = new Float32Array(keepCount * 3);
      
      // Extract target colors if they exist
      const tgtColAttr = targetGeom.getAttribute('color');
      const tgtHasColor = !!tgtColAttr;
      const tgtColorStride = tgtHasColor ? (tgtColAttr.itemSize || 3) : 0;
      const tgtColorArray = tgtHasColor ? tgtColAttr.array : null;
      if (tgtHasColor && tgtColorArray) {
        morphColorArray = new tgtColorArray.constructor(keepCount * tgtColorStride);
      }
      
      for (let i = 0; i < keepCount; i++) {
        const fraction = sampleFractions[i];
        let targetIndex = Math.round(fraction * (tgtCount - 1));
        if (!Number.isFinite(targetIndex)) targetIndex = 0;
        if (targetIndex < 0) targetIndex = 0;
        if (targetIndex >= tgtCount) targetIndex = tgtCount - 1;
        const dst = i * 3;
        const tgtOffset = targetIndex * tgtStride;
        morphArray[dst + 0] = tgtArray[tgtOffset + 0] ?? 0;
        morphArray[dst + 1] = tgtStride > 1 ? (tgtArray[tgtOffset + 1] ?? 0) : 0;
        morphArray[dst + 2] = tgtStride > 2 ? (tgtArray[tgtOffset + 2] ?? 0) : 0;
        
        // Sample target colors
        if (tgtHasColor && morphColorArray && tgtColorArray) {
          const tgtColorOffset = targetIndex * tgtColorStride;
          const dstColorOffset = i * tgtColorStride;
          for (let k = 0; k < tgtColorStride; k++) {
            morphColorArray[dstColorOffset + k] = tgtColorArray[tgtColorOffset + k] ?? 0;
          }
        }
      }
    }
  }
  if (!morphArray) {
    morphArray = positions.slice();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('morphTarget', new THREE.BufferAttribute(morphArray, 3));
  if (hasColor && colors) {
    const normalized = typeof colAttr.normalized === 'boolean' ? colAttr.normalized : false;
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, colorStride, normalized));
    
    // Always add morphColor attribute - use morphColorArray if available, otherwise duplicate colors
    let morphColorsToUse;
    if (morphColorArray && morphColorArray.length === colors.length) {
      morphColorsToUse = morphColorArray;
    } else {
      // Fallback to duplicate of source colors
      morphColorsToUse = colors.slice();
    }
    geometry.setAttribute('morphColor', new THREE.BufferAttribute(morphColorsToUse, colorStride, normalized));
  }
  return geometry;
}

// Wave glow shader: a moving front that brightens/enlarges points as it passes.
function makeGlowMaterial(hasVertexColor, baseSizePx = 3.0) {
  const uniforms = {
    uTime:        { value: 0.0 },
    uDPR:         { value: Math.min(devicePixelRatio, 1.5) },
    uBaseSize:    { value: baseSizePx }, // px
    uPulseAmp:    { value: 1.2 },        // how much points grow at the wave front
    uGlowBoost:   { value: 1.1 },        // brightness at the front
    uColor:       { value: new THREE.Color('#ffffff') },
    uHighlightColor: { value: new THREE.Color(highlightColorHex) },
    uUseVertexColor: { value: hasVertexColor ? 1 : 0 },
    uGlowMode:    { value: encodeGlowMode(glowMode) },
    uRandomGlowSpeed: { value: randomGlowSpeed },
    uMorphFactor: { value: morphUniformValue },
    uColorMix: { value: 0.0 }, // Explicit color blend uniform (0 = base color, 1 = morph color)

    // Size attenuation (0 = off, 1 = on). Ref distance where size is unchanged.
    uSizeAttenEnabled: { value: 0.0 },
    uSizeAttenRef:     { value: 2.0 },

    // World-size points (true world units → pixels via projection)
    uUseWorldSize: { value: 1.0 },  // default ON for this experiment
    uWorldSize:    { value: 0.015 }, // diameter in world units
    uPxPerUnit:    { value: 1.0 },   // pixels per world unit (CSS px)
    // Random scatter amount (world units)
    uScatterAmp:   { value: scatterAmp },
    uSquareMix:    { value: squareMix },
    // --- hover displacement ---
    uHoverPos:      { value: new THREE.Vector3() },
    uHoverRadius:   { value: 0.1 },
    uHoverStrength: { value: 0.0 },
    uHoverNormal:   { value: new THREE.Vector3(0, 0, -1) },
    uHoverThickness: { value: 0.05 },

    // --- wave controls ---
    // We normalized your model so the largest side ≈ 2 world units.
    // Wave length/speed below are in those same units.
    uWaveCenter:  { value: new THREE.Vector3(0, 0, 0) }, // center of circular wave
    uWaveLength:  { value: 0.94 }, // distance between consecutive fronts (in world units)
    uWaveSpeed:   { value: 0.21 }, // units per second that the front moves
    uWaveWidth:   { value: 0.2 }, // thickness of the bright band (0..0.5)
    uBandGamma:   { value: 3.0 },  // sharpness of the band response

    // --- wind sway controls (world units) ---
    uWindDir:     { value: new THREE.Vector3(1, 0, 0) }, // predominant wind direction
    uWindAmp:     { value: 0.02 },  // max displacement at tips (world units)
    uWindFreq:    { value: 0.8 },   // temporal frequency (Hz)
    uWindSpatial: { value: 1.5 },   // spatial frequency along x/z
    uWindEnabled: { value: 1.0 },   // 1 = on, 0 = off

    // --- custom fog uniforms ---
    uFogEnabled: { value: fogEnabled ? 1.0 : 0.0 },
    uFogDensity: { value: fogDensity },
    uFogColor:   { value: new THREE.Color(scene.background) },
  };

  const vertexShader = `
    precision mediump float;
    uniform float uTime;
    uniform float uDPR;
    uniform float uBaseSize;
    uniform float uPulseAmp;
    uniform float uGlowMode;
    uniform float uRandomGlowSpeed;
    uniform float uColorMix;
    uniform float uSizeAttenEnabled;
    uniform float uSizeAttenRef;
    // World-size uniforms
    uniform float uUseWorldSize;
    uniform float uWorldSize;
    uniform float uPxPerUnit;
    uniform float uScatterAmp;
    uniform float uMorphFactor;

    uniform vec3  uHoverPos;
    uniform float uHoverRadius;
    uniform float uHoverStrength;
    uniform vec3  uHoverNormal;
    uniform float uHoverThickness;

    uniform vec3  uWaveCenter;
    uniform float uWaveLength;
    uniform float uWaveSpeed;
    uniform float uWaveWidth;
    uniform float uBandGamma;

    attribute vec3 color;
    attribute vec3 morphTarget;
    attribute vec3 morphColor;
    // Wind uniforms
    uniform vec3  uWindDir;
    uniform float uWindAmp;
    uniform float uWindFreq;
    uniform float uWindSpatial;
    uniform float uWindEnabled;
    varying vec3  vColor;
    varying vec3  vMorphColor;
    varying vec3  vBlendedColor;
    varying float vPulse;
    varying float vViewZ;
    varying float vHash;
    varying float vMorphFactor;

    void main() {
      float morph = clamp(uMorphFactor, 0.0, 1.0);
      vec3 basePos = position;
      vec3 targetPos = morphTarget;
      vec3 p = mix(basePos, targetPos, morph);

      // Height factor (0 at base, 1 at top). Model is roughly in [-1,1] Y.
      float h = clamp(p.y * 0.5 + 0.5, 0.0, 1.0);

      // Stable random direction per point; blend base/target noise to avoid pops
      float hb1 = fract(sin(dot(basePos.xyz, vec3(127.1, 311.7,  74.7))) * 43758.5453);
      float hb2 = fract(sin(dot(basePos.yzx, vec3(269.5, 183.3, 246.1))) * 43758.5453);
      float hb3 = fract(sin(dot(basePos.zxy, vec3(113.5, 271.9, 124.6))) * 43758.5453);
      vec3 baseRand = normalize(vec3(hb1 * 2.0 - 1.0, hb2 * 2.0 - 1.0, hb3 * 2.0 - 1.0) + 1e-4);

      float ht1 = fract(sin(dot(targetPos.xyz, vec3(127.1, 311.7,  74.7))) * 43758.5453);
      float ht2 = fract(sin(dot(targetPos.yzx, vec3(269.5, 183.3, 246.1))) * 43758.5453);
      float ht3 = fract(sin(dot(targetPos.zxy, vec3(113.5, 271.9, 124.6))) * 43758.5453);
      vec3 targetRand = normalize(vec3(ht1 * 2.0 - 1.0, ht2 * 2.0 - 1.0, ht3 * 2.0 - 1.0) + 1e-4);

      vec3 mixedRand = mix(baseRand, targetRand, morph);
      float mixedLen = length(mixedRand);
      if (mixedLen > 1e-5) {
        mixedRand /= mixedLen;
      } else {
        mixedRand = baseRand;
      }
      p += mixedRand * uScatterAmp;

      // Pseudo-random per-point phase for variation
      float hashBase = fract(sin(dot(basePos.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      float hashTarget = fract(sin(dot(targetPos.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      float hash = mix(hashBase, hashTarget, morph);
      vHash = hash;

      // Time-varying wind direction (slowly rotates) blended with user dir
      vec3 rotDir = normalize(vec3(cos(uTime * 0.05), 0.0, sin(uTime * 0.05)));
      vec3 windDir = normalize(normalize(uWindDir) * 0.6 + rotDir * 0.4);

      // Smooth sinusoidal sway with spatial variation and per-point phase
      float sway = sin(uTime * uWindFreq + (p.x + p.z) * uWindSpatial + hash * 6.2831853);

      // Apply displacement increasing with height so bases stay steadier
      p += windDir * (uWindAmp * sway * (0.2 + 0.8 * h)) * uWindEnabled;

      // World position for spatial wave
      vec3 worldPos = (modelMatrix * vec4(p, 1.0)).xyz;

      // Cursor hover displacement operates within a camera-facing disk
      vec3 displacedWorldPos = worldPos;
      float normalLen = length(uHoverNormal);
      vec3 hoverNormal = normalLen > 1e-5 ? (uHoverNormal / normalLen) : vec3(0.0, 0.0, -1.0);
      float hoverThickness = max(uHoverThickness, 1e-5);
      if (uHoverStrength > 0.0 && uHoverRadius > 0.0) {
        vec3 toPoint = displacedWorldPos - uHoverPos;
        float depth = dot(toPoint, hoverNormal);
        float absDepth = abs(depth);
        if (absDepth < hoverThickness) {
          vec3 planeVec = toPoint - hoverNormal * depth;
          float distPlane = length(planeVec);
          if (distPlane < uHoverRadius) {
            float influence = 1.0 - smoothstep(0.0, uHoverRadius, distPlane);
            float depthFalloff = 1.0 - smoothstep(0.0, hoverThickness, absDepth);
            influence *= depthFalloff;
            if (influence > 0.0) {
              vec3 dir;
              if (distPlane > 1e-5) {
                dir = planeVec / distPlane;
              } else {
                vec3 fallback = abs(hoverNormal.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
                vec3 crossVec = cross(hoverNormal, fallback);
                float crossLen = length(crossVec);
                dir = crossLen > 1e-5 ? (crossVec / crossLen) : vec3(1.0, 0.0, 0.0);
              }
              displacedWorldPos += dir * (uHoverStrength * influence);
            }
          }
        }
      }

      // Radial distance from wave center (circular/spherical wave)
      float coord = length(displacedWorldPos - uWaveCenter);

      // Phase of the traveling wave (0..1 wraps every wavelength)
      float phase = fract( (coord / max(uWaveLength, 1e-5)) - uTime * uWaveSpeed );

      // Distance to nearest wave front (fronts at phase=0 and 1)
      float distToFront = min(phase, 1.0 - phase); // in [0, 0.5]

      // Convert to a soft band: 1 at front, 0 away from it
      float band = smoothstep(uWaveWidth, 0.0, distToFront); // thinner band -> sharper front
      float wavePulse = pow(band, uBandGamma);

      float randomPhase = uTime * uRandomGlowSpeed + hash * 6.2831853;
      float flicker = clamp(0.5 + 0.5 * sin(randomPhase), 0.0, 1.0);
      float randomPulse = pow(flicker, 3.0);

      float width = max(uWaveWidth, 1e-4);
      float riseCoord = displacedWorldPos.y * 0.5 + 0.5;
      float risePhase = fract(riseCoord - uTime * uWaveSpeed);
      float riseWidth = max(width * 0.35, 1e-4);
      float riseFront = smoothstep(0.0, riseWidth, risePhase);
      float riseTail = 1.0 - smoothstep(1.0 - riseWidth, 1.0, risePhase);
      float riseBand = clamp(riseFront * riseTail, 0.0, 1.0);
      float risePulse = pow(riseBand, uBandGamma);
      risePulse = 1.0 - risePulse;

      float mode = uGlowMode;
      if (mode < 0.5) {
        vPulse = wavePulse;
      } else if (mode < 1.5) {
        vPulse = randomPulse;
      } else {
        vPulse = risePulse;
      }

      // Point size: choose screen-space constant or world-space diameter
      vec4 mvPosition = viewMatrix * vec4(displacedWorldPos, 1.0);
      float dist = max(0.01, -mvPosition.z);
      float sizeScreenPx = uBaseSize; // constant pixel size
      float sizeWorldPx  = uWorldSize * (uPxPerUnit / dist); // projection-based pixels
      float basePx = mix(sizeScreenPx, sizeWorldPx, uUseWorldSize);
      // Optional legacy attenuation for screen-space mode
      float atten = mix(1.0, clamp(uSizeAttenRef / dist, 0.1, 4.0), uSizeAttenEnabled * (1.0 - uUseWorldSize));
      float sizePx = basePx * (1.0 + uPulseAmp * vPulse) * atten;
      // As scatter increases to 0.5, shrink point size to 0
      float scatterScale = clamp(1.0 - (uScatterAmp / 0.5), 0.0, 1.0);
      sizePx *= scatterScale;
      gl_PointSize = sizePx * uDPR;
      vColor = color; // will be (0,0,0) if no vertex colors bound
      // If morphColor isn't available, use color as fallback
      bool hasMorphColor = length(morphColor) > 0.001;
      vMorphColor = hasMorphColor ? morphColor : color;
      // Blend colors in vertex shader using uColorMix (explicit color blend separate from position morph)
      float colorMix = clamp(uColorMix, 0.0, 1.0);
      vBlendedColor = mix(vColor, vMorphColor, colorMix);
      vMorphFactor = morph; // pass morph factor to fragment shader (for position morph)
      vViewZ = dist;
      gl_Position = projectionMatrix * mvPosition;
    }
  `;

const fragmentShader = `
    precision mediump float;

uniform vec3  uColor;
uniform vec3  uHighlightColor;
uniform float uGlowBoost;
uniform float uUseVertexColor;
uniform float uScatterAmp;
uniform float uSquareMix;
uniform float uFogEnabled;
uniform float uFogDensity;
uniform vec3  uFogColor;

varying vec3  vColor;
varying vec3  vMorphColor;
varying vec3  vBlendedColor;
varying float vPulse;
varying float vViewZ;
varying float vHash;
varying float vMorphFactor;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float squareMask = step(1.0 - uSquareMix, vHash);
  float r2 = dot(uv, uv);
  if (squareMask < 0.5 && r2 > 1.0) discard;

  float alpha = 1.0;
  if (squareMask >= 0.5) {
    float edge = max(abs(uv.x), abs(uv.y));
    alpha = clamp(1.0 - smoothstep(0.96, 1.0, edge), 0.0, 1.0);
    if (alpha <= 0.0) discard;
  }

  float pulse = clamp(vPulse, 0.0, 1.0);
  
  // Use pre-blended color from vertex shader (blended using uColorMix)
  // This ensures colors always blend smoothly on-GPU every frame
  vec3 base = mix(uColor, vBlendedColor, uUseVertexColor);
  vec3 highlighted = mix(base, uHighlightColor, pulse);
  vec3 col  = highlighted * (1.0 + uGlowBoost * pulse);

  // Exponential squared fog based on view-space depth (approx via gl_FragCoord)
  // We approximate view depth using gl_FragCoord.z in [0,1] mapped by density scalar.
  // For point sprites, this is sufficient for a soft atmospheric effect.
  if (uFogEnabled > 0.5) {
    float f = 1.0 - exp(-pow(uFogDensity * vViewZ, 2.0));
    col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
  }

  gl_FragColor = vec4(col, alpha);
}
  `;

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: true,
    blending: THREE.NormalBlending,
  });
}

/* ---------------- Load PLY & Build Points ---------------- */
const loader = new PLYLoader();
let pendingModelPromise = null;
let modelLoadToken = 0;

let originalGeom = null; // unmodified, for re-subsampling

let keepRatio = 0.18;    // ↓ fewer points for speed (try 0.10–0.25)
let pointSizePx = 3.0;   // ↑ base point size (pixels)
let useScreenSize = true; // kept for API parity; shader uses screen-space size
let scatterAmp = 0.0;    // random displacement amplitude (world units)
let scatterGoal = scatterAmp;
let glowMode = 'wave';   // 'wave', 'random', or 'rise'
let randomGlowSpeed = 1.2; // Hz for random flicker
let squareMix = 0.0;     // 0 = circles, 1 = all squares
let currentWindAmp = 0.02;
let touchScrollActive = false;
let touchLastY = 0;
let highlightColorHex = '#b9e456';
let useOriginalPointColors = false;
let modelRotationOffsetDeg = 0;
const MORPH_LERP_SPEED = 4.0;
let morphTargetOriginal = null;
let morphProgress = 0;
let morphUniformValue = 0;
const floatingTextEl = typeof document !== 'undefined' ? document.getElementById('floating-text') : null;
const sectionEyebrowEl = floatingTextEl?.querySelector('.section-eyebrow') ?? null;
const sectionTitleEl = floatingTextEl?.querySelector('.section-title') ?? null;
const sectionBodyEl = floatingTextEl?.querySelector('.section-body') ?? null;
const sectionIndexEl = typeof document !== 'undefined' ? document.getElementById('section-index') : null;
const sectionCountEl = typeof document !== 'undefined' ? document.getElementById('section-count') : null;
let textOpacityTarget = 1;
let textOpacityValue = 1;
const TEXT_FADE_SPEED = 4.0;
const SCATTER_EASE_SPEED = SECTION_TRANSITION.scatterSpeed ?? 4.5;
const SCROLL_TRIGGER_THRESHOLD = SECTION_TRANSITION.wheelThreshold ?? 120;
const TOUCH_TRIGGER_THRESHOLD = SCROLL_TRIGGER_THRESHOLD * 0.6;
const SCROLL_PROGRESS_SCALE = SECTION_TRANSITION.scrollScale ?? 900;
const TOUCH_PROGRESS_SCALE = SCROLL_PROGRESS_SCALE * 0.6;

function setTextOpacityTarget(value, { immediate = false } = {}) {
  const clamped = THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
  textOpacityTarget = clamped;
  if (immediate) {
    textOpacityValue = clamped;
    if (floatingTextEl) {
      floatingTextEl.style.opacity = clamped.toFixed(3);
    }
  }
}

function formatSectionNumber(value) {
  const n = Math.max(0, Math.floor(Math.abs(value)));
  return n < 10 ? `0${n}` : String(n);
}

function setSectionTextContent(section, index) {
  if (!section) return;
  if (sectionEyebrowEl) {
    sectionEyebrowEl.textContent = section.eyebrow ?? '';
  }
  if (sectionTitleEl) {
    if (Array.isArray(section.title)) {
      const safeLines = section.title.map((line) => line?.trim?.() ?? '').filter(Boolean);
      sectionTitleEl.innerHTML = safeLines.join('<br>');
    } else {
      sectionTitleEl.innerHTML = section.title ?? '';
    }
  }
  if (sectionBodyEl) {
    sectionBodyEl.textContent = section.body ?? '';
  }
  if (sectionIndexEl) {
    sectionIndexEl.textContent = formatSectionNumber((index ?? 0) + 1);
  }
  if (sectionCountEl) {
    sectionCountEl.textContent = formatSectionNumber(getSectionCount());
  }
}

function setBackgroundTextForSection(section) {
  if (!section) return;
  const value = section.backgroundText;
  if (Array.isArray(value)) {
    bgTextLines = value;
  } else if (typeof value === 'string') {
    bgTextLines = value.split('\n');
  }
  updateBackgroundTextTexture();
}

function updateBackgroundControls(colors) {
  const normalized = normalizeBackgroundInput(colors);
  if (!normalized) return;
  const bgInput = document.getElementById('ui-bg');
  if (bgInput) bgInput.value = normalized.top;
  const bgLabel = document.getElementById('ui-bg-val');
  if (bgLabel) bgLabel.textContent = normalized.top.toUpperCase();
  const bgMidInput = document.getElementById('ui-bg-mid');
  if (bgMidInput) bgMidInput.value = normalized.mid;
  const bgMidLabel = document.getElementById('ui-bg-mid-val');
  if (bgMidLabel) bgMidLabel.textContent = normalized.mid.toUpperCase();
  const bgBottomInput = document.getElementById('ui-bg-bottom');
  if (bgBottomInput) bgBottomInput.value = normalized.bottom;
  const bgBottomLabel = document.getElementById('ui-bg-bottom-val');
  if (bgBottomLabel) bgBottomLabel.textContent = normalized.bottom.toUpperCase();
}

function applySectionOverrides(section, { skipBackground = false } = {}) {
  if (!section?.settings) return;
  const settings = section.settings || {};

  if (typeof settings.highlightColor === 'string') {
    setHighlightColor(settings.highlightColor);
  }

  if (typeof settings.useOriginalPointColors === 'boolean') {
    useOriginalPointColors = settings.useOriginalPointColors;
    const u = points?.material?.uniforms;
    if (u?.uUseVertexColor) {
      u.uUseVertexColor.value = useOriginalPointColors ? 1 : 0;
      const hasColorAttr = points?.geometry?.getAttribute('color');
      console.log('[colors] useOriginalPointColors set to', useOriginalPointColors, 'for section', section?.id, '- has color attr:', !!hasColorAttr);
    }
  }

  if (typeof settings.pointSizePx === 'number') {
    setPointSizePxValue(settings.pointSizePx, { rebuild: false });
  }

  if (settings.background) {
    const normalized = normalizeBackgroundInput(settings.background);
    if (normalized && !skipBackground) {
      setBackgroundGradient(normalized);
    }
    if (normalized) {
      updateBackgroundControls(normalized);
    } else {
      console.warn('Failed to normalize background color for section', section?.id ?? '(unknown)', settings.background);
    }
  }

  if (settings.fog) {
    fogEnabled = !!settings.fog.enabled;
    if (settings.fog.density !== undefined) {
      fogDensity = THREE.MathUtils.clamp(settings.fog.density, 0, 2);
    }
    updateFog();
    const fogToggle = document.getElementById('ui-fog');
    if (fogToggle) fogToggle.checked = fogEnabled;
    const fogDensityInput = document.getElementById('ui-fog-density');
    if (fogDensityInput) fogDensityInput.value = fogDensity.toFixed(3);
    const fogDensityLabel = document.getElementById('ui-fog-density-val');
    if (fogDensityLabel) fogDensityLabel.textContent = fogDensity.toFixed(3);
  }

  if (settings.lut) {
    setLutPreset(settings.lut.key ?? 'none');
    if (settings.lut.intensity !== undefined) {
      lutIntensity = THREE.MathUtils.clamp(settings.lut.intensity, 0, 1);
      updateLutPass();
    }
    const lutSelect = document.getElementById('ui-lut');
    if (lutSelect) lutSelect.value = settings.lut.key ?? 'none';
    const lutIntensityInput = document.getElementById('ui-lut-intensity');
    if (lutIntensityInput) lutIntensityInput.value = lutIntensity.toFixed(2);
    const lutIntensityLabel = document.getElementById('ui-lut-intensity-val');
    if (lutIntensityLabel) lutIntensityLabel.textContent = lutIntensity.toFixed(2);
  }

  if (typeof settings.windAmp === 'number') {
    currentWindAmp = settings.windAmp;
    const u = points?.material?.uniforms;
    if (u?.uWindAmp) u.uWindAmp.value = currentWindAmp;
    const windAmpInput = document.getElementById('ui-wind-amp');
    if (windAmpInput) windAmpInput.value = currentWindAmp.toFixed(3);
    const windAmpLabel = document.getElementById('ui-wind-amp-val');
    if (windAmpLabel) windAmpLabel.textContent = currentWindAmp.toFixed(3);
  }

  if (settings.bc) {
    const contrastValue = THREE.MathUtils.clamp(settings.bc.contrast ?? (bcPass?.material?.uniforms?.contrast.value ?? 0), -1, 1);
    const brightnessValue = THREE.MathUtils.clamp(settings.bc.brightness ?? (bcPass?.material?.uniforms?.brightness.value ?? 0), -1, 1);
    if (bcPass) {
      bcPass.enabled = settings.bc.enabled ?? bcPass.enabled;
      if (bcPass.material?.uniforms?.contrast) {
        bcPass.material.uniforms.contrast.value = contrastValue;
      }
      if (bcPass.material?.uniforms?.brightness) {
        bcPass.material.uniforms.brightness.value = brightnessValue;
      }
    }
    const contrastInput = document.getElementById('ui-contrast');
    if (contrastInput) contrastInput.value = contrastValue.toFixed(2);
    const contrastLabel = document.getElementById('ui-contrast-val');
    if (contrastLabel) contrastLabel.textContent = contrastValue.toFixed(2);
    const brightInput = document.getElementById('ui-bright');
    if (brightInput) brightInput.value = brightnessValue.toFixed(2);
    const brightLabel = document.getElementById('ui-bright-val');
    if (brightLabel) brightLabel.textContent = brightnessValue.toFixed(2);
    const bcToggle = document.getElementById('ui-bc');
    if (bcToggle && settings.bc.enabled !== undefined) {
      bcToggle.checked = !!settings.bc.enabled;
    }
  }
}

function buildPoints() {
  if (!originalGeom) return;

  const g = createPointGeometry(originalGeom, morphTargetOriginal, keepRatio);
  if (!g) return;
  g.computeBoundingBox();
  g.computeBoundingSphere?.();

  const hasColor = !!g.getAttribute('color');

  if (!points) {
    // First time: create material + mesh
    const mat = makeGlowMaterial(hasColor, pointSizePx);
    if (mat?.uniforms?.uSquareMix) {
      mat.uniforms.uSquareMix.value = squareMix;
    }
    points = new THREE.Points(g, mat);
    points.frustumCulled = true;
    pointCloudGroup.add(points);
  } else {
    // Subsequent rebuilds: keep material, just swap geometry
    points.geometry.dispose();
    points.geometry = g;

    // Update uBaseSize if pointSizePx changed
    if (points.material?.uniforms?.uBaseSize) {
      points.material.uniforms.uBaseSize.value = pointSizePx;
    }
    
    // Update uUseVertexColor if color availability changed
    if (points.material?.uniforms?.uUseVertexColor !== undefined) {
      points.material.uniforms.uUseVertexColor.value = hasColor ? 1 : 0;
    }
  }

  // --- sync uniforms to current app state (IMPORTANT) ---
  // This ensures uniforms maintain their values across rebuilds
  const u = points.material.uniforms;
  if (u) {
    // World size / camera dependent
    updateWorldSizeUniforms();

    if (u.uWindAmp) {
      u.uWindAmp.value = currentWindAmp;
    }
    if (u.uHoverStrength) {
      u.uHoverStrength.value = 0.0;
    }
    if (u.uHighlightColor) {
      u.uHighlightColor.value.set(highlightColorHex);
    }
    
    // CRITICAL: Restore morph and color blend values
    if (u.uMorphFactor) {
      u.uMorphFactor.value = morphUniformValue;
    }
    if (u.uColorMix) {
      u.uColorMix.value = scrollTweenState?.colorMix ?? 0;
    }
  }

  updateFog();
  setScatterAmplitude(scatterAmp);

  // keep morph targets bookkeeping
  const posAttr = g.getAttribute('position');
  if (posAttr) {
    baseVertexCount = posAttr.count;
    refreshAllMorphTargets();
    if (currentSectionId) {
      const asset = sectionAssets.get(currentSectionId);
      if (asset) {
        asset.geometry = originalGeom;
        asset.morphArray = new Float32Array(posAttr.array);
        setPointsMorphTarget(asset.morphArray);
      }
    }
  }
}

// Model loading
const DEFAULT_MODEL_PATH = 'point/akl3-bw.ply';
let currentModelPath = DEFAULT_MODEL_PATH;

function preprocessGeometry(geom, path) {
  if (!geom) return null;
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (!bb) return geom;

  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  geom.translate(-cx, -cy, -cz);

  const maxDim = Math.max(
    bb.max.x - bb.min.x,
    bb.max.y - bb.min.y,
    bb.max.z - bb.min.z
  ) || 1;
  const scale = 2 / maxDim;
  geom.scale(scale, scale, scale);

  geom.rotateY(THREE.MathUtils.degToRad(180));
  const extraRotation = MODEL_ROTATION_OVERRIDES[path];
  if (typeof extraRotation === 'number' && Number.isFinite(extraRotation)) {
    geom.rotateY(THREE.MathUtils.degToRad(extraRotation));
  }
  const scaleOverride = MODEL_SCALE_OVERRIDES[path];
  if (typeof scaleOverride === 'number' && Number.isFinite(scaleOverride)) {
    geom.scale(scaleOverride, scaleOverride, scaleOverride);
  }

  geom.computeBoundingBox();
  geom.computeBoundingSphere?.();
  return geom;
}

function loadModel(path, { resetPathProgress = false } = {}) {
  modelLoadToken += 1;
  const token = modelLoadToken;
  console.log('[PLY] loading:', path);

  const promise = new Promise((resolve, reject) => {
    loader.load(
      path,
      (geom) => {
        if (token !== modelLoadToken) {
          console.warn('[PLY] stale load discarded:', path);
          resolve(null);
          return;
        }

        currentModelPath = path;
        preprocessGeometry(geom, path);
        sectionAssets.forEach((asset) => {
          if (asset.path === path) {
            asset.geometry = geom.clone();
          }
        });
        originalGeom = geom;
        morphTargetOriginal = geom.clone();
        buildPoints();

        const measureTarget = points || pointCloudGroup;
        const box = new THREE.Box3().setFromObject(measureTarget);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        const md = Math.max(size.x, size.y, size.z) || 1;
        const dist = (md / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.2;
        controls.target.copy(center);
        const targetOffset = MODEL_TARGET_OFFSETS[path];
        if (targetOffset) controls.target.add(targetOffset);
        const overrideScale = CAMERA_PATH_DISTANCE_OVERRIDES[path] ?? 1.0;
        cameraPathScale = Math.max(dist, 0.1) * overrideScale;
        if (resetPathProgress) {
          cameraPathT = 0;
        }
        positionCameraOnPath();
        camera.near = Math.max(dist / 1e5, 0.01);
        camera.far = dist * 1e5;
        camera.updateProjectionMatrix();
        controls.update();
        applyModelSettings(path);
        updateBackgroundTextScale();
        updateBackgroundTextPose();

        if (points && points.material && points.material.uniforms) {
          const u = points.material.uniforms;
          u.uSizeAttenRef.value = dist;
          updateWorldSizeUniforms();
        }

        console.log('[PLY] points:', geom.getAttribute('position')?.count ?? 0,
                    'hasColor:', !!geom.getAttribute('color'));
        console.log(`[viewer] keepRatio=${keepRatio}, pointSizePx=${pointSizePx}`);
        try { window.dispatchEvent(new Event('ui-refresh')); } catch {}

        try {
          const btn = document.getElementById('ui-model-btn');
          if (btn) btn.textContent = path.split('/').pop();
        } catch {}

        resolve({ path, box });
      },
      undefined,
      (err) => {
        if (token !== modelLoadToken) {
          console.warn('[PLY] stale load error ignored:', err);
          resolve(null);
          return;
        }
        console.error('PLY load error:', err);
        reject(err);
      }
    );
  });

  pendingModelPromise = promise.then(
    (value) => value,
    (err) => {
      console.error(err);
      return null;
    }
  );

  return promise;
}

// Initial model + section bootstrap
bootstrapSections();

/* ---------------- Animate (advance uTime) ---------------- */
let lastFrameTime = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = (now - lastFrameTime) * 0.001;
  lastFrameTime = now;
  if (Math.abs(cameraPathTarget - cameraPathT) > 1e-4) {
    const diff = cameraPathTarget - cameraPathT;
    const step = diff * Math.min(1, CAMERA_PATH_LERP_SPEED * dt);
    cameraPathT = THREE.MathUtils.clamp(cameraPathT + step, 0, 1);
    positionCameraOnPath();
  }
  controls.update();

  if (points && points.material && points.material.uniforms) {
    const uniforms = points.material.uniforms;
    uniforms.uTime.value = now * 0.001;
    if (uniforms.uMorphFactor) {
      const diff = morphProgress - morphUniformValue;
      if (Math.abs(diff) > 1e-4) {
        morphUniformValue += diff * Math.min(1.0, MORPH_LERP_SPEED * dt);
      } else {
        morphUniformValue = morphProgress;
      }
      uniforms.uMorphFactor.value = morphUniformValue;
    }
    if (uniforms.uHoverStrength) uniforms.uHoverStrength.value = 0.0;
    if (uniforms.uLightDir?.value instanceof THREE.Vector3) {
      const lightDir = uniforms.uLightDir.value;
      const angle = now * 0.00025;
      lightDir.set(Math.cos(angle) * 0.6, 0.7, Math.sin(angle) * 0.6).normalize();
    }
  }
  if (gradientSky) {
    gradientSky.position.copy(camera.position);
  }
  if (backgroundTextMesh) {
    updateBackgroundTextScale();
    updateBackgroundTextPose();
  }
  updateSectionTransition();
  if (Math.abs(scatterGoal - scatterAmp) > 1e-4) {
    const delta = scatterGoal - scatterAmp;
    const step = delta * Math.min(1, SCATTER_EASE_SPEED * dt);
    setScatterAmplitude(scatterAmp + step, { syncTarget: false });
  }
  if (floatingTextEl) {
    const diff = textOpacityTarget - textOpacityValue;
    if (Math.abs(diff) > 1e-3) {
      textOpacityValue += diff * Math.min(1, TEXT_FADE_SPEED * dt);
    } else {
      textOpacityValue = textOpacityTarget;
    }
    floatingTextEl.style.opacity = textOpacityValue.toFixed(3);
  }

  if (composer) composer.render(); else renderer.render(scene, camera);
}
animate();

/* ---------------- Resize ---------------- */
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  updatePostSizes();

  // keep shader DPR in sync if devicePixelRatio changes
  if (points && points.material && points.material.uniforms) {
    points.material.uniforms.uDPR.value = Math.min(devicePixelRatio, 1.5);
    // update pixels-per-unit for world-size sizing
    updateWorldSizeUniforms();
  }
  if (backgroundTextMesh) {
    updateBackgroundTextScale();
    updateBackgroundTextPose();
  }
});

// Initialize UI after the module-level lets are initialized
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupUI, { once: true });
} else {
  setupUI();
}
