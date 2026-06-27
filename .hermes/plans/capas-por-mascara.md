# Plan: Refactor Capas a Máscaras Binarias

## Cambio fundamental

Cada capa pasa de tener un **heightmap continuo** (layerHeights[l] = Float32Array, 0..1) a tener:

- **Máscara binaria** (layerMasks[l] = Uint8Array, 0/1): donde hay terreno
- **Material** (layerMaterials[l] = Uint8Array, Tierra=0/Agua=1): qué material tiene

La altura total se **deriva**: `heightData[i] = count_layers_con_mascara_activa * thickness`

## Archivos a modificar

Solo `public/app.js` y migrar `uploads/sannjuanv7.json`.

## Paso 1: Nuevas estructuras de datos

Reemplazar:
```js
let layerHeights = null; // Array of Float32Array, one per layer
```
Con:
```js
let layerMasks = null;    // Array of Uint8Array(RES*RES), one per layer (0/1)
let layerMaterials = [];  // Array of Uint8Array(RES*RES), one per layer (0=Tierra, 1=Agua)
```

Propiedad derivada: `layerThickness = 1 / state.layers`

## Paso 2: initLayerHeights → initLayerMasks

En vez de distribuir height continua, crear máscaras:
- Si es preset legacy: `numFilled = Math.round(height / layerThickness)`, layers 0..numFilled-1 tienen mask=1
- Si es nuevo: todas en 0

## Paso 3: computeTotalHeight → computeHeightsFromMasks

```js
function computeHeightsFromMasks() {
  totalHeightData.fill(0);
  const th = 1 / state.layers;
  for (let l = 0; l < layerMasks.length; l++) {
    const mask = layerMasks[l];
    for (let i = 0; i < RES*RES; i++) {
      if (mask[i]) totalHeightData[i] += th;
    }
  }
  heightData.set(totalHeightData);
}
```

## Paso 4: Cambiar paintAt / paint3dAt para Subir/Bajar

En layers mode:
- **Subir (tool=add)**: `layerMasks[activeLayer][i] = 1`
- **Bajar (tool=sub)**: `layerMasks[activeLayer][i] = 0`
- **Suavizar**: dilatar/erosionar máscara
- **Color**: pintar material en layerMaterials[activeLayer]

## Paso 5: Floodfill → trabaja sobre layerMaterials de la capa activa

```js
function floodFillLayerMaterial(gx, gz, matId) {
  const li = activeLayer - 1;
  const mask = layerMasks[li];
  // Flood-fill sobre celdas donde mask === 1
  // Pinta layerMaterials[li][i] = matId
}
```

## Paso 6: rebuildTerrain — modo Capas

Cada capa visible se renderiza como mesh independiente:
- Altura de la capa = thickness (si mask=1) o 0 (si mask=0) → genera un escalón
- Y base = acumulado de layers anteriores
- Color según layerConfig[layer].color

## Paso 7: rebuildTerrain — otros modos (solid/heat/wire)

Usan `heightData` derivado de `computeHeightsFromMasks()`. Idéntico render que ahora.

## Paso 8: SVG export

Cada capa genera su contorno basado en la **máscara** (Uint8Array con 0/1), no en el heightmap continuo. Marching squares sobre valores 0/1.

## Paso 9: Save/Load preset

Guardar `layerMasks: layerMasks.map(m => Array.from(m))` y `layerMaterials: layerMaterials.map(m => Array.from(m))`.
Al cargar, restaurar arrays.

## Paso 10: Migración sanjuanv7.json

Agregar bloque en loadPreset: si el preset tiene heightData pero NO layerMasks, ejecutar migración única.

## Riesgos

1. **Eliminar smooth**: con máscaras binarias, smoothHeightmap no tiene sentido. En otros modos se puede omitir o aplicar sobre heightData derivado.
2. **fillTerrainHoles**: opera sobre heightData directamente. Con el nuevo sistema, "rellenar huecos" debería rellenar la máscara de la capa inferior.
3. **applyBrilloContraste**: con máscaras binarias no aplica. Solo aplicar sobre heightData derivado para visualización.
4. **Rellenar (floodfill) en modo layers**: actualmente modifica materialMap global. Ahora debe modificar layerMaterials[activeLayer].
