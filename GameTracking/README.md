# Gesture Controller

This is a script(No AI was used to write this code) written for a game controlling with face and hands landmarks, using a webcam.

- **Nose** steers the character: move your head to turn or tilt.
- **Left hand** in frame means flying. Make a fist to boost.
- **Right hand** sets the speed: the wider you spread your thumb and index finger, the faster you go.



When it starts, hold still for 5 seconds while the program learns your neutral head position.

## What it outputs

One JSON line per frame, which your game can read from stdout:

```json
{"calib": false, "face": true, "yaw": 0.0, "pitch": 0.0, "fly": false, "boost": false, "k": 0.0}
```

`yaw` and `pitch` go from -1 to 1, `k` (speed) from 0 to 1.

## Requirements

- Python 3.12 (tested on 3.12.10)
- A webcam
- Windows is the tested platform

## Installation

Create and activate a virtual environment:

```bash
python -m venv .venv
.venv\Scripts\activate
```

Install the dependencies:

```bash
pip install -r requirements.txt
```

## Running

- `python Moves.py` — prints one JSON line per frame to stdout.

Stop a script with `Ctrl+C` in the terminal.

The individual tracking modules can also be tested on their own from `TrackFace/usage.py`, `TrackHands/usage.py` and `TrackEyes/usage.py`.

## Built with

Python 3.12.10, MediaPipe 0.10.21, OpenCV 5.0.0.93, websockets