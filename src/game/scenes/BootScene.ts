import Phaser from 'phaser';

interface ManifestJson {
  baseline?: string;
  coverage?: Record<
    string,
    { exported: number; symbols: number; frames: number; pct: number }
  >;
}

const CENTER = 380;

/**
 * Web-native asset proof scene.
 *
 * This scene verifies only the generated JSON/PNG runtime contract. Historical
 * SWF/BIN inputs are conversion-time research material and are never fetched or
 * interpreted by the browser.
 */
export class BootScene extends Phaser.Scene {
  private loadErrors: string[] = [];

  constructor() {
    super('Boot');
  }

  preload(): void {
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: unknown) => {
      const f = file as { key?: string; url?: string };
      this.loadErrors.push(`${f.key ?? '?'} (${f.url ?? '?'})`);
    });
    this.load.multiatlas(
      'ingredient',
      'assets/generated/atlases/ingredient_asset.json',
    );
  }

  create(): void {
    this.add
      .text(CENTER, 60, 'Restaurant City web-native asset proof', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '24px',
        color: '#ffffff',
      })
      .setOrigin(0.5);

    this.showCoverage();
    this.showLoadErrors();
    this.showSprites();
  }

  private showLoadErrors(): void {
    if (this.loadErrors.length === 0) return;
    this.add
      .text(CENTER, 560, `LOAD ERRORS: ${this.loadErrors.join(' | ')}`, {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#ff8a80',
        wordWrap: { width: 720 },
      })
      .setOrigin(0.5);
  }

  private showCoverage(): void {
    const style = {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: '#c8c8c8',
    };

    fetch('/assets/generated/manifest.json')
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as ManifestJson;
      })
      .then((manifest) => {
        const coverage = manifest.coverage?.['ingredient_asset'];
        if (!coverage) throw new Error('no ingredient_asset coverage');
        return {
          text:
            `baseline ${manifest.baseline ?? '?'} · ` +
            `${coverage.exported}/${coverage.symbols} symbols ` +
            `(${coverage.pct}%) · ${coverage.frames} frames`,
          color: coverage.pct >= 100 ? '#7ddb8a' : '#ffb74d',
        };
      })
      .catch((error: unknown) => ({
        text: `manifest FAILED: ${error instanceof Error ? error.message : String(error)}`,
        color: '#ff8a80',
      }))
      .then(({ text, color }) =>
        this.add.text(CENTER, 110, text, { ...style, color }).setOrigin(0.5),
      );
  }

  private showSprites(): void {
    const texture = this.textures.get('ingredient');
    if (!texture) {
      throw new Error("texture 'ingredient' missing — atlas failed to load");
    }

    const frames = texture.getFrameNames();
    const symbols = [
      ...new Set(frames.map((key) => key.replace(/\/[^/]+$/, ''))),
    ].sort();

    const row = symbols.slice(0, 8);
    const x0 = CENTER - ((row.length - 1) * 64) / 2;
    row.forEach((symbol, index) => {
      const key = frames.find((candidate) =>
        candidate.startsWith(`${symbol}/`),
      );
      if (key) this.add.sprite(x0 + index * 64, 320, 'ingredient', key);
    });
  }
}
