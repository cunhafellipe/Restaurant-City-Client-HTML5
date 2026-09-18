import { gameUiBridge, type GameUiState } from './gameBridge';

export interface AppShell {
  readonly gameHost: HTMLElement;
  destroy(): void;
}

function button(label: string, command: Parameters<typeof gameUiBridge.command>[0]): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'rc-control-button';
  element.textContent = label;
  element.addEventListener('click', () => gameUiBridge.command(command));
  return element;
}

function platformButton(label: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'anewon-platform-button';
  element.textContent = label;
  element.disabled = true;
  element.title = 'ANEWON Platform integration pending';
  return element;
}

function renderState(
  state: GameUiState,
  status: HTMLElement,
  selection: HTMLElement,
  placement: HTMLElement,
  corpus: HTMLElement,
): void {
  status.textContent = state.status;
  status.dataset.phase = state.phase;

  selection.textContent = state.selectedItem
    ? [
        `#${state.selectedItem.id}`,
        state.selectedItem.name,
        state.selectedItem.footprint,
        `rot ${state.selectedItem.rotation}`,
        state.selectedItem.inventory
          ? `inventory ${state.selectedItem.inventory.available} available · ${state.selectedItem.inventory.placed}/${state.selectedItem.inventory.owned} placed`
          : 'inventory unavailable',
      ].join(' · ')
    : 'No item selected';

  placement.textContent = state.placement
    ? `tile ${state.placement.tileX},${state.placement.tileY} · ${state.placement.detail}`
    : 'Move the pointer over the restaurant floor';

  placement.dataset.valid =
    state.placement === undefined
      ? 'unknown'
      : state.placement.valid
        ? 'true'
        : 'false';

  corpus.textContent = state.corpus
    ? `${state.corpus.restaurantRecords} restaurant records · ${state.corpus.explicitFootprints} explicit footprints`
    : state.baseline
      ? `baseline ${state.baseline}`
      : 'Loading corpus…';
}

export function createAppShell(root: HTMLElement): AppShell {
  root.replaceChildren();
  root.className = 'anewon-app';

  const header = document.createElement('header');
  header.className = 'anewon-topbar';

  const identity = document.createElement('div');
  identity.className = 'anewon-brand';
  identity.innerHTML = '<strong>ANEWON</strong><span>Restaurant City</span>';
  header.append(identity);

  const platformNav = document.createElement('nav');
  platformNav.className = 'anewon-platform-nav';
  platformNav.setAttribute('aria-label', 'ANEWON platform');
  for (const label of ['Account', 'Profile', 'Social', 'Settings']) {
    platformNav.append(platformButton(label));
  }
  header.append(platformNav);

  const layout = document.createElement('main');
  layout.className = 'rc-layout';

  const gamePanel = document.createElement('section');
  gamePanel.className = 'rc-game-panel';
  gamePanel.setAttribute('aria-label', 'Restaurant City game world');

  const gameHost = document.createElement('div');
  gameHost.className = 'rc-game-host';
  gameHost.id = 'game-canvas-host';
  gamePanel.append(gameHost);

  const aside = document.createElement('aside');
  aside.className = 'rc-hud';
  aside.setAttribute('aria-label', 'Restaurant City controls');

  const heading = document.createElement('div');
  heading.className = 'rc-hud-heading';
  heading.innerHTML =
    '<strong>Restaurant editor</strong><span>HTML5 runtime · historical 0.9.143a baseline</span>';

  const selection = document.createElement('div');
  selection.className = 'rc-hud-card';
  selection.setAttribute('aria-live', 'polite');

  const placement = document.createElement('div');
  placement.className = 'rc-hud-card rc-placement-state';
  placement.setAttribute('aria-live', 'polite');

  const controls = document.createElement('div');
  controls.className = 'rc-controls';
  controls.append(
    button('← Previous', 'previous-item'),
    button('Rotate', 'rotate-item'),
    button('Next →', 'next-item'),
  );

  const status = document.createElement('div');
  status.className = 'rc-status';
  status.setAttribute('role', 'status');

  const corpus = document.createElement('div');
  corpus.className = 'rc-corpus';

  aside.append(heading, selection, placement, controls, status, corpus);
  layout.append(gamePanel, aside);
  root.append(header, layout);

  const unsubscribe = gameUiBridge.subscribeState((state) =>
    renderState(state, status, selection, placement, corpus),
  );

  return {
    gameHost,
    destroy(): void {
      unsubscribe();
      root.replaceChildren();
    },
  };
}
