# User guide

Everything is stored in **millimetres** internally. The display unit (mm / cm / m / in) is chosen in the top bar. You can always type a unit explicitly: `60cm`, `3/4"`, `2' 6"`, `5 1/2in`.

## Workspaces

Pick a workspace from the switch next to the logo, or from the start card in an empty model. It's saved with each project, and you can change it any time. Switching changes units, snap, colours and panels; it never changes your model.

| | **Print** | **Workshop** | **Build** |
|---|---|---|---|
| For | 3D-printed parts | woodworking, furniture | houses, rooms, gardens |
| Units / snap | mm, 0.5 mm | mm, 1 mm | cm, 1 cm |
| Ground | your printer's bed and build volume | floor | floor, with a 1.75 m person for scale |
| Colours | filament | wood and sheet materials | plaster, concrete, brick, glass… |
| Side panels | Properties, **Print**, Objects | Properties, **Cut list**, Objects | Properties, **Quantities**, Cut list, Objects |

The snap step you set is remembered per workspace.

### Print

- **Printer:** choose a profile (Bambu Lab, Prusa, Creality, Elegoo, Anycubic, Voron) or *Custom size*. Check your printer's spec sheet if unsure. The bed's front-left corner is the origin, as in slicers.
- **Fit check:** parts that are off the bed, too tall, below the bed, or floating turn red, and so does the build volume when something is outside it. The Print tab lists each problem; click a name to jump to the part.
- **Place on plate:** centres the selection (or everything) on the bed and sets it down on z = 0.
- **Volume and weight:** the volume has holes removed; the weight is for the filament you pick, at **100 % infill**. Your slicer's estimate will be lower.

### Workshop

- The **Cut list** tab groups identical parts by thickness × width × length. It uses each part's own dimensions, so rotated boards still list correctly. *Export CSV* saves it for the workshop.

### Build

- The **Quantities** tab lists each object's footprint (m², seen from above) and volume (m³, with door and window openings removed), plus totals.

## Tools

Default keys are shown; all of them can be changed (see [Shortcuts](#shortcuts)).

| Tool | Key | How |
|---|---|---|
| Select | `Space` | Click an object (a whole group selects as one; double-click opens it); ⌘/Ctrl-click adds or removes. Drag left→right to select objects fully inside the box, right→left to select anything it touches |
| Box | `B` | Click a corner, click the opposite corner, move up and click for the height. Works on any face |
| Cylinder | `C` | Click the centre, then the radius, then the height. Type `d8` for an 8 mm diameter |
| Line / Shape | `L` | Click points to draw an outline; click the first point (or press Enter) to close it, then set the thickness. Backspace removes the last point |
| Push/Pull | `P` | Click (or drag) a face. Boxes: any face. Cylinders: top/bottom (height) or the side (radius). Shapes: top or bottom |
| Move / Copy | `M` | Click a base point (corners snap), then the destination. Tap `Alt/Option` to copy |
| Rotate | `Q` | Click the pivot, then a reference direction, then the angle (snaps every 15°) |
| Tape measure | `T` | Click two points; Δx/Δy/Δz show in the status bar |
| Eraser | `E` | Click an object to delete it |
| Orbit / Pan | `O` / `H` | Left-drag orbits or pans (handy on a trackpad) |

### Snapping

Points snap, in this order of priority, to:
1. corners, centres and edge midpoints of existing parts (a coloured dot and label show which);
2. faces under the cursor;
3. the ground.

Free points are rounded to the snap step (top bar, toggle with `G`). Arrow keys lock an axis or drawing plane: **→ red (X)**, **← green (Y)**, **↑/↓ blue (Z)**.

### Groups

- **Make a group:** select parts and press `⌘/Ctrl+G` (or right-click → *Group*). A group selects, moves, rotates and copies as one; copying a group makes a new group (`Drawer` → `Drawer 2`). Groups can contain groups.
- **Select:** clicking any part of a group selects the whole group. Its properties show its name (editable), part count, bounds, and corner position (type to move the whole group).
- **Edit inside:** double-click (or *Open group*) to edit inside. A badge at the top shows which group is open, and everything else fades back. Click outside the group, or press `Esc` (twice if something is selected), to close it.
- **Ungroup:** `⇧⌘/Ctrl+Shift+G` dissolves a group; its parts stay where they are.
- **Objects tab:** shows the groups as a tree. Click a group to select it, double-click to open it, ▸/▾ to fold it, and the eye to hide or show the whole group.

### Right-click menu

**Right-click** a part or group for:
- Duplicate, Group, Ungroup, Open group;
- Make hole / Make solid, Place on ground (Print: Place on plate);
- Zoom to selection, Hide, Delete.

**Right-click empty space** for Select all, Zoom extents, Show all hidden, Close group, and standard views. Each item shows its shortcut. A right-*drag* still pans; only a click opens the menu.

### Holes

Draw a box or cylinder on a face and push it **into** the face: it becomes a hole automatically. Tap `Alt/Option` while drawing to toggle solid/hole. Any part can also be switched between *Solid* and *Hole* in Properties. Holes are subtracted from every solid they overlap, both on screen and in the STL.

## Typing measurements

While a tool is active, just start typing digits; they go into the measurement box (bottom right). Press Enter to apply.

| Situation | Type | Means |
|---|---|---|
| Box, after the first corner | `600,400` | width, depth; then type the height |
| Box, all at once | `600,400,18` | width, depth, height |
| Cylinder radius | `5` or `d10` | radius 5, or diameter 10 |
| Line | `120` / `30,40` | segment length in the current direction / offset dx,dy |
| Push/Pull | `25` | move the face 25 out (negative goes in) |
| Move | `100` / `0,0,50` | distance in the current direction / offset x,y,z |
| Move after a copy | `5x` / `/5` | array of 5 copies / 5 copies spread evenly over the distance |
| Rotate | `90` / `-45` | angle in degrees |

Right after finishing an operation, typing a new value **changes that last operation**, like in SketchUp.

## Navigation

- **Scroll / pinch:** zoom toward the point under the cursor. It slows down near surfaces and never passes through them or the floor.
- **Middle-drag:** orbit. **Right-drag:** pan.
- **Hold Shift + drag:** pan, with any tool. **Hold Alt/Option + drag:** orbit, with any tool. Let go and you're back in your tool, even halfway through drawing. A quick *tap* of Alt/Option (no drag) keeps its tool meaning (copy / hole).
- `Z` zooms to fit everything, `Shift+Z` zooms to the selection, and the top-bar buttons give standard views (Iso, Top, Front, Right, Left, Back) and perspective/orthographic.
- Orbiting below the floor hides the grid, so you see the model's underside.

## Shortcuts

Press `?` (or the keyboard button, top right) for the full list.
- **Change a key:** click it and press the new combination.
- **Manage keys:** × removes one, + adds another, ↺ resets a row, and *Reset all to defaults* restores everything.
- **Hold keys:** choose which key pans and which orbits while held (Shift / Alt / Ctrl / Off).
- **Not bindable:** digits and symbols (they start a measurement), Esc, Enter and the arrow keys.
- **Keyboard layouts:** with a non-Latin layout (e.g. Cyrillic), shortcuts follow the physical key position.

Customisations are saved in the browser.

## Reference drawings (DXF import)

Build on top of an existing plan, e.g. an architect's floor plan or a kitchen layout:

1. Click the **plan** button in the top bar (*Import DXF*), or drop a `.dxf` file on the window.
2. The drawing appears on the ground as thin purple lines, and the view zooms to it. The toast shows its size. Check it: if the file doesn't say its units, it is read as mm.
3. Draw on it. Corners, midpoints, and arc/circle centres of the drawing are snap points, so a box clicked from one cabinet corner to the opposite one matches the plan exactly.

In **Objects → Reference drawings**:
- the eye hides the drawing, the bin removes it;
- click the drawing to open it: **Drawn in** changes its units (mm, cm, m, in, ft), and each layer has its own eye;
- layers that were off or frozen in the CAD file start hidden;
- double-click zooms to the drawing.

Everything here is undoable. Reference drawings are saved in the project file, but they are **not part of the model**: they're never selected, cut, exported, or counted in cut lists or volumes.

Supported: lines, polylines (including arcs), circles, arcs, ellipses, splines, solids, and blocks (including nested, scaled, rotated and arrayed). Text, hatches and dimensions are skipped. **DWG files:** save as DXF in your CAD program, or convert with the free *ODA File Converter*.

## AI (Connect AI)

Claude can build and edit your model through the **modeler MCP server** (setup: [mcp/README.md](../mcp/README.md)).

1. Add the server to Claude Code or Claude Desktop (one-time).
2. Click **Connect AI** in the top bar. The button pulses (*Waiting for AI…*) until the server is running, then turns green (*AI connected*).
3. Ask Claude, e.g. *"build a bookcase with 4 shelves"* or *"add M3 screw holes in the corners of the selected part"*.

Claude can also import a DXF from its working folder and read the drawing's lines, e.g. *"import kitchen.dxf and put 600 mm base cabinets along the back wall"*.

Each AI change shows briefly at the bottom (*AI: Bookcase*) and is a normal undo step, so `⌘/Ctrl+Z` takes back exactly one AI action. Claude sees your selection and can render views of the model to check its work. Click the button again to disconnect. Only one tab can be connected; connecting another one takes over.

## Files

- **Autosave:** the model is saved to the browser continuously and restored when you come back.
- **Save / Open:** a `.modeler.json` project (includes the workspace and printer). You can also drag a project file onto the window.
- **New:** starts an empty model in the current workspace. Undo brings the previous one back.
- **STL:** exports the selection, or everything, in mm with holes applied.
- **Cut list CSV:** from the Cut list tab.

Undo/redo: `⌘/Ctrl+Z` and `⇧⌘Z` / `Ctrl+Y`. Duplicate: `⌘/Ctrl+D` (a copy appears beside the original and is selected). Group / Ungroup: `⌘/Ctrl+G` / `⇧⌘/Ctrl+Shift+G`. Delete: `Del` / `Backspace`. Hide and *Show all hidden* are in the right-click menu (and bindable).
