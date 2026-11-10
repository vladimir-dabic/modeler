/** Minimal stroke icons (24×24, currentColor). */
const PATHS: Record<string, string> = {
  select: 'M6 3.5l12 8.2-5.3 1.1 3 5.6-2.2 1.2-3-5.6L6.6 18z',
  box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12L4 7.5 M12 12v9',
  cylinder: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6',
  line: 'M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z M14.5 6.5l3 3',
  pushpull: 'M4 15l8 4 8-4 M4 15l8-4 8 4 M12 11V3 M9 6l3-3 3 3',
  move: 'M12 3v18 M3 12h18 M9 6l3-3 3 3 M9 18l3 3 3-3 M6 9l-3 3 3 3 M18 9l3 3-3 3',
  rotate: 'M20 12a8 8 0 11-2.3-5.7 M20 4v5h-5',
  tape: 'M3 8h18v8H3z M7 8v3 M11 8v4 M15 8v3 M19 8v4',
  erase: 'M15.5 4l5 5L10 19.5H5.5L3 17a1.4 1.4 0 010-2z M9 9.5l5.5 5.5 M10.5 19.5H21',
  orbit: 'M12 4.5c4.7 0 8.5 3.4 8.5 7.5s-3.8 7.5-8.5 7.5 M12 19.5c-4.7 0-8.5-3.4-8.5-7.5 0-2.4 1.3-4.6 3.4-6 M6.9 3v3h3 M12 11.2a.8.8 0 110 1.6.8.8 0 010-1.6z',
  pan: 'M8 13V6.5a1.5 1.5 0 013 0V11 M11 11V4.5a1.5 1.5 0 013 0V11 M14 11V6a1.5 1.5 0 013 0v7.5c0 4-2.6 7-6.2 7-2.6 0-4.3-1.4-5.7-3.6L3.4 12.6a1.5 1.5 0 012.5-1.6L8 13.5',
  undo: 'M9 14L4 9l5-5 M4 9h11a5 5 0 010 10h-3',
  redo: 'M15 14l5-5-5-5 M20 9H9a5 5 0 000 10h3',
  new: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z M14 3v5h5 M12 11v6 M9 14h6',
  open: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  save: 'M5 3h11l3 3v13a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z M7 3v5h8V3 M7 21v-7h10v7',
  export: 'M12 3v12 M7 10l5 5 5-5 M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2',
  extents: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5 M9 9h6v6H9z',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12 M9 7V4h6v3',
  duplicate: 'M8 8h11v11H8z M16 8V5H5v11h3',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M12 9a3 3 0 110 6 3 3 0 010-6z',
  eyeOff: 'M3 3l18 18 M10.6 5.1A10.4 10.4 0 0112 5c6.4 0 10 7 10 7a17.6 17.6 0 01-3.2 4.2 M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7c1.9 0 3.6-.6 5.1-1.5 M9.9 9.9a3 3 0 004.2 4.2',
  ground: 'M4 20h16 M12 4v11 M8 11l4 4 4-4',
  hole: 'M12 3a9 9 0 110 18 9 9 0 010-18z M12 8.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7z',
  shape: 'M4 18l3-12 7 3 6-4-2 13z',
  ai: 'M10 3l1.8 5.2L17 10l-5.2 1.8L10 17l-1.8-5.2L3 10l5.2-1.8z M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9z',
  drawing: 'M3 4h18v16H3z M3 11h7v9 M10 4v3 M14 11h7 M14 11v3',
  keyboard: 'M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M19 10h.01 M7 14h10',
  print: 'M6 3h12v5H6z M4 8h16v9H4z M7 17v4h10v-4 M9 12h6 M17 11h.01',
  saw: 'M3 15l12-12 6 6-12 12z M6 12l1.5 1.5 M9 9l1.5 1.5 M12 6l1.5 1.5 M15 15l3 3',
  house: 'M3 11l9-7 9 7 M5 9.5V20h14V9.5 M10 20v-6h4v6',
  group: 'M3 7V4h3 M18 4h3v3 M21 17v3h-3 M6 20H3v-3 M7 8h6v6H7z M11 11h6v6h-6z',
  ungroup: 'M4 4h7v7H4z M13 13h7v7h-7z M14 7h3v3 M7 14v3h3',
  openGroup: 'M4 6h6l2 2h8v10H4z M12 13h5 M15 11l2 2-2 2',
  help: 'M12 3a9 9 0 110 18 9 9 0 010-18z M9.5 9.5a2.5 2.5 0 015 .5c0 1.7-2.5 2-2.5 3.5 M12 17v.01',
};

export function icon(name: string, size = 20): string {
  const d = PATHS[name] ?? PATHS.help;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
