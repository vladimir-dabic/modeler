import './styles.css';
import { App } from './App';

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');
const app = new App(root);

// Handy for debugging from the browser console.
(window as unknown as { modeler: App }).modeler = app;
