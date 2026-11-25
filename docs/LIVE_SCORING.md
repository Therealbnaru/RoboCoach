# Live scoring: Match play and Skills

The calculator follows V5RC Override manual v2.1: [match scoring (SC3–SC7)](https://manuals.vex.com/v5/override/v2.1/game/#scoring) and [Skills (RSC3)](https://manuals.vex.com/v5/override/v2.1/skills/). Live totals are projected states, not official referee scores. Final placed/visible status, settled toggles and robot positioning require review.

## Select the scoring mode

Open Live score and choose Match play or Skills. Driving Skills and Autonomous Coding Skills use the same scoring formula.

Match play awards red/blue visible, placed halves to their alliance at 5 points each; owned yellow halves are 10. Quadrant toggle ownership applies to yellow halves. Midfield yellow ownership uses robot majority, with no ownership on a tie; each eligible midfield robot adds 8. Autonomous-period evaluation excludes robot-position points and midfield yellow ownership. The projected final mode can include a manually selected 12-point autonomous bonus or 6 each for a tie. Bonus assignment and violations are not inferred by the model.

Skills shows one total and no autonomous bonus. Choose the actual red/blue field color for each Left/Right/Top/Bottom area; these names describe your camera view, not a fixed alliance assignment. Red/blue halves count only in a matching-color quadrant or midfield. Yellow halves require matching quadrant toggle color, or a midfield robot for the midfield goal. The single midfield robot adds 8. Unknown quadrant colors do not earn quadrant points.

Mode switching reuses the displayed counts and pauses automatic count updates for review. Scores are not a saved per-mode match record.

## Apply model counts

1. Load the Toggle model if desired, and calibrate each field-facing strip using the existing Toggle controls.
2. Load the pins-and-goals ONNX model.
3. In Use detections for scoring, choose the scoring area, select Assign goal on video, and click its green goal-base box. Repeat for both goals in each quadrant and the midfield goal.
4. Check the area names in the stack summary. Assign only actual goal bases; the detector can produce false goals.
5. Select Apply counts once, or enable Update scoring counts live.

Live updates replace the red/blue/yellow half counts in each ready assigned area after two matching readings. This is replacement, not accumulation, so frames do not double-count. Only assigned goals contribute; unknown colors and unmatched halves are excluded. If any assigned goal in an area is missing, empty, ambiguous or has unknown-color halves, that area's previous counts are held. This also means a genuinely emptied stack requires manual correction.

A manual numeric or +/- correction pauses live updates to preserve the edit. Undo last count update restores the previous affected counts and pauses updates. Robot counts, quadrant colors, eligibility checks and autonomous bonus remain manual. Toggle tracking remains independently active.

Assignments use image positions, not frame-local G numbers. They clear for new video metadata. Reassign after camera movement, zoom, cuts or perspective changes. They are not field calibration or persistent object tracking.

## Verification and limits

Run `node tests/override-scoring.cjs` for rule arithmetic and aggregation checks. Additional development checks exercised two-reading stability, apply-once and undo snapshots. Actual scene eligibility cannot be established by these tests: box matching can confuse robot-held/floor objects with stacks, miss visible halves, and cannot determine nesting inside an opaque cup. Verify counts against footage before relying on totals.

The two ONNX models remain separate. ONNX graph composition can package networks together, but does not turn them into a single trained detector or eliminate their compute. A future shared detector would need reviewed labels for Toggle, stacked_pin_half and goal on every training image.
