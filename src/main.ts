import Phaser from 'phaser';
import './app.css';
import { RestaurantEditorScene } from './game/scenes/RestaurantEditorScene';
import { BootScene } from './game/scenes/BootScene';
import { createAppShell } from './shell/AppShell';

const root = document.getElementById('app');
if (!root) {
  throw new Error('ANEWON application root #app is missing');
}

const shell = createAppShell(root);

/**
 * Phaser is the world renderer/simulation presentation layer.
 *
 * Platform chrome and non-world-space game UI live in the HTML/CSS shell.
 * The recovered Flash logical resolution remains 760x600 for compatibility
 * with historical layout/math while Phaser scales that world to the host.
 */
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: shell.gameHost,
  width: 760,
  height: 600,
  backgroundColor: '#1c2b33',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [RestaurantEditorScene, BootScene],
});

export default game;
