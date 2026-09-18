# Web shell and Phaser renderer boundary

Status: **accepted architecture for the ANEWON Restaurant City revival**

## Decision

The production game is a native web application.

Runtime technologies:

- HTML5
- CSS
- TypeScript
- Phaser using WebGL/Canvas
- browser-native image/audio formats
- JSON / typed web-native runtime data
- ANEWON Platform and Runtime APIs
- AnewPack/protected delivery when that layer is integrated

The browser **does not execute, parse or emulate Flash**.

Historical SWF and BIN files are research/build inputs only. They stay in the
private Vault/trusted pipeline, are decoded/extracted offline, and produce
validated web-native derivatives. No Ruffle, Flash VM, SWF loader or BIN
decoder is part of the production browser runtime.

## Ownership boundary

### DOM / HTML / CSS owns

- ANEWON platform shell
- account/profile/social/settings
- notifications
- authentication/session surfaces
- game HUD that does not need world-space transforms
- inventory and shop panels
- recipe book
- challenge/progression panels
- settings and accessibility
- dialogs, confirmations and forms
- responsive/mobile layout
- text-heavy and keyboard-accessible interactions

This lets normal web semantics handle accessibility, localization, focus,
screen readers, responsive layout and forms.

### Phaser owns

- restaurant/street/garden world rendering
- characters and animations
- furniture/decoration rendering
- camera
- pathfinding/movement
- world simulation presentation
- object selection and hit testing
- tile/footprint placement preview
- world-space labels/indicators
- particle/effect animation
- other UI whose coordinate system is inherently the game world

### Backend owns authority

Neither DOM nor Phaser is authoritative for valuable state.

Placement, inventory, economy, rewards, recipes, progression, timers and other
valuable mutations are validated by the product backend. The client can
predict/preview but cannot mint authoritative results.

## Bridge contract

DOM and renderer communicate through a narrow typed bridge.

The DOM sends intent such as:

- previous/next inventory item
- rotate item
- open/close game panel
- choose recipe

The renderer publishes presentation state such as:

- currently selected item
- hover tile
- placement validity
- current scene/context

The bridge is not an authority bypass. Commands that mutate valuable state
still become authenticated product commands and are validated server-side.

## Historical fidelity

A DOM shell does not mean redesigning Restaurant City into a generic web app.

Historical menus/HUD can be reproduced with HTML/CSS and extracted,
rights-classified web-native imagery while preserving layout and visual
character. What we deliberately do **not** preserve is the obsolete Flash
runtime architecture.

## Forbidden production-runtime dependencies

- `.swf`
- legacy compressed `.bin` database parsing
- ActionScript VM/emulation
- Ruffle as the product runtime
- direct execution of recovered historical code
- original archive files
- raw historical resource loading from arbitrary external hosts

The trusted acquisition/build pipeline may inspect those formats. The shipped
client may not depend on them.

## Current implementation

The application shell now creates a dedicated Phaser host and a DOM HUD. The M2
RestaurantEditor scene renders only the world/placement layer. Selection,
status and editor controls travel through a typed `GameUiBridge`.

This boundary should remain stable as account/profile/social/settings and
game-specific panels are implemented.
