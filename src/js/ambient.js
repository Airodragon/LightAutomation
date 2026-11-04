// Soft volumetric wash for Home hero + screensaver (+ optional Studio preview).
// Vanilla WebGL2 fullscreen quad — no Three.js (direct ES modules, no bundler).
// Honors prefers-reduced-motion with a static CSS gradient fallback.

const PERIODS = {
  dawn:  [1.0, 0.62, 0.42, 0.55, 0.72, 1.0],
  day:   [0.45, 0.78, 1.0, 0.31, 0.82, 0.65],
  dusk:  [1.0, 0.48, 0.32, 0.55, 0.28, 0.72],
  night: [0.31, 0.82, 0.65, 0.22, 0.35, 0.65],
};

const VS = `#version 300 es
in vec2 a;
out vec2 v;
void main(){ v=a*.5+.5; gl_Position=vec4(a,0.,1.); }`;

const FS = `#version 300 es
precision highp float;
in vec2 v;
out vec4 o;
uniform float uT, uEnergy, uHue;
uniform vec3 uA, uB;
void main(){
  vec2 p = v * 2. - 1.;
  p.x *= 1.35;
  float t = uT * .12;
  float n1 = sin(p.x*1.7 + t) * cos(p.y*1.3 - t*.7);
  float n2 = sin(length(p*vec2(1.1,.85)) * 2.4 - t*1.2);
  float n3 = sin((p.x+p.y)*1.9 + t*.5) * .5;
  float field = .55 + .28*n1 + .22*n2 + .12*n3;
  field += uEnergy * .18 * sin(length(p)*4. - t*2.4);
  vec3 col = mix(uA, uB, clamp(field, 0., 1.));
  if (uHue > 0.) {
    float a = uHue * 6.2831853;
    vec3 tint = .5 + .5 * cos(a + vec3(0., 2.094, 4.189));
    col = mix(col, tint, .35);
  }
  float vign = smoothstep(1.55, .35, length(p));
  float alpha = (.22 + uEnergy * .12) * vign;
  o = vec4(col, alpha);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn("[ambient]", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  if (!m) return null;
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

function reducedMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Mount a soft ambient layer into `host`.
 * @param {HTMLElement} host
 * @param {{ fps?: number, className?: string }} [opts]
 * @returns {{ el: HTMLElement, setPeriod, setEnergy, setHue, setColor, pause, resume, destroy }}
 */
export function createAmbient(host, opts = {}) {
  const fps = Math.max(8, Math.min(60, opts.fps || 24));
  const wrap = document.createElement("div");
  wrap.className = opts.className || "ambient-layer";
  wrap.setAttribute("aria-hidden", "true");
  host.prepend(wrap);

  let period = document.documentElement.dataset.period || "night";
  let energy = 0;
  let hue = -1;
  let colorOverride = null;
  let alive = true;
  let paused = false;
  let raf = 0;
  let last = 0;
  let gl = null;
  let prog = null;
  let canvas = null;
  let uT, uEnergy, uHue, uA, uB;

  function paintStatic() {
    const p = PERIODS[period] || PERIODS.night;
    const a = colorOverride || [p[0], p[1], p[2]];
    const b = [p[3], p[4], p[5]];
    wrap.style.background = `radial-gradient(120% 90% at 18% 12%, rgba(${Math.round(a[0]*255)},${Math.round(a[1]*255)},${Math.round(a[2]*255)},.38), transparent 55%),
      radial-gradient(100% 80% at 88% 88%, rgba(${Math.round(b[0]*255)},${Math.round(b[1]*255)},${Math.round(b[2]*255)},.28), transparent 58%),
      transparent`;
  }

  function initGl() {
    if (reducedMotion()) {
      paintStatic();
      return false;
    }
    canvas = document.createElement("canvas");
    canvas.className = "ambient-canvas";
    wrap.append(canvas);
    gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: "low-power" });
    if (!gl) {
      paintStatic();
      return false;
    }
    const vs = compile(gl, gl.VERTEX_SHADER, VS);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) {
      paintStatic();
      return false;
    }
    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      paintStatic();
      return false;
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(prog);
    uT = gl.getUniformLocation(prog, "uT");
    uEnergy = gl.getUniformLocation(prog, "uEnergy");
    uHue = gl.getUniformLocation(prog, "uHue");
    uA = gl.getUniformLocation(prog, "uA");
    uB = gl.getUniformLocation(prog, "uB");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    return true;
  }

  function resize() {
    if (!canvas || !gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.floor(wrap.clientWidth * dpr));
    const h = Math.max(1, Math.floor(wrap.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  function draw(t) {
    if (!gl || !prog) return;
    const p = PERIODS[period] || PERIODS.night;
    const a = colorOverride || [p[0], p[1], p[2]];
    const b = [p[3], p[4], p[5]];
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uT, t * 0.001);
    gl.uniform1f(uEnergy, energy);
    gl.uniform1f(uHue, hue);
    gl.uniform3f(uA, a[0], a[1], a[2]);
    gl.uniform3f(uB, b[0], b[1], b[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function frame(now) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (paused || document.hidden) return;
    const minDelta = 1000 / fps;
    if (now - last < minDelta) return;
    last = now;
    resize();
    draw(now);
  }

  const onVis = () => {
    if (document.hidden) paused = true;
    else if (alive) paused = false;
  };
  document.addEventListener("visibilitychange", onVis);

  const ok = initGl();
  if (ok) raf = requestAnimationFrame(frame);
  else paintStatic();

  const api = {
    el: wrap,
    setPeriod(p) {
      if (!p || p === period) return;
      period = p;
      if (!gl) paintStatic();
    },
    setEnergy(e) {
      energy = Math.max(0, Math.min(1, Number(e) || 0));
    },
    setHue(h) {
      hue = h == null || h < 0 ? -1 : Math.max(0, Math.min(1, h));
    },
    setColor(hex) {
      colorOverride = hexToRgb(hex);
      if (!gl) paintStatic();
    },
    pause() { paused = true; },
    resume() { paused = false; },
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      if (gl) {
        const ext = gl.getExtension("WEBGL_lose_context");
        ext && ext.loseContext();
      }
      wrap.remove();
      gl = null;
      canvas = null;
    },
  };
  return api;
}
