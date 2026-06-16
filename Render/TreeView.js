// Render/TreeView.js — visible trees around asteroids. Seedling trees show a green icon that
// grows through stages (sprout → full tree) and varies in size per tree; defense trees show
// an owner-colored shield. Each icon is oriented radially so it appears to grow off the
// surface, arranged around the rock's rim — more trees → more icons.
import * as THREE from "three";
import { glyphTexture, ICON } from "./Glyphs.js";
import { ownerColor } from "./Palette.js";

const MARKER = 19; // base icon size (world units)
const MAX = 512;
const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
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
  const sproutMesh = makeMesh(scene, ICON.sprout); // young seedling tree
  const treeMesh = makeMesh(scene, ICON.tree); // mature seedling tree
  const defMesh = makeMesh(scene, ICON.shield); // defense tree
  const dummy = new THREE.Object3D();
  const green = new THREE.Color(TREE_GREEN);
  const col = new THREE.Color();

  function update() {
    let ms = 0,
      mt = 0,
      md = 0;
    for (const a of world.asteroids) {
      const trees = a.trees;
      if (!trees || trees.length === 0) continue;
      const total = trees.length;
      for (let t = 0; t < total; t++) {
        const tree = trees[t];
        const ang = (t / total) * TAU - HALF_PI;
        // size: per-tree jitter (deterministic) × growth — young trees start small.
        const jitter =
          0.78 + 0.5 * ((((a.id + 1) * 131 + (t + 1) * 977) % 100) / 100);
        const grow = 0.55 + 0.45 * Math.min(1, tree.growth || 0);
        const size = jitter * grow;
        const r = a.radius + MARKER * 0.45 * size;
        dummy.position.set(
          a.x + Math.cos(ang) * r,
          a.y + Math.sin(ang) * r,
          0.6,
        );
        dummy.rotation.set(0, 0, ang - HALF_PI); // grow radially outward from the surface
        dummy.scale.set(size, size, 1);
        dummy.updateMatrix();
        if (tree.type === "defense") {
          if (md >= MAX) continue;
          ownerColor(col, a.owner);
          defMesh.setMatrixAt(md, dummy.matrix);
          defMesh.setColorAt(md, col);
          md++;
        } else if ((tree.growth || 0) < 0.5) {
          if (ms >= MAX) continue;
          sproutMesh.setMatrixAt(ms, dummy.matrix);
          sproutMesh.setColorAt(ms, green);
          ms++;
        } else {
          if (mt >= MAX) continue;
          treeMesh.setMatrixAt(mt, dummy.matrix);
          treeMesh.setColorAt(mt, green);
          mt++;
        }
      }
    }
    for (const [mesh, count] of [
      [sproutMesh, ms],
      [treeMesh, mt],
      [defMesh, md],
    ]) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
  update();

  return { sproutMesh, treeMesh, defMesh, update };
}
