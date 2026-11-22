import * as THREE from 'three';
import { buildCutGeometry, cuttersFor } from './csg';
import { entityMatrix } from './geometry';
import type { Entity, Group } from './types';

/**
 * GLB (binary glTF 2.0) export, DOM-free so the MCP server can run it headless (ADR 0014,
 * ADR 0020). Built from the export scene:
 * - one node per visible solid, holes cut, its pivot and rotation kept as the node transform;
 * - one node per group (no transform) following the group tree, so SketchUp and Blender
 *   get the same nesting and names as the Objects panel;
 * - one material per colour, shared by every part that uses it.
 * Units and axes are converted explicitly: our millimetres, Z-up become glTF's metres, Y-up
 * (x, y, z) → (x, z, −y) ÷ 1000.
 */

export interface GlbExport {
  data: Uint8Array;
  parts: number;
  groups: number;
  materials: number;
  triangles: number;
}

const MM_TO_M = 0.001;
/** Z-up → Y-up: −90° about X. */
const AXES = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
/** The full conversion C = scale · axes, applied to vertex data. */
const CONVERT = new THREE.Matrix4().makeScale(MM_TO_M, MM_TO_M, MM_TO_M).multiply(AXES);
const CONVERT_INV = CONVERT.clone().invert();

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const TRIANGLES = 4;

interface GltfNode {
  name: string;
  children?: number[];
  mesh?: number;
  translation?: number[];
  rotation?: number[];
  extras?: Record<string, unknown>;
}

/** sRGB hex → linear RGB, as glTF's baseColorFactor expects. */
function linearColor(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return Math.round((s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * 1e5) / 1e5;
  };
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
}

const round = (v: number) => {
  const r = Math.round(v * 1e9) / 1e9;
  return Object.is(r, -0) ? 0 : r;
};

class BinaryWriter {
  private chunks: Uint8Array[] = [];
  length = 0;

  /** Append 4-byte aligned data and return its offset. */
  add(bytes: Uint8Array): number {
    const offset = this.length;
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    return offset;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}

/**
 * Binary glTF of the visible solids in `targets`, with every visible hole in `all` cut.
 * Null when there is nothing to export.
 */
export function exportGlb(targets: Entity[], all: Entity[], groups: Group[], options: { name?: string } = {}): GlbExport | null {
  const solids = targets.filter((e) => e.visible && !e.hole);
  if (!solids.length) return null;
  const holes = all.filter((e) => e.hole && e.visible);
  const boundsCache = new Map<string, THREE.Box3>();

  const bin = new BinaryWriter();
  const json = {
    asset: { version: '2.0', generator: 'Modeler' },
    scene: 0,
    scenes: [{ name: options.name || 'Model', nodes: [] as number[] }],
    nodes: [] as GltfNode[],
    meshes: [] as object[],
    materials: [] as object[],
    accessors: [] as object[],
    bufferViews: [] as object[],
    buffers: [] as object[],
  };
  const materialByColor = new Map<string, number>();
  let triangles = 0;

  const view = (bytes: Uint8Array, target: number) => {
    json.bufferViews.push({ buffer: 0, byteOffset: bin.add(bytes), byteLength: bytes.byteLength, target });
    return json.bufferViews.length - 1;
  };
  const accessor = (a: object) => {
    json.accessors.push(a);
    return json.accessors.length - 1;
  };

  // Named by the part's material where it has one (ADR 0025), so a renderer can swap it once.
  const materialFor = (color: string, material?: string) => {
    const hex = color.toLowerCase();
    const key = `${material ?? ''}|${hex}`;
    let index = materialByColor.get(key);
    if (index === undefined) {
      const [r, g, b] = linearColor(hex);
      const sameName = material && [...materialByColor.keys()].some((k) => k.startsWith(`${material}|`));
      json.materials.push({
        name: material ? (sameName ? `${material} ${hex}` : material) : `Colour ${hex}`,
        pbrMetallicRoughness: { baseColorFactor: [r, g, b, 1], metallicFactor: 0, roughnessFactor: 0.8 },
      });
      index = json.materials.length - 1;
      materialByColor.set(key, index);
    }
    return index;
  };

  const meshFor = (entity: Entity): number | null => {
    const { geometry } = buildCutGeometry(entity, cuttersFor(entity, holes, groups, boundsCache));
    const g = geometry.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(CONVERT); // also transforms (and renormalises) the normals
    const position = g.attributes.position as THREE.BufferAttribute;
    const normal = g.attributes.normal as THREE.BufferAttribute;
    if (!position || position.count < 3) return null;

    const positions = new Float32Array(position.count * 3);
    const normals = new Float32Array(position.count * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < position.count; i++) {
      for (let k = 0; k < 3; k++) {
        const v = position.getComponent(i, k);
        positions[i * 3 + k] = v;
        normals[i * 3 + k] = normal.getComponent(i, k);
      }
    }
    // min/max must match the stored float32 values exactly.
    for (let i = 0; i < positions.length; i++) {
      const k = i % 3;
      if (positions[i] < min[k]) min[k] = positions[i];
      if (positions[i] > max[k]) max[k] = positions[i];
    }
    const attributes = {
      POSITION: accessor({ bufferView: view(new Uint8Array(positions.buffer), ARRAY_BUFFER), componentType: FLOAT, count: position.count, type: 'VEC3', min, max }),
      NORMAL: accessor({ bufferView: view(new Uint8Array(normals.buffer), ARRAY_BUFFER), componentType: FLOAT, count: position.count, type: 'VEC3' }),
    };
    const primitive: Record<string, unknown> = { attributes, material: materialFor(entity.color, entity.material), mode: TRIANGLES };
    if (g.index) {
      const indices = Uint32Array.from(g.index.array as ArrayLike<number>);
      primitive.indices = accessor({ bufferView: view(new Uint8Array(indices.buffer), ELEMENT_ARRAY_BUFFER), componentType: UNSIGNED_INT, count: indices.length, type: 'SCALAR' });
      triangles += indices.length / 3;
    } else {
      triangles += position.count / 3;
    }
    json.meshes.push({ name: entity.name, primitives: [primitive] });
    return json.meshes.length - 1;
  };

  // Node transform: C · M · C⁻¹ keeps the part's pivot and rotation (a rigid transform,
  // translation in metres) while the vertices carry the conversion.
  const partNode = (entity: Entity): number | null => {
    const mesh = meshFor(entity);
    if (mesh === null) return null;
    const m = CONVERT.clone().multiply(entityMatrix(entity)).multiply(CONVERT_INV);
    const t = new THREE.Vector3();
    const q = new THREE.Quaternion();
    m.decompose(t, q, new THREE.Vector3());
    const node: GltfNode = { name: entity.name, mesh, extras: { id: entity.id } };
    if (t.lengthSq() > 0) node.translation = t.toArray().map(round);
    if (Math.abs(q.w) < 1 - 1e-12) node.rotation = q.toArray().map(round);
    json.nodes.push(node);
    return json.nodes.length - 1;
  };

  // The group tree, limited to groups that contain an exported part.
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const groupNodes = new Map<string, number>();
  const groupNode = (id: string): number | null => {
    const existing = groupNodes.get(id);
    if (existing !== undefined) return existing;
    const group = groupById.get(id);
    if (!group) return null;
    json.nodes.push({ name: group.name, children: [], extras: { id: group.id, group: true } });
    const index = json.nodes.length - 1;
    groupNodes.set(id, index);
    attach(index, group.parentId);
    return index;
  };
  const attach = (node: number, parentGroup: string | undefined) => {
    const parent = parentGroup ? groupNode(parentGroup) : null;
    if (parent === null) json.scenes[0].nodes.push(node);
    else json.nodes[parent].children!.push(node);
  };

  for (const entity of solids) {
    const node = partNode(entity);
    if (node !== null) attach(node, entity.groupId);
  }
  if (!json.meshes.length) return null;

  json.buffers.push({ byteLength: bin.length });
  return {
    data: packGlb(json, bin.bytes()),
    parts: json.meshes.length,
    groups: groupNodes.size,
    materials: json.materials.length,
    triangles,
  };
}

function packGlb(json: object, bin: Uint8Array): Uint8Array {
  let text = JSON.stringify(json);
  while (new TextEncoder().encode(text).byteLength % 4) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
  const total = 12 + 8 + jsonBytes.byteLength + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.byteLength, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  const binAt = 20 + jsonBytes.byteLength;
  dv.setUint32(binAt, bin.byteLength, true);
  dv.setUint32(binAt + 4, 0x004e4942, true); // 'BIN'
  out.set(bin, binAt + 8);
  return out;
}

/** Read back a GLB's JSON chunk (tests and the smoke test). */
export function readGlbJson(data: Uint8Array): any {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB file');
  const length = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(data.subarray(20, 20 + length)));
}
