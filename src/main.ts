import './styles.css';
import manifoldWasm from 'manifold-3d/manifold.wasm?url';
import { App } from './App';
import { setCsgEngine } from './model/csg';
import { initManifold } from './model/manifold';

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');
// ?csg=bvh keeps the previous geometry engine (for comparison or if Manifold misbehaves).
if (new URLSearchParams(location.search).get('csg') === 'bvh') setCsgEngine('bvh');
const app = new App(root);
// The geometry engine loads in the background (ADR 0017); the model is re-cut when it's ready.
void initManifold(manifoldWasm).then((ok) => ok && app.viewport.rebuildAll());

// Handy for debugging from the browser console.
(window as unknown as { modeler: App }).modeler = app;
