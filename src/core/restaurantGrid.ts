/**
 * Restaurant City restaurant-grid contract.
 *
 * Grounded in the recovered WorldRestaurant.as / RoomItem.as behavior:
 * - tileWidth = 80, ratio = 2, tileHeight = 40
 * - screenX = (tileX - tileY) * 40
 * - screenY = (tileX + tileY) * 20
 * - normal room items cannot occupy tile row/column 0
 * - RoomItem rotation swaps X/Y footprint
 * - OwnedItem.data: low nibble rotation, high nibble usage count
 *
 * This module has no Phaser/DOM/time/randomness and is safe to use for client
 * prediction. Server authority must independently validate mutations.
 */

export const TILE_WIDTH = 80;
export const TILE_HEIGHT = 40;
export const TILE_WIDTH_HALF = 40;
export const TILE_HEIGHT_HALF = 20;

export const ROOM_INDEX_MAIN = 0;
export const ROOM_INDEX_OUTSIDE_AREA = 1;

export type DefaultWallKind = 'corner' | 'segment';

export interface DefaultWallSegment {
  readonly kind: DefaultWallKind;
  readonly rotation: number;
}

export function defaultWallAt(
  tile: TilePoint,
  room: RoomDimensions,
): DefaultWallSegment | null {
  requireInteger(tile.x, 'tile.x');
  requireInteger(tile.y, 'tile.y');
  if (tile.x < 0 || tile.y < 0) return null;

  if (tile.x === 0 && tile.y === 0) {
    return { kind: 'corner', rotation: 0 };
  }
  if (tile.y === 0 && tile.x > 0 && tile.x < room.insideX) {
    return { kind: 'segment', rotation: 1 };
  }
  if (tile.x === 0 && tile.y > 0 && tile.y < room.insideY) {
    return { kind: 'segment', rotation: 0 };
  }
  return null;
}

export function defaultWallAttachmentRotation(
  tile: TilePoint,
  room: RoomDimensions,
): number | null {
  const wall = defaultWallAt(tile, room);
  return wall?.kind === 'segment' ? wall.rotation : null;
}

export interface TilePoint {
  readonly x: number;
  readonly y: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface Footprint {
  readonly sizeX: number;
  readonly sizeY: number;
}

export interface RoomDimensions {
  readonly insideX: number;
  readonly insideY: number;
  readonly outsideX: number;
  readonly outsideY: number;
}

export interface PlacementShape extends Footprint {
  readonly wallItem?: boolean;
  readonly wallDecorationItem?: boolean;
  readonly wallpaperItem?: boolean;
  readonly outdoor?: boolean;
  readonly floorTileItem?: boolean;
  /** Recovered RoomItem flag: this item may support another stackable item. */
  readonly surface?: boolean;
  /** Recovered RoomItem flag: this item may be placed on a surface item. */
  readonly stackable?: boolean;
}

export interface DecodedOwnedItemData {
  readonly rotation: number;
  readonly usageCount: number;
}

function requireInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
}

function requirePositiveDimension(value: number, label: string): void {
  requireInteger(value, label);
  if (value < 0) {
    throw new Error(`${label} cannot be negative`);
  }
}

export function projectTile(tile: TilePoint): ScreenPoint {
  requireInteger(tile.x, 'tile.x');
  requireInteger(tile.y, 'tile.y');
  return {
    x: (tile.x - tile.y) * TILE_WIDTH_HALF,
    y: (tile.x + tile.y) * TILE_HEIGHT_HALF,
  };
}

export function screenToTileFraction(screen: ScreenPoint): TilePoint {
  return {
    x: (screen.x + 2 * screen.y) / TILE_WIDTH,
    y: (2 * screen.y - screen.x) / (2 * TILE_HEIGHT),
  };
}

/**
 * Matches the historical ActionScript return type `int` used by
 * WorldRestaurant.getTileIndexX/Y: conversion truncates toward zero.
 */
export function screenToTileIndex(screen: ScreenPoint): TilePoint {
  const fractional = screenToTileFraction(screen);
  const x = Math.trunc(fractional.x);
  const y = Math.trunc(fractional.y);
  return {
    // ActionScript int has one zero value; JS exposes signed -0.
    x: Object.is(x, -0) ? 0 : x,
    y: Object.is(y, -0) ? 0 : y,
  };
}

export function decodeOwnedItemData(data: number): DecodedOwnedItemData {
  requireInteger(data, 'data');
  if (data < 0 || data > 0xff) {
    throw new Error('data must fit the historical uint8 item field');
  }
  return {
    rotation: data & 0x0f,
    usageCount: (data & 0xf0) >> 4,
  };
}

export function encodeOwnedItemData(
  rotation: number,
  usageCount: number,
): number {
  requireInteger(rotation, 'rotation');
  requireInteger(usageCount, 'usageCount');
  if (rotation < 0 || rotation > 0x0f) {
    throw new Error('rotation must fit one nibble');
  }
  if (usageCount < 0 || usageCount > 0x0f) {
    throw new Error('usageCount must fit one nibble');
  }
  return (usageCount << 4) | rotation;
}

export function rotateFootprint(
  footprint: Footprint,
  quarterTurns: number,
): Footprint {
  requirePositiveDimension(footprint.sizeX, 'sizeX');
  requirePositiveDimension(footprint.sizeY, 'sizeY');
  requireInteger(quarterTurns, 'quarterTurns');

  const normalized = ((quarterTurns % 4) + 4) % 4;
  return normalized % 2 === 0
    ? { sizeX: footprint.sizeX, sizeY: footprint.sizeY }
    : { sizeX: footprint.sizeY, sizeY: footprint.sizeX };
}


/**
 * Axis-aligned footprint overlap in Restaurant City tile space.
 *
 * This is intentionally limited to ordinary floor-space occupancy. Historical
 * stacking/surface/sub-item semantics remain a separate recovered-rule layer.
 */
export interface HistoricalTileStackEntry {
  readonly instanceId: number;
  readonly surface: boolean;
}

export type HistoricalTileStackResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'blocked-top' | 'stack-limit';
      readonly blockingInstanceId?: number;
    };

/**
 * Exact ordinary-tile stack rule recovered from WorldRestaurant.isValid().
 *
 * The historical itemMap is ordered bottom -> top. A new candidate may share
 * an occupied tile only when the candidate itself is stackable and the current
 * top item is a surface. At most five entries may occupy one tile.
 *
 * When validating an item that is already the top entry, the original client
 * temporarily looks through itself and raises the length threshold by one.
 * Keep this quirk explicit instead of normalizing it away.
 */
export function validateHistoricalTileStack(
  candidate: { readonly stackable?: boolean },
  stack: readonly HistoricalTileStackEntry[],
  selfInstanceId?: number,
): HistoricalTileStackResult {
  if (selfInstanceId !== undefined) {
    requireInteger(selfInstanceId, 'selfInstanceId');
  }
  for (const entry of stack) {
    requireInteger(entry.instanceId, 'stack.instanceId');
  }

  let topIndex = stack.length - 1;
  let lengthThreshold = 5;
  if (
    topIndex >= 0 &&
    selfInstanceId !== undefined &&
    stack[topIndex]?.instanceId === selfInstanceId
  ) {
    topIndex -= 1;
    lengthThreshold += 1;
  }

  const top = topIndex >= 0 ? stack[topIndex] : undefined;
  if (top && (!candidate.stackable || !top.surface)) {
    return {
      ok: false,
      reason: 'blocked-top',
      blockingInstanceId: top.instanceId,
    };
  }

  if (stack.length > lengthThreshold - 1) {
    return { ok: false, reason: 'stack-limit' };
  }

  return { ok: true };
}

export function footprintsOverlap(
  aTile: TilePoint,
  aFootprint: Footprint,
  bTile: TilePoint,
  bFootprint: Footprint,
): boolean {
  for (const [label, value] of Object.entries({
    aTileX: aTile.x,
    aTileY: aTile.y,
    aSizeX: aFootprint.sizeX,
    aSizeY: aFootprint.sizeY,
    bTileX: bTile.x,
    bTileY: bTile.y,
    bSizeX: bFootprint.sizeX,
    bSizeY: bFootprint.sizeY,
  })) {
    requireInteger(value, label);
  }
  requirePositiveDimension(aFootprint.sizeX, 'aFootprint.sizeX');
  requirePositiveDimension(aFootprint.sizeY, 'aFootprint.sizeY');
  requirePositiveDimension(bFootprint.sizeX, 'bFootprint.sizeX');
  requirePositiveDimension(bFootprint.sizeY, 'bFootprint.sizeY');

  if (
    aFootprint.sizeX === 0 ||
    aFootprint.sizeY === 0 ||
    bFootprint.sizeX === 0 ||
    bFootprint.sizeY === 0
  ) {
    return false;
  }

  const aMaxX = aTile.x + aFootprint.sizeX - 1;
  const aMaxY = aTile.y + aFootprint.sizeY - 1;
  const bMaxX = bTile.x + bFootprint.sizeX - 1;
  const bMaxY = bTile.y + bFootprint.sizeY - 1;

  return (
    aTile.x <= bMaxX &&
    aMaxX >= bTile.x &&
    aTile.y <= bMaxY &&
    aMaxY >= bTile.y
  );
}

export function isTileInOutsideArea(
  tile: TilePoint,
  room: RoomDimensions,
): boolean {
  return tile.y >= room.insideY && tile.x < room.outsideX;
}

/**
 * Exact structural bounds rule from WorldRestaurant.isItemOutOfBound.
 *
 * It deliberately does not decide collision/stacking/wall-map semantics; those
 * require item-map state and are a separate validator.
 */
export function isItemOutOfBounds(
  shape: PlacementShape,
  tile: TilePoint,
  room: RoomDimensions,
): boolean {
  for (const [label, value] of Object.entries({
    sizeX: shape.sizeX,
    sizeY: shape.sizeY,
    tileX: tile.x,
    tileY: tile.y,
    insideX: room.insideX,
    insideY: room.insideY,
    outsideX: room.outsideX,
    outsideY: room.outsideY,
  })) {
    requireInteger(value, label);
  }

  requirePositiveDimension(shape.sizeX, 'sizeX');
  requirePositiveDimension(shape.sizeY, 'sizeY');
  requirePositiveDimension(room.insideX, 'insideX');
  requirePositiveDimension(room.insideY, 'insideY');
  requirePositiveDimension(room.outsideX, 'outsideX');
  requirePositiveDimension(room.outsideY, 'outsideY');

  if (shape.wallItem || shape.wallDecorationItem || shape.wallpaperItem) {
    return !(
      tile.x >= 0 &&
      tile.y >= 0 &&
      tile.x < room.insideX &&
      tile.y < room.insideY
    );
  }

  if (tile.x < 1 || tile.y < 1) {
    return true;
  }

  const maxX = tile.x + shape.sizeX - 1;
  const maxY = tile.y + shape.sizeY - 1;

  if (maxY >= room.insideY) {
    return (
      maxX >= room.outsideX ||
      maxY >= room.insideY + room.outsideY
    );
  }

  return maxX >= room.insideX || maxY >= room.insideY;
}

export type StructuralPlacementResult =
  | { readonly ok: true; readonly roomIndex: number }
  | {
      readonly ok: false;
      readonly reason: 'out-of-bounds' | 'wrong-area' | 'floor-border';
    };

/**
 * Structural placement checks that can be proven without the live itemMap.
 * Collision/stacking validation is intentionally not guessed here.
 */
export function validateStructuralPlacement(
  shape: PlacementShape,
  tile: TilePoint,
  room: RoomDimensions,
): StructuralPlacementResult {
  if (isItemOutOfBounds(shape, tile, room)) {
    return { ok: false, reason: 'out-of-bounds' };
  }

  if (shape.floorTileItem && (tile.x === 0 || tile.y === 0)) {
    return { ok: false, reason: 'floor-border' };
  }

  const outside = isTileInOutsideArea(tile, room);
  if (shape.outdoor && !outside) {
    return { ok: false, reason: 'wrong-area' };
  }

  return {
    ok: true,
    roomIndex: outside ? ROOM_INDEX_OUTSIDE_AREA : ROOM_INDEX_MAIN,
  };
}
