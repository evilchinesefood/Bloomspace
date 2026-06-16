// Render/TreeView.js — visible trees around asteroids: a green tree icon per seedling tree
// and an owner-colored shield icon per defense tree, arranged around the rock's rim. The
// more trees a rock holds, the more icons appear; each scales up as the tree matures.
import * as THREE from "three";
import { glyphTexture, ICON } from "./Glyphs.js";
import { ownerColor } from "./Palette.js";

const MARKER = 13; // icon size (world units)
const GAP = 11; // distance beyond the rock rim
const MAX = 512;
const TAU = Math.PI * 2;
const TREE_GREEN = 0x7dd87a;

function makeMesh(scene, code) {
  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(MARKER, MARKER),
    new THREE.MeshBasicMaterial({
      map: glyphTexture(code),
      transparent: true,
      depthWrite: false,
    }),
    MAX,
  );
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX * 3),
    3,
  );
  mesh.frustumCulled = false;
  mesh.count = 0;
  scene.add(mesh);
  return mesh;
}

export function createTreeView(scene, world) {
  const treeMesh = makeMesh(scene, ICON.tree); // seedling trees (green)
  const defMesh = makeMesh(scene, ICON.shield); // defense trees (owner-colored)
  const dummy = new THREE.Object3D();
  const green = new THREE.Color(TREE_GREEN);
  const col = new THREE.Color();

  function update() {
    let mt = 0,
      md = 0;
    for (const a of world.asteroids) {
      const trees = a.trees;
      if (!trees || trees.length === 0) continue;
      const total = trees.length;
      for (let t = 0; t < total; t++) {
        const tree = trees[t];
        const ang = (t / total) * TAU - Math.PI / 2;
        const r = a.radius + GAP;
        const grow = 0.55 + 0.45 * Math.min(1, tree.growth || 0);
        dummy.position.set(
          a.x + Math.cos(ang) * r,
          a.y + Math.sin(ang) * r,
          0.6,
        );
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(grow, grow, 1);
        dummy.updateMatrix();
        if (tree.type === "defense") {
          if (md >= MAX) continue;
          ownerColor(col, a.owner);
          defMesh.setMatrixAt(md, dummy.matrix);
          defMesh.setColorAt(md, col);
          md++;
        } else {
          if (mt >= MAX) continue;
          treeMesh.setMatrixAt(mt, dummy.matrix);
          treeMesh.setColorAt(mt, green);
          mt++;
        }
      }
    }
    treeMesh.count = mt;
    defMesh.count = md;
    treeMesh.instanceMatrix.needsUpdate = true;
    defMesh.instanceMatrix.needsUpdate = true;
    if (treeMesh.instanceColor) treeMesh.instanceColor.needsUpdate = true;
    if (defMesh.instanceColor) defMesh.instanceColor.needsUpdate = true;
  }
  update();

  return { treeMesh, defMesh, update };
}
