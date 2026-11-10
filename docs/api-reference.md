# Modeler API reference

> Generated from `src/api` by `npm run docs:api`. Do not edit by hand: change the operation
> descriptions/schemas in code instead. Design and conventions: [modeler-api.md](modeler-api.md).

All lengths are millimetres, angles degrees, world Z-up. Write operations return `{ ids }` (usable as `$alias` in `apply_operations`).

| Operation | Kind |
|---|---|
| [`get_scene`](#get_scene) | read (no change) |
| [`get_entities`](#get_entities) | read (no change) |
| [`get_selection`](#get_selection) | read (no change) |
| [`measure`](#measure) | read (no change) |
| [`check_print`](#check_print) | read (no change) |
| [`get_cut_list`](#get_cut_list) | read (no change) |
| [`get_quantities`](#get_quantities) | read (no change) |
| [`add_box`](#add_box) | write (one undo step) |
| [`add_cylinder`](#add_cylinder) | write (one undo step) |
| [`add_shape`](#add_shape) | write (one undo step) |
| [`update_entity`](#update_entity) | write (one undo step) |
| [`delete_entities`](#delete_entities) | write (one undo step) |
| [`set_hole`](#set_hole) | write (one undo step) |
| [`set_visible`](#set_visible) | write (one undo step) |
| [`set_color`](#set_color) | write (one undo step) |
| [`move`](#move) | write (one undo step) |
| [`rotate`](#rotate) | write (one undo step) |
| [`place_on_ground`](#place_on_ground) | write (one undo step) |
| [`place_on_plate`](#place_on_plate) | write (one undo step) |
| [`duplicate`](#duplicate) | write (one undo step) |
| [`mirror`](#mirror) | write (one undo step) |
| [`place`](#place) | write (one undo step) |
| [`align`](#align) | write (one undo step) |
| [`distribute`](#distribute) | write (one undo step) |
| [`group`](#group) | write (one undo step) |
| [`ungroup`](#ungroup) | write (one undo step) |
| [`rename_group`](#rename_group) | write (one undo step) |
| [`set_selection`](#set_selection) | read (no change) |
| [`set_workspace`](#set_workspace) | settings (not undoable) |
| [`set_printer`](#set_printer) | settings (not undoable) |
| [`undo`](#undo) | undo / redo |
| [`redo`](#redo) | undo / redo |
| [`render_views`](#render_views) | needs a host capability (async) |
| [`open_file`](#open_file) | needs a host capability (async) |
| [`save_file`](#save_file) | needs a host capability (async) |
| [`export_stl`](#export_stl) | needs a host capability (async) |
| [`apply_operations`](#apply_operations) | write (one undo step) |

## get_scene

*read (no change)*

Overview of the model: workspace, printer, overall bounds and the parts. detail "outline" lists each top-level group as one line (best first call on big models), "compact" (default) one line per part, "full" complete JSON. Lines read: id "name" shape size at x,y,z [hole] in "group".

| Field | Type | Required | Notes |
|---|---|---|---|
| `detail` | "outline" \| "compact" \| "full" |  |  |
| `include_hidden` | boolean |  |  |

## get_entities

*read (no change)*

Full details (sizes, position, rotation, bounds, group) of the targeted parts.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |

## get_selection

*read (no change)*

What the user has selected in the app (ids, lines, and the group if a whole group is selected). Use it to resolve "this", "these", "the selected part".

No input.

## measure

*read (no change)*

Distance between two points, or the gap between two targets per axis (0 = touching or overlapping on that axis) and between their centres.

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | [number, number, number] |  | [x, y, z] in mm |
| `to` | [number, number, number] |  | [x, y, z] in mm |
| `between` | [{ ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group }, { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group }] |  |  |

## check_print

*read (no change)*

Print readiness: printer, problems (off the bed, too tall, below the bed, floating), size, solid volume and weight per filament at 100% infill.

No input.

## get_cut_list

*read (no change)*

Woodworking cut list: identical parts grouped as thickness × width × length (mm) with quantities.

No input.

## get_quantities

*read (no change)*

Building quantities: per part footprint (m², seen from above) and volume (m³, holes/openings removed), plus totals.

No input.

## add_box

*write (one undo step)*

Add a box (board, block, panel). position is its min corner (default origin); size is [x, y, z] in mm. Example: { "name": "Side", "position": [0, 0, 18], "size": [18, 300, 700] }.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string |  | Meaningful name (shows in the cut list); default "Box N" etc. |
| `position` | [number, number, number] |  | [x, y, z] in mm |
| `rotation` | [number, number, number] |  | Euler XYZ rotation in degrees |
| `color` | string |  | Default: the workspace colour |
| `hole` | boolean |  | true = subtract from every solid it overlaps |
| `group` | string |  | Add into this group (id or name) |
| `size` | [number, number, number] | yes | [x, y, z] sizes in mm, all > 0 |

## add_cylinder

*write (one undo step)*

Add a cylinder (rod, dowel, round hole). position is the centre of its base; it extends along axis (default z) by height. Give radius or diameter. For a screw hole: hole: true. Example M3 hole through a 10 mm plate: { "position": [20, 20, -1], "diameter": 3.4, "height": 12, "hole": true }.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string |  | Meaningful name (shows in the cut list); default "Box N" etc. |
| `position` | [number, number, number] |  | [x, y, z] in mm |
| `rotation` | [number, number, number] |  | Euler XYZ rotation in degrees |
| `color` | string |  | Default: the workspace colour |
| `hole` | boolean |  | true = subtract from every solid it overlaps |
| `group` | string |  | Add into this group (id or name) |
| `radius` | number |  |  |
| `diameter` | number |  |  |
| `height` | number | yes |  |
| `axis` | "x" \| "y" \| "z" |  |  |
| `segments` | integer |  | Smoothness; default from workspace |

## add_shape

*write (one undo step)*

Add an extruded outline (L-bracket, triangle, custom profile). points are [x, y] in mm relative to position, on the XY plane; extruded up by height. Use rotation to stand it up.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string |  | Meaningful name (shows in the cut list); default "Box N" etc. |
| `position` | [number, number, number] |  | [x, y, z] in mm |
| `rotation` | [number, number, number] |  | Euler XYZ rotation in degrees |
| `color` | string |  | Default: the workspace colour |
| `hole` | boolean |  | true = subtract from every solid it overlaps |
| `group` | string |  | Add into this group (id or name) |
| `points` | [number, number][] | yes |  |
| `height` | number | yes |  |

## update_entity

*write (one undo step)*

Change one part's parameters. Only keys that fit the part apply: size (box); radius or diameter, segments (cylinder); points (shape); height (cylinder, shape). Example: { "id": "k3f9a2", "set": { "size": [18, 300, 650] } }.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `set` | { name, position, rotation, size, radius, diameter, height, segments, points, color, hole, visible } | yes |  |

## delete_entities

*write (one undo step)*

Delete the targeted parts (groups left empty disappear).

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |

## set_hole

*write (one undo step)*

Make the targeted parts holes (subtracted from overlapping solids) or solids again.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `hole` | boolean | yes |  |

## set_visible

*write (one undo step)*

Hide or show the targeted parts. Hidden parts are not exported and do not cut.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `visible` | boolean | yes |  |

## set_color

*write (one undo step)*

Set the colour of the targeted parts (#rrggbb).

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `color` | string | yes |  |

## move

*write (one undo step)*

Move the targeted parts together: by an offset, or so their anchor point (bounds min, center or max; default min) lands at "to".

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `by` | [number, number, number] |  | [x, y, z] in mm |
| `to` | [number, number, number] |  | [x, y, z] in mm |
| `anchor` | "min" \| "center" \| "max" |  |  |

## rotate

*write (one undo step)*

Rotate the targeted parts together by angle degrees (counter-clockwise looking down the axis) about axis (default z) through pivot (default: the centre of their bounds; or "min", or a point).

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `angle` | number | yes |  |
| `axis` | "x" \| "y" \| "z" |  |  |
| `pivot` | [number, number, number] \| "center" \| "min" |  |  |

## place_on_ground

*write (one undo step)*

Drop the targeted parts (default: everything) so their lowest solid point sits at z = 0.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } |  | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |

## place_on_plate

*write (one undo step)*

Centre the targeted parts (default: everything) on the 3D printer bed and set them down on it.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } |  | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |

## duplicate

*write (one undo step)*

Copy the targeted parts in ONE call using a pattern (counts include the original): linear { count, step | span }, grid { counts, step }, radial { count, axis, center, angle } (bolt circles), or offsets [...]. Without a pattern: one copy beside the original. Whole groups are copied as new groups. Returns all copies.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `pattern` | { linear } \| { grid } \| { radial } \| { offsets } |  | How to place copies. Counts include the original. |

## mirror

*write (one undo step)*

Mirror the targeted parts across a plane perpendicular to x, y or z. about = the plane position (mm), or a part/group id whose centre defines it. keep_original (default true) makes mirrored copies; false flips in place. Default plane: the far side of the target (copies end up touching), or its centre when flipping in place.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `plane` | "x" \| "y" \| "z" | yes |  |
| `about` | number \| string |  |  |
| `keep_original` | boolean |  |  |

## place

*write (one undo step)*

Put the targeted parts against another target without computing coordinates: side top/bottom/left(-x)/right(+x)/front(-y)/back(+y), gap in mm (default 0), and on the other two axes align min/center/max (default center) or keep. Example: lid on top of a box, centred: { "target": { "name": "Lid" }, "relative_to": { "name": "Box" }, "side": "top" }.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `relative_to` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `side` | "top" \| "bottom" \| "left" \| "right" \| "front" \| "back" | yes |  |
| `align` | "min" \| "center" \| "max" \| "keep" |  |  |
| `gap` | number |  |  |

## align

*write (one undo step)*

Move the targeted parts (as one block) along one axis so their min, center or max lines up with another target's.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `to` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `axis` | "x" \| "y" \| "z" | yes |  |
| `mode` | "min" \| "center" \| "max" | yes |  |

## distribute

*write (one undo step)*

Space parts evenly along an axis (shelves, slats, posts). With count, the target is copied first until there are that many. With between [lower, upper], parts are spaced inside that gap with equal spaces (mode "even") or a fixed spacing gap; without it, the first and last part stay put. Example: 4 shelves between bottom and top: { "target": { "name": "Shelf" }, "count": 4, "between": [{ "name": "Bottom" }, { "name": "Top" }], "axis": "z" }.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `axis` | "x" \| "y" \| "z" | yes |  |
| `count` | integer |  |  |
| `between` | [{ ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group }, { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group }] |  |  |
| `mode` | "even" \| "spacing" |  |  |
| `spacing` | number |  | Gap between parts for mode "spacing" (mm) |

## group

*write (one undo step)*

Group the targeted parts (and any groups they belong to inside the common parent) into a new group, so they select, move and copy as one. Returns the group id.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `name` | string |  |  |

## ungroup

*write (one undo step)*

Dissolve a group (id or name). Its parts and subgroups move up one level and stay where they are.

| Field | Type | Required | Notes |
|---|---|---|---|
| `group` | string | yes |  |

## rename_group

*write (one undo step)*

Rename a group, found by its id or its current name.

| Field | Type | Required | Notes |
|---|---|---|---|
| `group` | string | yes |  |
| `name` | string | yes |  |

## set_selection

*read (no change)*

Select the targeted parts in the app (shows the user what you mean). No target clears the selection.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } |  | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |

## set_workspace

*settings (not undoable)*

Switch workspace: print (3D printing, mm), workshop (woodworking, mm) or build (houses, cm display). Changes display units, snapping and panels, never the model.

| Field | Type | Required | Notes |
|---|---|---|---|
| `workspace` | "print" \| "workshop" \| "build" | yes |  |

## set_printer

*settings (not undoable)*

Choose the 3D printer (profile id) or a custom build volume [x, y, z] mm. Profiles: bambu-x1-p1 (256×256×256), bambu-a1 (256×256×256), bambu-a1-mini (180×180×180), prusa-mk4 (250×210×220), prusa-core-one (250×220×270), prusa-mini (180×180×180), prusa-xl (360×360×360), ender3-v3 (220×220×250), creality-k1 (220×220×250), creality-k1-max (300×300×300), elegoo-neptune4 (225×225×265), anycubic-kobra3 (250×250×260), voron-350 (350×350×340).

| Field | Type | Required | Notes |
|---|---|---|---|
| `profile` | "bambu-x1-p1" \| "bambu-a1" \| "bambu-a1-mini" \| "prusa-mk4" \| "prusa-core-one" \| "prusa-mini" \| "prusa-xl" \| "ender3-v3" \| "creality-k1" \| "creality-k1-max" \| "elegoo-neptune4" \| "anycubic-kobra3" \| "voron-350" |  |  |
| `custom` | [number, number, number] |  | [x, y, z] sizes in mm, all > 0 |

## undo

*undo / redo*

Undo the last change (one call or batch = one step).

No input.

## redo

*undo / redo*

Redo the last undone change.

No input.

## render_views

*needs a host capability (async)*

Render PNG images of the model from standard views to check shape and alignment visually. Use sparingly: images cost tokens.

| Field | Type | Required | Notes |
|---|---|---|---|
| `views` | "iso" \| "top" \| "front" \| "right" \| "left" \| "back" \| "bottom"[] |  |  |
| `size` | integer |  |  |

## open_file

*needs a host capability (async)*

Open a .modeler.json project file (path relative to the working folder), replacing the current model. In the live app this is one undo step.

| Field | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes | e.g. "projects/bookcase.modeler.json" |

## save_file

*needs a host capability (async)*

Save the model as a .modeler.json project file. Without a path, saves to the file last opened or saved.

| Field | Type | Required | Notes |
|---|---|---|---|
| `path` | string |  | Must end in .json, e.g. "clip.modeler.json" |

## export_stl

*needs a host capability (async)*

Write a binary STL (mm) of the visible solids, with holes cut, for 3D printing. Target limits it to some parts; default: everything visible.

| Field | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes | Must end in .stl |
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } |  | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |

## apply_operations

*write (one undo step)*

Run several operations as ONE atomic step (all or nothing, one undo). Name a step's result with "as" and refer to it later as "$name" (in ids lists, group, about). Use this to build a whole assembly in a single call.

| Field | Type | Required | Notes |
|---|---|---|---|
| `operations` | { name, input, as }[] | yes |  |
| `label` | string |  | Short undo-history label for the whole batch, e.g. "add 4 shelves" |
