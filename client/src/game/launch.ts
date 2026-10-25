// Lazily loaded (dynamic import) so the menus appear before Phaser downloads.
// One Phaser.Game instance is reused across matches (avoids leaking WebGL contexts).

import Phaser from 'phaser';
import { GameScene, type SceneContext } from './GameScene';

let game: Phaser.Game | null = null;

export function startMatchScene(parent: HTMLElement, ctx: SceneContext): void {
  if (!game) {
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      transparent: true,
      scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
      render: { antialias: true, pixelArt: false, roundPixels: false, powerPreference: 'high-performance', batchSize: 2048 },
      fps: { target: 60, smoothStep: false, min: 5 },
      // Input and audio are handled outside Phaser (DOM pointer events, WebAudio).
      input: { keyboard: false, mouse: false, touch: false, gamepad: false },
      audio: { noAudio: true },
      banner: false,
      disableContextMenu: true,
    });
    game.scene.add('game', GameScene, false);
  }
  const g = game;
  const run = () => {
    g.loop.wake();
    if (g.scene.isActive('game')) g.scene.stop('game');
    g.scene.start('game', ctx);
  };
  if (g.isBooted) run();
  else g.events.once(Phaser.Core.Events.READY, run);
}

export function stopMatchScene(): void {
  if (!game) return;
  game.scene.stop('game');
  game.loop.sleep(); // no rendering while in menus (battery)
}
