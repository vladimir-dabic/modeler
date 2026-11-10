import type { CommandDef } from './keymap';

/**
 * Every keyboard-bindable command, with its default keys (SketchUp-like where possible).
 * The App maps ids to actions; the shortcuts dialog lists them by category.
 */
export const COMMANDS: CommandDef[] = [
  { id: 'tool.select', label: 'Select', category: 'Tools', keys: ['Space'] },
  { id: 'tool.box', label: 'Box', category: 'Tools', keys: ['B'] },
  { id: 'tool.cylinder', label: 'Cylinder', category: 'Tools', keys: ['C'] },
  { id: 'tool.line', label: 'Line / Shape', category: 'Tools', keys: ['L'] },
  { id: 'tool.pushpull', label: 'Push/Pull', category: 'Tools', keys: ['P'] },
  { id: 'tool.move', label: 'Move / Copy', category: 'Tools', keys: ['M'] },
  { id: 'tool.rotate', label: 'Rotate', category: 'Tools', keys: ['Q'] },
  { id: 'tool.tape', label: 'Tape Measure', category: 'Tools', keys: ['T'] },
  { id: 'tool.erase', label: 'Eraser', category: 'Tools', keys: ['E'] },
  { id: 'tool.orbit', label: 'Orbit', category: 'Tools', keys: ['O'] },
  { id: 'tool.pan', label: 'Pan', category: 'Tools', keys: ['H'] },

  { id: 'edit.undo', label: 'Undo', category: 'Edit', keys: ['Mod+Z'] },
  { id: 'edit.redo', label: 'Redo', category: 'Edit', keys: ['Mod+Shift+Z', 'Mod+Y'] },
  { id: 'edit.delete', label: 'Delete selection', category: 'Edit', keys: ['Delete', 'Backspace'] },
  { id: 'edit.duplicate', label: 'Duplicate selection', category: 'Edit', keys: ['Mod+D'] },
  { id: 'edit.selectAll', label: 'Select all', category: 'Edit', keys: ['Mod+A'] },
  { id: 'edit.group', label: 'Group selection', category: 'Edit', keys: ['Mod+G'] },
  { id: 'edit.ungroup', label: 'Ungroup', category: 'Edit', keys: ['Mod+Shift+G'] },
  { id: 'edit.openGroup', label: 'Open group (edit inside)', category: 'Edit', keys: [] },
  { id: 'edit.closeGroup', label: 'Close group', category: 'Edit', keys: [] },
  { id: 'edit.hide', label: 'Hide selection', category: 'Edit', keys: [] },
  { id: 'edit.showHidden', label: 'Show all hidden', category: 'Edit', keys: [] },
  { id: 'edit.placeOnGround', label: 'Place selection on ground', category: 'Edit', keys: [] },
  { id: 'edit.toggleHole', label: 'Toggle solid / hole', category: 'Edit', keys: [] },

  { id: 'view.extents', label: 'Zoom extents', category: 'View', keys: ['Z'] },
  { id: 'view.zoomSelection', label: 'Zoom to selection', category: 'View', keys: ['Shift+Z'] },
  { id: 'view.iso', label: 'Iso view', category: 'View', keys: [] },
  { id: 'view.top', label: 'Top view', category: 'View', keys: [] },
  { id: 'view.front', label: 'Front view', category: 'View', keys: [] },
  { id: 'view.right', label: 'Right view', category: 'View', keys: [] },
  { id: 'view.left', label: 'Left view', category: 'View', keys: [] },
  { id: 'view.back', label: 'Back view', category: 'View', keys: [] },
  { id: 'view.bottom', label: 'Bottom view', category: 'View', keys: [] },
  { id: 'view.projection', label: 'Toggle perspective / ortho', category: 'View', keys: [] },
  { id: 'view.xray', label: 'Toggle X-ray', category: 'View', keys: [] },
  { id: 'view.cuts', label: 'Toggle hole cut preview', category: 'View', keys: [] },
  { id: 'view.snap', label: 'Toggle snapping', category: 'View', keys: ['G'] },

  { id: 'file.new', label: 'New model', category: 'File', keys: [] },
  { id: 'file.open', label: 'Open project…', category: 'File', keys: ['Mod+O'] },
  { id: 'file.save', label: 'Save project', category: 'File', keys: ['Mod+S'] },
  { id: 'file.importDxf', label: 'Import DXF drawing (reference)…', category: 'File', keys: [] },
  { id: 'file.exportStl', label: 'Export STL', category: 'File', keys: ['Mod+E'] },
  { id: 'file.exportCutList', label: 'Export cut list (CSV)', category: 'File', keys: [] },

  { id: 'workspace.print', label: 'Print workspace (3D printing)', category: 'Workspace', keys: [] },
  { id: 'workspace.workshop', label: 'Workshop workspace (woodworking)', category: 'Workspace', keys: [] },
  { id: 'workspace.build', label: 'Build workspace (houses)', category: 'Workspace', keys: [] },
  { id: 'print.placeOnPlate', label: 'Place on print plate', category: 'Workspace', keys: [] },

  { id: 'ai.connect', label: 'Connect / disconnect AI (MCP bridge)', category: 'AI', keys: [] },

  { id: 'help.shortcuts', label: 'Keyboard shortcuts', category: 'Help', keys: ['?'] },
];
