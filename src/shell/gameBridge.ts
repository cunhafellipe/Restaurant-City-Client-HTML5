export type GameUiCommand =
  | 'previous-item'
  | 'next-item'
  | 'rotate-item'
  | 'remove-selected'
  | 'cancel-edit';

export interface GameUiState {
  readonly phase:
    | 'booting'
    | 'loading-content'
    | 'loading-authority'
    | 'editing'
    | 'saving'
    | 'error';
  readonly baseline?: string;
  readonly status: string;
  readonly selectedItem?: {
    readonly id: number;
    readonly name: string;
    readonly group: string;
    readonly footprint: string;
    readonly rotation: number;
    readonly inventory?: {
      readonly owned: number;
      readonly placed: number;
      readonly available: number;
    };
  };
  readonly selectedPlacedItem?: {
    readonly instanceId: number;
    readonly itemId: number;
    readonly name: string;
    readonly tileX: number;
    readonly tileY: number;
    readonly rotation: number;
  };
  readonly selectedWallpaper?: {
    readonly itemId: number;
    readonly name: string;
    readonly rotation: 0 | 1;
    readonly orientation: 'left' | 'top';
  };
  readonly placement?: {
    readonly tileX: number;
    readonly tileY: number;
    readonly valid: boolean;
    readonly detail: string;
  };
  readonly corpus?: {
    readonly restaurantRecords: number;
    readonly explicitFootprints: number;
  };
}

type StateListener = (state: GameUiState) => void;
type CommandListener = (command: GameUiCommand) => void;

/**
 * Narrow DOM <-> renderer boundary.
 *
 * The Phaser game never owns platform/account/profile/social/settings DOM.
 * The DOM shell never mutates world state directly. Commands cross this bridge
 * and still require game/server validation.
 */
export class GameUiBridge {
  private state: GameUiState = {
    phase: 'booting',
    status: 'Starting Restaurant City…',
  };

  private readonly stateListeners = new Set<StateListener>();
  private readonly commandListeners = new Set<CommandListener>();

  getState(): GameUiState {
    return this.state;
  }

  publish(state: GameUiState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  subscribeState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  command(command: GameUiCommand): void {
    for (const listener of this.commandListeners) listener(command);
  }

  subscribeCommands(listener: CommandListener): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }
}

export const gameUiBridge = new GameUiBridge();
