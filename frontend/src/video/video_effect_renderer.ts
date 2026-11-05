import { FRAGMENT_SHADERS, VERTEX_SHADER } from './video_effect_shaders';
import type { ShadedVideoEffect } from './video_effects';

const MAX_CANVAS_PIXELS = 1920 * 1080;
// Keeps sin/hash arguments small for mobile GPUs; a multiple of the VHS band's 12.5 s period so it doesn't jump.
const TIME_WRAP_SEC = 25;
const POSITION_ATTRIBUTE = 0;

type EffectProgram = {
  program: WebGLProgram;
  size: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
};

/** Draws onto a canvas laid over the video: where it's left clear (letterbox, a failure) the video shows through. */
export class VideoEffectRenderer {
  private readonly programs = new Map<ShadedVideoEffect, EffectProgram>();
  private readonly unbuildable = new Set<ShadedVideoEffect>();
  private readonly resizeObserver = new ResizeObserver((entries) => this.resize(entries));
  private video: HTMLVideoElement | undefined;
  private effect: ShadedVideoEffect | undefined;
  private frameRequest: number | undefined;
  private uploadedSize: { width: number; height: number } | undefined;
  private failed = false;
  private buffer: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;

  static create(canvas: HTMLCanvasElement): VideoEffectRenderer | undefined {
    const gl = canvas.getContext('webgl', { antialias: false, depth: false, stencil: false });
    if (gl == null) {
      console.warn('[video] no WebGL; video effects are off');
      return undefined;
    }
    return new VideoEffectRenderer(canvas, gl);
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGLRenderingContext,
  ) {
    this.setUp();
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
    this.resizeObserver.observe(canvas);
  }

  show(video: HTMLVideoElement, effect: ShadedVideoEffect): void {
    if (video !== this.video) {
      this.unfollow();
      this.reset();
      this.video = video;
      video.addEventListener('loadeddata', this.redraw);
      video.addEventListener('seeked', this.redraw);
      video.addEventListener('emptied', this.reset);
    }
    this.effect = effect;
    this.redraw();
  }

  destroy(): void {
    this.unfollow();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    // Not loseContext(): a remount on the same canvas would get the lost context back.
    const { gl } = this;
    for (const { program } of this.programs.values()) gl.deleteProgram(program);
    this.programs.clear();
    gl.deleteTexture(this.texture);
    gl.deleteBuffer(this.buffer);
  }

  private readonly redraw = (): void => {
    this.draw(performance.now());
    this.requestFrame();
  };

  private requestFrame(): void {
    const video = this.video;
    if (video == null || this.frameRequest != null || this.failed || this.gl.isContextLost()) return;
    this.frameRequest = video.requestVideoFrameCallback((now) => {
      this.frameRequest = undefined;
      this.draw(now);
      this.requestFrame();
    });
  }

  private cancelFrame(): void {
    if (this.frameRequest != null) this.video?.cancelVideoFrameCallback(this.frameRequest);
    this.frameRequest = undefined;
  }

  private unfollow(): void {
    this.cancelFrame();
    this.video?.removeEventListener('loadeddata', this.redraw);
    this.video?.removeEventListener('seeked', this.redraw);
    this.video?.removeEventListener('emptied', this.reset);
    this.video = undefined;
  }

  private draw(now: number): void {
    const { gl, video, effect, canvas } = this;
    if (this.failed || video == null || effect == null || gl.isContextLost()) return;
    if (video.readyState < video.HAVE_CURRENT_DATA || video.videoWidth === 0) return;
    const program = this.programFor(effect);
    if (program == null) {
      this.clear();
      return;
    }
    if (!this.upload(video)) return;
    const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport((canvas.width - width) >> 1, (canvas.height - height) >> 1, width, height);
    gl.useProgram(program.program);
    gl.uniform2f(program.size, width, height);
    gl.uniform1f(program.time, (now / 1000) % TIME_WRAP_SEC);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private upload(video: HTMLVideoElement): boolean {
    const { gl, uploadedSize } = this;
    try {
      if (uploadedSize?.width === video.videoWidth && uploadedSize.height === video.videoHeight) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        this.uploadedSize = { width: video.videoWidth, height: video.videoHeight };
      }
      return true;
    } catch (err) {
      // SecurityError: a cross-origin video served without CORS headers can't be read.
      console.error('[video] video effects are off: the video frame could not be read', err);
      this.failed = true;
      this.cancelFrame();
      this.clear();
      return false;
    }
  }

  private readonly reset = (): void => {
    this.failed = false;
    this.clear();
  };

  private clear(): void {
    if (!this.gl.isContextLost()) this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  private resize([entry]: ResizeObserverEntry[]): void {
    const box = entry.devicePixelContentBoxSize?.[0];
    const width = box?.inlineSize ?? entry.contentRect.width * devicePixelRatio;
    const height = box?.blockSize ?? entry.contentRect.height * devicePixelRatio;
    const scale = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(height * scale);
    this.draw(performance.now());
  }

  private setUp(): void {
    const { gl } = this;
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(POSITION_ATTRIBUTE);
    gl.vertexAttribPointer(POSITION_ATTRIBUTE, 2, gl.FLOAT, false, 0, 0);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private programFor(effect: ShadedVideoEffect): EffectProgram | undefined {
    const cached = this.programs.get(effect);
    if (cached != null || this.unbuildable.has(effect)) return cached;
    const program = this.link(FRAGMENT_SHADERS[effect]);
    if (program == null) {
      console.error(`[video] the ${effect} video effect is off: its shader did not build`);
      this.unbuildable.add(effect);
      return undefined;
    }
    const linked = {
      program,
      size: this.gl.getUniformLocation(program, 'u_size'),
      time: this.gl.getUniformLocation(program, 'u_time'),
    };
    this.programs.set(effect, linked);
    return linked;
  }

  private link(fragmentSource: string): WebGLProgram | undefined {
    const { gl } = this;
    const vertex = this.compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = this.compile(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (vertex == null || fragment == null || program == null) return undefined;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, POSITION_ATTRIBUTE, 'a_pos');
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
    console.error(`[video] effect shader failed to link: ${gl.getProgramInfoLog(program)}`);
    gl.deleteProgram(program);
    return undefined;
  }

  private compile(type: GLenum, source: string): WebGLShader | undefined {
    const { gl } = this;
    const shader = gl.createShader(type);
    if (shader == null) return undefined;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    console.error(`[video] effect shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
    gl.deleteShader(shader);
    return undefined;
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.cancelFrame();
    this.programs.clear();
    this.uploadedSize = undefined;
  };

  private readonly handleContextRestored = (): void => {
    this.setUp();
    this.redraw();
  };
}
