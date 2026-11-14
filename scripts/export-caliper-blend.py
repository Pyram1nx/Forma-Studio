# Exports the Shaper Connected Caliper from Caliper.blend into
# src/features/systainer/caliperMesh.ts (positions in 0.01 mm as Int16, triangle indices, a part
# class per triangle), for the Systainer catalogue (catalog.ts `connectedCaliper`).
#
# Usage (Blender 4.2+ / 5.x, headless; the .blend is not modified):
#   /Applications/Blender.app/Contents/MacOS/Blender -b ~/Documents/Blender/Caliper.blend \
#     --python scripts/export-caliper-blend.py -- src/features/systainer/caliperMesh.ts
#
# The .blend is in mm (1 BU = 1 m, so coordinates × 1000). Its frame: beam along +y, jaws toward +x,
# display facing +z. The scale's 0 is where the jaws meet (y = −62: the fixed and moving jaws
# share a face there), 3 mm right of the beam's first loop cut. Plane.001 is an unapplied cutter
# (the jaw relief slot) and is subtracted from the body here. Plane.002/.003 are the jaw-tip bevel
# cutters, already applied in the .blend: subtracting them again cuts along coincident faces and
# leaves duplicate and zero-area triangles, so they are skipped.
#
# Output frame (the catalogue's): X = y_blend + 62 (so the scale's 0 is X = 0), Y = −x_blend
# (jaws toward −Y, display up), Z = z_blend.
import base64
import struct
import sys

import bmesh
import bpy
from mathutils import Vector

out_path = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'caliperMesh.ts'
ZERO_Y = -62.0  # mm, where the jaws meet

# Part classes (must match caliperMesh.ts / catalog.ts).
STEEL, SCALE, HOUSING, DISPLAY, RUBBER, ROLLER = 0, 1, 2, 3, 4, 5
BEAM_TOP = 3.5  # mm, the beam's printed face
ROLLER_C = (13.66, 9.25)  # mm, thumb roller axis (blend x, y)
ROLLER_R = 5.8


def world_bmesh(name):
    o = bpy.data.objects[name]
    dg = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    bm.from_object(o, dg)
    bm.transform(o.matrix_world)
    bm.normal_update()
    return bm


def body_mesh():
    """Plane minus the relief-slot cutter, evaluated on a temporary copy."""
    src = bpy.data.objects['Plane']
    tmp = src.copy()
    tmp.data = src.data.copy()
    bpy.context.scene.collection.objects.link(tmp)
    m = tmp.modifiers.new('cut_slot', 'BOOLEAN')
    m.operation = 'DIFFERENCE'
    m.solver = 'EXACT'
    m.object = bpy.data.objects['Plane.001']
    bm = world_bmesh(tmp.name)
    bpy.data.objects.remove(tmp)
    fix_upper_jaw_bevels(bm)
    return bm


def fix_upper_jaw_bevels(bm):
    """
    The upper (inside-measuring) jaws' bevel faces point inward in the .blend: the moving jaw's
    sloped top, the fixed jaw's sloped underside and the two small end triangles, left reversed when
    the bevel cutter was applied. three culls back faces, so they showed as see-through triangles.
    Flip the faces there (blend x < −13, past the housing's top edge) whose winding disagrees with
    their neighbours. A whole-body recalc is not safe: the body has internal faces (the beam inside
    the jaws, the jaws' shared face) that make "outside" ambiguous.
    """
    flip = []
    for f in bm.faces:
        if f.calc_center_median().x * 1000 >= -13:
            continue
        good = bad = 0
        for l in f.loops:
            if not l.edge.is_manifold:
                continue
            other = next(x for x in l.edge.link_loops if x.face is not f)
            if other.vert is l.vert:
                bad += 1
            else:
                good += 1
        if bad > good:
            flip.append(f)
    bmesh.ops.reverse_faces(bm, faces=flip)
    bm.normal_update()
    print('CALIPER_FLIPPED', len(flip))


def classify_body(c, n):
    if c.z > BEAM_TOP + 0.05:
        return HOUSING
    if n.z > 0.99 and abs(c.z - BEAM_TOP) < 0.02:
        return SCALE
    return STEEL


def classify_roller(c, n):
    d = ((c.x - ROLLER_C[0]) ** 2 + (c.y - ROLLER_C[1]) ** 2) ** 0.5
    return ROLLER if d <= ROLLER_R else STEEL


# (mesh, classifier, recalculate normals). Only the bezel needs its normals fixed: its top faces are
# flipped in the .blend (three culls back faces). The body is open in a few places, where a recalc
# would guess wrong, so it keeps the .blend's own normals.
parts = [
    (body_mesh(), classify_body, False),
    (world_bmesh('Circle'), lambda c, n: RUBBER, False),
    (world_bmesh('Circle.001'), classify_roller, False),
    (world_bmesh('Plane.004'), lambda c, n: DISPLAY, True),
]

pos, idx, cls = [], [], []
for bm, classify, recalc in parts:
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    # Zero-area faces carry no geometry but break normals and the pocket silhouette.
    bmesh.ops.dissolve_degenerate(bm, dist=1e-7, edges=bm.edges[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()
    base = len(pos) // 3
    for v in bm.verts:
        p = v.co * 1000.0
        pos += [p.y - ZERO_Y, -p.x, p.z]
    for f in bm.faces:
        c = f.calc_center_median() * 1000.0
        idx += [base + v.index for v in f.verts]
        cls.append(classify(c, f.normal))
    bm.free()

q = [round(v * 100) for v in pos]
assert max(abs(v) for v in q) < 32767
assert len(pos) // 3 < 65536
b64 = lambda b: base64.b64encode(b).decode('ascii')
p64 = b64(struct.pack('<%dh' % len(q), *q))
i64 = b64(struct.pack('<%dH' % len(idx), *idx))
c64 = b64(bytes(cls))

wrap = lambda s: '\n'.join("  '" + s[i:i + 100] + "' +" for i in range(0, len(s), 100)).rstrip(' +')
with open(out_path, 'w') as f:
    f.write(
        '// Generated by scripts/export-caliper-blend.py from Caliper.blend (the Shaper Connected Caliper,\n'
        '// modelled by the project owner). Do not edit by hand.\n'
        '//\n'
        '// Frame (mm): x along the beam with the scale\'s 0 at x = 0 and 200 mm at x = 200, jaws toward −y,\n'
        '// display up (+z). Positions are Int16 in 0.01 mm, indices Uint16, one part class per triangle\n'
        '// (CALIPER_PART).\n'
        'export const CALIPER_PART = { steel: 0, scale: 1, housing: 2, display: 3, rubber: 4, roller: 5 } as const\n\n'
        f'export const CALIPER_COUNTS = {{ verts: {len(pos) // 3}, tris: {len(cls)} }}\n\n'
        f'export const CALIPER_POS =\n{wrap(p64)}\n\n'
        f'export const CALIPER_IDX =\n{wrap(i64)}\n\n'
        f'export const CALIPER_CLS =\n{wrap(c64)}\n'
    )
counts = {k: cls.count(v) for k, v in (('steel', 0), ('scale', 1), ('housing', 2), ('display', 3), ('rubber', 4), ('roller', 5))}
print('CALIPER_EXPORT', out_path, len(pos) // 3, 'verts', len(cls), 'tris', counts)
