# TypeScript Migration Plan for midi-zoner

## Overview
Convert the vanilla JavaScript Electron app to TypeScript with a practical VS Code toolchain for easy development and debugging.

**Approach**: tsc-only (no bundler), gradual typing, reorganized src/ structure

---

## Phase 1: Project Setup

### 1.1 Install Dependencies
```bash
npm install -D typescript @types/node concurrently rimraf
```

### 1.2 Create Directory Structure
```
midi-zoner/
├── src/
│   ├── main/
│   │   └── main.ts
│   ├── renderer/
│   │   └── app.ts
│   ├── modules/
│   │   ├── domutils.ts
│   │   ├── internal-clock.ts
│   │   ├── potdraghandler.ts
│   │   ├── dragzone.ts
│   │   ├── midi.ts
│   │   ├── zone.ts
│   │   ├── zone-template.ts
│   │   └── viewcontroller.ts
│   └── types/
│       ├── index.d.ts
│       ├── electron-settings.d.ts
│       └── seedrandom.d.ts
├── dist/                  # Compiled output
├── res/                   # Unchanged
├── assets/                # Unchanged
├── index.html             # Update script src
├── tsconfig.json
└── package.json           # Update main + scripts
```

### 1.3 Create tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "allowJs": true,
    "incremental": true,
    "tsBuildInfoFile": "./dist/.tsbuildinfo"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 1.4 Create VS Code Debug Configuration

**.vscode/launch.json**:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Main Process",
      "type": "node",
      "request": "launch",
      "cwd": "${workspaceFolder}",
      "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron",
      "args": [".", "--remote-debugging-port=9222"],
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: build:ts"
    },
    {
      "name": "Attach to Renderer",
      "type": "chrome",
      "request": "attach",
      "port": 9222,
      "webRoot": "${workspaceFolder}",
      "sourceMaps": true
    }
  ],
  "compounds": [
    {
      "name": "Full Debug",
      "configurations": ["Debug Main Process", "Attach to Renderer"]
    }
  ]
}
```

**.vscode/tasks.json**:
```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "npm",
      "script": "build:ts",
      "group": { "kind": "build", "isDefault": true },
      "problemMatcher": ["$tsc"]
    },
    {
      "type": "npm",
      "script": "watch",
      "isBackground": true,
      "problemMatcher": ["$tsc-watch"]
    }
  ]
}
```

### 1.5 Update package.json

**Change main entry**:
```json
"main": "dist/main/main.js"
```

**Update scripts**:
```json
{
  "scripts": {
    "start": "npm run build:ts && electron .",
    "dev": "concurrently \"npm run watch\" \"sleep 3 && electron .\"",
    "watch": "tsc --watch",
    "build:ts": "tsc",
    "clean": "rimraf dist",
    "typecheck": "tsc --noEmit",
    "pack:osx": "npm run build:ts && electron-packager . --out=dist/osx --platform=darwin --arch=x64 --icon='./assets/zoner.icns' --overwrite --ignore='src|assets'",
    "pack:osx:arm": "npm run build:ts && electron-packager . --out=dist/osx --platform=darwin --arch=arm64 --icon='./assets/zoner.icns' --overwrite --ignore='src|assets'",
    "build:win": "npm run build:ts && electron-builder -w",
    "build:mac": "npm run build:ts && electron-builder -m",
    "build:linux": "npm run build:ts && electron-builder -l"
  }
}
```

**Update build files config**:
```json
{
  "build": {
    "files": [
      "dist/**/*",
      "res/**/*",
      "index.html",
      "styles.css"
    ]
  }
}
```

### 1.6 Update index.html
```html
<script src="dist/renderer/app.js"></script>
```

---

## Phase 2: Create Type Definitions

### 2.1 src/types/index.d.ts
Core types for Zone, Sequence, MIDI, CC controllers:
- `NoteData`, `SeqStepData`, `CCController`, `CCControllerType`
- `ZonesState`, `PortDescriptor`, `MIDIMessageEvent`
- `MIDIHandlers` callback interfaces
- `SaveDialogResult` for IPC

### 2.2 src/types/electron-settings.d.ts
Declare module for electron-settings package.

### 2.3 src/types/seedrandom.d.ts
Declare module for seedrandom package.

---

## Phase 3: Migrate Files (Dependency Order)

### Batch 1: No Dependencies
| File | From | To |
|------|------|-----|
| domutils | modules/domutils.js | src/modules/domutils.ts |
| internal-clock | modules/internal-clock.js | src/modules/internal-clock.ts |

### Batch 2: Simple Dependencies
| File | From | To |
|------|------|-----|
| potdraghandler | modules/potdraghandler.js | src/modules/potdraghandler.ts |
| dragzone | modules/dragzone.js | src/modules/dragzone.ts |

### Batch 3: MIDI Layer
| File | From | To |
|------|------|-----|
| midi | modules/midi.js | src/modules/midi.ts |

### Batch 4: Core Domain (Largest)
| File | From | To |
|------|------|-----|
| zone | modules/zone.js | src/modules/zone.ts |

### Batch 5: Templates & View
| File | From | To |
|------|------|-----|
| zone-template | modules/zone-template.js | src/modules/zone-template.ts |
| viewcontroller | modules/viewcontroller.js | src/modules/viewcontroller.ts |

### Batch 6: Entry Points
| File | From | To |
|------|------|-----|
| app | app.js | src/renderer/app.ts |
| main | main.js | src/main/main.ts |

---

## Phase 4: Migration Strategy Per File

### For each file:
1. Copy to new location with `.ts` extension
2. Add type imports at top
3. Fix immediate compilation errors (use `any` liberally for speed)
4. Run `npm run build:ts` to verify
5. Run `npm start` to test functionality
6. Commit working state

### Key fixes needed during migration:
- **dragzone.ts**: Pass `zones` as parameter instead of global reference
- **zone-template.ts**: Type the template function parameters loosely
- **viewcontroller.ts**: Type event handlers with DOM event types
- **zone.ts**: Export class types, use interfaces for complex nested objects

---

## Phase 5: Post-Migration Refinement

### 5.1 Gradually Enable Strict Options
In tsconfig.json, progressively enable:
```json
{
  "strict": true,
  "noImplicitAny": true,
  "strictNullChecks": true
}
```

### 5.2 Replace `any` Types
- Review each `any` and add proper types
- Add return types to functions
- Type class properties fully

### 5.3 Clean Up
- Remove old `.js` files from root and modules/
- Update .gitignore to exclude dist/
- Update CLAUDE.md with TypeScript info

---

## Critical Files to Modify

1. **package.json** - Dependencies, scripts, main entry, build config
2. **index.html** - Script source path
3. **tsconfig.json** - New file
4. **.vscode/launch.json** - New file
5. **.vscode/tasks.json** - New file
6. **src/types/*.d.ts** - New type definition files
7. **All 10 source files** - Migrate to TypeScript

---

## Development Workflow After Migration

### Daily Development
```bash
npm run dev          # Watch mode + electron
# OR
npm run watch        # Terminal 1: tsc watch
npm start            # Terminal 2: run electron
```

### Debugging in VS Code
1. Press F5 (runs "Debug Main Process")
2. Use "Full Debug" compound to debug both main + renderer
3. Set breakpoints in .ts files - source maps work automatically

### Building for Distribution
```bash
npm run build:mac    # Creates DMG
npm run build:win    # Creates portable exe
npm run pack:osx:arm # Creates .app for ARM Mac
```

---

## Estimated Effort

| Phase | Time |
|-------|------|
| Setup (deps, configs, VS Code) | 1-2 hours |
| Type definitions | 1-2 hours |
| Migrate 10 files (with testing) | 4-6 hours |
| Initial refinement | 2-3 hours |
| **Total** | **8-13 hours** |

Note: The large files (zone.ts ~49KB, viewcontroller.ts ~71KB) will take the most time.
