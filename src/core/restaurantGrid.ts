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
  return {
    x: Math.trunc(fractional.x),
    y: Math.trunc(fractional.y),
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
