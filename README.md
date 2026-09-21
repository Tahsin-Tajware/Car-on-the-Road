# A Car in the Road

CSE 4204 Computer Graphics Lab, final project, task serial 10.
Same scene as before, restructured the way Lab 5 and Lab 6 are set up:
Three.js comes from npm and the code is split into ES modules.

## How to run

```
cd car-on-the-road
npm install
npm run dev
```

To hand in a static copy instead, `npm run build` writes one to `dist/` and
`npm run preview` serves it.

Open the address Vite prints (usually `http://localhost:5173`), wait for the
loader, then press **Enter the scene**.

`npm install` pulls Three.js r169 and Vite, so the machine needs internet the
first time only. Open the project through the dev server &mdash; opening
`index.html` directly will not work, because the browser refuses ES module
imports over `file://`.

## Folder structure

```
car-on-the-road/
├── index.html        markup, styles, loader, HUD and the info panel
├── package.json      three + vite
└── js/
    ├── helpers.js      small maths helpers and the loader progress bar
    ├── textures.js     every texture, drawn with the 2D canvas API
    ├── shaders.js      the GLSL programs and the materials built from them
    ├── renderer.js     renderer, perspective camera, orthographic camera
    ├── lighting.js     lights, sky colours and the time of day
    ├── world.js        road curve, asphalt, terrain, scenery, lamps, signs
    ├── car.js          the car model
    ├── driving.js      driving, wheel spin, collision, the orbiting lamp
    ├── interaction.js  mouse, touch and keyboard
    └── main.js         HUD, camera rig, main loop and start up
```

Nothing is imported from the internet at run time. Every texture is drawn in
`textures.js` and every model is built from Three.js geometry, so no material
comes from any outside source.

## Controls

The two the brief asks for by name are at the top of each block.

**Keyboard moves the camera around the car**

| Input | Action |
| --- | --- |
| Q / E | swing the camera around the car |
| , / . | raise and lower the camera |
| - / = | move the camera out and in |
| 1 - 4 | orbit, chase, driver and overhead camera |
| A | let the camera circle the car on its own |

**The mouse rotates the light around the road**

| Input | Action |
| --- | --- |
| Shift + drag | rotate the light around the road |
| Right button drag | the same thing, without the shift key |
| J | hand the light back to its own timer |

**Everything else**

| Input | Action |
| --- | --- |
| Up arrow | throttle |
| Down arrow | brake, then reverse |
| Left / Right arrow | steer |
| Mouse drag | swing the camera around the car |
| Mouse wheel | move the camera in and out |
| Click a part | name the part under the pointer |
| M | hand the wheel to autopilot and back |
| Space | handbrake, or stop and start the autopilot |
| P | switch between perspective and orthographic projection |
| [ and ] | field of view |
| N | jump between day and night |
| T | let the sun move on its own |
| L | orbiting lamp on and off |
| O | lamp circles the road or the car |
| K | lamp shadows |
| H | head lights |
| X | change the paint |
| W | wireframe |
| G | light helpers |
| R | put the car back on the road |
| I | the requirement table |

## Where each requirement lives

| Requirement | File |
| --- | --- |
| Custom shaders | `shaders.js` &mdash; complete GLSL programs for the sky, car paint, glass and grass, plus two programs grown out of the standard material with `onBeforeCompile` for the road and the terrain |
| Lighting | `lighting.js` &mdash; ambient, hemisphere, a directional sun with a shadow map, the point lamp that rotates around the road, head light spot lights and a pool of lamp lights |
| Perspective projection | `renderer.js` &mdash; `THREE.PerspectiveCamera`; an orthographic camera shares the same transform so the two can be compared with **P** |
| Texture for every object | `textures.js` &mdash; asphalt, gravel, grass, dirt, paint, tyre, metal, glass, bark, leaf, rock, concrete, plate, grille and the road signs |
| Animation | `driving.js` &mdash; the car drives along the road, the wheels spin from the speed and the wheel radius, the body leans into corners, the lamp orbits and the camera follows |
| Mouse and keyboard | `interaction.js` &mdash; drag, wheel, click to pick a part, touch gestures and the key map above |
| **Keyboard moves the camera around the car** | `interaction.js` `onKey` sets the orbit camera up, `main.js` `updateCamera` steps it from the held keys so the sweep is frame rate independent |
| **Mouse rotates the light around the road** | `interaction.js` `pointermove` writes the lamp angle during a shift or right button drag; `driving.js` `updateOrbitLamp` turns that angle into a position on the loop |
| **Car wheels rotate** | `driving.js` `updateCar` &mdash; spin is speed &divide; wheel radius, integrated each frame |
