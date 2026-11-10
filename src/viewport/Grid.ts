import * as THREE from 'three';

/**
 * Infinite, scale-adaptive ground grid drawn by a shader on the z = 0 plane.
 *
 * Three tiers of lines (s, 10s, 100s) are drawn; s = base × 10ⁿ is picked from the
 * zoom level so the finest lines stay ≥ ~10 px apart. The finest tier fades out
 * continuously as you zoom out, so the step from 1 mm → 10 mm → 100 mm lines has no pop.
 */
export class Grid {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  base = 1;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSpacing: { value: 1 },
        uFade: { value: 0 },
        uColor: { value: new THREE.Color(0x8e98a6) },
        uFar: { value: 1000 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uSpacing;
        uniform float uFade;
        uniform vec3 uColor;
        uniform float uFar;
        varying vec3 vWorld;

        // Anti-aliased line coverage (0..1) for a grid of the given spacing, ~1px wide.
        float lines(vec2 p, float spacing) {
          vec2 coord = p / spacing;
          vec2 deriv = fwidth(coord);
          vec2 g = abs(fract(coord - 0.5) - 0.5) / max(deriv, vec2(1e-6));
          float line = 1.0 - min(min(g.x, g.y), 1.0);
          // Lines closer than ~2px merge into a haze; fade them instead.
          float density = max(deriv.x, deriv.y);
          return line * (1.0 - smoothstep(0.12, 0.33, density));
        }

        void main() {
          vec2 p = vWorld.xy;
          float a0 = lines(p, uSpacing) * 0.22 * (1.0 - uFade);
          float a1 = lines(p, uSpacing * 10.0) * mix(0.22, 0.42, 1.0 - uFade);
          float a2 = lines(p, uSpacing * 100.0) * 0.42;
          float alpha = max(a0, max(a1, a2));
          // Fade toward the horizon.
          float dist = length(vWorld - cameraPosition);
          alpha *= 1.0 - smoothstep(uFar * 0.35, uFar, dist);
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(uColor, alpha);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  /**
   * Re-centre under the view and choose the line spacing.
   * `worldPerPixel` is the size of one screen pixel at the orbit target.
   */
  update(target: THREE.Vector3, distance: number, worldPerPixel: number) {
    const size = Math.max(distance * 60, 2000);
    this.mesh.scale.set(size, size, 1);
    this.mesh.position.set(target.x, target.y, 0);
    const minPx = 14;
    const lod = Math.max(0, Math.log10((worldPerPixel * minPx) / this.base));
    const level = Math.floor(lod);
    this.material.uniforms.uSpacing.value = this.base * 10 ** level;
    this.material.uniforms.uFade.value = lod - level;
    this.material.uniforms.uFar.value = Math.max(distance * 12, 500);
  }
}
