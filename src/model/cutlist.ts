import * as THREE from 'three';
import { localBounds } from './geometry';
import type { Entity, Unit } from './types';
import { bandingText } from './parts';
import { formatLength } from './units';

export interface CutListRow {
  names: string[];
  quantity: number;
  /** Dimensions in mm, sorted so thickness <= width <= length. */
  thickness: number;
  width: number;
  length: number;
  note: string;
  /** Part properties (ADR 0025), when set. */
  material?: string;
  banding?: string;
}

/**
 * Group identical parts. Dimensions come from each part's own (local) frame,
 * so a rotated board still reports its true size.
 */
export function buildCutList(entities: Entity[]): CutListRow[] {
  const rows = new Map<string, CutListRow>();
  for (const e of entities) {
    if (e.hole || !e.visible) continue;
    let dims: number[];
    let note = '';
    if (e.kind === 'box') {
      dims = [...e.size];
    } else if (e.kind === 'cylinder' || e.kind === 'sphere' || e.kind === 'revolve' || e.kind === 'tube') {
      const size = localBounds(e).getSize(new THREE.Vector3());
      dims = [size.x, size.y, size.z];
      note = e.kind === 'tube' ? 'tube (bounding box)' : 'round';
    } else {
      const size = localBounds(e).getSize(new THREE.Vector3());
      dims = [size.x, size.y, size.z];
      note = 'shape (bounding box)';
    }
    dims.sort((a, b) => a - b);
    const [thickness, width, length] = dims.map((d) => Math.round(d * 100) / 100);
    const banding = bandingText(e.banding);
    const key = `${thickness}|${width}|${length}|${note}|${e.material ?? ''}|${banding}`;
    const row = rows.get(key);
    if (row) {
      row.quantity++;
      if (!row.names.includes(e.name)) row.names.push(e.name);
    } else {
      rows.set(key, { names: [e.name], quantity: 1, thickness, width, length, note, ...(e.material ? { material: e.material } : {}), ...(banding ? { banding } : {}) });
    }
  }
  return [...rows.values()].sort(
    (a, b) => (a.material ?? '').localeCompare(b.material ?? '') || b.thickness - a.thickness || b.length - a.length || b.width - a.width,
  );
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function cutListToCsv(rows: CutListRow[], unit: Unit): string {
  const header = ['Part', 'Qty', `Thickness (${unit})`, `Width (${unit})`, `Length (${unit})`, 'Material', 'Edge banding', 'Notes'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.names.join(' / '),
        String(r.quantity),
        formatLength(r.thickness, unit, false),
        formatLength(r.width, unit, false),
        formatLength(r.length, unit, false),
        r.material ?? '',
        r.banding ?? '',
        r.note,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}
