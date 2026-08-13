import { Renderer, Program, Mesh, Triangle } from "ogl";

type FlowDirection = "inward" | "outward";

export interface LightTunnelOptions {
  cableColor?: string;
  pulseColor?: string;
  tunnelColor?: string;
  tunnelOpacity?: number;
  speed?: number;
  flowDirection?: FlowDirection;
  pulseSpeed?: number;
  pulseLength?: number;
  pulseBlend?: number;
  pulseWidth?: number;
  cableCount?: number;
  thickness?: number;
  rimWidth?: number;
  waviness?: number;
  sway?: number;
  spiral?: number;
  spinSpeed?: number;
  size?: number;
  centerX?: number;
  centerY?: number;
  glow?: number;
  fadeNear?: number;
  fadeFar?: number;
  brightness?: number;
  colorVariance?: boolean;
  grain?: boolean;
  grainIntensity?: number;
  opacity?: number;
  mouseInteraction?: boolean;
  mouseStrength?: number;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return [1, 1, 1];
  return [
    parseInt(result[1], 16) / 255,
    parseInt(result[2], 16) / 255,
    parseInt(result[3], 16) / 255,
  ];
};

const vertex = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragment = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform float uSpeed;
uniform float uFlowDir;
uniform float uPulseSpeed;
uniform float uPulseLength;
uniform float uPulseBlend;
uniform float uPulseWidth;
uniform float uCableCount;
uniform float uThickness;
uniform float uRimWidth;
uniform float uWaviness;
uniform float uSway;
uniform float uSpiral;
uniform float uSpinSpeed;
uniform float uSize;
uniform vec2 uCenter;
uniform vec2 uMouseOffset;
uniform float uGlow;
uniform float uFadeNear;
uniform float uFadeFar;
uniform float uBrightness;
uniform float uColorVariance;
uniform float uOpacity;
uniform vec3 uCableColor;
uniform vec3 uPulseColor;
uniform vec3 uTunnelColor;
uniform float uTunnelOpacity;
uniform float uGrain;
uniform float uGrainIntensity;
out vec4 fragColor;

void mainImage(out vec4 o, in vec2 fragCoord) {
  float size = uSize * 2.0;
  float flowDir = uFlowDir;
  float speedBase = uSpeed * 4.0 * flowDir;
  float waviness = uWaviness * 0.15;
  float rotationOsc = uSway * 0.5;
  float baseThick = uThickness * 0.35 + 0.05;
  float borderWeight = uRimWidth * 0.15 + 0.01;
  float cablesCount = floor(uCableCount);

  vec2 res = iResolution.xy;
  vec2 uv = (fragCoord - 0.5 * res) / min(res.y, res.x);
  uv -= (uCenter + uMouseOffset);
  uv /= (size + 0.0001);

  float r = length(uv);
  float angle = atan(uv.y, uv.x);
  float depth = -log(r + 0.0001);

  float swing = sin(iTime * (uSpeed * 0.5 + 0.1)) * rotationOsc;
  float waveOffset = sin(depth * 1.2 + iTime * speedBase * 0.25) * waviness;

  float angleNormalized = (angle / 6.2831853) + 0.5;
  // Spiral: twist the cables' angle as a function of depth so the straight
  // radial tunnel winds into a spiral, plus a slow continuous rotation so the
  // whole field turns like a vortex rather than swaying back and forth.
  float twist = depth * uSpiral;
  float spin = iTime * uSpinSpeed;
  float finalAngle = fract(angleNormalized + waveOffset + swing + twist + spin);

  float cableID = floor(finalAngle * cablesCount);
  float gvX = (fract(finalAngle * cablesCount) - 0.5);

  float rand = fract(sin(cableID * 12.9898) * 43758.5453);
  float randSpeed = (0.4 + rand * 0.6) * speedBase * uPulseSpeed;
  float cableThick = baseThick * (0.6 + rand * 0.4);

  vec3 cableCol = uCableColor;
  cableCol *= 1.0 + (rand - 0.5) * 0.4 * uColorVariance;
  cableCol = mix(cableCol, uPulseColor, rand * 0.25 * uColorVariance);

  float scroll = depth + (iTime * randSpeed);
  float pulseFact = fract(scroll);

  float distToCore = abs(gvX);
  float wireMask = smoothstep(cableThick, cableThick - 0.05, distToCore);
  float rimGlow = smoothstep(borderWeight, 0.0, abs(distToCore - cableThick));

  float pulseThick = cableThick * uPulseWidth;
  float pulseMask = smoothstep(pulseThick, pulseThick - 0.05 * uPulseWidth, distToCore);

  float pulseDist = abs(pulseFact - 0.5);
  float pulseTotal = uPulseLength;
  float pulseCore = pulseTotal * (1.0 - uPulseBlend);
  float pulseLo = min(pulseCore, pulseTotal - max(fwidth(scroll), 1e-4));
  float dataPulse = 1.0 - smoothstep(pulseLo, pulseTotal, pulseDist);

  float aBody = wireMask * uTunnelOpacity;
  float aRim = rimGlow;
  float aPulse = clamp(dataPulse * pulseMask, 0.0, 1.0);

  vec3 fiberCol = uTunnelColor * aBody
    + cableCol * aRim * 1.3 * uGlow
    + uPulseColor * dataPulse * 3.0 * pulseMask;

  float distFade = smoothstep(0.0, uFadeNear, r) * smoothstep(uFadeFar, uFadeFar - 0.9, r);
  float inten = clamp(aBody + aRim + aPulse, 0.0, 1.0) * distFade;

  vec3 finalCol = fiberCol * uBrightness;
  float alpha = clamp(inten, 0.0, 1.0) * uOpacity;
  vec3 outRgb = finalCol * alpha;

  if (uGrain > 0.5) {
    float gv = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + iTime) * 43758.5453) - 0.5) * uGrainIntensity;
    outRgb = clamp(outRgb + gv, 0.0, 1.0);
    alpha = clamp(alpha + gv, 0.0, 1.0);
  }

  o = vec4(outRgb, alpha);
}

void main() {
  vec4 o = vec4(0.0);
  mainImage(o, gl_FragCoord.xy);
  fragColor = o;
}
`;

function readOptions(el: HTMLElement): Required<LightTunnelOptions> {
  const d = el.dataset;
  const attr = (name: keyof DOMStringMap, fallback: string) => d[name] ?? fallback;
  const num = (name: keyof DOMStringMap, fallback: number) => {
    const value = Number(d[name]);
    return Number.isFinite(value) ? value : fallback;
  };
  const bool = (name: keyof DOMStringMap, fallback: boolean) => {
    const value = d[name];
    if (value === undefined) return fallback;
    return value !== "false";
  };
  const flow = attr("flowDirection", "outward");
  return {
    cableColor: attr("cableColor", "#112039"),
    pulseColor: attr("pulseColor", "#3B82F6"),
    tunnelColor: attr("tunnelColor", "#5227FF"),
    tunnelOpacity: num("tunnelOpacity", 0),
    speed: num("speed", 0.1),
    flowDirection: flow === "outward" ? "outward" : "inward",
    pulseSpeed: num("pulseSpeed", 2),
    pulseLength: num("pulseLength", 0.2),
    pulseBlend: num("pulseBlend", 0.8),
    pulseWidth: num("pulseWidth", 0.12),
    cableCount: num("cableCount", 44),
    thickness: num("thickness", 0.5),
    rimWidth: num("rimWidth", 0),
    waviness: num("waviness", 0.6),
    sway: num("sway", 0.2),
    spiral: num("spiral", 0.5),
    spinSpeed: num("spinSpeed", 0.02),
    size: num("size", 1.25),
    centerX: num("centerX", 0),
    centerY: num("centerY", 0),
    glow: num("glow", 1.6),
    fadeNear: num("fadeNear", 0.45),
    fadeFar: num("fadeFar", 1.8),
    brightness: num("brightness", 1),
    colorVariance: bool("colorVariance", true),
    grain: bool("grain", true),
    grainIntensity: num("grainIntensity", 0.05),
    opacity: num("opacity", 1),
    mouseInteraction: bool("mouseInteraction", false),
    mouseStrength: num("mouseStrength", 0.12),
  };
}

export function mountLightTunnel(container: HTMLElement) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};

  const o = readOptions(container);
  const renderer = new Renderer({
    webgl: 2,
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
  });

  const gl = renderer.gl;
  gl.clearColor(0, 0, 0, 0);
  const canvas = gl.canvas as HTMLCanvasElement;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.setAttribute("aria-hidden", "true");
  container.appendChild(canvas);

  const geometry = new Triangle(gl);
  const program = new Program(gl, {
    vertex,
    fragment,
    uniforms: {
      iTime: { value: 0 },
      iResolution: { value: new Float32Array([1, 1]) },
      uSpeed: { value: o.speed },
      uFlowDir: { value: o.flowDirection === "outward" ? -1.0 : 1.0 },
      uPulseSpeed: { value: o.pulseSpeed },
      uPulseLength: { value: o.pulseLength },
      uPulseBlend: { value: o.pulseBlend },
      uPulseWidth: { value: o.pulseWidth },
      uCableCount: { value: o.cableCount },
      uThickness: { value: o.thickness },
      uRimWidth: { value: o.rimWidth },
      uWaviness: { value: o.waviness },
      uSway: { value: o.sway },
      uSpiral: { value: o.spiral },
      uSpinSpeed: { value: o.spinSpeed },
      uSize: { value: o.size },
      uCenter: { value: new Float32Array([o.centerX, o.centerY]) },
      uMouseOffset: { value: new Float32Array([0, 0]) },
      uGlow: { value: o.glow },
      uFadeNear: { value: o.fadeNear },
      uFadeFar: { value: o.fadeFar },
      uBrightness: { value: o.brightness },
      uColorVariance: { value: o.colorVariance ? 1.0 : 0.0 },
      uOpacity: { value: o.opacity },
      uCableColor: { value: new Float32Array(hexToRgb(o.cableColor)) },
      uPulseColor: { value: new Float32Array(hexToRgb(o.pulseColor)) },
      uTunnelColor: { value: new Float32Array(hexToRgb(o.tunnelColor)) },
      uTunnelOpacity: { value: o.tunnelOpacity },
      uGrain: { value: o.grain ? 1.0 : 0.0 },
      uGrainIntensity: { value: o.grainIntensity },
    },
  });

  const mesh = new Mesh(gl, { geometry, program });

  const setSize = () => {
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    renderer.setSize(w, h);
    const res = program.uniforms.iResolution.value as Float32Array;
    res[0] = gl.drawingBufferWidth;
    res[1] = gl.drawingBufferHeight;
    renderer.render({ scene: mesh });
  };

  const ro = new ResizeObserver(setSize);
  ro.observe(container);
  setSize();

  const currentMouse = [0.5, 0.5];
  const targetMouse = [0.5, 0.5];
  const onPointerMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    targetMouse[0] = (e.clientX - rect.left) / rect.width;
    targetMouse[1] = 1.0 - (e.clientY - rect.top) / rect.height;
  };
  const onPointerLeave = () => {
    targetMouse[0] = 0.5;
    targetMouse[1] = 0.5;
  };
  if (o.mouseInteraction) {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerleave", onPointerLeave);
  }

  let raf = 0;
  let isVisible = true;
  let isPageVisible = !document.hidden;
  const t0 = performance.now();

  const loop = (t: number) => {
    program.uniforms.iTime.value = (t - t0) * 0.001;
    const tx = o.mouseInteraction ? targetMouse[0] : 0.5;
    const ty = o.mouseInteraction ? targetMouse[1] : 0.5;
    currentMouse[0] += 0.05 * (tx - currentMouse[0]);
    currentMouse[1] += 0.05 * (ty - currentMouse[1]);
    const off = program.uniforms.uMouseOffset.value as Float32Array;
    off[0] = (currentMouse[0] - 0.5) * o.mouseStrength;
    off[1] = (currentMouse[1] - 0.5) * o.mouseStrength;
    renderer.render({ scene: mesh });
    raf = requestAnimationFrame(loop);
  };

  const tryStart = () => {
    if (isVisible && isPageVisible && raf === 0) raf = requestAnimationFrame(loop);
  };
  const tryStop = () => {
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const io = new IntersectionObserver(
    ([entry]) => {
      isVisible = entry.isIntersecting;
      isVisible ? tryStart() : tryStop();
    },
    { threshold: 0 },
  );
  io.observe(container);

  const onVisibility = () => {
    isPageVisible = !document.hidden;
    isPageVisible ? tryStart() : tryStop();
  };
  document.addEventListener("visibilitychange", onVisibility);
  tryStart();

  return () => {
    tryStop();
    ro.disconnect();
    io.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerleave", onPointerLeave);
    try {
      container.removeChild(canvas);
    } catch {}
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
}
