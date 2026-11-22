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
- **Volume and weight:** the volume has holes removed, and overlapping parts count once. The weight is for the filament you pick, at **100 % infill**; your slicer's estimate will be lower.
- **STL export** fuses everything it exports into **one watertight solid**: overlapping parts merge, separate parts stay separate pieces. You never need a "merge" step.
- **Split for printing:** right-click a part or group → *Split for printing* cuts it horizontally through the middle into two pieces, *Name 1* and *Name 2*:
  - the upper piece is lifted 10 mm so you can see the cut;
  - the lower piece gets **pegs** (Ø5 mm by default, smaller on thin walls) and the upper one matching holes 0.2 mm larger, so they line up and glue;
  - the halves that are cut away are quiet helper holes, visible only when selected;
  - one undo brings the original back.
  
  To cut elsewhere, along X/Y, or with other peg sizes, ask Claude (`split_for_print { at, axis, pegs, peg_diameter, clearance }`).

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
| Cylinder | `C` | Click the centre, then the radius, then the height. Type `d8` for an 8 mm diameter. For a **cone**, set *Top ⌀* in Properties (0 = pointed, larger than the base = a countersink when it's a hole) |
| Sphere | — | Click where it should sit (the ground or a face), move to size it and click, or type a radius (`d40` = 40 mm diameter). For an **egg / ellipsoid**, give it different diameters in Properties |
| Line / Shape | `L` | Click points to draw an outline; click the first point (or press Enter) to close it, then set the thickness. Backspace removes the last point |
| Push/Pull | `P` | Click (or drag) a face. Boxes: any face. Cylinders: top/bottom (height) or the side (radius). Shapes: top or bottom |
| Move / Copy | `M` | Click a base point (corners snap), then the destination. Tap `Alt/Option` to copy |
| Rotate | `Q` | Click the pivot, then a reference direction, then the angle (snaps every 15°) |
| Tape measure | `T` | Click two points; Δx/Δy/Δz show in the status bar |
| Dimension | `D` | Click two points (corners snap; arrow keys measure along one axis), move to place the dimension line, click. See [Notes and dimensions](#notes-and-dimensions) |
| Text / note | `N` | Click a part (or anywhere), move to place the text and click (same spot = no leader line), type, Enter |
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

**Holes in a group** can be limited to that group: tick *Cuts only its own group* in Properties. For example, a pocket in the lid of a box then won't cut the base under it. Holes are exact and watertight (the Manifold engine), even when they're flush with a surface.

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

### Exploded view

**Explode** in the top bar (`X`) pulls the model apart, so you can see every piece and how it fits together. The base stays on the floor and the other parts rise and spread above it, on a clean background (no grid, axes, bed or plans):
- **Every part comes apart:** assemblies (groups) first move apart side by side, then the parts of each one come apart around it. Legs move out, and parts that sit on or inside each other (a top in its rim, a lid on a box) are lifted off one above the other. **Open a group** (double-click) to take only that one apart.
- **The panel at the top right:** the slider sets how far apart, *All / X / Y / Z* limits the direction (Z just lifts parts up and down), and × puts it back together.
- **It's only a view.** Nothing moves in the model, there is nothing to undo, and saving and exporting use the assembled model. Notes and dimensions hide while exploded.
- **Look only:**
  - **Works while exploded:** select, orbit, pan, zoom, open groups, export.
  - **Refused, with a hint:** Delete, undo, typing in Properties, and right-click edits.
  - **Puts it back together first:** picking a drawing or editing tool, New, Open or Import.
- If Claude changes something while it's exploded, the view reassembles first so you see the change in place.

Claude can show it too (*"explode the cabinet"*), or render exploded images to check its work without changing your view.

## Shortcuts

Press `?` (or the keyboard button, top right) for the full list.
- **Change a key:** click it and press the new combination.
- **Manage keys:** × removes one, + adds another, ↺ resets a row, and *Reset all to defaults* restores everything.
- **Hold keys:** choose which key pans and which orbits while held (Shift / Alt / Ctrl / Off).
- **Not bindable:** digits and symbols (they start a measurement), Esc, Enter and the arrow keys.
- **Keyboard layouts:** with a non-Latin layout (e.g. Cyrillic), shortcuts follow the physical key position.

Customisations are saved in the browser.

### Rounded and smooth parts

- **Round edges:** a box's *Round edges* field in Properties rounds every edge and corner (printed enclosures, soft blocks).
- **Revolved shapes** (vases, cups, knobs, turned legs) and **tubes** (handles, tails, cables, rails: smooth through a list of points, optionally tapering) are created through the API, so ask Claude over MCP, e.g. *"add a cup 90 mm tall"* or *"a handle tube from here to there"*. Once they exist, you can move, rotate, copy, mirror, colour and cut them like any part, and change a tube's diameter in Properties.

## Build instructions

**Instructions** in the toolbar opens an IKEA-style booklet of the model, to build it yourself or send it to a craftsman:
- a cover with a picture and the overall size;
- every part with a letter (identical parts share one), a picture, the quantity and its size, plus a cut list table;
- the assembly steps, with pictures: parts already in place are grey, new ones are in colour with arrows and letters;
- a "Done!" page.

How to use it:
- **Print / Save PDF** prints it, or saves it as a PDF to send.
- **Steps:** until someone writes them, they're suggested bottom-up, one per kind of part. Click any step text (or the title, or the description under it) to change it. `Enter` saves, `Esc` reverts, and every edit can be undone.
- **With Claude:** ask it to write the steps, e.g. *"write the build instructions in Serbian for a beginner"*. It sets the order and one short sentence per step, and the open booklet updates.
- **Language:** the headings can be English or Srpski (the language menu).
- **Names:** name your parts well ("Leg", "Shelf"), because the names appear in the booklet.

## Notes and dimensions

Annotations explain the model to whoever builds it. They are **not geometry**: they're never exported, cut or counted.

- **Dimension (`D`):**
  1. Click two points. Corners, midpoints and centres snap; the arrow keys measure along X, Y or Z only.
  2. Move to choose where the dimension line sits, then click.
  
  The value is always measured and shown in the display units.
- **Text (`N`):**
  1. Click a point on a part (or empty space).
  2. Move away to draw a leader line and click. Clicking the same spot gives a plain label.
  3. Type the text and press Enter. Shift+Enter adds a new line.
- **Attached to parts:** dimensions and notes clicked on a part stay attached to it. Move, rotate or resize the part and they follow (a cabinet dimension shows the new width). Delete the part and they go with it. Hide it and they hide too.
- **Edit with the Select tool:**
  - click a label (or a dimension line) to select it;
  - drag it to move the text or slide the dimension line;
  - double-click to edit the text in place; `Del` deletes.
  
  The Properties panel has the text, a dimension's text override (`<>` inserts the measured value, e.g. `<> clear`) and its offset. Objects lists all annotations.
- **Show / hide all:** the *Show / hide notes and dimensions* command (bind it a key in `?`).

Claude can annotate too. For example, *"dimension the cabinet"* adds overall dimensions in one step (`dimension_parts`).

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

Projects are `.modeler.json` files: plain JSON with everything in it (parts, groups, notes and dimensions, reference drawings, workspace, printer). The name of the file you're editing is shown next to *Modeler* in the top bar and in the window title, with a **•** while it has unsaved changes.

- **Save (`⌘/Ctrl+S`):**
  - The first time, it asks where to save. After that it **saves back to the same file**.
  - **In Chrome and Edge**, a project you opened or dropped onto the window also saves back in place. The browser asks once for permission to edit the file.
  - **In Safari and Firefox**, which can't write to files, Save downloads a copy instead.
- **Save as (`⇧⌘/Ctrl+Shift+S`):** saves to a new file, which becomes the current one.
- **Open (`⌘/Ctrl+O`),** or drag a project file onto the window. Opening is one undo step, so `⌘Z` brings back what you had.
- **Open recent:** the **▾** next to Open lists the last 8 projects (Chrome and Edge).
- **Autosave:** the model is also saved to the browser continuously and restored when you come back, still linked to its file, so `⌘S` keeps saving to it.
- **New:** starts an empty, *Untitled* model in the current workspace. Undo brings the previous one back.
- **STL:** exports the selection, or everything, in mm with holes applied.
- **GLB:** for SketchUp (File > Import > glTF Binary), Blender, Twinmotion and other renderers. Exports the selection, or everything: one named object per part, groups nested as in the Objects panel, holes applied, one material per colour, converted to metres.
- **Cut list CSV:** from the Cut list tab.

Undo/redo: `⌘/Ctrl+Z` and `⇧⌘Z` / `Ctrl+Y`. Duplicate: `⌘/Ctrl+D` (a copy appears beside the original and is selected). Group / Ungroup: `⌘/Ctrl+G` / `⇧⌘/Ctrl+Shift+G`. Delete: `Del` / `Backspace`. Hide and *Show all hidden* are in the right-click menu (and bindable).
