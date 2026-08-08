"use strict";

(() => {
  const GRID_WIDTH = 64;
  const GRID_HEIGHT = 16;
  const SPRING = 0.08;
  const DAMPING = 0.9;
  const STEP = 0.1;
  const FORCE = 2;

  const VERTEX_SOURCE = `#version 300 es
    in vec2 aPosition;
    in vec2 aUv;
    in vec2 aDisplacement;
    out vec2 vUv;
    out float vMagnitude;
    void main() {
      gl_Position = vec4(aPosition + aDisplacement, 0.0, 1.0);
      vUv = aUv;
      vMagnitude = length(aDisplacement);
    }
  `;

  const FRAGMENT_SOURCE = `#version 300 es
    precision highp float;
    in vec2 vUv;
    in float vMagnitude;
    out vec4 outColor;
    uniform sampler2D uTexture;
    uniform vec3 uColorA;
    uniform vec3 uColorB;
    void main() {
      vec4 base = texture(uTexture, vUv);
      float offset = 0.005 * clamp(vMagnitude * 8.0, 0.0, 1.0);
      float alphaA = texture(uTexture, vUv + vec2(offset, 0.0)).a;
      float alphaB = texture(uTexture, vUv - vec2(offset, 0.0)).a;
      vec3 color = base.rgb * base.a;
      color += uColorA * max(0.0, alphaA - base.a);
      color += uColorB * max(0.0, alphaB - base.a);
      outColor = vec4(color, max(base.a, max(alphaA, alphaB)));
    }
  `;

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn("[mesh-text] Shader compilation failed", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn("[mesh-text] Program linking failed", gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    return program;
  }

  function initMeshTitle() {
    const wrapper = document.getElementById("clips-mesh-title");
    const canvas = wrapper?.querySelector("canvas");
    const heading = wrapper?.querySelector("h1");
    if (!wrapper || !canvas || !heading || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: "low-power",
    });
    if (!gl) return;

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    if (!vertexShader || !fragmentShader) return;
    const program = createProgram(gl, vertexShader, fragmentShader);
    if (!program) return;

    const vertexCount = (GRID_WIDTH + 1) * (GRID_HEIGHT + 1);
    const positions = new Float32Array(vertexCount * 2);
    const uvs = new Float32Array(vertexCount * 2);
    const displacement = new Float32Array(vertexCount * 2);
    const velocity = new Float32Array(vertexCount * 2);

    for (let y = 0; y <= GRID_HEIGHT; y += 1) {
      for (let x = 0; x <= GRID_WIDTH; x += 1) {
        const index = y * (GRID_WIDTH + 1) + x;
        const u = x / GRID_WIDTH;
        const v = y / GRID_HEIGHT;
        positions[index * 2] = u * 2 - 1;
        positions[index * 2 + 1] = 1 - v * 2;
        uvs[index * 2] = u;
        uvs[index * 2 + 1] = v;
      }
    }

    const indices = new Uint16Array(GRID_WIDTH * GRID_HEIGHT * 6);
    let cursorIndex = 0;
    for (let y = 0; y < GRID_HEIGHT; y += 1) {
      for (let x = 0; x < GRID_WIDTH; x += 1) {
        const first = y * (GRID_WIDTH + 1) + x;
        const second = first + 1;
        const third = first + GRID_WIDTH + 1;
        const fourth = third + 1;
        indices[cursorIndex++] = first;
        indices[cursorIndex++] = third;
        indices[cursorIndex++] = second;
        indices[cursorIndex++] = second;
        indices[cursorIndex++] = third;
        indices[cursorIndex++] = fourth;
      }
    }

    const vertexArray = gl.createVertexArray();
    gl.bindVertexArray(vertexArray);

    function createAttribute(name, data, usage) {
      const location = gl.getAttribLocation(program, name);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      return buffer;
    }

    const positionBuffer = createAttribute("aPosition", positions, gl.STATIC_DRAW);
    const uvBuffer = createAttribute("aUv", uvs, gl.STATIC_DRAW);
    const displacementBuffer = createAttribute("aDisplacement", displacement, gl.DYNAMIC_DRAW);
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const textureLocation = gl.getUniformLocation(program, "uTexture");
    const colorALocation = gl.getUniformLocation(program, "uColorA");
    const colorBLocation = gl.getUniformLocation(program, "uColorB");
    let destroyed = false;
    let frameId = 0;
    let running = false;
    let visible = true;

    const pointer = { x: 99, y: 99, previousX: 99, previousY: 99, inside: false };

    function rebuildTexture() {
      const buffer = document.createElement("canvas");
      buffer.width = canvas.width;
      buffer.height = canvas.height;
      const context = buffer.getContext("2d");
      if (!context) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const style = getComputedStyle(heading);
      const size = Number.parseFloat(style.fontSize) * dpr;
      context.clearRect(0, 0, buffer.width, buffer.height);
      context.fillStyle = style.color || "#f7f5ff";
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.font = `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`;
      context.fillText(wrapper.dataset.text || heading.textContent || "", 18 * dpr, buffer.height / 2);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(2, Math.round(rect.width * dpr));
      const height = Math.max(2, Math.round(rect.height * dpr));
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      rebuildTexture();
      render();
    }

    function render() {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(textureLocation, 0);
      gl.uniform3f(colorALocation, 0.85, 0.28, 0.94);
      gl.uniform3f(colorBLocation, 0.22, 0.74, 0.97);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(vertexArray);
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
    }

    function start() {
      if (destroyed || running || !visible) return;
      running = true;
      frameId = requestAnimationFrame(tick);
    }

    function tick() {
      if (destroyed || !visible) {
        running = false;
        return;
      }
      let pointerVelocityX = pointer.x - pointer.previousX;
      let pointerVelocityY = pointer.y - pointer.previousY;
      if (Math.hypot(pointerVelocityX, pointerVelocityY) > 0.3) {
        pointerVelocityX = 0;
        pointerVelocityY = 0;
      }
      pointer.previousX = pointer.x;
      pointer.previousY = pointer.y;

      let maximumMotion = 0;
      for (let index = 0; index < vertexCount; index += 1) {
        const offset = index * 2;
        const dx = displacement[offset];
        const dy = displacement[offset + 1];
        const distanceX = pointer.x - (positions[offset] + dx);
        const distanceY = pointer.y - (positions[offset + 1] + dy);
        const distance = Math.hypot(distanceX, distanceY);
        const proximity = Math.max(0, 1 / (1 + distance / 0.05) - 0.1);
        let velocityX = velocity[offset] + pointerVelocityX * FORCE * proximity - dx * SPRING;
        let velocityY = velocity[offset + 1] + pointerVelocityY * FORCE * proximity - dy * SPRING;
        velocityX *= DAMPING;
        velocityY *= DAMPING;
        velocity[offset] = velocityX;
        velocity[offset + 1] = velocityY;
        displacement[offset] = Math.max(-1, Math.min(1, dx + velocityX * STEP));
        displacement[offset + 1] = Math.max(-1, Math.min(1, dy + velocityY * STEP));
        maximumMotion = Math.max(maximumMotion, Math.abs(velocityX), Math.abs(velocityY), Math.abs(dx), Math.abs(dy));
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, displacementBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, displacement);
      render();
      if (pointer.inside || maximumMotion > 0.00008) frameId = requestAnimationFrame(tick);
      else running = false;
    }

    function onPointerMove(event) {
      const rect = wrapper.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const y = 1 - ((event.clientY - rect.top) / rect.height) * 2;
      if (!pointer.inside) {
        pointer.previousX = x;
        pointer.previousY = y;
        pointer.inside = true;
      }
      pointer.x = x;
      pointer.y = y;
      start();
    }

    function onPointerLeave() {
      pointer.inside = false;
      pointer.x = 99;
      pointer.y = 99;
      pointer.previousX = 99;
      pointer.previousY = 99;
      start();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      wrapper.removeEventListener("pointermove", onPointerMove);
      wrapper.removeEventListener("pointerleave", onPointerLeave);
      gl.deleteBuffer(positionBuffer);
      gl.deleteBuffer(uvBuffer);
      gl.deleteBuffer(displacementBuffer);
      gl.deleteBuffer(indexBuffer);
      gl.deleteTexture(texture);
      gl.deleteVertexArray(vertexArray);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(wrapper);
    const intersectionObserver = new IntersectionObserver((entries) => {
      visible = entries.at(-1)?.isIntersecting ?? true;
      if (visible) start();
    });
    intersectionObserver.observe(wrapper);
    wrapper.addEventListener("pointermove", onPointerMove);
    wrapper.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      wrapper.classList.remove("mesh-ready");
      destroy();
    }, { once: true });
    window.addEventListener("pagehide", destroy, { once: true });
    resize();
    rebuildTexture();
    render();
    wrapper.classList.add("mesh-ready");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initMeshTitle, { once: true });
  else initMeshTitle();
})();
