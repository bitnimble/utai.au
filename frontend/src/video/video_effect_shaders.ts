import type { ShadedVideoEffect } from './video_effects';

export const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x, -a_pos.y) * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const PRELUDE = `
// No mediump fallback: the hash and frame counters overflow fp16, so a GPU without highp gets no effect.
precision highp float;
uniform sampler2D u_frame;
uniform vec2 u_size;
uniform float u_time;
varying vec2 v_uv;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

float vignette(vec2 uv, float strength) {
  vec2 v = uv * (1.0 - uv);
  return pow(max(v.x * v.y * 16.0, 0.0), strength);
}
`;

const CRT = `
vec2 curve(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  vec2 offset = abs(uv.yx) / vec2(6.0, 5.0);
  uv += uv * offset * offset;
  return uv * 0.5 + 0.5;
}

void main() {
  vec2 uv = curve(v_uv);
  vec2 edge = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  float shift = 1.2 / u_size.x;
  vec3 col = vec3(
    texture2D(u_frame, uv + vec2(shift, 0.0)).r,
    texture2D(u_frame, uv).g,
    texture2D(u_frame, uv - vec2(shift, 0.0)).b
  );
  float scan = 0.7 + 0.3 * sin(uv.y * u_size.y * 2.0944);
  float m = mod(gl_FragCoord.x, 3.0);
  vec3 mask = vec3(0.8) + 0.3 * vec3(step(m, 1.0), step(1.0, m) * step(m, 2.0), step(2.0, m));
  float flicker = 1.0 + 0.015 * sin(u_time * 120.0);
  gl_FragColor = vec4(col * scan * mask * vignette(uv, 0.25) * flicker * 1.45 * edge.x * edge.y, 1.0);
}
`;

const VHS = `
void main() {
  vec2 uv = v_uv;
  float frame = floor(u_time * 30.0);
  float line = floor(uv.y * 240.0);
  uv.x += (hash(vec2(line, frame)) - 0.5) * 0.0025;
  float band = 1.0 - smoothstep(0.0, 0.04, abs(uv.y - 1.0 + fract(u_time * 0.08)));
  uv.x += band * (hash(vec2(line, frame + 7.0)) - 0.5) * 0.03;
  uv.x += smoothstep(0.96, 1.0, uv.y) * 0.02 * hash(vec2(line, frame + 13.0));
  vec3 sharp = texture2D(u_frame, uv).rgb;
  vec3 smeared = 0.5 * (texture2D(u_frame, uv - vec2(0.004, 0.0)).rgb + texture2D(u_frame, uv - vec2(0.009, 0.0)).rgb);
  vec3 col = luma(sharp) + (smeared - luma(smeared)) * 0.85;
  col = col * 0.92 + 0.05;
  col += (hash(gl_FragCoord.xy + frame * 17.0) - 0.5) * 0.07;
  col += band * hash(vec2(gl_FragCoord.x, frame)) * 0.25;
  gl_FragColor = vec4(col, 1.0);
}
`;

const FILM = `
void main() {
  float frame = floor(u_time * 24.0);
  vec2 weave = vec2(0.0, (hash(vec2(frame, 1.0)) - 0.5) * 0.003);
  vec3 col = texture2D(u_frame, v_uv + weave).rgb;
  col = mix(col, luma(col) * vec3(1.07, 0.92, 0.72), 0.7);
  col *= 0.94 + 0.06 * hash(vec2(frame, 2.0));
  float scratch = 1.0 - smoothstep(0.0, 1.5 / u_size.x, abs(v_uv.x - hash(vec2(frame, 3.0))));
  col = mix(col, vec3(0.85, 0.8, 0.7), scratch * step(0.6, hash(vec2(frame, 4.0))) * 0.5);
  col += (hash(gl_FragCoord.xy + frame * 17.0) - 0.5) * 0.1;
  gl_FragColor = vec4(col * vignette(v_uv, 0.3), 1.0);
}
`;

const PIXEL = `
void main() {
  vec2 cells = vec2(256.0, floor(256.0 * u_size.y / u_size.x));
  vec2 cell = floor(v_uv * cells);
  vec2 c = (cell + 0.5) / cells;
  vec2 d = 0.25 / cells;
  vec3 col = 0.25 * (
    texture2D(u_frame, c + d).rgb + texture2D(u_frame, c - d).rgb +
    texture2D(u_frame, c + vec2(d.x, -d.y)).rgb + texture2D(u_frame, c + vec2(-d.x, d.y)).rgb
  );
  vec2 b = mod(cell, 2.0);
  float dither = (2.0 * b.x + 3.0 * b.y - 4.0 * b.x * b.y + 0.5) / 4.0 - 0.5;
  col = floor(clamp(col, 0.0, 1.0) * 3.0 + 0.5 + dither) / 3.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const FRAGMENT_SHADERS: Record<ShadedVideoEffect, string> = {
  crt: PRELUDE + CRT,
  vhs: PRELUDE + VHS,
  film: PRELUDE + FILM,
  pixel: PRELUDE + PIXEL,
};
