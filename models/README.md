# Model artifacts

These are versioned research checkpoints from the author's Google Drive runs, collected on November 20, 2026. They are provided to demonstrate the work completed and support evaluation.

| File | Use | Browser compatible? |
| --- | --- | --- |
| [toggle/best.onnx](./toggle/best.onnx) | Single-class Toggle inference, YOLO26n-OBB | Yes |
| [toggle/best.pt](./toggle/best.pt) | Toggle evaluation and further training in Python | No; export ONNX for the app |
| [pins/best.pt](./pins/best.pt) | Experimental Toggle + red/blue/yellow halves + cup model | No; this historical five-class model is unsupported |

The ONNX is approximately 10 MB; the PyTorch checkpoints are approximately 5.7 MB each. Use the file's **Download raw file** option on GitHub to save the binary, rather than saving its HTML preview page.

## Use the Toggle model

1. Download toggle/best.onnx.
2. Open [RoboCoach](https://therealbnaru.github.io/RoboCoach/).
3. Open an uploaded video or share a playing tab.
4. Open Live score, turn on Dev mode, and choose the ONNX file.
5. Inspect rotated boxes and confidence labels.
6. Select each field side and use Pick on video on its **field-facing strip** to calibrate ownership sampling.

The detector finds Toggle geometry. The app separately samples a calibrated strip to estimate red/blue/neutral state. It may need recalibration after camera movement or perspective changes. These weights do not provide complete automatic match scoring.

## Verified Toggle ONNX interface

- Exported with Ultralytics 8.4.215.
- Input images: float tensor [1, 3, 640, 640].
- Output output0: [1, 6, 8400].
- Class map: {0: 'toggle'}.
- Raw OBB output, no embedded NMS; the app applies duplicate suppression.
- See [model-info.json](./toggle/model-info.json) and [SHA256SUMS](./SHA256SUMS).

The file's interface and metadata were inspected; no new inference benchmark was run during packaging.

## Provenance and limitations

- toggle/best.pt and toggle/best.onnx: toggle-obb-with-online.
- pins/best.pt: pins-cups-obb.
- Dataset splits, evaluation artifacts, and metric caveats are documented in [the training guide](../docs/TRAINING.md).
- Full videos and datasets remain outside the repository. The historical notebook's outputs and account metadata have been removed.
- Upstream Ultralytics software/model terms apply. Inclusion here does not waive upstream license requirements or grant rights to third-party training footage.

## Latest pins-and-goals model

The app now has one Vision model ONNX loader supporting a future combined three-class model or one historical model at a time. The latest run is pins-goals-100, trained for 100 epochs at 960×960 with class 0 stacked_pin_half and class 1 goal. These newer weights are still managed in Drive and are **not** the historical pins/best.pt linked above.

See the [latest results and export instructions](../docs/TRAINING.md#pins-and-goals-browser-preview). Export with end2end=False and nms=False, then load the downloaded file under Live score → Vision model — one ONNX file. Required raw output is [1,7,N]. Blue and green boxes are detection previews; manual scoring remains separate. Real exported-model browser verification is pending.

Combined-model contract: class IDs 0 Toggle, 1 PIN, 2 Goals; raw float32 OBB output [1,8,N], square static input 640 or 960, batch 1. The combined weights are not bundled and have not yet been trained. Existing one- and two-class exports work individually; they are not automatically merged.
