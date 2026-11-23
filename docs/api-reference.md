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
| [`add_sphere`](#add_sphere) | write (one undo step) |
| [`add_revolve`](#add_revolve) | write (one undo step) |
| [`add_tube`](#add_tube) | write (one undo step) |
| [`split_for_print`](#split_for_print) | write (one undo step) |
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
| [`explode_view`](#explode_view) | needs a host capability (async) |
| [`open_file`](#open_file) | needs a host capability (async) |
| [`save_file`](#save_file) | needs a host capability (async) |
| [`export_stl`](#export_stl) | needs a host capability (async) |
| [`export_model`](#export_model) | needs a host capability (async) |
| [`get_instructions`](#get_instructions) | read (no change) |
| [`paste`](#paste) | write (one undo step) |
| [`make_component`](#make_component) | write (one undo step) |
| [`make_unique`](#make_unique) | write (one undo step) |
| [`set_properties`](#set_properties) | write (one undo step) |
| [`set_instructions`](#set_instructions) | write (one undo step) |
| [`add_note`](#add_note) | write (one undo step) |
| [`add_dimension`](#add_dimension) | write (one undo step) |
| [`dimension_parts`](#dimension_parts) | write (one undo step) |
| [`update_annotation`](#update_annotation) | write (one undo step) |
| [`delete_annotations`](#delete_annotations) | write (one undo step) |
| [`import_dxf`](#import_dxf) | needs a host capability (async) |
| [`get_reference`](#get_reference) | read (no change) |
| [`update_reference`](#update_reference) | write (one undo step) |
| [`delete_reference`](#delete_reference) | write (one undo step) |
| [`apply_operations`](#apply_operations) | write (one undo step) |

## get_scene

*read (no change)*

Overview of the model: workspace, printer, overall bounds, the parts, annotations (notes, dimensions) and any reference drawings (imported plans to build on; not parts). detail "outline" lists each top-level group as one line (best first call on big models), "compact" (default) one line per part, "full" complete JSON. Lines read: id "name" shape size at x,y,z [hole] in "group".

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

Add a box (board, block, panel). position is its min corner (default origin); size is [x, y, z] in mm. edge_radius rounds every edge and corner (printed enclosures, soft blocks). Example: { "name": "Side", "position": [0, 0, 18], "size": [18, 300, 700] }.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string |  | Meaningful name (shows in the cut list); default "Box N" etc. |
| `position` | [number, number, number] |  | [x, y, z] in mm |
| `rotation` | [number, number, number] |  | Euler XYZ rotation in degrees |
| `color` | string |  | Default: the workspace colour |
| `hole` | boolean |  | true = subtract from every solid it overlaps |
| `group` | string |  | Add into this group (id or name) |
| `size` | [number, number, number] | yes | [x, y, z] sizes in mm, all > 0 |
| `edge_radius` | number |  | Round all edges, mm (< half the smallest side) |

## add_cylinder

*write (one undo step)*

Add a cylinder (rod, dowel, round hole), or a cone/frustum with a different top: radius_top or diameter_top (0 = pointed; larger than the base for a countersink hole). position is the centre of its base; it extends along axis (default z) by height. Give radius or diameter. For a screw hole: hole: true. Example M3 hole through a 10 mm plate: { "position": [20, 20, -1], "diameter": 3.4, "height": 12, "hole": true }.

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
| `radius_top` | number |  |  |
| `diameter_top` | number |  |  |
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

## add_sphere

*write (one undo step)*

Add a sphere or ellipsoid. position is its CENTRE. Give radius or diameter (sphere), or radii [x, y, z] (ellipsoid: egg, head, body). Use with holes for domes and half-spheres.

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
| `radii` | [number, number, number] |  | Ellipsoid radii [x, y, z], mm |
| `segments` | integer |  | Smoothness (default 48) |

## add_revolve

*write (one undo step)*

Add a solid of revolution (vase, bottle, knob, turned leg, bowl): profile points [radius, z] (radius ≥ 0) outline one side of it; it spins 360° around an axis through position (default z). Points with radius 0 lie on the axis and close it there. Example cup: [[0,0],[40,0],[45,90],[42,90],[37,4],[0,4]].

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string |  | Meaningful name (shows in the cut list); default "Box N" etc. |
| `position` | [number, number, number] |  | [x, y, z] in mm |
| `rotation` | [number, number, number] |  | Euler XYZ rotation in degrees |
| `color` | string |  | Default: the workspace colour |
| `hole` | boolean |  | true = subtract from every solid it overlaps |
| `group` | string |  | Add into this group (id or name) |
| `profile` | [number, number][] | yes | [radius, z] points of a closed outline, mm |
| `axis` | "x" \| "y" \| "z" |  |  |
| `segments` | integer |  | Smoothness around the axis (default 64) |

## add_tube

*write (one undo step)*

Add a round tube along a path of world points (tail, neck, handle, cable, pipe, rail): one part instead of many cylinders. smooth (default true) curves through the points; false makes straight segments. Give radius/diameter for a constant tube, or radii (one per point) to taper. Ends are flat.

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string |  | Meaningful name (shows in the cut list); default "Box N" etc. |
| `color` | string |  | Default: the workspace colour |
| `hole` | boolean |  | true = subtract from every solid it overlaps |
| `group` | string |  | Add into this group (id or name) |
| `path` | [number, number, number][] | yes | World points the centre line passes through, mm |
| `radius` | number |  |  |
| `diameter` | number |  |  |
| `radii` | number[] |  | A radius per path point |
| `smooth` | boolean |  |  |
| `segments` | integer |  | Smoothness around the tube (default 24) |

## split_for_print

*write (one undo step)*

Cut a part or assembly into two printable pieces along a plane across axis (default z) at a coordinate (default: the middle). The lower piece gets pegs and the upper one matching holes with clearance, so they align and glue. Each piece is a new group; holes that cut the original are copied into each piece; the upper piece moves gap mm away. The original is replaced (one undo brings it back). Default pegs: as many as fit, up to 2.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `axis` | "x" \| "y" \| "z" |  |  |
| `at` | number |  | Where to cut, mm along axis |
| `gap` | number |  | How far to move the upper piece apart (default 10) |
| `pegs` | integer |  | Number of pegs (0 = none) |
| `peg_diameter` | number |  | Default: 5 mm, smaller for small cut faces |
| `peg_depth` | number |  | How far a peg goes into each piece (default 1.2 × diameter) |
| `clearance` | number |  | Extra radius of the peg holes (default 0.2 mm, a sliding fit) |
| `name` | string |  | Base name of the pieces |

## update_entity

*write (one undo step)*

Change one part's parameters. Only keys that fit the part apply: size, edge_radius (box); radius or diameter (cylinder, sphere, tube); radius_top or diameter_top (cylinder → cone); height (cylinder, shape); radii ([x,y,z] for a sphere, one per point for a tube); points (shape); profile (revolve); path (tube, world points), smooth (tube); segments (round kinds). Example: { "id": "k3f9a2", "set": { "size": [18, 300, 650] } }.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `set` | { name, position, rotation, size, edge_radius, radius, diameter, radius_top, diameter_top, height, radii, segments, points, profile, path, smooth, color, hole, visible } | yes |  |

## delete_entities

*write (one undo step)*

Delete the targeted parts (groups left empty disappear).

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |

## set_hole

*write (one undo step)*

Make the targeted parts holes (subtracted from overlapping solids) or solids again. only_own_group: true makes a hole cut only parts in its own group (e.g. a pocket in one part of an assembly that must not cut its neighbours); false: it cuts everything it overlaps (the default).

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `hole` | boolean | yes |  |
| `only_own_group` | boolean |  |  |

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

Render PNG images of the model from standard views to check shape and alignment visually. explode (0–1) renders it pulled apart (how parts fit together) without changing the user's view. Use sparingly: images cost tokens.

| Field | Type | Required | Notes |
|---|---|---|---|
| `views` | "iso" \| "top" \| "front" \| "right" \| "left" \| "back" \| "bottom"[] |  |  |
| `size` | integer |  |  |
| `explode` | number |  |  |
| `explode_axis` | "x" \| "y" \| "z" |  |  |

## explode_view

*needs a host capability (async)*

Show the model pulled apart in the app (an exploded view: how the parts fit together). factor 0 = assembled, 1 = fully apart; axis limits it to one direction (e.g. z lifts parts apart vertically). Every part comes apart; groups stay together as clusters side by side. View only: the model and undo history are untouched.

| Field | Type | Required | Notes |
|---|---|---|---|
| `factor` | number | yes |  |
| `axis` | "x" \| "y" \| "z" |  |  |

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

## export_model

*needs a host capability (async)*

Write the model for other 3D programs: GLB (binary glTF) for SketchUp (File > Import), Blender, Twinmotion, Unreal, web/AR. Visible solids with holes cut, one named node per part, groups as nested nodes, one material per colour; converted to metres, Y-up. Target limits it to some parts; default: everything visible.

| Field | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes | Must end in .glb |
| `format` | "glb" |  | Default: from the file extension |
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } |  | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |

## get_instructions

*read (no change)*

The build-instructions booklet (IKEA style) the app prints: identical parts lettered A, B, C… with quantities and sizes (mm), and the assembly steps (stored, or suggested bottom-up). The user opens it with the Instructions button. A project with several pieces of furniture (top-level groups) has a booklet for each: pass group.

| Field | Type | Required | Notes |
|---|---|---|---|
| `group` | string |  | A top-level group (id or name): the booklet for that one piece of furniture, when a project holds several. Omit for the whole model. |

## paste

*write (one undo step)*

Insert parts copied with Copy (⌘C): clipboard text in the "modeler-clipboard" JSON format, e.g. from another project or tab. Everything gets new ids; groups and attached notes/dimensions come along. It lands where it was copied from, or beside the model (+x) if that spot is taken; offset moves it instead. Inside an open group, it is pasted into that group.

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | string | yes | The copied text |
| `offset` | [number, number, number] |  | Move the pasted parts by this, mm (instead of the automatic placement) |

## make_component

*write (one undo step)*

Link identical parts as copies of one component ("Leg × 4", "Door × 12"): from then on, changing the size, shape, colour or properties of one changes all, while each keeps its own place, name and group. Duplicating a copy adds another linked copy. The parts must be the same kind; if they differ, match: true makes them all like the first.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `match` | boolean |  | Make all targeted parts like the first one (default false: they must already be identical) |

## make_unique

*write (one undo step)*

Unlink parts from their component, so they can be changed on their own.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |

## set_properties

*write (one undo step)*

Say what parts are made of, for the cut list and the build booklet: material ("Oak veneered MDF", "White melamine chipboard", "Steel tube 40×40×2"), finish ("Oiled", "Black powder coat"), edge banding of boards ({ long: 2, short: 1, thickness: 1 }), part number and a note for the maker. Only given fields change; null clears one. Linked copies (components) all get it.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `material` | string \| null |  |  |
| `finish` | string \| null |  |  |
| `banding` | { long, short, thickness } \| null |  |  |
| `part_no` | string \| null |  |  |
| `note` | string \| null |  |  |

## set_instructions

*write (one undo step)*

Write the build instructions: title, a short intro, language of the booklet headings (en, sr) and the assembly steps in order. Each step adds parts (a target, e.g. { name: "Leg*" }) with a short, plain-language text for a non-expert ("Screw the four legs B into the corners of the top A, 2 screws each."). Parts missing from every step are added as a last step. Only given fields change; steps: null goes back to suggested steps. With group, it writes that piece's own booklet, and steps only take parts inside it.

| Field | Type | Required | Notes |
|---|---|---|---|
| `group` | string |  | A top-level group (id or name): the booklet for that one piece of furniture, when a project holds several. Omit for the whole model. |
| `title` | string |  |  |
| `intro` | string \| null |  | One or two sentences under the title; null removes it |
| `language` | "en" \| "sr" |  | Language of the booklet headings; write texts in the same language |
| `steps` | { parts, text }[] \| null |  |  |

## add_note

*write (one undo step)*

Add a text note (annotation, not geometry), e.g. "Oak top, 18 mm" or "drill on site". It sits at `at` (a point, or { part, at } to stay attached to a part), with a leader line when label_offset moves the text away.

| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | yes |  |
| `at` | [number, number, number] \| { part, at } | yes | A world point [x, y, z] (mm), or a point on a part { part, at }. Points on parts follow the part when it moves or is resized. |
| `label_offset` | [number, number, number] |  | Where the text goes relative to the point, mm (default: on the point, no leader) |

## add_dimension

*write (one undo step)*

Add a dimension between two points (or { part, at } points, which keep it updated when parts move or resize). axis measures along x, y or z only; otherwise the true distance. The line sits offset mm (default ~15% of the length) towards side (default: away from the parts). text overrides the value; "<>" inserts it.

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | [number, number, number] \| { part, at } | yes | A world point [x, y, z] (mm), or a point on a part { part, at }. Points on parts follow the part when it moves or is resized. |
| `to` | [number, number, number] \| { part, at } | yes | A world point [x, y, z] (mm), or a point on a part { part, at }. Points on parts follow the part when it moves or is resized. |
| `axis` | "x" \| "y" \| "z" |  |  |
| `offset` | number \| [number, number, number] |  | Distance from the measured points to the dimension line, mm (or an exact offset vector) |
| `side` | "+x" \| "-x" \| "+y" \| "-y" \| "+z" \| "-z" |  | Which way the dimension line sits from the measured points |
| `text` | string |  |  |

## dimension_parts

*write (one undo step)*

Add overall dimensions of the targeted parts (e.g. a whole cabinet or group): one per axis (default x, y and z), attached to the outermost parts so they update when the model changes. Width (x) sits above, depth (y) and height (z) to the left.

| Field | Type | Required | Notes |
|---|---|---|---|
| `target` | { ids } \| { selection } \| { group } \| { name } \| { all, kind, hole, in_group } | yes | Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group } |
| `axes` | "x" \| "y" \| "z"[] |  |  |
| `offset` | number |  | Distance from the parts to the dimension lines, mm |

## update_annotation

*write (one undo step)*

Change an annotation: text (a dimension's override; "" restores the measured value), a note's label_offset, or a dimension's offset distance and side.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes |  |
| `text` | string |  |  |
| `label_offset` | [number, number, number] |  | [x, y, z] in mm |
| `offset` | number |  |  |
| `side` | "+x" \| "-x" \| "+y" \| "-y" \| "+z" \| "-z" |  | Which way the dimension line sits from the measured points |

## delete_annotations

*write (one undo step)*

Remove annotations by id, or all of them. Parts are not affected.

| Field | Type | Required | Notes |
|---|---|---|---|
| `ids` | string[] |  |  |
| `all` | true |  |  |

## import_dxf

*needs a host capability (async)*

Import a DXF drawing (e.g. a floor plan) as a reference drawing: lines on the ground (or at position) to build on and snap to. It is not part of the model (no cut list, export or holes). Give path (MCP: relative to the working folder) or text (the file contents). Units come from the file, else units, else mm. DWG is not supported: save as DXF first.

| Field | Type | Required | Notes |
|---|---|---|---|
| `path` | string |  | A .dxf file |
| `text` | string |  | DXF contents (the app passes the picked file) |
| `name` | string |  | Default: the file name |
| `units` | "mm" \| "cm" \| "m" \| "in" \| "ft" |  | Units of the drawing when the file does not say (default mm), or to override it |
| `position` | [number, number, number] |  | Where the drawing's lower-left corner goes (default 0,0,0) |
| `rotation` | number |  | Rotation about Z in degrees |

## get_reference

*read (no change)*

Read the lines of a reference drawing in world mm (units, position and rotation applied), to build on a plan, e.g. walls along its outlines. One line per path: "Walls: closed x,y x,y …", "Doors: arc centre x,y r R from x,y to x,y", "circle centre x,y ø D". Filter with layers; limit caps the paths (default 200).

| Field | Type | Required | Notes |
|---|---|---|---|
| `reference` | string | yes | Reference drawing id or exact name |
| `layers` | string[] |  | Only these layers (default: the visible ones) |
| `limit` | integer |  |  |

## update_reference

*write (one undo step)*

Change a reference drawing: name, units (rescales it), position, rotation (about Z, degrees), visible, or switch layers off/on by name ("*" = all). Reference drawings are listed in get_scene.

| Field | Type | Required | Notes |
|---|---|---|---|
| `reference` | string | yes | Reference drawing id or exact name |
| `name` | string |  |  |
| `units` | "mm" \| "cm" \| "m" \| "in" \| "ft" |  |  |
| `position` | [number, number, number] |  | [x, y, z] in mm |
| `rotation` | number |  |  |
| `visible` | boolean |  |  |
| `hide_layers` | string[] |  |  |
| `show_layers` | string[] |  | Applied after hide_layers |

## delete_reference

*write (one undo step)*

Remove a reference drawing (the model is not affected).

| Field | Type | Required | Notes |
|---|---|---|---|
| `reference` | string | yes | Reference drawing id or exact name |

## apply_operations

*write (one undo step)*

Run several operations as ONE atomic step (all or nothing, one undo). Name a step's result with "as" and refer to it later as "$name" (in ids lists, group, about). Use this to build a whole assembly in a single call.

| Field | Type | Required | Notes |
|---|---|---|---|
| `operations` | { name, input, as }[] | yes |  |
| `label` | string |  | Short undo-history label for the whole batch, e.g. "add 4 shelves" |
