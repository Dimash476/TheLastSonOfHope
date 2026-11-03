# The Last Son of Hope

A mini project for practicing applied computer vision.
The game is written in Three.js with the help of Claude Code. The camera control module, built on MediaPipe, was written by hand by the author.

# Overview

A 3D simulator inspired by the film adaptation Man of Steel / The Last Son of Krypton. (A fan project, not affiliated with DC Comics or Warner Bros.)

The game has three main modes:

- **Simulator** — free play with no rules or objectives.
- **Battle** — a fight against the Colossus, a stone giant with magma inside.
- **Story** — in development.

# Controls
- **Keyboard and mouse** - standard PC controls. Instructions are built into the game.
- **Camera** - switch control to the camera. Press CTRL and wait for calibration to finish.

# Gesture Map
- **Turning** - head movement (the program tracks a point on the tip of the nose); equivalent to WASD on PC.
- **Flight activation / acceleration** - the appearance of your left hand in the frame activates flight; clenching your left hand activates acceleration.
- **Additional acceleration** - moving the index finger and thumb of your right hand apart and together speeds up flight.


## Running

You need Python 3 and an internet connection (the three.js engine is loaded from a CDN).

````bash
python server.py 8000
````

Then open http://localhost:8000. On Windows, you can simply double-click `start.bat`.

The first 5 seconds after startup are calibration: look straight at the screen.

Python 3.12 is required (mediapipe 0.10.21 has no builds for newer versions):

````bash
cd GameTracking
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
````

You can specify a different Python via the `TRACKING_PYTHON` environment variable.

The gesture recognition module (`GameTracking/`) was written by the author by hand; the integration with the game and minor improvements were made with the help of Claude Code.

## Customization (your own music)

Optional. Audio files are not included in the repository.

- `music/` — mp3, ogg or m4a: played in sequence; press `M` for the next track.
- `music/party/` — a track for the party on the island (mp3, ogg, m4a, wav, webm, opus): loudest near the stage, paused when outside the island.
- `assets/audio/city_ambience.mp3` (or `.ogg`) — a recording of city background noise to replace the synthesized one. CC0 license only.

Without these files, all sounds and music are synthesized by the game code.

## Third-Party Components

| Component | Author | License | How it's used |
|---|---|---|---|
| [three.js](https://threejs.org) r160 | three.js authors | [MIT](https://github.com/mrdoob/three.js/blob/r160/LICENSE) | Loaded by the browser from the [jsDelivr](https://www.jsdelivr.com) CDN, not stored in the repository |
| 3D model "Free Rigged Male Basemesh" | Filip ([Sketchfab](https://sketchfab.com/filip.hans.nyberg)) | [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/) | `assets/models/hero/` together with `license.txt` |
| [MediaPipe](https://github.com/google-ai-edge/mediapipe) 0.10.21 | Google | [Apache-2.0](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE) | Face and hand recognition; installed via pip |
| [OpenCV](https://opencv.org) | OpenCV team | [Apache-2.0](https://github.com/opencv/opencv/blob/4.x/LICENSE) | Camera handling; installed together with MediaPipe |
| [websockets](https://github.com/python-websockets/websockets) | Aymeric Augustin and contributors | [BSD-3-Clause](https://github.com/python-websockets/websockets/blob/main/LICENSE) | Communication between the script and the game; installed via pip |

Character model: This work is based on "Free Rigged Male Basemesh" (https://sketchfab.com/3d-models/free-rigged-male-basemesh-b8de3373addd4decac40400ee96c62e0) by Filip (https://sketchfab.com/filip.hans.nyberg) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/).
Changes: a suit (shader), a cape and procedural animations were added; the original geometry was not modified.

## Rights

© 2026 DimashSh2407. All rights reserved.

The source code is open for viewing but is **not distributed under an open-source license**: copying, modifying, and using the code
in other projects is allowed only with the author's permission. Third-party components (see the table above) are used under the terms of their own licenses.
````
````

